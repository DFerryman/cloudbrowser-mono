import { browserEstimate, customerRates, priceVersion, ProviderPriceSheet } from '@cloudbrowser/contracts';
import { meterUsage } from '@cloudbrowser/engine';
import { createDb } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { billingSweep } from '../src/billing/sweep.js';
import { creemFrom } from '../src/billing/creem.js';
import { setup, signIn, SIMULATED_SHEET } from './helpers.js';

const SECRET = 'whsec_test';
const BASE = 'https://test-api.creem.io';

/**
 * A stand-in for Creem's API (page 6): one-time top-up products and checkouts. Field names follow
 * Creem's docs and must be confirmed against recorded test-mode payloads before launch.
 */
class FakeCreem {
  products: Record<string, Record<string, unknown>> = {
    prod_10: { id: 'prod_10', name: '$10 credit', price: 1000, currency: 'USD', billing_type: 'onetime' },
    prod_25: { id: 'prod_25', name: '$25 credit', price: 2500, currency: 'USD', billing_type: 'onetime' },
    prod_sub: { id: 'prod_sub', name: 'A subscription', price: 900, currency: 'USD', billing_type: 'recurring' },
  };
  checkouts = new Map<string, Record<string, unknown>>();
  calls: { method: string; path: string; body: unknown }[] = [];

  /** Creem marks the checkout paid (what the hosted checkout does when the buyer pays). */
  pay(id: string, orderId = `ord_${id}`) {
    const c = this.checkouts.get(id)!;
    this.checkouts.set(id, { ...c, status: 'completed', order: { id: orderId, status: 'paid', amount: 1100, sub_total: 1000, tax_amount: 100, currency: 'USD' }, customer: { id: 'cust_1' } });
    return this.checkouts.get(id)!;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    this.calls.push({ method, path: url.pathname, body });
    if (init?.headers && (init.headers as Record<string, string>)['x-api-key'] !== 'creem_test_key') return new Response('no key', { status: 401 });
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && url.pathname === '/v1/products') {
      const p = this.products[url.searchParams.get('product_id') ?? ''];
      return p ? ok(p) : new Response('not found', { status: 404 });
    }
    if (method === 'POST' && url.pathname === '/v1/checkouts') {
      const id = `ch_${this.checkouts.size + 1}`;
      this.checkouts.set(id, { id, status: 'pending', request_id: body.request_id, product: body.product_id, metadata: body.metadata });
      return ok({ id, checkout_url: `https://checkout.test/${id}` });
    }
    if (method === 'GET' && url.pathname === '/v1/checkouts') {
      const c = this.checkouts.get(url.searchParams.get('checkout_id') ?? '');
      return c ? ok(c) : new Response('not found', { status: 404 });
    }
    if (method === 'POST' && url.pathname === '/v1/customers/billing') return ok({ customer_portal_link: `https://portal.test/${body.customer_id}` });
    return new Response('unexpected', { status: 500 });
  };
}

