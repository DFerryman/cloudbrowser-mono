import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let instanceId: string;
let ownerCookie: string;
let ownerId: string;
const open = (key?: string) => t.call('POST', `/api/v1/instances/${instanceId}/sessions`, undefined,
  key === undefined ? {} : { 'idempotency-key': key });
const sessions = () => t.d1.sqlite.prepare('SELECT id, user_id, ended_at FROM viewer_sessions WHERE instance_id = ? ORDER BY rowid').all(instanceId) as { id: string; user_id: string; ended_at: number | null }[];

beforeEach(async () => {
  t = setup();
  // D1 serializes transactions. The sqlite stand-in yields between statements, so model
  // that scheduling here as well when this suite deliberately sends parallel requests.
  const batch = t.d1.batch.bind(t.d1);
  let tail: Promise<unknown> = Promise.resolve();
  t.d1.batch = ((statements: D1PreparedStatement[]) => {
    const result = tail.then(() => batch(statements));
    tail = result.catch(() => {});
    return result;
  }) as D1Database['batch'];
  t.d1.sqlite.exec("INSERT INTO invites (email) VALUES ('session-owner@example.com'), ('session-other@example.com')");
  await signIn(t, 'session-owner@example.com');
  ownerCookie = t.cookie();
  ownerId = (await t.call('GET', '/api/v1/me')).body.user.id;
  const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
  const created = await t.call('POST', '/api/v1/instances', { name: 'Session browser', regionId: 'tyo1', storageGb: 10, priceVersion: price.version }, { 'idempotency-key': 'session-browser' });
  expect(created.status).toBe(202);
  await t.settle();
  instanceId = created.body.instanceId;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.settle();
  t.d1.sqlite.close();
});

function delayFirstOpenBatch() {
  const batch = t.d1.batch.bind(t.d1);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let delayed = false;
  vi.spyOn(t.d1, 'batch').mockImplementation(async (statements: D1PreparedStatement[]) => {
    if (!delayed && statements.some((s) => /insert into "viewer_sessions"/i.test((s as unknown as { sql: string }).sql))) {
      delayed = true;
      entered();
      await blocked;
    }
    return batch(statements);
  });
  return { waiting, release };
}

