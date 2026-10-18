import { createDb, prepaidAccess, prepaidBalance, reservationQuote } from '@cloudbrowser/db';
import { meterUsage } from '@cloudbrowser/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBalance } from '../src/billing/ledger.js';
import { billingSweep } from '../src/billing/sweep.js';
import { setup, signIn } from './helpers.js';

const DAY = 86_400_000;
let t: ReturnType<typeof setup>;
let userId: string;
let reference = 0;

const db = () => createDb(t.d1);
const at = (time: number) => ({ db: db(), now: () => new Date(time), notify() {} }) as never;
const one = (query: string, ...params: (string | number)[]) => t.d1.sqlite.prepare(query).get(...params) as Record<string, number | string | null>;
const state = () => prepaidBalance(db(), userId);
const hold = (id: string) => one('SELECT reserved_micros AS held, required_micros AS required, retention_started_at AS started, retention_ends_at AS ends FROM browser_reservations WHERE instance_id = ?', id);
const charged = () => Number(one('SELECT coalesce(sum(charged_micros), 0) AS n FROM usage_records').n);

async function credit(amountMicros: number) {
  return applyBalance(db(), { userId, kind: 'adjustment', amountMicros, reference: `test-credit:${++reference}`, actor: 'test-admin' }, new Date());
}

async function version() {
  return (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1').version as string;
}

async function create(name = 'Browser') {
  return t.call('POST', '/api/v1/instances', { name, regionId: 'tyo1', storageGb: 10, priceVersion: await version() }, { 'idempotency-key': `create:${name}` });
}

async function browser(name = 'Browser') {
  const result = await create(name);
  expect(result.status).toBe(202);
  await t.settle();
  expect((await t.call('GET', `/api/v1/instances/${result.body.instanceId}`)).body.status).toBe('running');
  return result.body.instanceId as string;
}

async function sleep(id: string) {
  expect((await t.call('POST', `/api/v1/instances/${id}/stop`, undefined, { 'idempotency-key': `sleep:${id}` })).status).toBe(202);
  await t.settle();
  expect((await t.call('GET', `/api/v1/instances/${id}`)).body.status).toBe('sleeping');
}

/** Exhaust actual available credit, without spending or fabricating a deposit. */
async function exhaust(now: number) {
  await credit(-(await state()).availableMicros);
  await meterUsage(at(now));
}

beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec("INSERT INTO invites (email) VALUES ('prepaid@example.com')");
  await signIn(t, 'prepaid@example.com');
  userId = (await t.call('GET', '/api/v1/me')).body.user.id;
  t.d1.sqlite.exec(`INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', ${Date.now()})
    ON CONFLICT(key) DO UPDATE SET value = 'true';
    UPDATE caps SET "limit" = 2 WHERE scope = 'user:default' AND metric = 'running';`);
});

