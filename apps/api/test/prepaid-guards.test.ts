import { createDb, prepaidAccess, prepaidBalance } from '@cloudbrowser/db';
import { meterUsage } from '@cloudbrowser/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBalance } from '../src/billing/ledger.js';
import { setup, signIn } from './helpers.js';

const START = Date.parse('2026-10-18T00:00:00Z');
let t: ReturnType<typeof setup>;
let userId: string;
let seq = 0;
const db = () => createDb(t.d1);
const advance = (ms: number) => vi.setSystemTime(START + ms);
const record = (id: string) => t.d1.sqlite.prepare('SELECT trial_state AS state, trial_used_s AS seconds, trial_used_ms AS milliseconds FROM browser_instances WHERE id = ?').get(id) as { state: string; seconds: number; milliseconds: number };
const health = (id: string) => t.d1.sqlite.prepare('SELECT metered_at AS compute, base_metered_at AS fixed, pending_compute_ms AS pending, net_tx_billed_bytes AS billed FROM instance_health WHERE instance_id = ?').get(id) as { compute: number | null; fixed: number | null; pending: number; billed: number | null };
const meter = () => meterUsage({ db: db(), now: () => new Date(), notify() {} } as never);
async function credit(amountMicros: number) {
  return applyBalance(db(), { userId, kind: 'adjustment', amountMicros, actor: 'test', reference: `guard-credit:${++seq}` }, new Date());
}
async function create(trial = true) {
  const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === (trial ? 'syd1' : 'tyo1'));
  const result = await t.call('POST', '/api/v1/instances', { name: 'Browser', regionId: trial ? 'syd1' : 'tyo1', storageGb: trial ? 2 : 10, priceVersion: price.version, ...(trial ? { trial: true } : {}) }, { 'idempotency-key': `guard-create:${++seq}` });
  expect(result.status).toBe(202); await t.settle();
  return result.body.instanceId as string;
}
async function stop(id: string) {
  expect((await t.call('POST', `/api/v1/instances/${id}/stop`, undefined, { 'idempotency-key': `guard-stop:${++seq}` })).status).toBe(202);
  await t.settle();
}
async function start(id: string) {
  expect((await t.call('POST', `/api/v1/instances/${id}/start`, undefined, { 'idempotency-key': `guard-start:${++seq}` })).status).toBe(202);
  await t.settle();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START);
  t = setup();
  t.d1.sqlite.exec("INSERT INTO invites (email) VALUES ('guards@example.com'); UPDATE regions SET enabled = 1, executor = 'fake' WHERE id = 'syd1'; UPDATE provider_prices SET executor = 'fake' WHERE region_id = 'syd1'; UPDATE control_flags SET value = 'true' WHERE key = 'billing_required';");
  await signIn(t, 'guards@example.com');
  userId = (await t.call('GET', '/api/v1/me')).body.user.id;
});
afterEach(() => vi.useRealTimers());

describe('prepaid runtime boundaries', () => {
  it('defaults a missing billing flag to prepaid rather than silently enabling free paid browsers', async () => {
    t.d1.sqlite.exec("DELETE FROM control_flags WHERE key = 'billing_required'");
    const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
    expect((await t.call('GET', '/api/v1/billing')).body.mode).toBe('prepaid');
    expect(await t.call('POST', '/api/v1/instances', { name: 'No credit', regionId: 'tyo1', storageGb: 10, priceVersion: price.version }, { 'idempotency-key': 'missing-flag' }))
      .toMatchObject({ status: 402, body: { type: 'insufficient_balance' } });
  });

  it('does not replenish a trial by reconnecting, input heartbeats or activity timestamp updates', async () => {
    const id = await create(); await meter();
    const deadline = START + 600_000;
    for (const ms of [15_000, 45_000, 120_000, 599_000]) {
      advance(ms);
      const session = await t.call('POST', `/api/v1/instances/${id}/sessions`);
      expect(session.status).toBe(201);
      expect((await t.call('POST', `/api/v1/sessions/${session.body.session.id}/heartbeat`, { input: true })).status).toBe(200);
      t.d1.sqlite.prepare('UPDATE browser_instances SET last_active_at = ? WHERE id = ?').run(Date.now(), id);
      expect((await prepaidAccess(db(), userId, id)).deadlineAt?.getTime()).toBe(deadline);
    }
    advance(600_000);
    expect(await prepaidAccess(db(), userId, id)).toMatchObject({ allowed: false, reason: 'trial' });
    expect((await t.call('POST', `/api/v1/instances/${id}/sessions`)).status).toBe(402);
    await meter();
    expect(record(id)).toMatchObject({ state: 'ended', seconds: 600, milliseconds: 600_000 });
    expect((await prepaidBalance(db(), userId)).balanceMicros).toBe(0);
  });

  it('keeps fractional trial runtime through short sleep/start cycles before a meter tick', async () => {
    const id = await create();
    advance(750); await stop(id);
    expect(record(id)).toMatchObject({ milliseconds: 750, seconds: 0 });
    advance(1_000); await start(id);
    advance(1_750); await stop(id);
    expect(record(id)).toMatchObject({ milliseconds: 1_500, seconds: 1 });
    advance(2_000); await start(id);
    expect((await prepaidAccess(db(), userId, id)).deadlineAt?.getTime()).toBe(START + 600_500);
    advance(600_500);
    expect(await prepaidAccess(db(), userId, id)).toMatchObject({ allowed: false, reason: 'trial' });
    await meter(); expect(record(id)).toMatchObject({ state: 'ended', milliseconds: 600_000 });
  });

  it('starts a paid epoch at conversion and never retroactively charges free time or traffic', async () => {
    const id = await create(); await meter();
    advance(1_000); await stop(id);
    expect(health(id).pending).toBe(1_000);
    advance(2_000); await start(id);
    advance(30_000);
    t.d1.sqlite.prepare('UPDATE instance_health SET net_tx_bytes = 1000000000, net_tx_billed_bytes = 0 WHERE instance_id = ?').run(id);
    await credit(10_000_000);
    expect(record(id).state).toBe('converted');
    expect(health(id)).toMatchObject({ compute: START + 30_000, fixed: START + 30_000, pending: 0, billed: 1_000_000_000 });
    advance(60_000); await meter();
    const paid = t.d1.sqlite.prepare("SELECT item, sum(charged_micros) AS charged FROM usage_records WHERE instance_id = ? GROUP BY item").all(id) as { item: string; charged: number }[];
    expect(paid.find((r) => r.item === 'compute')?.charged).toBe(1_000);
    expect(paid.find((r) => r.item === 'transfer')?.charged ?? 0).toBe(0);
    expect((await prepaidBalance(db(), userId)).balanceMicros).toBeGreaterThan(9_998_000);
  });

  it('charges paid short runs even when every run stops before the minute cron', async () => {
    await credit(10_000_000); const id = await create(false); await meter();
    advance(750); await stop(id);
    advance(1_000); await start(id);
    advance(1_750); await stop(id);
    expect(health(id).pending).toBe(1_500);
    advance(2_000); await meter();
    expect(health(id).pending).toBe(0);
    const compute = t.d1.sqlite.prepare("SELECT sum(charged_micros) AS n FROM usage_records WHERE instance_id = ? AND item = 'compute'").get(id) as { n: number };
    expect(compute.n).toBe(50);
    expect((await prepaidBalance(db(), userId)).balanceMicros).toBeLessThan(10_000_000);
  });
});
