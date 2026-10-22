import { createDb } from '@cloudbrowser/db';
import { idleStops } from '@cloudbrowser/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentMessage } from '../src/internal.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let instanceId: string;
let sessionId: string;
let start: number;
const activityAt = () => (t.d1.sqlite.prepare('SELECT last_input_at FROM instance_health WHERE instance_id=?').get(instanceId) as { last_input_at: number }).last_input_at;
const presence = () => t.d1.sqlite.prepare('SELECT presence_seq, viewing, presence_at, ended_at FROM viewer_sessions WHERE id=?').get(sessionId);
const heartbeat = (sequence: number, viewing: boolean | null, input = false) =>
  t.call('POST', `/api/v1/sessions/${sessionId}/heartbeat`, { input, presence: { sequence, viewing } });
const at = (ms: number) => vi.setSystemTime(start + ms);
const deadline = (ms: number) => new Date(start + ms + 600_000).toISOString();

beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec("INSERT INTO invites(email) VALUES('presence@example.com')");
  await signIn(t, 'presence@example.com');
  const priceVersion = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1').version;
  const created = await t.call('POST', '/api/v1/instances', { name: 'Presence', regionId: 'tyo1', storageGb: 10, priceVersion }, { 'idempotency-key': 'presence' });
  expect(created.status).toBe(202);
  await t.settle();
  instanceId = created.body.instanceId;
  const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
  expect(opened.status).toBe(201);
  sessionId = opened.body.session.id;
  start = activityAt();
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await t.settle(); t.d1.sqlite.close(); });

describe('ordered visible-view activity', () => {
  it('keeps an input-free visible view running beyond its timeout, then sleeps only after the hidden countdown', async () => {
    const deps = { db: createDb(t.d1), now: () => new Date(), notify: () => {} } as unknown as Parameters<typeof idleStops>[0];
    // Forty-two normal fifteen-second reports span longer than this browser's ten-minute timeout.
    for (let sequence = 0; sequence <= 41; sequence++) {
      at(sequence * 15_000);
      expect((await heartbeat(sequence, true)).status).toBe(200);
      expect(await idleStops(deps)).toEqual([]);
    }
    at(620_000);
    expect(await heartbeat(42, false)).toMatchObject({ status: 200, body: { sleepAt: deadline(620_000) } });
    at(900_000);
    await heartbeat(43, false);
    at(1_219_999);
    await heartbeat(44, false);
    expect(activityAt()).toBe(start + 620_000);
    expect(await idleStops(deps)).toEqual([]);
    at(1_220_000);
    expect(await idleStops(deps)).toEqual([instanceId]);
    expect(t.d1.sqlite.prepare("SELECT desired_state FROM browser_instances WHERE id=?").get(instanceId)).toEqual({ desired_state: 'stopped' });
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM operations WHERE instance_id=? AND kind='stop' AND finished_at IS NULL").get(instanceId)).toEqual({ n: 1 });
  });

  it('keeps a visible live view awake with finite heartbeat renewals without input', async () => {
    for (let sequence = 0; sequence < 5; sequence++) {
      const elapsed = sequence * 15_000;
      at(elapsed);
      expect(await heartbeat(sequence, true)).toMatchObject({ status: 200, body: { sleepAt: deadline(elapsed), reason: 'idle' } });
      expect(activityAt()).toBe(start + elapsed);
    }
    // Silence leaves an ordinary finite deadline, without an infinite viewer-presence hold.
    at(180_000);
    expect(activityAt()).toBe(start + 60_000);
  });

  it.each([false, null] as const)('starts the countdown once at visible -> %s and ignores delayed visible reports', async (hidden) => {
    at(1000);
    expect((await heartbeat(0, true)).status).toBe(200);
    at(2000);
    expect(await heartbeat(2, hidden)).toMatchObject({ status: 200, body: { sleepAt: deadline(2000) } });
    for (const [sequence, viewing, elapsed] of [[3, hidden, 20_000], [1, true, 30_000], [2, true, 40_000], [4, hidden, 50_000]] as const) {
      at(elapsed);
      expect(await heartbeat(sequence, viewing)).toMatchObject({ status: 200, body: { sleepAt: deadline(2000) } });
      expect(activityAt()).toBe(start + 2000);
    }
    expect(presence()).toMatchObject({ presence_seq: 4, viewing: hidden === null ? null : 0, presence_at: start + 50_000, ended_at: null });
  });

  it.each([false, null] as const)('uses input-only activity when initially %s', async (viewing) => {
    at(15_000);
    expect(await heartbeat(0, viewing)).toMatchObject({ status: 200, body: { sleepAt: deadline(0) } });
    expect(activityAt()).toBe(start);
    at(30_000);
    expect(await heartbeat(1, viewing, true)).toMatchObject({ status: 200, body: { sleepAt: deadline(30_000) } });
    at(45_000);
    expect(await heartbeat(2, viewing)).toMatchObject({ status: 200, body: { sleepAt: deadline(30_000) } });
    expect(activityAt()).toBe(start + 30_000);
  });

  it('ignores stale and repeated input reports after a newer hidden transition', async () => {
    at(1000);
    await heartbeat(0, true, true);
    at(2000);
    await heartbeat(2, false);
    for (const sequence of [0, 1, 2]) {
      at(30_000 + sequence * 1000);
      expect(await heartbeat(sequence, true, true)).toMatchObject({ status: 200, body: { sleepAt: deadline(2000) } });
      expect(activityAt()).toBe(start + 2000);
    }
    at(45_000);
    expect(await heartbeat(3, false, true)).toMatchObject({ status: 200, body: { sleepAt: deadline(45_000) } });
  });

  it('fences a visible input packet delayed before the newer hidden transaction', async () => {
    at(1000);
    await heartbeat(0, true);
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
    at(15_000);
    const oldVisible = heartbeat(1, true, true);
    await waiting;
    at(20_000);
    expect(await heartbeat(2, false)).toMatchObject({ status: 200, body: { sleepAt: deadline(20_000) } });
    release();
    expect(await oldVisible).toMatchObject({ status: 200, body: { sleepAt: deadline(20_000) } });
    expect(activityAt()).toBe(start + 20_000);
    expect(presence()).toMatchObject({ presence_seq: 2, viewing: 0 });
  });

  it('starts idle from the close of a visible view once and rejects later heartbeat activity', async () => {
    at(1000);
    await heartbeat(0, true);
    at(20_000);
    expect((await t.call('POST', `/api/v1/sessions/${sessionId}/end`)).status).toBe(204);
    expect(activityAt()).toBe(start + 20_000);
    expect(presence()).toMatchObject({ viewing: 0, presence_seq: 0, ended_at: start + 20_000 });
    at(30_000);
    expect((await t.call('POST', `/api/v1/sessions/${sessionId}/end`)).status).toBe(204);
    expect((await heartbeat(1, true, true)).status).toBe(409);
    expect(activityAt()).toBe(start + 20_000);
  });

  it('does not restart the countdown when an already-hidden view ends', async () => {
    at(1000);
    await heartbeat(0, true);
    at(2000);
    await heartbeat(1, false);
    at(30_000);
    expect((await t.call('POST', `/api/v1/sessions/${sessionId}/end`)).status).toBe(204);
    expect(activityAt()).toBe(start + 2000);
  });

  it('cannot renew a replacement controller from an old managed session', async () => {
    at(1000);
    await heartbeat(0, true);
    at(20_000);
    const next = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
    expect(next.status).toBe(201);
    at(30_000);
    expect((await heartbeat(99, true, true)).status).toBe(409);
    expect(activityAt()).toBe(start + 20_000);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid sequence %s', async (sequence) => {
    at(30_000);
    expect((await heartbeat(sequence, true)).status).toBe(400);
    expect(activityAt()).toBe(start);
  });
});

