import { browserEstimate, costRates, customerRates, minimumMarkupPercent, priceVersion, ProviderPriceSheet, splitUsagePeriod } from '@cloudbrowser/contracts';
import { meterUsage } from '@cloudbrowser/engine';
import { createDb, prepaidBalance, reservationQuote } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { billingSweep } from '../src/billing/sweep.js';
import { creemFrom } from '../src/billing/creem.js';
import { applyBalance } from '../src/billing/ledger.js';
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
    const net = Number(this.products[String(c.product)]!.price);
    const tax = Math.round(net / 10);
    this.checkouts.set(id, { ...c, status: 'completed', order: { id: orderId, status: 'paid', amount: net + tax, amount_paid: net + tax, sub_total: net, tax_amount: tax, currency: 'USD' }, customer: { id: 'cust_1' } });
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
const prepaid = () => t.d1.sqlite.exec(`INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = 'true'`);
const quoteVersion = async (regionId: string) => ((await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === regionId)?.version ?? 'unavailable') as string;
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

  const markup = (percent: number, relayGbMicros = 0) => ({ markupPercent: percent, fixedMarkupPercent: percent, transferMarkupPercent: percent, relayGbMicros });

  it('are the provider cost times the markup, per unit, in micro-dollars', () => {
    expect(customerRates(sheet, markup(100))).toEqual({ compute: 100_000, ip: 5_000, storage: 80_000, snapshot: 50_000, transfer: 90_000 });
    expect(customerRates(sheet, markup(120))).toEqual({ compute: 120_000, ip: 6_000, storage: 96_000, snapshot: 60_000, transfer: 108_000 });
    expect(priceVersion(customerRates(sheet, markup(120)), 16)).not.toBe(priceVersion(customerRates(sheet, markup(125)), 16));
  });

  it('mark each kind of cost up separately and add the relay to data transfer', () => {
    const factors = { markupPercent: 130, fixedMarkupPercent: 110, transferMarkupPercent: 150, relayGbMicros: 50_000 };
    expect(costRates(sheet, 50_000)).toMatchObject({ compute: 100_000, transfer: 140_000 });
    expect(customerRates(sheet, factors)).toEqual({ compute: 130_000, ip: 5_500, storage: 88_000, snapshot: 55_000, transfer: 210_000 });
    expect(minimumMarkupPercent(390)).toBe(104);
  });

  it('estimate what a browser costs running, and per month while it is kept', () => {
    const e = browserEstimate(customerRates(sheet, markup(120)), { storageGb: 10, rootVolumeGb: 16, backups: true });
    expect(e).toMatchObject({ runningHour: 120_000, ipMonth: 4_380_000, storageMonth: 2_496_000, snapshotMonth: 600_000, alwaysOnMonth: 7_476_000 });
  });

  it('are shown per region, and creating needs the version the user saw', async () => {
    const prices = (await t.call('GET', '/api/v1/pricing')).body;
    const tyo = prices.find((p: { regionId: string }) => p.regionId === 'tyo1');
    expect(tyo).toMatchObject({ available: true, source: 'simulated', rootVolumeGb: 16, defaultStorageGb: 10, maxStorageGb: 100 });
    const stale = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1', priceVersion: 'old' , storageGb: 10}, { 'idempotency-key': 'a' });
    expect(stale).toMatchObject({ status: 409, body: { type: 'price_changed' } });
    const ok = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1', priceVersion: tyo.version , storageGb: 10}, { 'idempotency-key': 'b' });
    expect(ok.status).toBe(202);
  });

  it('nothing can be bought in a region before its prices are read', async () => {
    t = setup({ prices: false });
    t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('p2@example.com')`);
    await signIn(t, 'p2@example.com');
    expect((await t.call('GET', '/api/v1/pricing')).body[0]).toMatchObject({ available: false, rates: null, version: null });
    const res = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' , storageGb: 10, priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'a' });
    expect(res).toMatchObject({ status: 503, body: { type: 'price_unavailable' } });
  });
});

describe('prepaid balance', () => {
  it('runs the pilot for free and requires credit once billing is on', async () => {
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ mode: 'pilot', enabled: true, balanceMicros: 0 });
    prepaid();
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.billing).toBe('prepaid');
    const res = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' , storageGb: 10, priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'a' });
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
    expect((await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' , storageGb: 10, priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'a' })).status).toBe(202);
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
    await webhook(event('refund.created', { id: 'ref_1', refund_amount: 550, refund_currency: 'USD', status: 'succeeded', order: { id: order } }));
    await webhook(event('refund.created', { id: 'ref_1', refund_amount: 550, refund_currency: 'USD', status: 'succeeded', order: { id: order } }));
    expect(await balance()).toBe(20_000_000);

    await webhook(event('dispute.created', { id: 'dsp_1', amount: 2750, currency: 'USD', order: order }));
    const b = (await t.call('GET', '/api/v1/billing')).body;
    expect(b).toMatchObject({ frozen: true, balanceMicros: 0 });
    expect((await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' , storageGb: 10, priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'a' })).body.type).toBe('account_frozen');
  });

  it('sleeps browsers as available credit runs out, warns, and permanently deletes them after seven days', async () => {
    prepaid();
    const db = createDb(t.d1 as never);
    const quote = (await reservationQuote(db, 'tyo1', { storageGb: 10, backupsEnabled: false }))!;
    await applyBalance(db, { userId, kind: 'adjustment', amountMicros: quote.requiredMicros + 1_000_000, reference: 'retention-credit', actor: 'test' }, new Date());
    expect((await t.call('POST', '/api/v1/instances', { name: 'w', regionId: 'tyo1' , storageGb: 10, priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'w' })).status).toBe(202);
    await t.settle();
    const [inst] = (await t.call('GET', '/api/v1/instances')).body;
    expect(inst.status).toBe('running');

    await applyBalance(db, { userId, kind: 'adjustment', amountMicros: -(await prepaidBalance(db, userId)).availableMicros, reference: 'use-available-credit', actor: 'test' }, new Date());
    const engineDeps = (at: number) => ({ db, now: () => new Date(at), notify: () => {} }) as never;
    const start = Date.now();
    expect((await meterUsage(engineDeps(start))).stopped).toBe(1);
    const b = (await t.call('GET', '/api/v1/billing')).body;
    expect(b.exhaustedAt).not.toBeNull();
    expect(Date.parse(b.dataKeptUntil) - start).toBe(7 * 86_400_000);
    expect(b).toMatchObject({ balanceMicros: quote.requiredMicros, reservedMicros: quote.requiredMicros, availableMicros: 0 });
    await t.env.OPERATIONS.send({ operationId: (t.d1.sqlite.prepare(`SELECT id FROM operations WHERE kind = 'stop'`).get() as { id: string }).id });
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${inst.id}`)).body.status).toBe('sleeping');
    expect((await t.call('POST', `/api/v1/instances/${inst.id}/start`, undefined, { 'idempotency-key': 's' })).body.type).toBe('insufficient_balance');

    // The stopped browser, its deletion time and the top-up that keeps it, in the app and by email.
    const deletesAt = new Date(start + 7 * 86_400_000);
    expect((await t.call('GET', `/api/v1/instances/${inst.id}`)).body).toMatchObject({ stopReason: 'balance', deletesAt: deletesAt.toISOString() });
    const kept = (await t.call('GET', '/api/v1/billing')).body;
    expect(kept.retained).toEqual([{ id: inst.id, name: 'w', regionId: 'tyo1', deletesAt: deletesAt.toISOString() }]);
    // The deposit is the whole balance now, so the minimum balance is what is missing.
    expect(kept.restoreNeededMicros).toBe(Math.max(1, kept.minBalanceMicros));
    const sweep = (days: number) => billingSweep(t.env as never, db, creemFrom(t.env as never), new Date(start + days * 86_400_000), { nightly: false });
    expect((await sweep(1)).notices).toBe(1);
    expect((await sweep(1)).notices).toBe(0);
    const notice = t.emails.at(-1)!;
    expect(notice.subject).toMatch(/credit ran out/);
    expect(notice.text).toContain(`w (Tokyo): ${deletesAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    expect(notice.text).toMatch(/add at least \$\d+\.\d\d/);
    expect(notice.text).toMatch(/None restarts by itself/);
    // Three days on, then a final reminder within a day of deletion; each once.
    expect((await sweep(3)).notices).toBe(1);
    expect((await sweep(4)).notices).toBe(0);
    expect((await sweep(6.5)).notices).toBe(1);
    expect(t.emails.at(-1)!.subject).toMatch(/Final reminder/);
    expect((await sweep(6.9)).notices).toBe(0);
    expect((await sweep(7)).deleted).toBe(1);
    await t.settle();
    expect(t.d1.sqlite.prepare(`SELECT desired_state AS d FROM browser_instances`).get()).toEqual({ d: 'deleted' });
    expect(JSON.parse(String((t.d1.sqlite.prepare("SELECT params FROM operations WHERE kind = 'delete'").get() as { params: string }).params))).toMatchObject({ purgeNow: true });
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
  it('grows the volume after showing the price, up to four times per rolling day, and never shrinks it', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' , storageGb: 10, priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'a' });
    await t.settle();
    const id = created.body.instanceId;
    expect((await t.call('GET', `/api/v1/instances/${id}/storage`)).body).toMatchObject({ sizeGb: 10, rootVolumeGb: 16, maxGb: 100, resizable: true, blockedReason: null });

    expect((await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 8 , priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'g0' })).status).toBe(400);
    expect((await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 500 , priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'g1' })).body.type).toBe('plan_limit');
    expect((await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 20, priceVersion: 'old' }, { 'idempotency-key': 'g2' })).body.type).toBe('price_changed');
    const grown = await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 20 , priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'g3' });
    expect(grown.status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body.storageGb).toBe(20);
    expect((await t.call('GET', `/api/v1/instances/${id}/storage`)).body).toMatchObject({ sizeGb: 20, resizable: true, blockedReason: null });
    // Completing one change permits the next immediately; the former six-hour delay is gone.
    for (const sizeGb of [30, 40, 50]) {
      expect((await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb, priceVersion: await quoteVersion('tyo1') }, { 'idempotency-key': `grow-${sizeGb}` })).status).toBe(202);
      await t.settle();
    }
    expect((await t.call('GET', `/api/v1/instances/${id}/storage`)).body).toMatchObject({ sizeGb: 50, resizable: false, blockedReason: 'cooldown', nextResizeAt: expect.any(String) });
    expect((await t.call('POST', `/api/v1/instances/${id}/storage`, { sizeGb: 60 , priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'g4' })).body.type).toBe('invalid_state');
  });

  it('shows what the browser has cost this month and what it costs now', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1' , storageGb: 10, priceVersion: await quoteVersion('tyo1')}, { 'idempotency-key': 'a' });
    await t.settle();
    const id = created.body.instanceId;
    const db = createDb(t.d1 as never);
    const at = Date.now();
    await meterUsage({ db, now: () => new Date(at), notify: () => {} } as never);
    await meterUsage({ db, now: () => new Date(at + 5 * 60_000), notify: () => {} } as never);
    const u = (await t.call('GET', `/api/v1/instances/${id}/usage`)).body;
    expect(u.items.find((i: { item: string }) => i.item === 'compute')).toMatchObject({ amountMicros: 0 });
    const recorded = t.d1.sqlite.prepare("SELECT amount_micros AS estimate, cost_micros AS cost, charged_micros AS charged FROM usage_records WHERE item = 'compute'").get() as { estimate: number; cost: number; charged: number };
    expect(recorded.estimate).toBeGreaterThanOrEqual(10_000);
    expect(recorded.cost).toBeGreaterThan(0);
    expect(recorded.charged).toBe(0); // The free pilot shows usage without collecting it.
    expect(u.now).toMatchObject({ runningHourMicros: 120_000 });
    expect(u.now.hourMicros).toBeGreaterThan(120_000);
    const account = (await t.call('GET', '/api/v1/usage')).body;
    expect(account.byBrowser).toEqual([expect.objectContaining({ instanceId: id, deleted: false, totalMicros: u.totalMicros })]);
  });
});

describe('billing failure and concurrency regressions', () => {
  const db = () => createDb(t.d1 as never);
  const at = (time: number) => ({ db: db(), now: () => new Date(time), notify: () => {} }) as never;
  const sqlOne = (query: string) => t.d1.sqlite.prepare(query).get() as Record<string, number | string | null>;
  async function browser() {
    const { applyBalance } = await import('../src/billing/ledger.js');
    await applyBalance(db(), { userId, kind: 'adjustment', amountMicros: 10_000_000, reference: 'seed', actor: 'test' }, new Date());
    prepaid();
    const r = await t.call('POST', '/api/v1/instances', { name: 'Metered', regionId: 'tyo1', storageGb: 10, priceVersion: await quoteVersion('tyo1') }, { 'idempotency-key': 'metered' });
    expect(r.status).toBe(202);
    await t.settle();
    return r.body.instanceId as string;
  }
  function charged() { return Number(sqlOne('SELECT coalesce(sum(charged_micros), 0) AS n FROM usage_records').n); }

  it('rolls back the cursor, traffic counter and debit if writing usage fails, then safely retries', async () => {
    const id = await browser();
    const start = Date.now();
    await meterUsage(at(start));
    // Initial metering may charge the milliseconds since creation on a busy test runner.
    const balanceBefore = await balance();
    const chargedBefore = charged();
    t.d1.sqlite.exec(`UPDATE instance_health SET net_tx_bytes = 1000000000, net_tx_billed_bytes = 0 WHERE instance_id = '${id}';
      CREATE TRIGGER meter_fault BEFORE INSERT ON usage_records BEGIN SELECT RAISE(ABORT, 'usage unavailable'); END;`);
    await expect(meterUsage(at(start + 60_000))).rejects.toThrow(/usage unavailable/);
    expect(sqlOne(`SELECT base_metered_at AS cursor, net_tx_billed_bytes AS tx FROM instance_health WHERE instance_id = '${id}'`)).toEqual({ cursor: start, tx: 0 });
    expect(await balance()).toBe(balanceBefore);
    expect(charged()).toBe(chargedBefore);
    t.d1.sqlite.exec('DROP TRIGGER meter_fault');
    const done = await meterUsage(at(start + 60_000));
    expect(done.chargedMicros).toBe(charged() - chargedBefore);
    expect(charged()).toBeGreaterThan(100_000); // the unbilled transfer survived rollback
    expect(10_000_000 - await balance()).toBe(charged());
    await meterUsage(at(start + 60_000));
    expect(10_000_000 - await balance()).toBe(charged());
  });

  it('does not let an overlapping older cron overwrite a newer cursor or debit the same interval', async () => {
    const id = await browser();
    const start = Date.now();
    await meterUsage(at(start));
    const computeBefore = Number(sqlOne("SELECT coalesce(sum(quantity), 0) AS q FROM usage_records WHERE item = 'compute'").q);
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
    const older = meterUsage(at(start + 60_000));
    await reached;
    expect((await meterUsage(at(start + 120_000))).metered).toBe(1);
    release();
    expect((await older).metered).toBe(0);
    t.d1.batch = original;
    expect(sqlOne(`SELECT base_metered_at AS cursor FROM instance_health WHERE instance_id = '${id}'`).cursor).toBe(start + 120_000);
    await meterUsage(at(start + 180_000));
    expect(Number(sqlOne("SELECT quantity AS q FROM usage_records WHERE item = 'compute'").q) - computeBefore).toBeCloseTo(3 / 60, 10);
    expect(10_000_000 - await balance()).toBe(charged());
  });

  it('keeps pilot estimates separate from revenue after billing is enabled', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Pilot', regionId: 'tyo1', storageGb: 10, priceVersion: await quoteVersion('tyo1') }, { 'idempotency-key': 'pilot' });
    expect(created.status).toBe(202);
    await t.settle();
    const start = Date.now();
    await meterUsage(at(start));
    await meterUsage(at(start + 60_000));
    const estimate = Number(sqlOne('SELECT sum(amount_micros) AS n FROM usage_records').n);
    expect(estimate).toBeGreaterThan(0);
    expect(charged()).toBe(0);
    const { applyBalance } = await import('../src/billing/ledger.js');
    await applyBalance(db(), { userId, kind: 'adjustment', amountMicros: 10_000_000, reference: 'pilot-credit', actor: 'test' }, new Date());
    prepaid();
    await meterUsage(at(start + 120_000));
    expect(charged()).toBeGreaterThan(0);
    expect(charged()).toBeLessThan(Number(sqlOne('SELECT sum(amount_micros) AS n FROM usage_records').n));
    expect(10_000_000 - await balance()).toBe(charged());
  });

  it('uses the existing machine price times markup and its actual root disk size', async () => {
    const id = await browser();
    const sheet = { ...SIMULATED_SHEET, instanceTypes: { ...SIMULATED_SHEET.instanceTypes, 'old.large': 0.2 } };
    t.d1.sqlite.prepare('UPDATE provider_prices SET sheet = ?').run(JSON.stringify(sheet));
    t.d1.sqlite.prepare('UPDATE placements SET instance_type = ?, root_volume_gb = ? WHERE instance_id = ?').run('old.large', 32, id);
    const start = Date.now();
    await meterUsage(at(start));
    await meterUsage(at(start + 300_000));
    expect(sqlOne("SELECT unit_price_micros AS price, unit_cost_micros AS cost FROM usage_records WHERE item = 'compute'")).toEqual({ price: 240_000, cost: 200_000 });
    const monthFraction = splitUsagePeriod(new Date(start), new Date(start + 300_000)).reduce((sum, p) => sum + p.monthFraction, 0);
    expect(Number(sqlOne("SELECT quantity AS q FROM usage_records WHERE item = 'storage'").q)).toBeCloseTo(42 * monthFraction, 10);
  });

  it('does not invent cost for a known unpriced machine or advance its billing cursor', async () => {
    const id = await browser();
    const start = Date.now();
    await meterUsage(at(start));
    const chargedBefore = charged();
    t.d1.sqlite.prepare('UPDATE placements SET instance_type = ? WHERE instance_id = ?').run('unknown.large', id);
    await meterUsage(at(start + 60_000));
    await meterUsage(at(start + 120_000));
    expect(sqlOne(`SELECT base_metered_at AS cursor FROM instance_health WHERE instance_id = '${id}'`).cursor).toBe(start);
    expect(charged()).toBe(chargedBefore);
    expect(sqlOne("SELECT count(*) AS n FROM alerts WHERE dedupe_key LIKE 'machine-price:%'").n).toBe(1);
  });

  it('records retained system-deletion costs without charging the customer, stopping each cost when its resource is gone', async () => {
    const id = await browser();
    const start = Date.now();
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'deleting', desired_state = 'deleted', deleted_at = ?, purge_after = ? WHERE id = ?").run(start, start + 7 * 86_400_000, id);
    await meterUsage(at(start));
    await meterUsage(at(start + 300_000));
    const before = Number(sqlOne("SELECT quantity AS q FROM usage_records WHERE item = 'storage'").q);
    const monthFraction = (from: number, to: number) => splitUsagePeriod(new Date(from), new Date(to)).reduce((sum, p) => sum + p.monthFraction, 0);
    expect(before).toBeCloseTo(26 * monthFraction(start, start + 300_000), 10);
    expect(charged()).toBe(0);
    expect(await balance()).toBe(10_000_000);
    expect(Number(sqlOne('SELECT sum(cost_micros) AS c FROM usage_records').c)).toBeGreaterThan(0);
    t.d1.sqlite.prepare("UPDATE resources SET state = 'deleted' WHERE instance_id = ? AND kind = 'vm'").run(id);
    await meterUsage(at(start + 600_000));
    expect(Number(sqlOne("SELECT quantity AS q FROM usage_records WHERE item = 'storage'").q) - before).toBeCloseTo(10 * monthFraction(start + 300_000, start + 600_000), 10);
    const cost = Number(sqlOne('SELECT sum(cost_micros) AS c FROM usage_records').c);
    t.d1.sqlite.prepare("UPDATE resources SET state = 'deleted' WHERE instance_id = ?").run(id);
    await meterUsage(at(start + 900_000));
    expect(Number(sqlOne('SELECT sum(cost_micros) AS c FROM usage_records').c)).toBe(cost);
    expect(await balance()).toBe(10_000_000);
  });

  it('saves a browser if its owner funds the deposit while a seven-day deletion sweep is admitting work', async () => {
    const id = await browser();
    const now = Date.now();
    expect((await t.call('POST', `/api/v1/instances/${id}/stop`, undefined, { 'idempotency-key': 'before-retention' })).status).toBe(202);
    await t.settle();
    await applyBalance(db(), { userId, kind: 'adjustment', amountMicros: -(await prepaidBalance(db(), userId)).availableMicros, reference: 'race-exhaust', actor: 'test' }, new Date(now));
    await meterUsage(at(now));
    const original = t.d1.batch.bind(t.d1);
    let topped = false;
    t.d1.batch = (async (statements: D1PreparedStatement[]) => {
      if (!topped) {
        topped = true;
        const { applyBalance } = await import('../src/billing/ledger.js');
        await applyBalance(db(), { userId, kind: 'adjustment', amountMicros: 10_000_000, reference: 'race-topup', actor: 'test' }, new Date(now));
      }
      return original(statements);
    }) as typeof t.d1.batch;
    try {
      expect((await billingSweep(t.env as never, db(), null, new Date(now + 7 * 86_400_000), { nightly: false })).deleted).toBe(0);
    } finally {
      t.d1.batch = original;
    }
    expect(topped).toBe(true); // The sweep really selected an expired hold before the top-up.
    expect(sqlOne(`SELECT desired_state AS state FROM browser_instances WHERE id = '${id}'`).state).toBe('stopped');
    expect(sqlOne(`SELECT retention_started_at AS at FROM browser_reservations WHERE instance_id = '${id}'`).at).toBeNull();
    expect(sqlOne("SELECT count(*) AS n FROM operations WHERE kind = 'delete'").n).toBe(0);
  });
});

describe('payment reconciliation regressions', () => {
  it('credits the settled net amount when catalog prices change or checkout discounts apply', async () => {
    const { id, paid } = await topUp();
    t.d1.sqlite.exec("UPDATE topup_packs SET amount_cents = 2500 WHERE product_id = 'prod_10'");
    creem.checkouts.set(id, { ...paid, order: { ...(paid.order as object), amount: 1100, amount_paid: 880, tax_amount: 80 } });
    await webhook(event('checkout.completed', { id }));
    expect(await balance()).toBe(8_000_000);
    expect(t.d1.sqlite.prepare('SELECT gross_amount_cents AS gross, amount_micros AS net, currency FROM balance_transactions').get()).toEqual({ gross: 880, net: 8_000_000, currency: 'USD' });
  });

  it('rejects a paid checkout with mismatched local identity, product or currency', async () => {
    const { creditCheckout } = await import('../src/billing/webhooks.js');
    const { id, paid } = await topUp();
    const creemApi = creemFrom(t.env as never)!;
    const db = createDb(t.d1 as never);
    for (const changed of [
      { ...paid, id: 'other-checkout' },
      { ...paid, request_id: 'unrelated-request' },
      { ...paid, product: 'prod_25' },
      { ...paid, metadata: { userId: 'other-user' } },
      { ...paid, order: { ...(paid.order as object), currency: 'EUR' } },
      { ...paid, order: { ...(paid.order as object), amount_paid: 0 } },
      { ...paid, order: { ...(paid.order as object), status: 'pending' } },
    ]) {
      creem.checkouts.set(id, changed);
      await expect(creditCheckout(db, creemApi, id, new Date())).rejects.toThrow();
      expect(await balance()).toBe(0);
    }
  });

  it('retains an early refund or dispute until the checkout credit arrives, even after 10 retry attempts', async () => {
    const { pendingWebhooks } = await import('../src/billing/webhooks.js');
    const { id, paid } = await topUp();
    const order = (paid.order as { id: string }).id;
    const refund = event('refund.created', { id: 'early-refund', refund_amount: 550, refund_currency: 'USD', status: 'succeeded', order });
    const dispute = event('dispute.created', { id: 'early-dispute', amount: 1100, currency: 'USD', transaction: { order } });
    await webhook(refund);
    await webhook(dispute);
    expect(await balance()).toBe(0);
    t.d1.sqlite.exec('UPDATE webhook_events SET attempts = 11');
    const db = createDb(t.d1 as never);
    const later = new Date(Date.now() + 120_000);
    expect(await pendingWebhooks(db, later)).toEqual(expect.arrayContaining([refund.id, dispute.id]));
    await webhook(event('checkout.completed', { id }));
    await billingSweep(t.env as never, db, creemFrom(t.env as never), later, { nightly: false });
    expect(await balance()).toBe(0);
    expect((await t.call('GET', '/api/v1/billing')).body.frozen).toBe(true);
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NULL').get()).toEqual({ n: 0 });
  });

  it('caps concurrent refund events at the original net credit including tax', async () => {
    const { processWebhook } = await import('../src/billing/webhooks.js');
    const { id, paid } = await topUp();
    await webhook(event('checkout.completed', { id }));
    const order = (paid.order as { id: string }).id;
    const a = event('refund.created', { id: 'ref-a', refund_amount: 1100, refund_currency: 'USD', status: 'succeeded', order });
    const b = event('refund.created', { id: 'ref-b', refund_amount: 1100, refund_currency: 'USD', status: 'succeeded', order });
    const { schema } = await import('@cloudbrowser/db');
    const db = createDb(t.d1 as never);
    for (const e of [a, b]) await db.insert(schema.webhookEvents).values({ id: e.id, type: e.eventType, payload: e, receivedAt: new Date() });
    const original = t.d1.batch.bind(t.d1);
    let tail = Promise.resolve();
    t.d1.batch = ((statements: D1PreparedStatement[]) => {
      const result = tail.then(() => original(statements));
      tail = result.then(() => {}, () => {});
      return result;
    }) as typeof t.d1.batch;
    await Promise.all([a, b].map((e) => processWebhook(t.env as never, db, creemFrom(t.env as never)!, e.id)));
    expect(await balance()).toBe(0);
    expect(t.d1.sqlite.prepare("SELECT sum(amount_micros) AS amount FROM balance_transactions WHERE kind = 'refund'").get()).toEqual({ amount: -10_000_000 });
  });
});