describe('viewer session open idempotency', () => {
  it('coalesces parallel requests with the same key into one active controller', async () => {
    const [a, b] = await Promise.all([open('parallel-open'), open('parallel-open')]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.session).toEqual(b.body.session);
    expect(a.body.session.id).toMatch(/^[a-f0-9]{64}$/);
    expect(sessions()).toEqual([{ id: a.body.session.id, user_id: ownerId, ended_at: null }]);
  });

  it('does not end the retry session when the original timed-out POST finally reaches its transaction', async () => {
    const delay = delayFirstOpenBatch();
    const oldPost = open('timed-out-open');
    await delay.waiting;
    const retry = await open('timed-out-open');
    expect(retry.status).toBe(201);
    delay.release();
    const original = await oldPost;
    expect(original.status).toBe(201);
    expect(original.body.session).toEqual(retry.body.session);
    expect(sessions()).toHaveLength(1);
    expect(sessions()[0]?.ended_at).toBeNull();
  });

  it('keeps a genuinely newer controller when the delayed old POST arrives after another takeover', async () => {
    const delay = delayFirstOpenBatch();
    const oldPost = open('old-intent');
    await delay.waiting;
    const retry = await open('old-intent');
    const current = await open('new-intent');
    expect(retry.status).toBe(201);
    expect(current.status).toBe(201);
    delay.release();
    expect((await oldPost).status).toBe(409);
    expect(sessions().filter((s) => s.ended_at === null).map((s) => s.id)).toEqual([current.body.session.id]);
  });

  it('allows a new key to take over but never resurrects an ended key', async () => {
    const previous = await open('first-intent');
    const current = await open('use-here-intent');
    expect(current.status).toBe(201);
    expect(current.body.session.id).not.toBe(previous.body.session.id);
    expect((await open('first-intent')).status).toBe(409);
    const rows = sessions();
    expect(rows.find((s) => s.id === previous.body.session.id)?.ended_at).not.toBeNull();
    expect(rows.filter((s) => s.ended_at === null).map((s) => s.id)).toEqual([current.body.session.id]);
  });

  it('does not replay another user’s session or expose it through the same key', async () => {
    const owner = await open('shared-key');
    await signIn(t, 'session-other@example.com');
    expect((await open('shared-key')).status).toBe(404);
    const otherId = (await t.call('GET', '/api/v1/me')).body.user.id;
    const originalId = instanceId;
    t.d1.sqlite.prepare(`INSERT INTO browser_instances (id,user_id,name,region_id,status,desired_state,idle_timeout_s,locale,screen,fingerprint,created_at,updated_at)
      VALUES ('other-browser',?,'Other','tyo1','running','running',900,'en-US','auto','{}',?,?)`).run(otherId, Date.now(), Date.now());
    instanceId = 'other-browser';
    const other = await open('shared-key');
    expect(other.status).toBe(201);
    expect(other.body.session.id).not.toBe(owner.body.session.id);
    instanceId = originalId;
    t.setCookie(ownerCookie);
    expect((await open('shared-key')).body.session.id).toBe(owner.body.session.id);
    expect(sessions().filter((s) => s.ended_at === null).map((s) => s.id)).toEqual([owner.body.session.id]);
  });

  it('does not wake a sleeping browser when replaying an existing open', async () => {
    await open('old-open');
    t.d1.sqlite.prepare("UPDATE browser_instances SET status='sleeping',desired_state='stopped' WHERE id=?").run(instanceId);
    const before = t.d1.sqlite.prepare('SELECT count(*) AS n FROM operations').get();
    expect((await open('old-open')).status).toBe(409);
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM operations').get()).toEqual(before);
    expect(t.d1.sqlite.prepare('SELECT status,desired_state FROM browser_instances WHERE id=?').get(instanceId))
      .toEqual({ status: 'sleeping', desired_state: 'stopped' });
  });

  it('records opening activity even when the running browser has no health row yet', async () => {
    t.d1.sqlite.prepare('DELETE FROM instance_health WHERE instance_id=?').run(instanceId);
    t.d1.sqlite.prepare('UPDATE browser_instances SET last_active_at=0 WHERE id=?').run(instanceId);
    const started = Date.now();
    const opened = await open('missing-health');
    expect(opened.status).toBe(201);
    const health = t.d1.sqlite.prepare('SELECT last_input_at FROM instance_health WHERE instance_id=?').get(instanceId) as { last_input_at: number };
    expect(health.last_input_at).toBeGreaterThanOrEqual(started);
    const beat = await t.call('POST', `/api/v1/sessions/${opened.body.session.id}/heartbeat`, { input: false });
    expect(beat.status).toBe(200);
    expect(Date.parse(beat.body.sleepAt)).toBeGreaterThan(started + 60_000);
  });

  it('cannot create or replace a session after sleep wins the admission race', async () => {
    const current = await open('current-open');
    const delay = delayFirstOpenBatch();
    const stalePost = open('stale-open');
    await delay.waiting;
    t.d1.sqlite.prepare("UPDATE browser_instances SET status='stopping',desired_state='stopped' WHERE id=?").run(instanceId);
    delay.release();
    expect((await stalePost).status).toBe(409);
    expect(sessions()).toEqual([{ id: current.body.session.id, user_id: ownerId, ended_at: null }]);
  });

  it('preserves legacy opens without a key and validates a supplied key', async () => {
    const a = await open();
    const b = await open();
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.session.id).not.toBe(b.body.session.id);
    expect((await open(' '.repeat(3))).status).toBe(400);
    expect((await open('x'.repeat(201))).status).toBe(400);
  });
});