async function sign(raw: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let t: ReturnType<typeof setup>;
let creem: FakeCreem;
let userId: string;

async function webhook(event: Record<string, unknown>, signature?: string) {
  const raw = JSON.stringify(event);
  const res = await worker.fetch(
    new Request('http://app.test/api/webhooks/creem', { method: 'POST', headers: { 'creem-signature': signature ?? (await sign(raw)) }, body: raw }),
    t.env as never,
    t.ctx,
  );
  await t.settle();
  return res.status;
}
let n = 0;
const event = (eventType: string, object: Record<string, unknown>) => ({ id: `evt_${++n}`, eventType, created_at: Date.now(), object });
const prepaid = () => t.d1.sqlite.exec(`INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', ${Date.now()})`);
const balance = async () => (await t.call('GET', '/api/v1/billing')).body.balanceMicros as number;

/** Starts a top-up checkout as the signed-in user and pays it in Creem. */
async function topUp(productId = 'prod_10') {
  const res = await t.call('POST', '/api/v1/billing/checkout', { productId });
  expect(res.body.url).toMatch(/^https:\/\/checkout\.test\//);
  const id = String(res.body.url).split('/').pop()!;
  return { id, paid: creem.pay(id) };
}

beforeEach(async () => {
  t = setup();
  creem = new FakeCreem();
  vi.stubGlobal('fetch', creem.fetch);
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('pilot@example.com')`);
  Object.assign(t.env, {
    CREEM_API_BASE: BASE,
    CREEM_API_KEY: 'creem_test_key',
    CREEM_WEBHOOK_SECRET: SECRET,
    CREEM_TOPUP_PRODUCTS: 'prod_25, prod_10, prod_sub',
    // The billing queue delivers to the api Worker's own consumer, in process.
    BILLING: {
      send: async (body: { eventId: string }) =>
        worker.queue({ messages: [{ id: body.eventId, body, ack() {}, retry() {} }], queue: 'billing' } as never, t.env as never),
    },
  });
  await signIn(t, 'pilot@example.com');
  userId = (await t.call('GET', '/api/v1/me')).body.user.id;
});
afterEach(() => vi.unstubAllGlobals());

describe('prices', () => {
  const sheet = ProviderPriceSheet.parse(SIMULATED_SHEET);

  it('are the provider cost times the markup, per unit, in micro-dollars', () => {
    expect(customerRates(sheet, 100)).toEqual({ compute: 100_000, ip: 5_000, storage: 80_000, snapshot: 50_000, transfer: 90_000 });
    expect(customerRates(sheet, 120)).toEqual({ compute: 120_000, ip: 6_000, storage: 96_000, snapshot: 60_000, transfer: 108_000 });
    expect(priceVersion(customerRates(sheet, 120), 16)).not.toBe(priceVersion(customerRates(sheet, 125), 16));
  });

  it('estimate what a browser costs running, and per month while it is kept', () => {
    const e = browserEstimate(customerRates(sheet, 120), { storageGb: 10, rootVolumeGb: 16, backups: true });
    expect(e).toMatchObject({ runningHour: 120_000, ipMonth: 4_380_000, storageMonth: 2_496_000, snapshotMonth: 600_000, alwaysOnMonth: 7_476_000 });
  });

  it('are shown per region, and creating needs the version the user saw', async () => {
    const prices = (await t.call('GET', '/api/v1/pricing')).body;
    const tyo = prices.find((p: { regionId: string }) => p.regionId === 'tyo1');
    expect(tyo).toMatchObject({ available: true, source: 'simulated', rootVolumeGb: 16, defaultStorageGb: 10, maxStorageGb: 100 });
    const stale = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1', priceVersion: 'old' }, { 'idempotency-key': 'a' });
    expect(stale).toMatchObject({ status: 409, body: { type: 'price_changed' } });
    const ok = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1', priceVersion: tyo.version }, { 'idempotency-key': 'b' });
    expect(ok.status).toBe(202);
  });

  it('nothing can be bought in a region before its prices are read', async () => {
    t = setup({ prices: false });
    t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('p2@example.com')`);
    await signIn(t, 'p2@example.com');
    expect((await t.call('GET', '/api/v1/pricing')).body[0]).toMatchObject({ available: false, rates: null, version: null });
    const res = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' }, { 'idempotency-key': 'a' });
    expect(res).toMatchObject({ status: 503, body: { type: 'price_unavailable' } });
  });
});

