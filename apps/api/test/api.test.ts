import { verifyViewerToken } from '@cloudbrowser/contracts';
import { newArchiveKey } from '@cloudbrowser/db';
import { beforeEach, describe, expect, it } from 'vitest';
import engine from '@cloudbrowser/engine';
import app from '../src/index.js';
import { internalApi } from '../src/internal.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
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
    expect(me.body.entitlements.maxBrowsers).toBe(2);
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

  it('never sends a code to an address that was not invited', async () => {
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
    const res = await t.call('POST', '/api/v1/instances', { name: 'x', regionId: 'tyo1' }, { origin: 'https://evil.test', 'idempotency-key': 'k' });
    expect(res.status).toBe(403);
  });

  it('keeps Sydney unavailable until configured and uses its own region and timezone', async () => {
    const regions = await t.call('GET', '/api/v1/regions');
    expect(regions.body.find((r: { id: string }) => r.id === 'syd1')).toMatchObject({
      country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney', acceptingNew: false,
    });
    const body = { name: 'Sydney', regionId: 'syd1' };
    const blocked = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'syd-blocked' });
    expect(blocked.body.type).toBe('region_unavailable');
    t.d1.sqlite.exec("UPDATE regions SET enabled = 1, executor = 'fake' WHERE id = 'syd1'");
    const created = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'syd-ready' });
    expect(created.status).toBe(202);
    await t.settle();
    const list = await t.call('GET', '/api/v1/instances');
    expect(list.body[0]).toMatchObject({ regionId: 'syd1', status: 'running' });
    const row = t.d1.sqlite.prepare('SELECT fingerprint FROM browser_instances WHERE id = ?').get(created.body.instanceId) as { fingerprint: string };
    expect(JSON.parse(row.fingerprint).timezone).toBe('Australia/Sydney');
  });

  it('creates exactly one browser per Idempotency-Key and runs it', async () => {
    const body = { name: 'Work', regionId: 'tyo1' };
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
    expect(inst.ipAddress).toMatch(/^203\.0\.113\./);
    expect(inst.lastIpCheck.ok).toBe(true);

    const op = await t.call('GET', `/api/v1/operations/${a.body.operationId}`);
    expect(op.body.status).toBe('succeeded');
  });

  it('enforces the plan limits', async () => {
    for (const k of ['a', 'b']) await t.call('POST', '/api/v1/instances', { name: k, regionId: 'usw1' }, { 'idempotency-key': k });
    await t.settle();
    const third = await t.call('POST', '/api/v1/instances', { name: 'c', regionId: 'usw1' }, { 'idempotency-key': 'c' });
    expect(third.status).toBe(403);
    expect(third.body.type).toBe('plan_limit');
  });

  it('opens, sleeps, wakes, changes IP, deletes and restores a browser', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1' }, { 'idempotency-key': 'c1' });
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
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { idleTimeoutS: 3600 })).body.type).toBe('plan_limit');
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { name: 'Renamed', idleTimeoutS: 900 })).body.name).toBe('Renamed');

    expect((await t.call('POST', `/api/v1/instances/${id}/ip-change-requests`, {}, { 'idempotency-key': 'ip0' })).status).toBe(400);
    expect((await t.call('POST', `/api/v1/instances/${id}/ip-change-requests`, { confirm: true }, { 'idempotency-key': 'ip1' })).status).toBe(202);
    await t.settle();
    const limited = await t.call('POST', `/api/v1/instances/${id}/ip-change-requests`, { confirm: true }, { 'idempotency-key': 'ip2' });
    expect(limited.body.type).toBe('ip_change_limit');

    expect((await t.call('DELETE', `/api/v1/instances/${id}`, undefined, { 'idempotency-key': 'd1' })).status).toBe(202);
    await t.settle();
    inst = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(inst.status).toBe('deleting');
    expect(inst.purgeAfter).toBeTruthy();

    expect((await t.call('POST', `/api/v1/instances/${id}/undelete`, undefined, { 'idempotency-key': 'u1' })).status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body.status).toBe('sleeping');
  });

  it('lists backups and restores a snapshot only while the browser sleeps', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1' }, { 'idempotency-key': 'b1' });
    await t.settle();
    const id = created.body.instanceId;
    expect((await t.call('GET', `/api/v1/instances/${id}/backups`)).body).toEqual([]);

    // The engine's daily snapshot runs at minute 7 of its 1-minute cron.
    await engine.scheduled!({ scheduledTime: Date.UTC(2026, 9, 1, 3, 7), cron: '* * * * *', noRetry() {} } as never, t.engineEnv as never, t.ctx);
    const list = (await t.call('GET', `/api/v1/instances/${id}/backups`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'snapshot', reason: 'daily', status: 'complete', restorableWhen: 'sleeping' });

    const path = `/api/v1/instances/${id}/backups/${list[0].id}/restore`;
    expect((await t.call('POST', path, undefined, { 'idempotency-key': 'r0' })).body.type).toBe('invalid_state');
    expect((await t.call('POST', `/api/v1/instances/${id}/backups/nope/restore`, undefined, { 'idempotency-key': 'r1' })).status).toBe(404);

    await t.call('POST', `/api/v1/instances/${id}/stop`, undefined, { 'idempotency-key': 's1' });
    await t.settle();
    const restored = await t.call('POST', path, undefined, { 'idempotency-key': 'r2' });
    expect(restored.status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/operations/${restored.body.operationId}`)).body.status).toBe('succeeded');
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body.status).toBe('sleeping');
  });

  it('serves the OpenAPI document', async () => {
    const doc = await t.call('GET', '/api/v1/openapi.json');
    expect(doc.status).toBe(200);
    expect(Object.keys(doc.body.paths)).toContain('/api/v1/instances/{id}/ip-change-requests');
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
    const created = await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1' }, { 'idempotency-key': 'g1' });
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
    const tampered = info.token.slice(0, -2) + (info.token.endsWith('A') ? 'BB' : 'AA');
    expect(await verifyViewerToken(keys.publicJwk, tampered)).toBeNull();

    const api = internalApi(t.env as never);
    expect(await api.redeemViewerToken(claims!)).toBe(true);
    expect(await api.redeemViewerToken(claims!)).toBe(false);
  });
});

