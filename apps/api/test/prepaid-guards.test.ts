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

const health = (id: string) => t.d1.sqlite.prepare('SELECT metered_at AS compute, base_metered_at AS fixed, pending_compute_ms AS pending, net_tx_billed_bytes AS billed FROM instance_health WHERE instance_id = ?').get(id) as { compute: number | null; fixed: number | null; pending: number; billed: number | null };
const meter = () => meterUsage({ db: db(), now: () => new Date(), notify() {} } as never);
async function credit(amountMicros: number) {
  return applyBalance(db(), { userId, kind: 'adjustment', amountMicros, actor: 'test', reference: `guard-credit:${++seq}` }, new Date());
}
async function create() {
  const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
  const result = await t.call('POST', '/api/v1/instances', { name: 'Browser', regionId: 'tyo1', storageGb: 10, priceVersion: price.version }, { 'idempotency-key': `guard-create:${++seq}` });
  expect(result.status).toBe(202); await t.settle();
  return result.body.instanceId as string;
}
/** Never sleep needs a top-up and the quoted price; any other timeout is a plain setting. */
async function setIdle(id: string, idleTimeoutS: number) {
  if (idleTimeoutS !== 0) return expect((await t.call('PATCH', `/api/v1/instances/${id}`, { idleTimeoutS })).status).toBe(200);
  await applyBalance(db(), { userId, kind: 'topup', amountMicros: 1, actor: 'test', reference: `guard-topup:${++seq}` }, new Date());
  const quote = (await t.call('GET', `/api/v1/instances/${id}/never-sleep`)).body;
  expect(quote).toMatchObject({ allowed: true, reason: null });
  expect((await t.call('PATCH', `/api/v1/instances/${id}`, { idleTimeoutS, priceVersion: quote.priceVersion })).status).toBe(200);
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
  it('checks a fresh authorization snapshot in one D1 round trip, including immediate revocation', async () => {
    await credit(10_000_000);
    const id = await create(); await meter();
    let requests = 0;
    let batching = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (key === 'bind') return wrap(Reflect.apply(value, target, args));
          if (!batching && ['all', 'first', 'raw', 'run'].includes(String(key))) requests++;
          return Reflect.apply(value, target, args);
        };
      },
    });
    const counted = createDb({ ...t.d1,
      prepare: (query: string) => wrap(t.d1.prepare(query)),
      async batch(statements: D1PreparedStatement[]) {
        requests++; batching = true;
        try { return await t.d1.batch(statements); } finally { batching = false; }
      },
    } as D1Database);

    expect(await prepaidAccess(counted, userId, id)).toMatchObject({ allowed: true });
    expect(requests).toBe(1);
    t.d1.sqlite.prepare('UPDATE billing_accounts SET frozen_at = ? WHERE user_id = ?').run(Date.now(), userId);
    expect(await prepaidAccess(counted, userId, id)).toMatchObject({ allowed: false, reason: 'frozen' });
    expect(requests).toBe(2);
    t.d1.sqlite.prepare("UPDATE browser_instances SET desired_state = 'deleted' WHERE id = ?").run(id);
    expect(await prepaidAccess(counted, userId, id)).toMatchObject({ allowed: false, reason: 'deleted' });
    expect(requests).toBe(3);
  });

  it('tells the owner of a suspended browser it is suspended, not that credit ran out', async () => {
    await credit(10_000_000);
    const id = await create();
    const session = (await t.call('POST', `/api/v1/instances/${id}/sessions`)).body.session.id as string;
    t.d1.sqlite.prepare('UPDATE browser_instances SET suspended_at = ? WHERE id = ?').run(Date.now(), id);
    const suspended = { status: 403, body: { type: 'suspended', detail: 'This browser is suspended. Contact support.' } };
    expect(await t.call('POST', `/api/v1/sessions/${session}/heartbeat`, { input: false })).toMatchObject(suspended);
    expect(await t.call('POST', `/api/v1/instances/${id}/sessions`)).toMatchObject(suspended);
  });

  it.each([600, 0])('renews funded access without treating the lease as balance exhaustion with timeout %s', async (idleTimeoutS) => {
    await credit(10_000_000);
    const id = await create(); await meter();
    await setIdle(id, idleTimeoutS);
    const session = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    expect(session.status).toBe(201);
    for (const ms of [0, 45_000, 90_000]) {
      advance(ms);
      const access = await prepaidAccess(db(), userId, id);
      expect(access).toMatchObject({ allowed: true, reason: null, balanceDeadlineAt: null });
      expect(access.deadlineAt?.getTime()).toBe(Date.now() + 60_000);
      const heartbeat = await t.call('POST', `/api/v1/sessions/${session.body.session.id}/heartbeat`, { input: true });
      expect(heartbeat.status).toBe(200);
      if (idleTimeoutS === 0) expect(heartbeat.body).toEqual({ sleepAt: null });
      else {
        expect(heartbeat.body.reason).toBe('idle');
        expect(Date.parse(heartbeat.body.sleepAt)).toBeGreaterThan(Date.now() + 60_000);
      }
    }
  });

  it.each([600, 0])('still reports actual depletion and clears the warning after credit with timeout %s', async (idleTimeoutS) => {
    await credit(10_000_000);
    const id = await create(); await meter();
    await setIdle(id, idleTimeoutS);
    const session = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    expect(session.status).toBe(201);
    await credit(1_000 - (await prepaidBalance(db(), userId)).availableMicros);

    const access = await prepaidAccess(db(), userId, id);
    expect(access.allowed).toBe(true);
    expect(access.balanceDeadlineAt?.getTime()).toBeGreaterThan(Date.now());
    expect(access.balanceDeadlineAt?.getTime()).toBeLessThan(Date.now() + 60_000);
    const heartbeat = await t.call('POST', `/api/v1/sessions/${session.body.session.id}/heartbeat`, { input: true });
    expect(heartbeat).toMatchObject({ status: 200, body: { reason: 'balance', sleepAt: access.balanceDeadlineAt!.toISOString() } });

    advance(access.balanceDeadlineAt!.getTime() - START);
    expect(await prepaidAccess(db(), userId, id)).toMatchObject({ allowed: false, reason: 'balance' });
    await credit(10_000_000);
    expect(await t.call('POST', `/api/v1/sessions/${session.body.session.id}/heartbeat`, { input: true }))
      .toMatchObject({ status: 200, body: idleTimeoutS === 0 ? { sleepAt: null } : { reason: 'idle' } });
  });

  it('defaults a missing billing flag to prepaid rather than silently enabling free paid browsers', async () => {
    t.d1.sqlite.exec("DELETE FROM control_flags WHERE key = 'billing_required'");
    const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
    expect((await t.call('GET', '/api/v1/billing')).body.mode).toBe('prepaid');
    expect(await t.call('POST', '/api/v1/instances', { name: 'No credit', regionId: 'tyo1', storageGb: 10, priceVersion: price.version }, { 'idempotency-key': 'missing-flag' }))
      .toMatchObject({ status: 402, body: { type: 'insufficient_balance' } });
  });

  it('keeps accrued runtime and unbilled traffic intact when credit is added', async () => {
    await credit(10_000_000);
    const id = await create(); await meter();
    advance(30_000);
    t.d1.sqlite.prepare('UPDATE instance_health SET net_tx_bytes = 1000000000, net_tx_billed_bytes = 0 WHERE instance_id = ?').run(id);
    const before = health(id);
    await credit(1_000_000);
    expect(health(id)).toEqual(before);
    advance(60_000); await meter();
    const paid = t.d1.sqlite.prepare("SELECT item, sum(charged_micros) AS charged FROM usage_records WHERE instance_id = ? GROUP BY item").all(id) as { item: string; charged: number }[];
    expect(paid.find((r) => r.item === 'compute')?.charged).toBe(2_000);
    expect(paid.find((r) => r.item === 'transfer')?.charged).toBeGreaterThan(0);
    expect(health(id).billed).toBe(1_000_000_000);
  });

  it('charges paid short runs even when every run stops before the minute cron', async () => {
    await credit(10_000_000); const id = await create(); await meter();
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