describe('seven-day prepaid resource deposits', () => {
  it('writes nothing between cron settlements and writes each billing row only once per settlement', async () => {
    await credit(10_000_000);
    const id = await browser();
    await sleep(id);
    const start = Date.now();
    const options = { minIntervalMs: 4 * 60_000 };
    await meterUsage(at(start), options);
    const writes = () => Number(one('SELECT total_changes() AS n').n);
    const before = writes();
    for (let minute = 1; minute < 4; minute++) {
      expect((await meterUsage(at(start + minute * 60_000), options)).metered).toBe(0);
    }
    expect(writes()).toBe(before);
    const previousCharge = charged();
    expect((await meterUsage(at(start + 4 * 60_000), options)).metered).toBe(1);
    // One journal insert + two usage items + account + journal completion + cursor.
    expect(writes() - before).toBe(6);
    expect(charged()).toBeGreaterThan(previousCharge);
    expect(10_000_000 - (await state()).balanceMicros).toBe(charged());
  });

  it('still stops an unfunded browser between settlement ticks', async () => {
    await credit(10_000_000);
    const id = await browser();
    const start = Date.now();
    await meterUsage(at(start));
    t.d1.sqlite.prepare('UPDATE instance_health SET net_tx_bytes=1000000000000,net_tx_billed_bytes=0 WHERE instance_id=?').run(id);
    expect((await meterUsage(at(start + 60_000), { minIntervalMs: 4 * 60_000 })).stopped).toBe(1);
  });

  it('still ends a trial between settlement ticks', async () => {
    await credit(10_000_000);
    const id = await browser();
    const start = Date.now();
    await meterUsage(at(start));
    t.d1.sqlite.prepare("UPDATE browser_instances SET trial_state='active',trial_used_ms=540000,trial_used_s=540 WHERE id=?").run(id);
    expect((await meterUsage(at(start + 60_000), { minIntervalMs: 4 * 60_000 })).stopped).toBe(1);
    expect(one('SELECT trial_state AS state FROM browser_instances WHERE id=?', id).state).toBe('ended');
  });

  it('holds a new browser deposit inside the total balance without charging it as usage', async () => {
    await credit(10_000_000);
    expect(await state()).toMatchObject({ balanceMicros: 10_000_000, reservedMicros: 0, availableMicros: 10_000_000 });
    const quote = await reservationQuote(db(), 'tyo1', { storageGb: 10, backupsEnabled: false });
    expect(quote!.requiredMicros).toBeGreaterThan(0);

    const id = await browser();
    const expected = { balanceMicros: 10_000_000, reservedMicros: quote!.requiredMicros, availableMicros: 10_000_000 - quote!.requiredMicros };
    expect(await state()).toMatchObject(expected);
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject(expected);
    expect(hold(id)).toMatchObject({ held: quote!.requiredMicros, required: quote!.requiredMicros, started: null, ends: null });
    expect(charged()).toBe(0);
    expect(one("SELECT count(*) AS n FROM balance_transactions WHERE kind = 'usage'").n).toBe(0);
    expect(await prepaidAccess(db(), userId, id)).toMatchObject({ allowed: true, reason: null });
  });

  it('does not let concurrent creates reserve the same available credit or leave an unfunded browser', async () => {
    const quote = (await reservationQuote(db(), 'tyo1', { storageGb: 10, backupsEnabled: false }))!;
    // Enough for exactly one deposit plus the normal $1 available-credit requirement.
    await credit(quote.requiredMicros + 1_000_000);
    const priceVersion = await version();
    const responses = await Promise.all(['First', 'Second'].map((name) => t.call('POST', '/api/v1/instances',
      { name, regionId: 'tyo1', storageGb: 10, priceVersion }, { 'idempotency-key': `parallel:${name}` })));
    expect(responses.map((r) => r.status).sort()).toEqual([202, 402]);
    expect(responses.find((r) => r.status === 402)?.body.type).toBe('insufficient_balance');
    await t.settle();
    expect(one('SELECT count(*) AS n FROM browser_instances').n).toBe(1);
    expect(one('SELECT count(*) AS n FROM browser_reservations').n).toBe(1);
    expect(one("SELECT count(*) AS n FROM operations WHERE kind = 'create'").n).toBe(1);
    expect(one('SELECT count(*) AS n FROM idempotency_keys').n).toBe(1);
    expect(await state()).toMatchObject({ balanceMicros: quote.requiredMicros + 1_000_000, reservedMicros: quote.requiredMicros, availableMicros: 1_000_000 });
  });

  it('refuses waking, viewing and additional resources when only held credit remains', async () => {
    await credit(10_000_000);
    const id = await browser();
    await sleep(id);
    await credit(-(await state()).availableMicros);
    const before = await state();
    expect(before.reservedMicros).toBeGreaterThan(0);
    expect(before.availableMicros).toBe(0);
    expect(await prepaidAccess(db(), userId, id)).toMatchObject({ allowed: false, reason: 'balance' });
    const operations = one('SELECT count(*) AS n FROM operations').n;
    const priceVersion = await version();
    const requests = [
      () => t.call('POST', `/api/v1/instances/${id}/start`, undefined, { 'idempotency-key': 'empty:start' }),
      () => t.call('POST', `/api/v1/instances/${id}/sessions`),
      () => t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 20, priceVersion }, { 'idempotency-key': 'empty:grow' }),
      () => t.call('POST', `/api/v1/instances/${id}/ip-change-requests`, { confirm: true, priceVersion }, { 'idempotency-key': 'empty:ip' }),
    ];
    for (const request of requests) expect(await request()).toMatchObject({ status: 402, body: { type: 'insufficient_balance' } });
    await t.settle();
    expect(one('SELECT count(*) AS n FROM operations').n).toBe(operations);
    expect(await state()).toMatchObject(before);
    expect(hold(id).held).toBe(before.reservedMicros);
  });

  it('caps a transfer debit at available credit and uses each deposit only for its own fixed retention costs', async () => {
    await credit(10_000_000);
    const first = await browser('First');
    const second = await browser('Second');
    const start = Date.now();
    await meterUsage(at(start));
    const before = await state();
    const chargedBefore = charged();
    const heldBefore = [hold(first), hold(second)];
    // This traffic is much more expensive than the entire balance, let alone available credit.
    t.d1.sqlite.prepare('UPDATE instance_health SET net_tx_bytes = 1000000000000, net_tx_billed_bytes = 0 WHERE instance_id = ?').run(first);
    const result = await meterUsage(at(start + 60_000));
    expect(result.chargedMicros).toBe(before.availableMicros);
    expect(charged() - chargedBefore).toBe(before.availableMicros);
    expect(await state()).toMatchObject({ balanceMicros: before.reservedMicros, reservedMicros: before.reservedMicros, availableMicros: 0 });
    expect(hold(first).held).toBe(heldBefore[0].held);
    expect(hold(second).held).toBe(heldBefore[1].held);
    expect(hold(first).started).toBe(start + 60_000);
    expect(hold(second).started).toBe(start + 60_000);

    // Let the already-enqueued provider stops finish; the data, IP and deposits survive.
    const stops = t.d1.sqlite.prepare("SELECT id FROM operations WHERE kind = 'stop' AND finished_at IS NULL").all() as { id: string }[];
    for (const op of stops) await t.env.OPERATIONS.send({ operationId: op.id });
    await t.settle();
    const previous = charged();
    const oldCharge = new Map((t.d1.sqlite.prepare('SELECT instance_id AS id, coalesce(sum(charged_micros), 0) AS n FROM usage_records GROUP BY instance_id').all() as { id: string; n: number }[]).map((r) => [r.id, r.n]));
    t.d1.sqlite.prepare('UPDATE instance_health SET net_tx_bytes = net_tx_bytes + 1000000000000 WHERE instance_id = ?').run(first);
    await meterUsage(at(start + 120_000));
    const retentionCharge = charged() - previous;
    expect(retentionCharge).toBeGreaterThan(0);
    expect(retentionCharge).toBeLessThan(1_000);
    expect(await state()).toMatchObject({ balanceMicros: before.reservedMicros - retentionCharge, reservedMicros: before.reservedMicros - retentionCharge, availableMicros: 0 });
    for (const [index, id] of [first, second].entries()) {
      const delta = Number(one('SELECT coalesce(sum(charged_micros), 0) AS n FROM usage_records WHERE instance_id = ?', id).n) - (oldCharge.get(id) ?? 0);
      expect(hold(id).held).toBe(Number(heldBefore[index].held) - delta);
      const paid = t.d1.sqlite.prepare('SELECT DISTINCT item FROM usage_records WHERE instance_id = ? AND unit_price_micros > 0 AND updated_at = ?').all(id, start + 120_000) as { item: string }[];
      expect(paid.map((r) => r.item).sort()).toEqual(['ip', 'storage']);
    }
  });

  it('permanently deletes at the seven-day deadline even when a positive deposit remains', async () => {
    await credit(10_000_000);
    const id = await browser();
    await sleep(id);
    const start = Date.now();
    await exhaust(start);
    expect(hold(id).held).toBeGreaterThan(0);
    expect(hold(id).ends).toBe(start + 7 * DAY);
    // A token credit cannot buy a fresh seven-day window or reactivate this browser.
    await credit(1);
    expect(hold(id).ends).toBe(start + 7 * DAY);
    expect(await prepaidAccess(db(), userId, id)).toMatchObject({ allowed: false, reason: 'balance' });
    expect((await billingSweep(t.env as never, db(), null, new Date(start + 7 * DAY - 1), { nightly: false })).deleted).toBe(0);
    const beforeDeadline = await state();
    await meterUsage(at(start + 7 * DAY));
    expect(await state()).toMatchObject({ balanceMicros: beforeDeadline.balanceMicros, reservedMicros: beforeDeadline.reservedMicros });
    expect((await billingSweep(t.env as never, db(), null, new Date(start + 7 * DAY), { nightly: false })).deleted).toBe(1);
    await t.settle();
    expect(one('SELECT desired_state AS desired FROM browser_instances WHERE id = ?', id).desired).toBe('deleted');
    expect(JSON.parse(String(one("SELECT params FROM operations WHERE instance_id = ? AND kind = 'delete'", id).params))).toMatchObject({ reason: 'billing', purgeNow: true });
    expect(hold(id).held).toBe(0);
  });

  it('atomically restores deposits and cancels an expiry already selected by the billing sweep after sufficient credit arrives', async () => {
    await credit(10_000_000);
    const id = await browser();
    await sleep(id);
    const start = Date.now();
    await exhaust(start);
    await meterUsage(at(start + 60_000));
    const depositShortfall = Number(hold(id).required) - Number(hold(id).held);
    expect(depositShortfall).toBeGreaterThan(0);
    const original = t.d1.batch.bind(t.d1);
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { ready = resolve; });
    let first = true;
    t.d1.batch = (async (statements: D1PreparedStatement[]) => {
      if (first) { first = false; ready(); await held; }
      return original(statements);
    }) as typeof t.d1.batch;
    const sweep = billingSweep(t.env as never, db(), null, new Date(start + 7 * DAY), { nightly: false });
    await reached;
    try {
      await credit(2_000_000 + depositShortfall);
      expect(hold(id).held).toBe(hold(id).required);
      expect(hold(id)).toMatchObject({ started: null, ends: null });
      expect(await state()).toMatchObject({ availableMicros: 2_000_000, exhaustedAt: null });
    } finally {
      release();
      t.d1.batch = original;
    }
    expect((await sweep).deleted).toBe(0);
    await t.settle();
    expect(one('SELECT desired_state AS desired FROM browser_instances WHERE id = ?', id).desired).toBe('stopped');
    expect(one("SELECT count(*) AS n FROM operations WHERE instance_id = ? AND kind = 'delete'", id).n).toBe(0);
    expect(hold(id)).toMatchObject({ started: null, ends: null });
    expect(await prepaidAccess(db(), userId, id)).toMatchObject({ allowed: true });
  });

  it('does not let stale exhaustion stop a freshly funded browser or end its new viewer session', async () => {
    const { beginRetention } = await import('../../engine/src/prepaid.js');
    const { requestStop } = await import('../../engine/src/scheduler.js');
    await credit(10_000_000);
    const id = await browser();
    const start = Date.now();
    await exhaust(start);
    const stops = t.d1.sqlite.prepare("SELECT id FROM operations WHERE kind = 'stop' AND finished_at IS NULL").all() as { id: string }[];
    for (const op of stops) await t.env.OPERATIONS.send({ operationId: op.id });
    await t.settle();
    await meterUsage(at(start + 60_000));
    const shortfall = Number(hold(id).required) - Number(hold(id).held);
    expect(shortfall).toBeGreaterThan(0);
    expect((await state()).availableMicros).toBe(0);

    // An old enforcement pass has already decided the account is exhausted. Before its
    // retention transaction commits, the owner tops up, wakes the browser and opens a viewer.
    const original = t.d1.batch.bind(t.d1);
    let injected = false;
    let sessionId = '';
    t.d1.batch = (async (statements: D1PreparedStatement[]) => {
      if (!injected) {
        injected = true;
        await credit(shortfall + 2_000_000);
        expect((await t.call('POST', `/api/v1/instances/${id}/start`, undefined, { 'idempotency-key': 'funded-wake' })).status).toBe(202);
        await t.settle();
        const opened = await t.call('POST', `/api/v1/instances/${id}/sessions`);
        expect(opened.status).toBe(201);
        sessionId = opened.body.session.id;
      }
      return original(statements);
    }) as typeof t.d1.batch;
    try {
      await beginRetention(db(), userId, new Date(start + 120_000));
    } finally {
      t.d1.batch = original;
    }
    expect(injected).toBe(true);
    expect(hold(id)).toMatchObject({ held: hold(id).required, started: null, ends: null });
    expect(await state()).toMatchObject({ availableMicros: 2_000_000, exhaustedAt: null });
    expect(one('SELECT status, desired_state AS desired FROM browser_instances WHERE id = ?', id)).toEqual({ status: 'running', desired: 'running' });
    expect(one('SELECT ended_at AS ended FROM viewer_sessions WHERE id = ?', sessionId).ended).toBeNull();
    expect(await requestStop(at(start + 120_000), { id, userId }, 'balance')).toBe(false);
    expect(one("SELECT count(*) AS n FROM operations WHERE instance_id = ? AND kind = 'stop' AND finished_at IS NULL", id).n).toBe(0);
    expect(await prepaidAccess(db(), userId, id)).toMatchObject({ allowed: true });
  });
});
