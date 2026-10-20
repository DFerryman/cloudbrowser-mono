import { verifyViewerToken } from '@cloudbrowser/contracts';
import { createDb, newArchiveKey, operationRow, schema } from '@cloudbrowser/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import engine from '@cloudbrowser/engine';
import app from '../src/index.js';
import { internalApi } from '../src/internal.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
const quote = async (regionId = 'tyo1') => (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string; version: string }) => p.regionId === regionId).version as string;
beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('pilot@example.com')`);
});

describe('auth', () => {
  it('signs in an invited user with an email code', async () => {
    expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
    const res = await signIn(t, 'pilot@example.com');
    expect(res?.status).toBe(200);
    const me = await t.call('GET', '/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('pilot@example.com');
    expect(me.body.entitlements.maxBrowsers).toBe(3);
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM caps WHERE metric = 'creates_per_day'").get()).toEqual({ n: 0 });
  });

  it('throttles sign-in code requests', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await t.call('POST', '/api/auth/email-otp/send-verification-otp', { email: 'pilot@example.com', type: 'sign-in' })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('echoes the caller IP for the agent IP check', async () => {
    const res = await app.fetch(
      new Request('http://app.test/api/echo/ip', { headers: { origin: 'null', 'cf-connecting-ip': '203.0.113.9' } }),
      t.env as never,
      t.ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('203.0.113.9');
  });

  it('lets anyone sign up while sign-up is open', async () => {
    expect(await signIn(t, 'stranger@example.com')).not.toBeNull();
    const users = t.d1.sqlite.prepare('SELECT count(*) AS n FROM user').get() as { n: number };
    expect(users.n).toBe(1);
  });

  it('never sends a code to an address that was not invited while invite only is on', async () => {
    t.d1.sqlite.exec("UPDATE control_flags SET value = 'true' WHERE key = 'invite_only'");
    expect(await signIn(t, 'stranger@example.com')).toBeNull();
    const users = t.d1.sqlite.prepare('SELECT count(*) AS n FROM user').get() as { n: number };
    expect(users.n).toBe(0);
  });
});

describe('browsers', () => {
  beforeEach(async () => {
    await signIn(t, 'pilot@example.com');
  });

  it('refuses cross-origin writes', async () => {
    const res = await t.call('POST', '/api/v1/instances', { name: 'x', regionId: 'tyo1', storageGb: 10, priceVersion: await quote('tyo1') }, { origin: 'https://evil.test', 'idempotency-key': 'k' });
    expect(res.status).toBe(403);
  });

  it('keeps Sydney unavailable until configured and uses its own region and timezone', async () => {
    const regions = await t.call('GET', '/api/v1/regions');
    expect(regions.body.find((r: { id: string }) => r.id === 'syd1')).toMatchObject({
      country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney', acceptingNew: false,
    });
    const body = { name: 'Sydney', regionId: 'syd1', storageGb: 10, priceVersion: await quote('syd1') };
    const blocked = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'syd-blocked' });
    expect(blocked.body.type).toBe('region_unavailable');
    t.d1.sqlite.exec("UPDATE regions SET enabled = 1, executor = 'fake' WHERE id = 'syd1'");
    t.d1.sqlite.exec("UPDATE provider_prices SET executor = 'fake' WHERE region_id = 'syd1'");
    const created = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'syd-ready' });
    expect(created.status).toBe(202);
    await t.settle();
    const list = await t.call('GET', '/api/v1/instances');
    expect(list.body[0]).toMatchObject({ regionId: 'syd1', status: 'running' });
    const row = t.d1.sqlite.prepare('SELECT fingerprint FROM browser_instances WHERE id = ?').get(created.body.instanceId) as { fingerprint: string };
    expect(JSON.parse(row.fingerprint).timezone).toBe('Australia/Sydney');
  });

  it('creates exactly one browser per Idempotency-Key and runs it', async () => {
    const body = { name: 'Work', regionId: 'tyo1', storageGb: 10, priceVersion: await quote('tyo1') };
    expect((await t.call('POST', '/api/v1/instances', body)).body.type).toBe('idempotency_key_required');
    const a = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'k1' });
    const b = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'k1' });
    expect(a.status).toBe(202);
    expect(b.body).toEqual(a.body);
    await t.settle();

    const list = await t.call('GET', '/api/v1/instances');
    expect(list.body).toHaveLength(1);
    const inst = list.body[0];
    expect(inst.status).toBe('running');
    expect(inst.idleTimeoutS).toBe(600);
    expect(inst.ipAddress).toMatch(/^203\.0\.113\./);
    expect(inst.lastIpCheck.ok).toBe(true);

    const op = await t.call('GET', `/api/v1/operations/${a.body.operationId}`);
    expect(op.body.status).toBe('succeeded');
  });

  it('saves never sleep and can restore the 10-minute inactivity timeout', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Always available', regionId: 'tyo1', storageGb: 10, priceVersion: await quote() }, { 'idempotency-key': 'never-sleep' });
    expect(created.status).toBe(202);
    await t.settle();
    const path = `/api/v1/instances/${created.body.instanceId}`;
    // Never sleep is confirmed against the 24-hour cost the user was shown.
    const neverSleep = (await t.call('GET', `${path}/never-sleep`)).body;
    expect(neverSleep).toMatchObject({ allowed: true, reason: null, regionId: 'tyo1', priceVersion: await quote() });
    expect(neverSleep.day.totalMicros).toBe(neverSleep.day.computeMicros + neverSleep.day.ipMicros + neverSleep.day.storageMicros);
    expect(await t.call('PATCH', path, { idleTimeoutS: 0 })).toMatchObject({ status: 400, body: { type: 'validation_failed' } });
    expect(await t.call('PATCH', path, { idleTimeoutS: 0, priceVersion: 'old' })).toMatchObject({ status: 409, body: { type: 'price_changed' } });
    expect(await t.call('PATCH', path, { idleTimeoutS: 0, priceVersion: neverSleep.priceVersion })).toMatchObject({ status: 200, body: { idleTimeoutS: 0 } });
    expect((await t.call('GET', path)).body.idleTimeoutS).toBe(0);
    const opened = await t.call('POST', `${path}/sessions`);
    expect(opened.status).toBe(201);
    const heartbeat = () => t.call('POST', `/api/v1/sessions/${opened.body.session.id}/heartbeat`, { input: false });
    expect(await heartbeat()).toMatchObject({ status: 200, body: { sleepAt: null } });
    for (const idleTimeoutS of [-1, 1, 60, 599, 3601]) {
      expect(await t.call('PATCH', path, { idleTimeoutS })).toMatchObject({ status: 400, body: { type: 'validation_failed' } });
    }
    // An hour is allowed by default (migration 0024); a lower operator limit greys it out.
    expect(await t.call('PATCH', path, { idleTimeoutS: 3600 })).toMatchObject({ status: 200, body: { idleTimeoutS: 3600 } });
    t.d1.sqlite.exec(`UPDATE caps SET "limit" = 1800 WHERE scope = 'user:default' AND metric = 'idle_timeout_max_s'`);
    expect(await t.call('PATCH', path, { idleTimeoutS: 3600 })).toMatchObject({ status: 403, body: { type: 'plan_limit' } });
    expect(await t.call('PATCH', path, { idleTimeoutS: 600 })).toMatchObject({ status: 200, body: { idleTimeoutS: 600 } });
    const resumed = await heartbeat();
    expect(resumed).toMatchObject({ status: 200, body: { reason: 'idle' } });
    expect(Date.parse(resumed.body.sleepAt)).toBeGreaterThan(Date.now() + 590_000);
  });

  it('lets a user own three browsers by default and rejects a fourth', async () => {
    for (const k of ['a', 'b', 'c']) {
      const created = await t.call('POST', '/api/v1/instances', { name: k, regionId: 'tyo1', storageGb: 10, priceVersion: await quote() }, { 'idempotency-key': k });
      expect(created.status).toBe(202);
    }
    await t.settle();
    expect((await t.call('GET', '/api/v1/me')).body).toMatchObject({ usage: { browsers: 3 }, entitlements: { maxBrowsers: 3, maxRunning: 3 } });
    const fourth = await t.call('POST', '/api/v1/instances', { name: 'd', regionId: 'tyo1', storageGb: 10, priceVersion: await quote() }, { 'idempotency-key': 'd' });
    expect(fourth).toMatchObject({ status: 403, body: { type: 'plan_limit', limit: 'instances' } });
  });

  it('pauses creates after the 10-minute cap and says when to try again', async () => {
    t.d1.sqlite.exec(`UPDATE caps SET "limit" = 2 WHERE scope = 'global' AND metric = 'creates_per_10_min'`);
    for (const k of ['a', 'b']) expect((await t.call('POST', '/api/v1/instances', { name: k, regionId: 'tyo1', storageGb: 10, priceVersion: await quote() }, { 'idempotency-key': k })).status).toBe(202);
    const third = await t.call('POST', '/api/v1/instances', { name: 'c', regionId: 'tyo1', storageGb: 10, priceVersion: await quote() }, { 'idempotency-key': 'c' });
    expect(third).toMatchObject({ status: 503, body: { type: 'creation_frozen', limit: 'create_rate' } });
    expect(third.body.detail).toMatch(/Try again in about (9|10) minutes\./);
  });

  it('runs every browser a user owns at the same time: there is no separate running limit', async () => {
    const ids: string[] = [];
    for (const k of ['a', 'b', 'c']) {
      ids.push((await t.call('POST', '/api/v1/instances', { name: k, regionId: 'tyo1', storageGb: 10, priceVersion: await quote() }, { 'idempotency-key': k })).body.instanceId);
      await t.settle();
      await t.call('POST', `/api/v1/instances/${ids.at(-1)}/stop`, undefined, { 'idempotency-key': `stop-${k}` });
      await t.settle();
    }
    for (const id of ids) expect((await t.call('POST', `/api/v1/instances/${id}/start`, undefined, { 'idempotency-key': `start-${id}` })).status).toBe(202);
    await t.settle();
    const list = (await t.call('GET', '/api/v1/instances')).body as { status: string }[];
    expect(list.map((i) => i.status)).toEqual(['running', 'running', 'running']);
  });

  it('keeps the browser limit when one user sends creates at the same moment', async () => {
    t.d1.sqlite.exec(`UPDATE caps SET "limit" = 1 WHERE scope = 'user:default' AND metric = 'instances'`);
    const version = await quote();
    // Both requests pass admission before either transaction commits, as two Workers would.
    const batch = t.d1.batch.bind(t.d1);
    let arrived = 0;
    let release = () => {};
    const both = new Promise<void>((r) => (release = r));
    let queue: Promise<unknown> = Promise.resolve();
    t.d1.batch = (async (stmts: never) => {
      if (++arrived === 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 2000))]);
      const run = queue.then(() => batch(stmts));
      queue = run.catch(() => {});
      return run;
    }) as never;
    const results = await Promise.all(['x', 'y'].map((k) => t.call('POST', '/api/v1/instances', { name: k, regionId: 'tyo1', storageGb: 10, priceVersion: version }, { 'idempotency-key': k })));
    t.d1.batch = batch;
    expect(results.map((r) => r.status).sort()).toEqual([202, 403]);
    expect(results.find((r) => r.status === 403)!.body).toMatchObject({ type: 'plan_limit', limit: 'instances' });
    expect(t.d1.sqlite.prepare('SELECT COUNT(*) n FROM browser_instances').get()).toEqual({ n: 1 });
  });

  it('allows replacement browsers regardless of daily create history or obsolete daily-cap settings', async () => {
    const body = { name: 'Work', regionId: 'tyo1', storageGb: 10, priceVersion: await quote() };
    const first = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'daily-first' });
    expect(first.status).toBe(202);
    await t.settle();
    const userId = (await t.call('GET', '/api/v1/me')).body.user.id;
    // These are inside the old daily window but outside the retained global ten-minute guard.
    const now = new Date(Date.now() - 60 * 60_000);
    t.d1.sqlite.exec("INSERT INTO caps(scope, metric, \"limit\") VALUES ('user:default', 'creates_per_day', 3)");
    for (const status of ['succeeded', 'succeeded', 'succeeded', 'failed', 'canceled']) {
      await createDb(t.d1).insert(schema.operations).values({
        ...operationRow({ instanceId: first.body.instanceId, userId, kind: 'create', now }),
        status, finishedAt: now,
      });
    }
    await t.call('POST', `/api/v1/instances/${first.body.instanceId}/stop`, undefined, { 'idempotency-key': 'daily-stop' });
    await t.settle();
    const before = await t.call('GET', '/api/v1/me');
    expect(before.body).toMatchObject({ usage: { browsers: 1 }, entitlements: { maxBrowsers: 3 } });

    const second = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'daily-second' });
    expect(second.status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/operations/${second.body.operationId}`)).body.status).toBe('succeeded');
    await t.call('DELETE', `/api/v1/instances/${first.body.instanceId}`, undefined, { 'idempotency-key': 'daily-delete' });
    await t.settle();
    expect((await t.call('GET', '/api/v1/me')).body.usage.browsers).toBe(1);

    const replacement = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'daily-third' });
    expect(replacement.status).toBe(202);
  });

  it('joins a queued wake when the browser is opened again before the engine starts it', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1', storageGb: 10, priceVersion: await quote('tyo1') }, { 'idempotency-key': 'c1' });
    await t.settle();
    const id = created.body.instanceId;
    const starts = () => (t.d1.sqlite.prepare("SELECT count(*) AS n FROM operations WHERE instance_id = ? AND kind = 'start'").get(id) as { n: number }).n;
    // Hold queue deliveries: until the engine picks a wake up, the browser still reads sleeping.
    const queue = t.env.OPERATIONS as { send: (b: { operationId: string }) => Promise<void> };
    const deliver = queue.send;
    const held: { operationId: string }[] = [];
    const sleep = async (key: string) => {
      await t.call('POST', `/api/v1/instances/${id}/stop`, undefined, { 'idempotency-key': key });
      await t.settle();
      expect((await t.call('GET', `/api/v1/instances/${id}`)).body.status).toBe('sleeping');
      queue.send = async (b) => void held.push(b);
    };
    const wake = async () => {
      queue.send = deliver;
      for (const b of held.splice(0)) await deliver(b);
      await t.settle();
      expect((await t.call('GET', `/api/v1/instances/${id}`)).body.status).toBe('running');
    };

    await sleep('s1');
    const first = await t.call('POST', `/api/v1/instances/${id}/sessions`, undefined, { 'idempotency-key': 'open-1' });
    expect(first.status).toBe(201);
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body).toMatchObject({ status: 'sleeping', currentOperation: { id: first.body.operationId, kind: 'start' } });
    // A second click or another tab in that gap joins the same wake instead of answering 409.
    const second = await t.call('POST', `/api/v1/instances/${id}/sessions`, undefined, { 'idempotency-key': 'open-2' });
    expect(second).toMatchObject({ status: 201, body: { operationId: first.body.operationId } });
    await wake();
    expect(starts()).toBe(1);

    // Two opens at the same moment share one wake too.
    await sleep('s2');
    const both = await Promise.all(['open-3', 'open-4'].map((k) => t.call('POST', `/api/v1/instances/${id}/sessions`, undefined, { 'idempotency-key': k })));
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(both[0]!.body.operationId).toBe(both[1]!.body.operationId);
    await wake();
    expect(starts()).toBe(2);
  });

  it('opens, sleeps, wakes, changes IP and permanently deletes a browser', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1', storageGb: 10, priceVersion: await quote('tyo1') }, { 'idempotency-key': 'c1' });
    await t.settle();
    const id = created.body.instanceId;

    const open = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    expect(open.status).toBe(201);
    const sid = open.body.session.id;
    expect((await t.call('GET', `/api/v1/sessions/${sid}/connect`)).body).toEqual({ mode: 'simulated' });
    const hb = await t.call('POST', `/api/v1/sessions/${sid}/heartbeat`, { input: true });
    expect(new Date(hb.body.sleepAt).getTime()).toBeGreaterThan(Date.now());

    // A second tab takes over; the first sees "open elsewhere".
    const other = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    expect((await t.call('POST', `/api/v1/sessions/${sid}/heartbeat`, { input: false })).status).toBe(409);
    expect(other.status).toBe(201);

    expect((await t.call('POST', `/api/v1/instances/${id}/stop`, undefined, { 'idempotency-key': 's1' })).status).toBe(202);
    await t.settle();
    let inst = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(inst.status).toBe('sleeping');
    const ip = inst.ipAddress;

    const wake = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    expect(wake.body.operationId).toBeTruthy();
    await t.settle();
    inst = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(inst.status).toBe('running');
    expect(inst.ipAddress).toBe(ip);

    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { regionId: 'usw1' })).status).toBe(400);
    t.d1.sqlite.exec(`UPDATE caps SET "limit" = 1800 WHERE scope = 'user:default' AND metric = 'idle_timeout_max_s'`);
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { idleTimeoutS: 3600 })).body.type).toBe('plan_limit');
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { name: 'Renamed', idleTimeoutS: 900 })).body.name).toBe('Renamed');
    // The browser language, picture setting and new-IP requests were removed: the fields are
    // refused, the route is gone. The live view picks its picture from the connection; pages
    // loaded before the picture setting went still read full and adapting.
    expect(inst).not.toHaveProperty('locale');
    expect(inst).toMatchObject({ videoQuality: 'full', videoAuto: true });
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { locale: 'zh-CN' })).status).toBe(400);
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { videoQuality: 'medium' })).status).toBe(400);
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { videoAuto: false })).status).toBe(400);
    const ipBefore = inst.ipAddress;
    expect(await t.call('POST', `/api/v1/instances/${id}/ip-change-requests`, { confirm: true, priceVersion: await quote() }, { 'idempotency-key': 'ip1' })).toMatchObject({ status: 410, body: { type: 'not_found' } });
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM operations WHERE kind = 'change_ip'").get()).toEqual({ n: 0 });
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM caps WHERE metric = 'ip_changes_per_month'").get()).toEqual({ n: 0 });
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body.ipAddress).toBe(ipBefore);

    expect((await t.call('DELETE', `/api/v1/instances/${id}`, undefined, { 'idempotency-key': 'd1' })).status).toBe(202);
    await t.settle();
    inst = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(inst.status).toBe('deleting');
    expect(inst.purgeAfter).toBeTruthy();

    expect((await t.call('POST', `/api/v1/instances/${id}/undelete`, undefined, { 'idempotency-key': 'u1' })).status).toBe(409);
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body.status).toBe('deleting');
  });

  it('removes public snapshots, rejects old clients and never runs legacy daily snapshots', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1', storageGb: 10, priceVersion: await quote('tyo1'), backupsEnabled: true }, { 'idempotency-key': 'b1' });
    expect(created.status).toBe(202);
    await t.settle();
    const id = created.body.instanceId;
    const path = `/api/v1/instances/${id}`;
    expect(t.d1.sqlite.prepare('SELECT backups_enabled AS enabled FROM browser_instances WHERE id = ?').get(id)).toEqual({ enabled: 0 });
    expect((await t.call('GET', path)).body).not.toHaveProperty('backupsEnabled');
    expect((await t.call('GET', `${path}/storage`)).body).not.toHaveProperty('snapshots');
    for (const enabled of [true, false]) {
      expect(await t.call('PATCH', path, { backupsEnabled: enabled, priceVersion: await quote() })).toMatchObject({ status: 400, body: { type: 'validation_failed' } });
    }
    expect((await t.call('GET', `${path}/backups`)).status).toBe(410);
    expect((await t.call('POST', `${path}/backups/old-snapshot/restore`, undefined, { 'idempotency-key': 'removed-restore' })).status).toBe(410);
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM operations WHERE kind = 'restore'").get()).toEqual({ n: 0 });

    // Old database rows cannot opt the machine back into snapshots, including pilot mode.
    t.d1.sqlite.prepare('UPDATE browser_instances SET backups_enabled = 1 WHERE id = ?').run(id);
    await engine.scheduled!({ scheduledTime: Date.UTC(2026, 9, 18, 3, 7), cron: '* * * * *', noRetry() {} } as never, t.engineEnv as never, t.ctx);
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM backups WHERE kind = 'snapshot'").get()).toEqual({ n: 0 });
    expect((await t.call('PATCH', path, { name: 'Renamed' })).status).toBe(200);
    expect(t.d1.sqlite.prepare('SELECT backups_enabled AS enabled FROM browser_instances WHERE id = ?').get(id)).toEqual({ enabled: 0 });

    const doc = (await t.call('GET', '/api/v1/openapi.json')).body;
    expect(Object.keys(doc.paths).some((p) => p.includes('/backups'))).toBe(false);
  });

  it('requires a current quote for creating and adding storage', async () => {
    const create = { name: 'Quoted', regionId: 'tyo1', storageGb: 10 };
    expect((await t.call('POST', '/api/v1/instances', create, { 'idempotency-key': 'no-quote' })).status).toBe(400);
    const created = await t.call('POST', '/api/v1/instances', { ...create, priceVersion: await quote() }, { 'idempotency-key': 'quoted' });
    await t.settle();
    const path = `/api/v1/instances/${created.body.instanceId}`;
    expect((await t.call('PATCH', path, { backupsEnabled: true })).status).toBe(400);
    expect((await t.call('POST', `${path}/storage`, { sizeGb: 11 }, { 'idempotency-key': 'resize-no-quote' })).status).toBe(400);
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM operations WHERE kind = 'resize_volume'").get()).toEqual({ n: 0 });
    expect((await t.call('GET', path)).body).not.toHaveProperty('backupsEnabled');
  });

  it('requires confirmation again when the default storage size changes after the quote', async () => {
    const priceVersion = await quote();
    t.d1.sqlite.exec("UPDATE caps SET `limit` = 20 WHERE scope = 'user:default' AND metric = 'storage_gb'");
    const stale = await t.call('POST', '/api/v1/instances', { name: 'Quoted', regionId: 'tyo1', storageGb: 10, priceVersion }, { 'idempotency-key': 'old-storage' });
    expect(stale).toMatchObject({ status: 409, body: { type: 'price_changed' } });
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM browser_instances').get()).toEqual({ n: 0 });
    const refreshed = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
    // Admission and execution are separate: a later operator change must not change this order.
    const dispatch = t.env.OPERATIONS.send;
    t.env.OPERATIONS.send = async () => {};
    const accepted = await t.call('POST', '/api/v1/instances', { name: 'Reviewed', regionId: 'tyo1', storageGb: refreshed.defaultStorageGb, priceVersion: refreshed.version }, { 'idempotency-key': 'new-storage' });
    expect(accepted.status).toBe(202);
    await t.settle();
    t.d1.sqlite.exec("UPDATE caps SET `limit` = 30 WHERE scope = 'user:default' AND metric = 'storage_gb'");
    await dispatch({ operationId: accepted.body.operationId });
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${accepted.body.instanceId}`)).body.storageGb).toBe(20);
    const op = t.d1.sqlite.prepare('SELECT params FROM operations WHERE id = ?').get(accepted.body.operationId) as { params: string };
    expect(JSON.parse(op.params).storageGb).toBe(20);
  });

  it('blocks frozen accounts from claiming a free trial, including after billing is disabled', async () => {
    const userId = (await t.call('GET', '/api/v1/me')).body.user.id;
    t.d1.sqlite.prepare('INSERT INTO billing_accounts (user_id, frozen_at, updated_at) VALUES (?, ?, ?)').run(userId, Date.now(), Date.now());
    t.d1.sqlite.exec(`INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = 'true'`);
    t.d1.sqlite.exec("UPDATE regions SET enabled = 1, executor = 'fake' WHERE id = 'syd1'");
    t.d1.sqlite.exec("UPDATE provider_prices SET executor = 'fake' WHERE region_id = 'syd1'");
    const create = { name: 'Trial', regionId: 'syd1', storageGb: 2, trial: true, priceVersion: await quote('syd1') };
    expect((await t.call('GET', '/api/v1/billing')).body.trial.eligible).toBe(false);
    expect((await t.call('POST', '/api/v1/instances', create, { 'idempotency-key': 'frozen-trial' })).body.type).toBe('account_frozen');
    t.d1.sqlite.exec("UPDATE control_flags SET value = 'false' WHERE key = 'billing_required'");
    expect((await t.call('POST', '/api/v1/instances', create, { 'idempotency-key': 'frozen-pilot' })).body.type).toBe('account_frozen');
    expect(t.d1.sqlite.prepare('SELECT trial_used_at AS used FROM billing_accounts WHERE user_id = ?').get(userId)).toEqual({ used: null });
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM browser_instances').get()).toEqual({ n: 0 });
  });

  it('blocks frozen accounts from waking an active trial through either start endpoint', async () => {
    t.d1.sqlite.exec(`INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = 'true'`);
    t.d1.sqlite.exec("UPDATE regions SET enabled = 1, executor = 'fake' WHERE id = 'syd1'");
    t.d1.sqlite.exec("UPDATE provider_prices SET executor = 'fake' WHERE region_id = 'syd1'");
    const created = await t.call('POST', '/api/v1/instances', { name: 'Trial', regionId: 'syd1', storageGb: 2, trial: true, priceVersion: await quote('syd1') }, { 'idempotency-key': 'trial' });
    await t.settle();
    const path = `/api/v1/instances/${created.body.instanceId}`;
    await t.call('POST', `${path}/stop`, undefined, { 'idempotency-key': 'trial-stop' });
    await t.settle();
    t.d1.sqlite.exec(`UPDATE billing_accounts SET frozen_at = ${Date.now()}`);
    expect((await t.call('POST', `${path}/start`, undefined, { 'idempotency-key': 'frozen-start' })).body.type).toBe('account_frozen');
    expect((await t.call('POST', `${path}/sessions`)).body.type).toBe('account_frozen');
    expect((await t.call('GET', path)).body.status).toBe('sleeping');
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM operations WHERE kind = 'start'").get()).toEqual({ n: 0 });
  });

  it('keeps another user out of browser storage, usage, snapshots, operations and sessions', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Private', regionId: 'tyo1', storageGb: 10, priceVersion: await quote() }, { 'idempotency-key': 'private' });
    await t.settle();
    const path = `/api/v1/instances/${created.body.instanceId}`;
    const session = await t.call('POST', `${path}/sessions`);
    t.d1.sqlite.exec("INSERT INTO invites (email) VALUES ('other@example.com')");
    t.setCookie('');
    await signIn(t, 'other@example.com');
    for (const suffix of ['', '/storage', '/usage', '/backups', '/sessions']) expect((await t.call('GET', `${path}${suffix}`)).status).toBe(404);
    for (const [suffix, body] of [
      ['/storage', { sizeGb: 20, priceVersion: await quote() }],
      // Removed, but still answers 404 rather than 410 for someone else's browser.
      ['/ip-change-requests', { confirm: true, priceVersion: await quote() }],
      ['/sessions', undefined],
    ] as const) expect((await t.call('POST', `${path}${suffix}`, body, { 'idempotency-key': `other${suffix}` })).status).toBe(404);
    expect((await t.call('PATCH', path, { name: 'Other user' })).status).toBe(404);
    expect((await t.call('GET', `/api/v1/operations/${created.body.operationId}`)).status).toBe(404);
    expect((await t.call('GET', `/api/v1/sessions/${session.body.session.id}/connect`)).status).toBe(404);
  });

  it('serves the OpenAPI document', async () => {
    const doc = await t.call('GET', '/api/v1/openapi.json');
    expect(doc.status).toBe(200);
    expect(Object.keys(doc.body.paths)).toContain('/api/v1/instances/{id}/storage');
    expect(Object.keys(doc.body.paths)).not.toContain('/api/v1/instances/{id}/ip-change-requests');
  });
});

describe('gateway internal API and live view', () => {
  let keys: { privateJwk: JsonWebKey; publicJwk: JsonWebKey };
  beforeEach(async () => {
    await signIn(t, 'pilot@example.com');
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    keys = { privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
  });

  async function createRunning() {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1', storageGb: 10, priceVersion: await quote('tyo1') }, { 'idempotency-key': 'g1' });
    await t.settle();
    return created.body.instanceId as string;
  }

  it('swaps a bootstrap token once for a long-lived agent credential', async () => {
    const id = await createRunning();
    const row = t.d1.sqlite.prepare(`SELECT attrs FROM fake_provider_resources WHERE kind = 'vm'`).get() as { attrs: string };
    const { bootstrapToken } = JSON.parse(row.attrs).userData;
    const api = internalApi(t.env as never);

    const first = await api.authenticateAgent({ instanceId: id, bootstrap: bootstrapToken });
    expect(first.ok && first.credential).toBeTruthy();
    expect(await api.authenticateAgent({ instanceId: id, bootstrap: bootstrapToken })).toEqual({ ok: false, reason: 'invalid_token' });
    expect(await api.authenticateAgent({ instanceId: id, credential: first.ok ? first.credential : '' })).toEqual({ ok: true, generation: 1 });
    expect((await api.authenticateAgent({ instanceId: id, credential: 'nope' })).ok).toBe(false);
  });

  it('records agent readiness, heartbeats and command replies', async () => {
    const id = await createRunning();
    const api = internalApi(t.env as never);
    await api.agentMessage(id, 1, { t: 'event', kind: 'ready', data: { chromeMajor: 141 } });
    await api.agentMessage(id, 1, { t: 'event', kind: 'heartbeat', data: { viewers: 1, lastInputAt: new Date().toISOString() } });
    const h = t.d1.sqlite.prepare('SELECT * FROM instance_health WHERE instance_id = ?').get(id) as Record<string, unknown>;
    expect(h.agent_ready_generation).toBe(1);
    expect(h.chrome_major).toBe(141);
    expect(h.viewers).toBe(1);

    t.d1.sqlite
      .prepare(`INSERT INTO agent_commands (id, instance_id, kind, payload, status, created_at) VALUES ('c1', ?, 'ip_check', '{}', 'delivered', 0)`)
      .run(id);
    await api.agentMessage(id, 1, { t: 'reply', commandId: 'c1', ok: true, result: { observed: ['203.0.113.5'] } });
    const c = t.d1.sqlite.prepare(`SELECT status, reply FROM agent_commands WHERE id = 'c1'`).get() as { status: string; reply: string };
    expect(c.status).toBe('succeeded');
    expect(JSON.parse(c.reply).observed).toEqual(['203.0.113.5']);
    await expect(api.agentMessage(id, 1, { t: 'bogus' })).rejects.toThrow();

    // An IP check passes only if Chrome sees exactly the browser's static IP, whatever the agent thinks.
    const ip = (t.d1.sqlite.prepare(`SELECT ip_address AS ip FROM placements WHERE instance_id = ?`).get(id) as { ip: string }).ip;
    const lastCheck = () => JSON.parse((t.d1.sqlite.prepare('SELECT last_ip_check AS c FROM instance_health WHERE instance_id = ?').get(id) as { c: string }).c);
    await api.agentMessage(id, 1, { t: 'event', kind: 'ip_check', data: { ok: true, observed: [ip], expected: '' } });
    expect(lastCheck()).toMatchObject({ ok: true, expected: ip });
    await api.agentMessage(id, 1, { t: 'event', kind: 'ip_check', data: { ok: true, observed: ['192.0.2.77'], expected: '' } });
    expect(lastCheck()).toMatchObject({ ok: false, expected: ip, observed: ['192.0.2.77'] });
  });

  it('hands the gateway the plain archive key only while it exists', async () => {
    const id = await createRunning();
    const master = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const api = internalApi({ ...t.env, ARCHIVE_MASTER_KEY: master } as never);
    expect(await api.archiveKey(id)).toBeNull();
    const { key, wrapped } = await newArchiveKey(master);
    t.d1.sqlite.prepare('INSERT INTO archive_keys (instance_id, wrapped_key, created_at) VALUES (?, ?, 0)').run(id, wrapped);
    expect(await api.archiveKey(id)).toBe(key);
    expect(await internalApi(t.env as never).archiveKey(id)).toBeNull(); // no master key configured
    t.d1.sqlite.prepare('UPDATE archive_keys SET wrapped_key = NULL, destroyed_at = 1 WHERE instance_id = ?').run(id);
    expect(await api.archiveKey(id)).toBeNull();
  });

  it('issues a 60 s viewer token that the gateway can verify and redeem once', async () => {
    Object.assign(t.env, { LIVE_VIEW: 'on', GATEWAY_URL: 'wss://connect.test', VIEWER_TOKEN_PRIVATE_KEY: JSON.stringify(keys.privateJwk) });
    const id = await createRunning();
    const open = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    const info = (await t.call('GET', `/api/v1/sessions/${open.body.session.id}/connect`)).body;
    expect(info.mode).toBe('webrtc');
    expect(info.gatewayUrl).toBe(`wss://connect.test/v1/stream/${id}`);

    const claims = await verifyViewerToken(keys.publicJwk, info.token);
    expect(claims?.iid).toBe(id);
    expect(await verifyViewerToken(keys.publicJwk, info.token, Date.now() + 61_000)).toBeNull();
    // Change actual signature bits; the last base64url character also has unused padding bits.
    const signatureStart = info.token.indexOf('.') + 1;
    const tampered = info.token.slice(0, signatureStart)
      + (info.token[signatureStart] === 'A' ? 'B' : 'A') + info.token.slice(signatureStart + 1);
    expect(await verifyViewerToken(keys.publicJwk, tampered)).toBeNull();

    const api = internalApi(t.env as never);
    expect(await api.redeemViewerToken(claims!)).toBe(true);
    expect(await api.redeemViewerToken(claims!)).toBe(false);
  });

  it('returns TURN credentials fetched alongside the checks, and never redeems a token of an ended session', async () => {
    Object.assign(t.env, { LIVE_VIEW: 'on', GATEWAY_URL: 'wss://connect.test', VIEWER_TOKEN_PRIVATE_KEY: JSON.stringify(keys.privateJwk), TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 'secret' });
    const turn = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ iceServers: [
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'], username: 'u', credential: 'c' },
    ] }));
    const id = await createRunning();
    const open = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    const info = (await t.call('GET', `/api/v1/sessions/${open.body.session.id}/connect`)).body;
    expect(info.iceServers).toEqual([{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }]);
    expect(turn).toHaveBeenCalledTimes(1);

    // A TURN outage is reported, not hidden behind a token without relay servers.
    turn.mockImplementationOnce(async () => new Response('down', { status: 503 }));
    expect((await t.call('GET', `/api/v1/sessions/${open.body.session.id}/connect`)).status).toBeGreaterThanOrEqual(500);

    const claims = await verifyViewerToken(keys.publicJwk, info.token);
    t.d1.sqlite.prepare('UPDATE viewer_sessions SET ended_at = ? WHERE id = ?').run(Date.now(), open.body.session.id);
    expect(await internalApi(t.env as never).redeemViewerToken(claims!)).toBe(false);
    turn.mockRestore();
  });
});

