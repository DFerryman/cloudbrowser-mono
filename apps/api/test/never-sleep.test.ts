import { accountRunway, createDb, prepaidBalance } from '@cloudbrowser/db';
import { meterUsage } from '@cloudbrowser/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBalance } from '../src/billing/ledger.js';
import { billingSweep } from '../src/billing/sweep.js';
import { setup, signIn } from './helpers.js';

const START = Date.parse('2026-10-18T00:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let t: ReturnType<typeof setup>;
let userId: string;
let seq = 0;
const db = () => createDb(t.d1);
const meter = () => meterUsage({ db: db(), now: () => new Date(), notify() {} } as never);
const sweep = () => billingSweep(t.env as never, db(), null, new Date(), { nightly: false });
const change = (kind: 'topup' | 'adjustment', amountMicros: number) =>
  applyBalance(db(), { userId, kind, amountMicros, actor: 'test', reference: `never-sleep:${++seq}` }, new Date());
/** Sets available credit to exactly `micros` with an adjustment (not a top-up). */
const setAvailable = async (micros: number) => change('adjustment', micros - (await prepaidBalance(db(), userId)).availableMicros);

async function create() {
  const regionId = 'tyo1';
  const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === regionId);
  const r = await t.call('POST', '/api/v1/instances', { name: 'Work', regionId, storageGb: 10, priceVersion: price.version }, { 'idempotency-key': `create:${++seq}` });
  expect(r.status).toBe(202);
  await t.settle();
  return r.body.instanceId as string;
}
const quote = async (id: string) => (await t.call('GET', `/api/v1/instances/${id}/never-sleep`)).body;
const enable = async (id: string, priceVersion?: string | null) => t.call('PATCH', `/api/v1/instances/${id}`, { idleTimeoutS: 0, priceVersion: priceVersion ?? undefined });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  t = setup();
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('owner@example.com');
    UPDATE regions SET enabled = 1, executor = 'fake' WHERE id = 'syd1'; UPDATE provider_prices SET executor = 'fake' WHERE region_id = 'syd1';
    UPDATE control_flags SET value = 'true' WHERE key = 'billing_required';`);
  await signIn(t, 'owner@example.com');
  userId = (await t.call('GET', '/api/v1/me')).body.user.id;
});
afterEach(() => vi.useRealTimers());

describe('who may turn on Never sleep', () => {
  it('needs a top-up and available credit for 24 hours of the account with this browser always on', async () => {
    await change('adjustment', 20_000_000);
    const id = await create();
    await meter();
    // Credit granted by an operator is not a top-up.
    expect(await quote(id)).toMatchObject({ allowed: false, reason: 'no_topup' });
    expect(await enable(id, (await quote(id)).priceVersion)).toMatchObject({ status: 402, body: { type: 'insufficient_balance', limit: 'never_sleep_topup' } });

    await change('topup', 1);
    const q = await quote(id);
    const runway = await accountRunway(db(), userId, new Date());
    // 24 hours of everything the account spends now; this browser already runs, so its compute is included.
    expect(q.requiredMicros).toBe(Math.ceil(24 * runway.burnHourMicros) + (runway.availableMicros - runway.remainingMicros));
    expect(q.day.computeMicros).toBeGreaterThan(0);
    expect(q.day.ipMicros).toBeGreaterThan(0);
    expect(q.day.storageMicros).toBeGreaterThan(0);
    expect(q.day.totalMicros).toBe(q.day.computeMicros + q.day.ipMicros + q.day.storageMicros);

    await setAvailable(q.requiredMicros - 1);
    expect(await quote(id)).toMatchObject({ allowed: false, reason: 'insufficient_credit' });
    const short = await enable(id, q.priceVersion);
    expect(short).toMatchObject({ status: 402, body: { type: 'insufficient_balance', limit: 'never_sleep_credit' } });
    expect(short.body.detail).toMatch(/needs \$\d+\.\d\d of available credit/);

    await setAvailable(q.requiredMicros + 1_000);
    expect(await quote(id)).toMatchObject({ allowed: true, reason: null });
    expect(await enable(id)).toMatchObject({ status: 400, body: { type: 'validation_failed' } });
    expect(await enable(id, 'stale')).toMatchObject({ status: 409, body: { type: 'price_changed' } });
    expect(await enable(id, q.priceVersion)).toMatchObject({ status: 200, body: { idleTimeoutS: 0 } });
  });

  it('is its own admin setting: Never sleep does not slip under the auto-sleep limit, and the switch does not lift it', async () => {
    await change('topup', 50_000_000);
    const id = await create();
    await meter();
    t.d1.sqlite.exec(`UPDATE caps SET "limit" = 300 WHERE scope = 'user:default' AND metric = 'idle_timeout_max_s'`);
    expect(await t.call('PATCH', `/api/v1/instances/${id}`, { idleTimeoutS: 600 })).toMatchObject({ status: 403, body: { type: 'plan_limit' } });
    t.d1.sqlite.exec(`UPDATE caps SET "limit" = 0 WHERE scope = 'user:default' AND metric = 'never_sleep'`);
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.neverSleep).toBe(false);
    expect(await quote(id)).toMatchObject({ allowed: false, reason: 'disabled' });
    expect(await enable(id, (await quote(id)).priceVersion)).toMatchObject({ status: 403, body: { type: 'plan_limit', limit: 'never_sleep' } });
    // One user can be allowed while it is off for everyone else.
    t.d1.sqlite.prepare(`INSERT INTO caps (scope, metric, "limit") VALUES (?, 'never_sleep', 1)`).run(`user:${userId}`);
    expect(await enable(id, (await quote(id)).priceVersion)).toMatchObject({ status: 200, body: { idleTimeoutS: 0 } });
    // Turning the switch off later leaves a browser that already uses it alone.
    t.d1.sqlite.prepare(`DELETE FROM caps WHERE scope = ?`).run(`user:${userId}`);
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body.idleTimeoutS).toBe(0);
  });
});

describe('the idle countdown', () => {
  it('starts again when the setting changes, including when leaving Never sleep', async () => {
    await change('topup', 50_000_000);
    const id = await create();
    await meter();
    const session = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    const heartbeat = async () => (await t.call('POST', `/api/v1/sessions/${session.body.session.id}/heartbeat`, { input: false })).body;
    expect(await enable(id, (await quote(id)).priceVersion)).toMatchObject({ status: 200 });
    // Hours without any input while it never sleeps.
    vi.setSystemTime(START + 5 * HOUR);
    expect(await heartbeat()).toEqual({ sleepAt: null });
    const changedAt = Date.now();
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { idleTimeoutS: 600 })).status).toBe(200);
    expect(await heartbeat()).toMatchObject({ reason: 'idle', sleepAt: new Date(changedAt + 600_000).toISOString() });
    vi.setSystemTime(changedAt + 60_000);
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { idleTimeoutS: 300 })).status).toBe(200);
    expect(await heartbeat()).toMatchObject({ reason: 'idle', sleepAt: new Date(changedAt + 60_000 + 300_000).toISOString() });
  });
});

describe('funded time', () => {
  it('shows available credit and how long it lasts at the combined rate, and warns at 24, 6 and 1 hours once each', async () => {
    await change('topup', 50_000_000);
    const id = await create();
    await meter();
    await create();
    await meter();
    const { burnHourMicros } = await accountRunway(db(), userId, new Date());
    expect(burnHourMicros).toBeGreaterThan(0);
    const fundFor = (hours: number) => setAvailable(Math.round(burnHourMicros * hours));
    const warned = () => (t.d1.sqlite.prepare('SELECT runway_warned_hours AS h FROM billing_accounts WHERE user_id = ?').get(userId) as { h: number | null }).h;

    await fundFor(20);
    const billing = (await t.call('GET', '/api/v1/billing')).body;
    expect(billing.burnHourMicros).toBe(burnHourMicros);
    expect(Math.abs(Date.parse(billing.fundedUntil) - (Date.now() + 20 * HOUR))).toBeLessThan(60_000);

    expect(await sweep()).toMatchObject({ runway: 1, lowBalance: 0 });
    expect(t.emails.at(-1)!.subject).toBe('Your Nevazu credit lasts less than 24 hours');
    expect(t.emails.at(-1)!.text).toMatch(/including those set to Never sleep/);
    expect(await sweep()).toMatchObject({ runway: 0, lowBalance: 0 });

    await fundFor(5);
    expect((await sweep()).runway).toBe(1);
    expect(t.emails.at(-1)!.subject).toBe('Your Nevazu credit lasts less than 6 hours');
    // Hovering just above a threshold does not repeat a warning already sent.
    await fundFor(6.5);
    expect((await sweep()).runway).toBe(0);
    await fundFor(5.5);
    expect((await sweep()).runway).toBe(0);
    expect(warned()).toBe(6);

    await fundFor(0.5);
    expect((await sweep()).runway).toBe(1);
    expect(t.emails.at(-1)!.subject).toBe('Your Nevazu credit runs out within an hour');
    expect(await sweep()).toMatchObject({ runway: 0, lowBalance: 0 });

    // Clearly recovered: the warnings re-arm, and the next dip warns again.
    await fundFor(100);
    expect((await sweep()).runway).toBe(0);
    expect(warned()).toBeNull();
    await fundFor(4);
    expect((await sweep()).runway).toBe(1);
    expect(t.emails.at(-1)!.subject).toBe('Your Nevazu credit lasts less than 6 hours');
    expect(t.emails.filter((e) => e.subject?.includes('Nevazu credit'))).toHaveLength(4);
    expect(id).toBeTruthy();
  });

  it('sends a warning whose email failed on the next sweep', async () => {
    await change('topup', 50_000_000);
    await create();
    await meter();
    const { burnHourMicros } = await accountRunway(db(), userId, new Date());
    await setAvailable(Math.round(burnHourMicros * 20));
    vi.spyOn(t.env.EMAIL, 'send').mockRejectedValueOnce(new Error('Email Service unavailable'));
    expect((await sweep()).runway).toBe(0);
    expect(t.d1.sqlite.prepare('SELECT runway_warned_hours AS h FROM billing_accounts WHERE user_id = ?').get(userId)).toEqual({ h: null });
    expect((await sweep()).runway).toBe(1);
    expect((await sweep()).runway).toBe(0);
    expect(t.emails.filter((e) => e.subject?.includes('Nevazu credit')).map((e) => e.subject)).toEqual(['Your Nevazu credit lasts less than 24 hours']);
  });
});

describe('when credit runs out', () => {
  it('stops an unattended Never sleep browser, and a top-up never wakes it: the user resumes it', async () => {
    await change('topup', 50_000_000);
    const id = await create();
    await meter();
    expect(await enable(id, (await quote(id)).priceVersion)).toMatchObject({ status: 200 });
    // No viewer is connected. Credit runs out.
    await setAvailable(0);
    vi.setSystemTime(START + 60_000);
    expect((await meter()).stopped).toBe(1);
    const stop = t.d1.sqlite.prepare("SELECT id, json_extract(params, '$.reason') AS reason FROM operations WHERE kind = 'stop'").get() as { id: string; reason: string };
    expect(stop.reason).toBe('balance');
    await t.env.OPERATIONS.send({ operationId: stop.id });
    await t.settle();
    const stopped = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(stopped).toMatchObject({ status: 'sleeping', desiredState: 'stopped', idleTimeoutS: 0, stopReason: 'balance' });
    expect(stopped.deletesAt).toBe(new Date(START + 60_000 + 7 * 86_400_000).toISOString());

    const { restoreNeededMicros } = (await t.call('GET', '/api/v1/billing')).body;
    await change('topup', restoreNeededMicros);
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ retained: [], restoreNeededMicros: null, exhaustedAt: null });
    // Nothing restarts it: not the top-up, the meter, or the sweep.
    vi.setSystemTime(START + 2 * HOUR);
    await meter();
    await sweep();
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body).toMatchObject({ status: 'sleeping', desiredState: 'stopped', deletesAt: null });
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM operations WHERE kind IN ('start', 'create') AND created_at > ?").get(START + 60_000)).toEqual({ n: 0 });
    // The user resumes it, with enough credit for its deposit and the minimum.
    await change('topup', 20_000_000);
    expect((await t.call('POST', `/api/v1/instances/${id}/start`, undefined, { 'idempotency-key': 'resume' })).status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body).toMatchObject({ status: 'running', stopReason: null, idleTimeoutS: 0 });
  });

  it('sends a reminder whose email failed on the next sweep, the final one too', async () => {
    await change('topup', 50_000_000);
    await create();
    await meter();
    await setAvailable(0);
    vi.setSystemTime(START + 60_000);
    await meter();
    const send = vi.spyOn(t.env.EMAIL, 'send');
    const reminders = () => t.emails.filter((e) => /credit ran out|will be deleted/.test(e.subject ?? '')).map((e) => e.subject);
    send.mockRejectedValueOnce(new Error('Email Service unavailable'));
    expect((await sweep()).notices).toBe(0);
    expect((await sweep()).notices).toBe(1);
    expect((await sweep()).notices).toBe(0);
    // A day before deletion.
    vi.setSystemTime(START + 60_000 + 6.5 * DAY);
    send.mockRejectedValueOnce(new Error('Email Service unavailable'));
    expect((await sweep()).notices).toBe(0);
    expect((await sweep()).notices).toBe(1);
    expect((await sweep()).notices).toBe(0);
    expect(reminders()).toEqual(['Your Nevazu credit ran out: your browsers have stopped', 'Final reminder: your Nevazu browsers will be deleted within 24 hours']);
  });
});

describe('notices the engine queues', () => {
  it('emails unexpected stops and paused networks once each', async () => {
    const at = Date.now();
    t.d1.sqlite.prepare(`INSERT INTO user_notices (id, user_id, kind, instance_id, data, created_at) VALUES
      ('stop:op1', ?, 'stopped', 'i1', '{"name":"Work","reason":"operator"}', ?),
      ('ip:i1:1', ?, 'network_paused', 'i1', '{"name":"Work"}', ?)`).run(userId, at, userId, at + 1);
    expect((await sweep()).userNotices).toBe(2);
    expect(t.emails.slice(-2).map((e) => e.subject)).toEqual(['Your Nevazu browser "Work" was stopped', 'Network paused on your Nevazu browser "Work"']);
    expect(t.emails.at(-2)!.text).toMatch(/An administrator stopped "Work"\.[\s\S]*It will not restart by itself, even if it was set to Never sleep/);
    expect(t.emails.at(-1)!.text).toMatch(/does not resume by itself/);
    expect((await sweep()).userNotices).toBe(0);
  });

  it('sends a notice whose email failed on a later sweep, and drops one still failing after a day', async () => {
    const add = (id: string) => t.d1.sqlite.prepare(`INSERT INTO user_notices (id, user_id, kind, instance_id, data, created_at)
      VALUES (?, ?, 'stopped', 'i1', '{"name":"Work","reason":"suspended"}', ?)`).run(id, userId, Date.now());
    const pending = () => (t.d1.sqlite.prepare('SELECT id FROM user_notices WHERE sent_at IS NULL').all() as { id: string }[]).map((n) => n.id);
    const send = vi.spyOn(t.env.EMAIL, 'send');
    add('stop:op1');
    send.mockRejectedValueOnce(new Error('Email Service unavailable'));
    expect((await sweep()).userNotices).toBe(0);
    expect(pending()).toEqual(['stop:op1']);
    expect((await sweep()).userNotices).toBe(1);
    expect(pending()).toEqual([]);
    expect(t.emails.at(-1)!.subject).toBe('Your Nevazu browser "Work" was stopped');

    // An address that keeps failing must not hold up the queue for ever.
    add('stop:op2');
    send.mockRejectedValue(new Error('Recipient rejected'));
    expect((await sweep()).userNotices).toBe(0);
    vi.setSystemTime(Date.now() + DAY);
    expect((await sweep()).userNotices).toBe(1);
    expect(pending()).toEqual([]);

    // Without an email binding (local development) nothing is retried.
    send.mockRestore();
    Object.assign(t.env, { EMAIL: undefined });
    add('stop:op3');
    expect((await sweep()).userNotices).toBe(1);
    expect(pending()).toEqual([]);
  });
});
