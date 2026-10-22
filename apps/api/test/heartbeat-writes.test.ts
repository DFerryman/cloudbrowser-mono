import { createDb } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentMessage } from '../src/internal.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let instanceId: string;
const writes = () => Number((t.d1.sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n);

beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec("INSERT INTO invites(email) VALUES('heartbeat@example.com')");
  await signIn(t, 'heartbeat@example.com');
  const prices = await t.call('GET', '/api/v1/pricing');
  const priceVersion = prices.body.find((p: { regionId: string }) => p.regionId === 'tyo1').version;
  const created = await t.call('POST', '/api/v1/instances', { name: 'Heartbeat', regionId: 'tyo1', storageGb: 10, priceVersion }, { 'idempotency-key': 'heartbeat' });
  expect(created.status).toBe(202);
  await t.settle();
  instanceId = created.body.instanceId;
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Never sleep is confirmed against its quoted price (free pilot here, so no credit is needed). */
async function setIdle(idleTimeoutS: number) {
  const priceVersion = idleTimeoutS === 0 ? (await t.call('GET', `/api/v1/instances/${instanceId}/never-sleep`)).body.priceVersion : undefined;
  expect((await t.call('PATCH', `/api/v1/instances/${instanceId}`, { idleTimeoutS, priceVersion })).status).toBe(200);
}

describe('heartbeat D1 write budget', () => {
  it.each([600, 0])('persists four agent heartbeats as one update with timeout %s, retaining the latest counters', async (idleTimeoutS) => {
    await setIdle(idleTimeoutS);
    const start = Date.now();
    t.d1.sqlite.prepare('UPDATE instance_health SET last_heartbeat_at=?,last_input_at=? WHERE instance_id=?').run(start, start, instanceId);
    const before = writes();
    for (const seconds of [15, 30, 45, 60]) {
      await agentMessage(t.env as never, createDb(t.d1), instanceId, 1,
        { t: 'event', kind: 'heartbeat', data: { viewers: 0, netTxBytes: seconds * 100, lastInputAt: new Date(start + seconds * 1000).toISOString() } }, new Date(start + seconds * 1000));
    }
    expect(writes() - before).toBe(1);
    expect(t.d1.sqlite.prepare('SELECT net_tx_bytes FROM instance_health WHERE instance_id=?').get(instanceId)).toEqual({ net_tx_bytes: 6000 });
  });

  it('persists each batched viewer input report when inactivity sleep is disabled', async () => {
    await setIdle(0);
    const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
    expect(opened.status).toBe(201);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    const before = writes();
    for (const seconds of [15, 30, 45, 60]) {
      vi.setSystemTime(start + seconds * 1000);
      expect(await t.call('POST', `/api/v1/sessions/${opened.body.session.id}/heartbeat`, { input: true }))
        .toMatchObject({ status: 200, body: { sleepAt: null } });
    }
    expect(writes() - before).toBe(5); // One session renewal and four input timestamps.
  });

  it('does not write idle viewer heartbeats until the session renewal is due', async () => {
    const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
    expect(opened.status).toBe(201);
    const sessionId = opened.body.session.id;
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    const before = writes();
    for (const seconds of [15, 30, 45, 60]) {
      vi.setSystemTime(start + seconds * 1000);
      expect((await t.call('POST', `/api/v1/sessions/${sessionId}/heartbeat`, { input: false })).status).toBe(200);
    }
    expect(writes() - before).toBe(1);
  });
});

describe('durable idle activity', () => {
  const activityAt = () => (t.d1.sqlite.prepare('SELECT last_input_at FROM instance_health WHERE instance_id=?').get(instanceId) as { last_input_at: number }).last_input_at;

  it('retains a final input inside a minute and returns the same deadline on later idle heartbeats', async () => {
    const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
    expect(opened.status).toBe(201);
    const start = activityAt();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 15_000);
    const endpoint = `/api/v1/sessions/${opened.body.session.id}/heartbeat`;
    const expected = new Date(start + 15_000 + 600_000).toISOString();
    expect(await t.call('POST', endpoint, { input: true }))
      .toMatchObject({ status: 200, body: { sleepAt: expected, reason: 'idle' } });
    expect(activityAt()).toBe(start + 15_000);
    for (const seconds of [30, 45, 60]) {
      vi.setSystemTime(start + seconds * 1000);
      expect(await t.call('POST', endpoint, { input: false }))
        .toMatchObject({ status: 200, body: { sleepAt: expected, reason: 'idle' } });
    }
    expect(activityAt()).toBe(start + 15_000);
  });

  it('does not let a delayed agent health snapshot erase a newer session open', async () => {
    const start = Date.now();
    t.d1.sqlite.prepare('UPDATE instance_health SET last_heartbeat_at=?,last_input_at=? WHERE instance_id=?').run(start, start, instanceId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 60_000);
    const prepare = t.d1.prepare.bind(t.d1);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    vi.spyOn(t.d1, 'prepare').mockImplementation((query) => {
      const statement = prepare(query);
      if (!paused && /^insert into "?instance_health"?/i.test(query)) {
        paused = true;
        const bind = statement.bind.bind(statement);
        statement.bind = (...values: unknown[]) => {
          const bound = bind(...values);
          const raw = bound.raw.bind(bound);
          bound.raw = (async () => { entered(); await blocked; return raw(); }) as typeof bound.raw;
          return bound;
        };
      }
      return statement;
    });
    const heartbeat = agentMessage(t.env as never, createDb(t.d1), instanceId, 1,
      { t: 'event', kind: 'heartbeat', data: { viewers: 0, lastInputAt: new Date(start + 10_000).toISOString() } }, new Date(start + 60_000));
    await waiting; // The agent has read the old health row and has not written its snapshot yet.
    vi.setSystemTime(start + 65_000);
    const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
    expect(opened.status).toBe(201);
    expect(activityAt()).toBe(start + 65_000);
    release();
    await heartbeat;
    expect(activityAt()).toBe(start + 65_000);
  });

  it('returns the durable deadline when an input heartbeat races newer activity', async () => {
    const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
    const start = activityAt();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 15_000);
    const prepare = t.d1.prepare.bind(t.d1);
    let advanced = false;
    vi.spyOn(t.d1, 'prepare').mockImplementation((query) => {
      if (!advanced && /^insert into "?instance_health"?/i.test(query)) {
        advanced = true;
        // Another request commits after this heartbeat read health and captured its clock.
        vi.setSystemTime(start + 20_000);
        t.d1.sqlite.prepare('UPDATE instance_health SET last_input_at=? WHERE instance_id=?').run(start + 20_000, instanceId);
      }
      return prepare(query);
    });
    expect(await t.call('POST', `/api/v1/sessions/${opened.body.session.id}/heartbeat`, { input: true }))
      .toMatchObject({ status: 200, body: { sleepAt: new Date(start + 20_000 + 600_000).toISOString(), reason: 'idle' } });
    expect(advanced).toBe(true);
    expect(activityAt()).toBe(start + 20_000);
  });

  it.each([false, true])('rejects input delayed past session takeover even with missing health=%s', async (removeHealth) => {
    const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
    const start = activityAt();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 15_000);
    const batch = t.d1.batch.bind(t.d1);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    vi.spyOn(t.d1, 'batch').mockImplementation(async (statements: D1PreparedStatement[]) => {
      if (!paused && statements.some((statement) => (statement as unknown as { sql: string }).sql.includes('presence_seq < ?'))) {
        paused = true;
        entered();
        await blocked;
      }
      return batch(statements);
    });
    const delayed = t.call('POST', `/api/v1/sessions/${opened.body.session.id}/heartbeat`, { input: true });
    await waiting;
    vi.setSystemTime(start + 20_000);
    expect((await t.call('POST', `/api/v1/instances/${instanceId}/sessions`)).status).toBe(201);
    if (removeHealth) t.d1.sqlite.prepare('DELETE FROM instance_health WHERE instance_id=?').run(instanceId);
    release();
    expect((await delayed).status).toBe(409);
    if (removeHealth) expect(t.d1.sqlite.prepare('SELECT instance_id FROM instance_health WHERE instance_id=?').get(instanceId)).toBeUndefined();
    else expect(activityAt()).toBe(start + 20_000);
  });

  it.each(['open', 'setting'] as const)('does not let a delayed %s overwrite newer viewer input', async (action) => {
    const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
    const start = activityAt();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 1000);
    const batch = t.d1.batch.bind(t.d1);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    vi.spyOn(t.d1, 'batch').mockImplementation(async (statements: D1PreparedStatement[]) => {
      if (!paused && statements.some((s) => /^insert into "?instance_health"?/i.test((s as unknown as { sql: string }).sql))) {
        paused = true;
        entered();
        await blocked;
      }
      return batch(statements);
    });
    const delayed = action === 'open'
      ? t.call('POST', `/api/v1/instances/${instanceId}/sessions`)
      : t.call('PATCH', `/api/v1/instances/${instanceId}`, { idleTimeoutS: 900 });
    await waiting;
    vi.setSystemTime(start + 30_000);
    expect((await t.call('POST', `/api/v1/sessions/${opened.body.session.id}/heartbeat`, { input: true })).status).toBe(200);
    expect(activityAt()).toBe(start + 30_000);
    release();
    expect((await delayed).status).toBe(action === 'open' ? 201 : 200);
    expect(activityAt()).toBe(start + 30_000);
  });
});