describe('agent activity compatibility', () => {
  const agentHeartbeat = async (elapsed: number) => {
    at(elapsed);
    t.d1.sqlite.prepare('UPDATE instance_health SET last_heartbeat_at=0 WHERE instance_id=?').run(instanceId);
    return agentMessage(t.env as never, createDb(t.d1), instanceId, 1,
      { t: 'event', kind: 'heartbeat', data: { viewers: 1, netTxBytes: elapsed, lastInputAt: new Date(start + elapsed).toISOString() } }, new Date(start + elapsed));
  };

  it('ignores agent signaling activity while hidden and after a managed session ends, but resumes for a new legacy session', async () => {
    at(1000);
    await heartbeat(0, true);
    at(2000);
    await heartbeat(1, false);
    await agentHeartbeat(60_000);
    expect(activityAt()).toBe(start + 2000);
    expect(t.d1.sqlite.prepare('SELECT viewers,net_tx_bytes,last_heartbeat_at FROM instance_health WHERE instance_id=?').get(instanceId))
      .toEqual({ viewers: 1, net_tx_bytes: 60_000, last_heartbeat_at: start + 60_000 });
    at(65_000);
    await t.call('POST', `/api/v1/sessions/${sessionId}/end`);
    await agentHeartbeat(120_000);
    expect(activityAt()).toBe(start + 2000);
    at(121_000);
    expect((await t.call('POST', `/api/v1/instances/${instanceId}/sessions`)).status).toBe(201);
    await agentHeartbeat(180_000);
    expect(activityAt()).toBe(start + 180_000);
  });

  it('uses input-only reports rather than agent signaling when visibility is unsupported', async () => {
    at(1000);
    await heartbeat(0, null);
    await agentHeartbeat(60_000);
    expect(activityAt()).toBe(start);
    at(65_000);
    await heartbeat(1, null, true);
    expect(activityAt()).toBe(start + 65_000);
  });

  it('rechecks modern presence at the agent write after a legacy health snapshot', async () => {
    const prepare = t.d1.prepare.bind(t.d1);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    vi.spyOn(t.d1, 'prepare').mockImplementation((query) => {
      const statement = prepare(query);
      if (!paused && /^insert into "instance_health"/i.test(query)) {
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
    const oldAgent = agentHeartbeat(60_000);
    await waiting;
    at(65_000);
    // Initial hidden presence establishes frontend ownership without being input activity.
    expect((await heartbeat(0, false)).status).toBe(200);
    release();
    await oldAgent;
    expect(activityAt()).toBe(start);
    expect(presence()).toMatchObject({ presence_seq: 0, viewing: 0 });
  });
});