describe('prepaid balance', () => {
  it('runs the pilot for free and requires credit once billing is on', async () => {
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ mode: 'pilot', enabled: true, balanceMicros: 0 });
    prepaid();
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.billing).toBe('prepaid');
    const res = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' }, { 'idempotency-key': 'a' });
    expect(res).toMatchObject({ status: 402, body: { type: 'insufficient_balance' } });
  });

  it('offers the one-time USD top-ups configured in Creem, cheapest first', async () => {
    const b = (await t.call('GET', '/api/v1/billing')).body;
    expect(b.topUps).toEqual([
      { productId: 'prod_10', name: '$10 credit', amountCents: 1000, currency: 'USD' },
      { productId: 'prod_25', name: '$25 credit', amountCents: 2500, currency: 'USD' },
    ]);
    expect((await t.call('POST', '/api/v1/billing/checkout', { productId: 'prod_sub' })).body.type).toBe('validation_failed');
  });

  it('credits a top-up once, from Creem’s record of the paid checkout, never from the redirect', async () => {
    prepaid();
    await t.call('GET', '/api/v1/billing');
    const res = await t.call('POST', '/api/v1/billing/checkout', { productId: 'prod_10' });
    const id = String(res.body.url).split('/').pop()!;
    expect(creem.checkouts.get(id)).toMatchObject({ product: 'prod_10', metadata: { userId } });
    // The buyer comes back before paying: nothing is credited.
    expect(await balance()).toBe(0);
    await webhook(event('checkout.completed', { id, status: 'pending' }));
    expect(await balance()).toBe(0);

    creem.pay(id);
    // The webhook body is not trusted: even a forged amount credits what Creem says was bought.
    const evt = event('checkout.completed', { id, order: { amount: 999_999 } });
    expect(await webhook(evt)).toBe(200);
    expect(await balance()).toBe(10_000_000);
    expect(await webhook(evt)).toBe(200); // duplicate delivery
    await webhook(event('checkout.completed', { id })); // a second event for the same order
    expect(await balance()).toBe(10_000_000);
    expect((await t.call('GET', '/api/v1/billing/transactions')).body).toEqual([
      expect.objectContaining({ kind: 'topup', amountMicros: 10_000_000, description: '$10 credit' }),
    ]);

    // Now a browser can be created, and the receipts portal works.
    expect((await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' }, { 'idempotency-key': 'a' })).status).toBe(202);
    expect((await t.call('POST', '/api/v1/billing/portal')).body.url).toBe('https://portal.test/cust_1');
  });

  it('rejects bad signatures and credits a lost webhook from the nightly check', async () => {
    const { id } = await topUp();
    expect(await webhook(event('checkout.completed', { id }), 'deadbeef')).toBe(401);
    expect(await balance()).toBe(0);
    const db = createDb(t.d1 as never);
    const summary = await billingSweep(t.env as never, db, creemFrom(t.env as never), new Date(), { nightly: true });
    expect(summary.credited).toBe(1);
    expect(await balance()).toBe(10_000_000);
  });

  it('takes refunds back out of the balance, and freezes the account on a dispute', async () => {
    const { id, paid } = await topUp('prod_25');
    await webhook(event('checkout.completed', { id }));
    expect(await balance()).toBe(25_000_000);
    const order = (paid.order as { id: string }).id;
    await webhook(event('refund.created', { id: 'ref_1', refund_amount: 500, order: { id: order } }));
    await webhook(event('refund.created', { id: 'ref_1', refund_amount: 500, order: { id: order } }));
    expect(await balance()).toBe(20_000_000);

    await webhook(event('dispute.created', { id: 'dsp_1', amount: 2500, order: order }));
    const b = (await t.call('GET', '/api/v1/billing')).body;
    expect(b).toMatchObject({ frozen: true, balanceMicros: -5_000_000 });
    expect((await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' }, { 'idempotency-key': 'a' })).body.type).toBe('account_frozen');
  });

  it('sleeps browsers when the balance runs out, warns, keeps them 30 days, then deletes them', async () => {
    prepaid();
    t.d1.sqlite.exec(`INSERT INTO billing_accounts (user_id, balance_micros, updated_at) VALUES ('${userId}', 2000000, ${Date.now()})`);
    await t.call('POST', '/api/v1/instances', { name: 'w', regionId: 'tyo1' }, { 'idempotency-key': 'w' });
    await t.settle();
    const [inst] = (await t.call('GET', '/api/v1/instances')).body;
    expect(inst.status).toBe('running');

    const db = createDb(t.d1 as never);
    t.d1.sqlite.exec(`UPDATE billing_accounts SET balance_micros = 0`);
    const engineDeps = (at: number) => ({ db, now: () => new Date(at), notify: () => {} }) as never;
    const start = Date.now();
    await meterUsage(engineDeps(start)); // runs out: the 10-minute warning starts
    const b = (await t.call('GET', '/api/v1/billing')).body;
    expect(b.exhaustedAt).not.toBeNull();
    expect(Date.parse(b.dataKeptUntil) - start).toBeGreaterThan(29 * 86_400_000);
    expect((await meterUsage(engineDeps(start + 11 * 60_000))).stopped).toBe(1);
    await t.env.OPERATIONS.send({ operationId: (t.d1.sqlite.prepare(`SELECT id FROM operations WHERE kind = 'stop'`).get() as { id: string }).id });
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${inst.id}`)).body.status).toBe('sleeping');
    expect((await t.call('POST', `/api/v1/instances/${inst.id}/start`, undefined, { 'idempotency-key': 's' })).body.type).toBe('insufficient_balance');

    // Day 1: a notice. Day 30: the browsers are deleted (restorable 7 more days, then purged).
    const sweep = (days: number) => billingSweep(t.env as never, db, creemFrom(t.env as never), new Date(start + days * 86_400_000), { nightly: false });
    expect((await sweep(1)).notices).toBe(1);
    expect((await sweep(1)).notices).toBe(0);
    expect(t.emails.at(-1)?.text).toMatch(/kept until/);
    expect((await sweep(30)).deleted).toBe(1);
    await t.settle();
    expect(t.d1.sqlite.prepare(`SELECT desired_state AS d FROM browser_instances`).get()).toEqual({ d: 'deleted' });
  });

  it('emails once when the balance gets low', async () => {
    prepaid();
    t.d1.sqlite.exec(`INSERT INTO billing_accounts (user_id, balance_micros, updated_at) VALUES ('${userId}', 1500000, ${Date.now()})`);
    const db = createDb(t.d1 as never);
    expect((await billingSweep(t.env as never, db, null, new Date(), { nightly: false })).lowBalance).toBe(1);
    expect((await billingSweep(t.env as never, db, null, new Date(), { nightly: false })).lowBalance).toBe(0);
    expect(t.emails.at(-1)?.text).toMatch(/running low/);
  });

  it('answers 503 when Creem is not configured', async () => {
    Object.assign(t.env, { CREEM_API_KEY: undefined });
    expect((await t.call('POST', '/api/v1/billing/checkout', { productId: 'prod_10' })).body.type).toBe('billing_unavailable');
    expect((await t.call('GET', '/api/v1/billing')).body.enabled).toBe(false);
  });
});

describe('storage and usage of one browser', () => {
  it('grows the volume after showing the price, at most once every 6 hours, and never shrinks it', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' }, { 'idempotency-key': 'a' });
    await t.settle();
    const id = created.body.instanceId;
    expect((await t.call('GET', `/api/v1/instances/${id}/storage`)).body).toMatchObject({ sizeGb: 10, rootVolumeGb: 16, maxGb: 100, resizable: true, blockedReason: null });

    expect((await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 8 }, { 'idempotency-key': 'g0' })).status).toBe(400);
    expect((await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 500 }, { 'idempotency-key': 'g1' })).body.type).toBe('plan_limit');
    expect((await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 20, priceVersion: 'old' }, { 'idempotency-key': 'g2' })).body.type).toBe('price_changed');
    const grown = await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 20 }, { 'idempotency-key': 'g3' });
    expect(grown.status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body.storageGb).toBe(20);
    expect((await t.call('GET', `/api/v1/instances/${id}/storage`)).body).toMatchObject({ sizeGb: 20, resizable: false, blockedReason: 'cooldown' });
    expect((await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 30 }, { 'idempotency-key': 'g4' })).body.type).toBe('invalid_state');
  });

  it('shows what the browser has cost this month and what it costs now', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' }, { 'idempotency-key': 'a' });
    await t.settle();
    const id = created.body.instanceId;
    const db = createDb(t.d1 as never);
    const at = Date.now();
    await meterUsage({ db, now: () => new Date(at), notify: () => {} } as never);
    await meterUsage({ db, now: () => new Date(at + 5 * 60_000), notify: () => {} } as never);
    const u = (await t.call('GET', `/api/v1/instances/${id}/usage`)).body;
    expect(u.items.find((i: { item: string }) => i.item === 'compute')).toMatchObject({ amountMicros: 10_000 });
    expect(u.now).toMatchObject({ runningHourMicros: 120_000 });
    expect(u.now.hourMicros).toBeGreaterThan(120_000);
    const account = (await t.call('GET', '/api/v1/usage')).body;
    expect(account.byBrowser).toEqual([expect.objectContaining({ instanceId: id, deleted: false, totalMicros: u.totalMicros })]);
  });
});

describe('free trial', () => {
  const syd = () => t.d1.sqlite.exec(`UPDATE regions SET enabled = 1, executor = 'fake' WHERE id = 'syd1'`);
  const db = () => createDb(t.d1 as never);
  const engineAt = (at: number) => ({ db: db(), now: () => new Date(at), notify: () => {} }) as never;
  const runOps = async () => {
    for (const { id } of t.d1.sqlite.prepare(`SELECT id FROM operations WHERE finished_at IS NULL`).all() as { id: string }[]) {
      await t.env.OPERATIONS.send({ operationId: id });
    }
    await t.settle();
  };

  it('gives each user one free browser in Sydney: 10 minutes, 2 GB, kept 7 days after it sleeps, then reclaimed', async () => {
    const { reclaimTrials } = await import('@cloudbrowser/engine');
    prepaid();
    syd();
    expect((await t.call('GET', '/api/v1/billing')).body.trial).toMatchObject({ eligible: true, regionId: 'syd1', minutes: 10, storageGb: 2, keptDays: 7 });
    expect((await t.call('POST', '/api/v1/instances', { name: 'x', regionId: 'tyo1', trial: true }, { 'idempotency-key': 'x' })).status).toBe(400);
    const created = await t.call('POST', '/api/v1/instances', { name: 'Trial', regionId: 'syd1', trial: true }, { 'idempotency-key': 't1' });
    expect(created.status).toBe(202);
    await t.settle();
    const id = created.body.instanceId;
    const inst = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(inst).toMatchObject({ status: 'running', storageGb: 2, backupsEnabled: false, idleTimeoutS: 300, trial: { state: 'active', secondsLeft: 600 } });
    // Once per user.
    expect((await t.call('GET', '/api/v1/billing')).body.trial.eligible).toBe(false);
    expect((await t.call('POST', '/api/v1/instances', { name: 'again', regionId: 'syd1', trial: true }, { 'idempotency-key': 't2' })).body.type).toBe('invalid_state');
    // No paid extras during the trial.
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { backupsEnabled: true })).body.type).toBe('invalid_state');
    expect((await t.call('GET', `/api/v1/instances/${id}/storage`)).body.blockedReason).toBe('trial');

    // Metered at cost, charged nothing; after 10 minutes of running it goes to sleep.
    const start = Date.now();
    for (let m = 0; m <= 10; m += 5) await meterUsage(engineAt(start + m * 60_000));
    await meterUsage(engineAt(start + 11 * 60_000));
    const rows = t.d1.sqlite.prepare(`SELECT item, amount_micros AS a, cost_micros AS c FROM usage_records WHERE instance_id = ?`).all(id) as { item: string; a: number; c: number }[];
    expect(rows.every((r) => r.a === 0)).toBe(true);
    expect(rows.find((r) => r.item === 'compute')!.c).toBeGreaterThan(0);
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ balanceMicros: 0, exhaustedAt: null });
    await runOps();
    const asleep = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(asleep).toMatchObject({ status: 'sleeping', trial: { state: 'ended', secondsLeft: 0 } });
    expect(Date.parse(asleep.trial.reclaimAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    // Waking needs credit now; without it the browser is reclaimed after 7 days.
    const wake = await t.call('POST', `/api/v1/instances/${id}/start`, undefined, { 'idempotency-key': 'w1' });
    expect(wake.body).toMatchObject({ type: 'insufficient_balance' });
    expect(await reclaimTrials(engineAt(Date.now() + 6 * 86_400_000))).toBe(0);
    expect(await reclaimTrials(engineAt(Date.now() + 8 * 86_400_000))).toBe(1);
    await runOps();
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body.status).toBe('deleting');
    const purgeAfter = t.d1.sqlite.prepare(`SELECT purge_after AS p FROM browser_instances WHERE id = ?`).get(id) as { p: number };
    expect(purgeAfter.p).toBeLessThanOrEqual(Date.now()); // purged on the reaper's next run, not 7 more days later
  });

  it('keeps the same browser when the user pays before it is reclaimed, and charges it from then on', async () => {
    prepaid();
    syd();
    const created = await t.call('POST', '/api/v1/instances', { name: 'Trial', regionId: 'syd1', trial: true }, { 'idempotency-key': 't1' });
    await t.settle();
    const id = created.body.instanceId;
    const before = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    await t.call('POST', `/api/v1/instances/${id}/stop`, undefined, { 'idempotency-key': 's1' });
    await t.settle();

    const { id: checkout } = await topUp();
    await webhook(event('checkout.completed', { id: checkout }));
    const converted = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(converted).toMatchObject({ trial: { state: 'converted', reclaimAt: null }, ipAddress: before.ipAddress, storageGb: 2 });
    expect((await t.call('GET', `/api/v1/instances/${id}/storage`)).body.blockedReason).toBeNull();

    expect((await t.call('POST', `/api/v1/instances/${id}/start`, undefined, { 'idempotency-key': 'w1' })).status).toBe(202);
    await t.settle();
    const start = Date.now();
    await meterUsage(engineAt(start));
    await meterUsage(engineAt(start + 5 * 60_000));
    const compute = t.d1.sqlite.prepare(`SELECT amount_micros AS a FROM usage_records WHERE instance_id = ? AND item = 'compute' AND amount_micros > 0`).get(id) as { a: number };
    expect(compute.a).toBe(10_000); // 5 minutes at $0.12/h
    expect((await t.call('GET', '/api/v1/billing')).body.balanceMicros).toBeLessThan(10_000_000);
  });
});
