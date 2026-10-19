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
afterEach(() => { vi.useRealTimers(); });

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

  it('throttles viewer input updates when inactivity sleep is disabled', async () => {
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
    expect(writes() - before).toBe(2); // One session renewal and one input timestamp.
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
