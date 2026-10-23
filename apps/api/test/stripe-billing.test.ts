import { createDb } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { paymentProviders } from '../src/billing/providers.js';
import { formEncode, parsePrice, stripeFrom, verifyStripeSignature } from '../src/billing/stripe.js';
import { creditStripeCheckout, processStripeWebhook } from '../src/billing/stripe-webhooks.js';
import { billingSweep } from '../src/billing/sweep.js';
import { setup, signIn } from './helpers.js';

const STRIPE_KEY = 'sk_test_51TestKeyForNevazuBilling0000';
const STRIPE_SECRET = 'whsec_testSigningSecretForNevazu0000';
const CREEM_SECRET = 'whsec_test';
const STRIPE_CONFIG = {
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
  STRIPE_TOPUP_PRICES: 'price_25usd00001, price_10usd00001, price_anyusd0001, price_monthly001, price_eur0000001, price_usdgbp0001',
};

const hmacHex = async (secret: string, text: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const stripeSignature = async (raw: string, at = Math.floor(Date.now() / 1000), secret = STRIPE_SECRET) => `t=${at},v1=${await hmacHex(secret, `${at}.${raw}`)}`;

type Json = Record<string, unknown>;

/**
 * A stand-in for Stripe's API (page 6): prices with their products, Checkout Sessions, the
 * PaymentIntents and charges behind them, refunds, disputes and the customer portal. Requests are
 * form-encoded and must carry the secret key and a pinned Stripe-Version.
 */
class FakeStripe {
  products: Record<string, Json> = {
    prod_10: { id: 'prod_10', name: '$10 credit', active: true },
    prod_25: { id: 'prod_25', name: '$25 credit', active: true },
    prod_any: { id: 'prod_any', name: 'Credit', active: true },
    prod_sub: { id: 'prod_sub', name: 'Monthly', active: true },
    prod_eur: { id: 'prod_eur', name: 'Euro credit', active: true },
  };
  prices: Record<string, Json> = {
    price_10usd00001: { id: 'price_10usd00001', object: 'price', active: true, type: 'one_time', currency: 'usd', unit_amount: 1000, custom_unit_amount: null, product: 'prod_10' },
    price_25usd00001: { id: 'price_25usd00001', object: 'price', active: true, type: 'one_time', currency: 'usd', unit_amount: 2500, custom_unit_amount: null, product: 'prod_25' },
    price_anyusd0001: { id: 'price_anyusd0001', object: 'price', active: true, type: 'one_time', currency: 'usd', unit_amount: null, custom_unit_amount: { minimum: 500, maximum: 100000, preset: 2000 }, product: 'prod_any' },
    price_monthly001: { id: 'price_monthly001', object: 'price', active: true, type: 'recurring', currency: 'usd', unit_amount: 900, custom_unit_amount: null, product: 'prod_sub' },
    price_eur0000001: { id: 'price_eur0000001', object: 'price', active: true, type: 'one_time', currency: 'eur', unit_amount: 1000, custom_unit_amount: null, product: 'prod_eur' },
    // USD with a GBP option: Checkout would charge a UK buyer in GBP.
    price_usdgbp0001: { id: 'price_usdgbp0001', object: 'price', active: true, type: 'one_time', currency: 'usd', unit_amount: 1000, custom_unit_amount: null, product: 'prod_10', currency_options: { usd: { unit_amount: 1000 }, gbp: { unit_amount: 800 } } },
  };
  /** Customers that exist in this account and mode; Checkout makes `cus_new1` for a new buyer. */
  customers = new Set(['cus_new1']);
  sessions = new Map<string, Json>();
  intents = new Map<string, Json>();
  charges = new Map<string, Json>();
  refunds: Json[] = [];
  disputes = new Map<string, Json>();
  calls: { method: string; path: string; params: URLSearchParams; headers: Record<string, string> }[] = [];
  /** Whether the dashboard has a Terms of Service URL (needed for the consent checkbox). */
  termsUrl = true;
  private n = 0;

  /** The buyer pays the hosted checkout. A custom amount is what they typed; `unpaid` is a delayed method. */
  pay(id: string, opts: { amount?: number; tax?: number; unpaid?: boolean } = {}) {
    const s = this.sessions.get(id)!;
    const price = this.prices[String(s.price)]!;
    const net = opts.amount ?? Number(price.unit_amount);
    const tax = opts.tax ?? Math.round(net / 5);
    const pi = `pi_${id}`;
    this.intents.set(pi, { id: pi, object: 'payment_intent', metadata: s.intent_metadata ?? {} });
    this.charges.set(`ch_${id}`, { id: `ch_${id}`, object: 'charge', payment_intent: pi });
    this.sessions.set(id, {
      ...s, status: 'complete', payment_status: opts.unpaid ? 'unpaid' : 'paid', payment_intent: pi,
      customer: s.customer ?? 'cus_new1', amount_subtotal: net, amount_total: net + tax, total_details: { amount_tax: tax, amount_discount: 0, amount_shipping: 0 },
    });
    return { pi, charge: `ch_${id}` };
  }
  refund(pi: string, amount: number, status = 'succeeded') {
    const id = `re_${++this.n}`;
    this.refunds.unshift({ id, object: 'refund', status, amount, currency: 'usd', payment_intent: pi, charge: `ch_${pi.slice(3)}` });
    return id;
  }
  dispute(pi: string, amount: number, status = 'needs_response') {
    const id = `du_${++this.n}`;
    this.disputes.set(id, { id, object: 'dispute', status, amount, currency: 'usd', payment_intent: pi, charge: `ch_${pi.slice(3)}` });
    return id;
  }
  /** Another sale on the same Stripe account, made without this app. */
  foreignPayment() {
    const pi = `pi_foreign${++this.n}`;
    this.intents.set(pi, { id: pi, object: 'payment_intent', metadata: {} });
    this.charges.set(`ch_${pi.slice(3)}`, { id: `ch_${pi.slice(3)}`, payment_intent: pi });
    return pi;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const params = method === 'POST' ? new URLSearchParams(String(init?.body ?? '')) : url.searchParams;
    this.calls.push({ method, path: url.pathname, params, headers });
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    const fail = (status: number, message: string, param?: string) => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message, param } }), { status });
    if (headers.authorization !== `Bearer ${STRIPE_KEY}`) return fail(401, 'Invalid API Key provided');
    if (!/^\d{4}-\d{2}-\d{2}\.\w+$/.test(headers['stripe-version'] ?? '')) return fail(400, 'no pinned version');
    const [, , kind, id, sub] = url.pathname.split('/');
    if (method === 'GET' && kind === 'prices') {
      const p = this.prices[id!];
      if (!p) return fail(404, 'No such price');
      // `currency_options` is includable: only returned when expanded.
      const { currency_options: options, ...price } = p;
      return ok({ ...price, product: this.expand(url).includes('product') ? this.products[String(p.product)] : p.product, ...(this.expand(url).includes('currency_options') && options ? { currency_options: options } : {}) });
    }
    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      if (params.get('consent_collection[terms_of_service]') && !this.termsUrl) {
        return fail(400, 'You cannot collect consent to your terms of service unless a URL is set in the Stripe Dashboard.', 'consent_collection[terms_of_service]');
      }
      const customer = params.get('customer');
      if (customer && !this.customers.has(customer)) return fail(400, `No such customer: '${customer}'; a similar object exists in test mode`, 'customer');
      const sid = `cs_test_${this.sessions.size + 1}`;
      const price = params.get('line_items[0][price]')!;
      this.sessions.set(sid, {
        id: sid, object: 'checkout.session', url: `https://checkout.stripe.test/c/pay/${sid}`, status: 'open', payment_status: 'unpaid',
        client_reference_id: params.get('client_reference_id'), currency: 'usd', amount_total: null, total_details: null,
        customer: params.get('customer'), payment_intent: null, price,
        metadata: { userId: params.get('metadata[userId]'), attemptId: params.get('metadata[attemptId]') },
        intent_metadata: { userId: params.get('payment_intent_data[metadata][userId]'), attemptId: params.get('payment_intent_data[metadata][attemptId]') },
      });
      return ok(this.sessions.get(sid));
    }
    if (method === 'GET' && kind === 'checkout' && id === 'sessions') {
      const s = this.sessions.get(sub!);
      if (!s) return fail(404, 'No such checkout.session');
      const expanded = this.expand(url).includes('line_items');
      const { price, intent_metadata: _, ...rest } = s;
      return ok({ ...rest, ...(expanded ? { line_items: { object: 'list', data: [{ price: this.prices[String(price)] }], has_more: false } } : {}) });
    }
    if (method === 'GET' && kind === 'charges') return this.charges.has(id!) ? ok(this.charges.get(id!)) : fail(404, 'No such charge');
    if (method === 'GET' && kind === 'payment_intents') return this.intents.has(id!) ? ok(this.intents.get(id!)) : fail(404, 'No such payment_intent');
    if (method === 'GET' && kind === 'refunds' && id) {
      const r = this.refunds.find((x) => x.id === id);
      return r ? ok(r) : fail(404, 'No such refund');
    }
    if (method === 'GET' && kind === 'refunds') return ok({ object: 'list', data: this.refunds.filter((r) => r.payment_intent === url.searchParams.get('payment_intent')), has_more: false });
    if (method === 'GET' && kind === 'disputes') return this.disputes.has(id!) ? ok(this.disputes.get(id!)) : fail(404, 'No such dispute');
    if (method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
      const customer = params.get('customer')!;
      return this.customers.has(customer) ? ok({ id: 'bps_1', url: `https://billing.stripe.test/p/session/${customer}` }) : fail(400, `No such customer: '${customer}'`, 'customer');
    }
    return fail(500, `unexpected ${method} ${url.pathname}`);
  };

  private expand(url: URL) {
    return [...url.searchParams].filter(([k]) => /^expand\[\d*\]$/.test(k)).map(([, v]) => v);
  }

  /** The last Checkout Session created, as Stripe received it. */
  lastCheckout() {
    return this.calls.filter((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions').at(-1)!.params;
  }
}

/** Just enough of Creem (see billing.test.ts) to show it keeps working beside Stripe. */
class FakeCreem {
  checkouts = new Map<string, Json>();
  pay(id: string) {
    const c = this.checkouts.get(id)!;
    this.checkouts.set(id, { ...c, status: 'completed', order: { id: `ord_${id}`, status: 'paid', amount: 1100, amount_paid: 1100, tax_amount: 100, currency: 'USD' }, customer: { id: 'cust_creem1' } });
    return `ord_${id}`;
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.pathname === '/v1/products') return ok({ id: 'prod_creem10', name: 'Creem $10', price: 1000, currency: 'USD', billing_type: 'onetime' });
    if (init?.method === 'POST' && url.pathname === '/v1/checkouts') {
      const id = `ch_creem${this.checkouts.size + 1}`;
      this.checkouts.set(id, { id, status: 'pending', request_id: body.request_id, product: body.product_id, metadata: body.metadata });
      return ok({ id, checkout_url: `https://creem.test/${id}` });
    }
    if (url.pathname === '/v1/checkouts') return ok(this.checkouts.get(url.searchParams.get('checkout_id') ?? ''));
    if (url.pathname === '/v1/customers/billing') return ok({ customer_portal_link: `https://creem-portal.test/${body.customer_id}` });
    return new Response('unexpected', { status: 500 });
  };
}

let t: ReturnType<typeof setup>;
let stripe: FakeStripe;
let creem: FakeCreem;
let userId: string;
let n = 0;

const db = () => createDb(t.d1 as never);
const balance = async () => (await t.call('GET', '/api/v1/billing')).body.balanceMicros as number;
const sql = (query: string, ...args: unknown[]) => t.d1.sqlite.prepare(query).get(...(args as never[])) as Record<string, unknown>;

/** A snapshot event, as a dashboard destination with the Snapshot payload sends it. */
const event = (type: string, object: Json, extra: Json = {}) => ({ id: `evt_${++n}`, object: 'event', type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object }, ...extra });

async function stripeWebhook(e: Json, signature?: string) {
  const raw = JSON.stringify(e);
  const res = await worker.fetch(
    new Request('http://app.test/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': signature ?? (await stripeSignature(raw)) }, body: raw }),
    t.env as never,
    t.ctx,
  );
  await t.settle();
  return res.status;
}

async function creemWebhook(e: Json) {
  const raw = JSON.stringify(e);
  const res = await worker.fetch(
    new Request('http://app.test/api/webhooks/creem', { method: 'POST', headers: { 'creem-signature': await hmacHex(CREEM_SECRET, raw) }, body: raw }),
    t.env as never,
    t.ctx,
  );
  await t.settle();
  return res.status;
}

/** Starts a top-up as the signed-in user; returns the Checkout Session id. */
async function checkout(productId = 'price_10usd00001') {
  const res = await t.call('POST', '/api/v1/billing/checkout', { productId });
  expect(res.status).toBe(200);
  return String(res.body.url).split('/').pop()!;
}

async function paidTopUp(productId = 'price_10usd00001', opts: { amount?: number; tax?: number } = {}) {
  const id = await checkout(productId);
  const paid = stripe.pay(id, opts);
  expect(await stripeWebhook(event('checkout.session.completed', { id, object: 'checkout.session' }))).toBe(200);
  return { id, ...paid };
}

beforeEach(async () => {
  t = setup();
  stripe = new FakeStripe();
  creem = new FakeCreem();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).host === 'api.stripe.com' ? stripe.fetch(input, init) : creem.fetch(input, init));
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('buyer@example.com')`);
  Object.assign(t.env, {
    CREEM_API_BASE: 'https://test-api.creem.io',
    CREEM_API_KEY: 'creem_test_key',
    CREEM_WEBHOOK_SECRET: CREEM_SECRET,
    CREEM_TOPUP_PRODUCTS: 'prod_creem10',
    ...STRIPE_CONFIG,
    // The billing queue delivers to the api Worker's own consumer, in process.
    BILLING: {
      send: async (body: { eventId: string }) =>
        worker.queue({ messages: [{ id: body.eventId, body, ack() {}, retry() {} }], queue: 'billing' } as never, t.env as never),
    },
  });
  await signIn(t, 'buyer@example.com');
  userId = (await t.call('GET', '/api/v1/me')).body.user.id;
});
afterEach(() => vi.unstubAllGlobals());

describe('choosing the payment provider', () => {
  it('takes top-ups with Stripe when its settings are valid, offering its one-time USD prices cheapest first', async () => {
    const b = (await t.call('GET', '/api/v1/billing')).body;
    expect(b).toMatchObject({ enabled: true, provider: 'stripe' });
    expect(b.topUps).toEqual([
      { productId: 'price_10usd00001', name: '$10 credit', amountCents: 1000, currency: 'USD' },
      { productId: 'price_anyusd0001', name: 'Credit', amountCents: 2000, currency: 'USD' },
      { productId: 'price_25usd00001', name: '$25 credit', amountCents: 2500, currency: 'USD' },
    ]);
    // Recurring and non-USD prices, and Creem's products, are not offered while Stripe takes top-ups.
    for (const productId of ['price_monthly001', 'price_eur0000001', 'price_usdgbp0001', 'prod_creem10']) {
      expect((await t.call('POST', '/api/v1/billing/checkout', { productId })).body.type).toBe('validation_failed');
    }
  });

  it('falls back to Creem when any Stripe setting is missing or not valid', async () => {
    for (const broken of [
      { STRIPE_SECRET_KEY: undefined },
      { STRIPE_SECRET_KEY: 'pk_live_51PublishableKeyNotSecret000' },
      { STRIPE_SECRET_KEY: 'sk_live_short' },
      { STRIPE_SECRET_KEY: 'your-stripe-key' },
      { STRIPE_WEBHOOK_SECRET: '' },
      { STRIPE_WEBHOOK_SECRET: 'not-a-secret' },
      { STRIPE_TOPUP_PRICES: '' },
      { STRIPE_TOPUP_PRICES: 'price_10usd00001, prod_10' },
    ]) {
      Object.assign(t.env, STRIPE_CONFIG, broken);
      const b = (await t.call('GET', '/api/v1/billing')).body;
      expect(b, JSON.stringify(broken)).toMatchObject({ enabled: true, provider: 'creem', topUps: [{ productId: 'prod_creem10', amountCents: 1000 }] });
    }
    const id = String((await t.call('POST', '/api/v1/billing/checkout', { productId: 'prod_creem10' })).body.url).split('/').pop()!;
    expect(creem.checkouts.get(id)).toMatchObject({ product: 'prod_creem10', metadata: { userId } });
    expect(sql('SELECT provider FROM topup_checkouts')).toEqual({ provider: 'creem' });

    // Stripe valid again: it takes over at once, without waiting for the hourly product refresh.
    Object.assign(t.env, STRIPE_CONFIG);
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ provider: 'stripe', topUps: expect.arrayContaining([expect.objectContaining({ productId: 'price_10usd00001' })]) });
  });

  it('answers 503 when neither provider is configured', async () => {
    Object.assign(t.env, { STRIPE_SECRET_KEY: undefined, CREEM_API_KEY: undefined });
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ enabled: false, provider: null, topUps: [] });
    expect((await t.call('POST', '/api/v1/billing/checkout', { productId: 'price_10usd00001' })).body.type).toBe('billing_unavailable');
    expect((await t.call('POST', '/api/v1/billing/portal')).body.type).toBe('billing_unavailable');
  });
});

describe('Stripe checkout for a UK account', () => {
  it('asks Stripe for a USD payment-mode checkout that adds tax, takes the address and tax ids, invoices and asks for the terms', async () => {
    await checkout();
    const p = stripe.lastCheckout();
    const attemptId = String(sql('SELECT id FROM topup_checkouts').id);
    expect(Object.fromEntries(p)).toMatchObject({
      mode: 'payment',
      'line_items[0][price]': 'price_10usd00001',
      'line_items[0][quantity]': '1',
      client_reference_id: attemptId,
      success_url: 'http://app.test/billing/success',
      cancel_url: 'http://app.test/billing',
      'metadata[userId]': userId,
      'metadata[attemptId]': attemptId,
      'payment_intent_data[metadata][attemptId]': attemptId,
      customer_email: 'buyer@example.com',
      customer_creation: 'always',
      billing_address_collection: 'required',
      'automatic_tax[enabled]': 'true',
      'tax_id_collection[enabled]': 'true',
      'invoice_creation[enabled]': 'true',
      currency: 'usd',
      'adaptive_pricing[enabled]': 'false',
      'consent_collection[terms_of_service]': 'required',
    });
    expect(p.get('custom_text[terms_of_service_acceptance][message]')).toMatch(/\[Terms of Service\]\(http:\/\/app\.test\/terms\).*withdraw within 14 days/);
    expect(p.get('invoice_creation[invoice_data][footer]')).toMatch(/withdraw within 14 days.*http:\/\/app\.test\/refunds/);
    expect(p.has('payment_method_types[0]')).toBe(false);
    const create = stripe.calls.find((c) => c.path === '/v1/checkout/sessions')!;
    expect(create.headers['idempotency-key']).toBe(`checkout:${attemptId}`);
    expect(create.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(sql('SELECT provider, checkout_id AS checkout FROM topup_checkouts')).toEqual({ provider: 'stripe', checkout: 'cs_test_1' });
  });

  it('turns automatic tax off only when told to', async () => {
    Object.assign(t.env, { STRIPE_AUTOMATIC_TAX: 'off' });
    await checkout();
    expect(stripe.lastCheckout().get('automatic_tax[enabled]')).toBe('false');
  });

  it('puts the terms above the pay button and tells operators when the dashboard has no Terms URL', async () => {
    stripe.termsUrl = false;
    await checkout();
    const p = stripe.lastCheckout();
    expect(p.has('consent_collection[terms_of_service]')).toBe(false);
    expect(p.get('custom_text[submit][message]')).toMatch(/I agree to the \[Terms of Service\]/);
    await checkout();
    expect(t.d1.sqlite.prepare("SELECT title FROM alerts WHERE dedupe_key = 'stripe-terms-url'").all()).toHaveLength(1);
  });
});

describe('Stripe top-ups', () => {
  it('credits a top-up once, net of tax, from Stripe’s record of the paid session, never from the webhook body', async () => {
    const id = await checkout();
    expect(stripe.sessions.get(id)).toMatchObject({ client_reference_id: expect.any(String), metadata: { userId } });
    await stripeWebhook(event('checkout.session.completed', { id }));
    expect(await balance()).toBe(0); // not paid yet

    stripe.pay(id, { tax: 200 });
    // The body is not trusted: a forged amount credits what Stripe says was paid, without tax.
    const evt = event('checkout.session.completed', { id, amount_total: 999_999, total_details: { amount_tax: 0 } });
    expect(await stripeWebhook(evt)).toBe(200);
    expect(await balance()).toBe(10_000_000);
    expect(await stripeWebhook(evt)).toBe(200); // duplicate delivery
    await stripeWebhook(event('checkout.session.completed', { id })); // Stripe sometimes sends one change as two events
    expect(await balance()).toBe(10_000_000);
    expect((await t.call('GET', '/api/v1/billing/transactions')).body).toEqual([expect.objectContaining({ kind: 'topup', amountMicros: 10_000_000, description: '$10 credit' })]);
    expect(sql("SELECT reference, order_id AS orderId, gross_amount_cents AS gross, currency, actor FROM balance_transactions WHERE kind = 'topup'"))
      .toEqual({ reference: `order:pi_${id}`, orderId: `pi_${id}`, gross: 1200, currency: 'USD', actor: 'stripe' });

    // The buyer's Stripe customer is kept: the receipts button opens its portal, and the next
    // checkout reuses it so all invoices stay together.
    expect((await t.call('POST', '/api/v1/billing/portal')).body.url).toBe('https://billing.stripe.test/p/session/cus_new1');
    expect(stripe.calls.at(-1)!.params.get('return_url')).toBe('http://app.test/billing');
    await checkout();
    expect(Object.fromEntries(stripe.lastCheckout())).toMatchObject({ customer: 'cus_new1', 'customer_update[address]': 'auto', 'customer_update[name]': 'auto' });
    expect(stripe.lastCheckout().has('customer_email')).toBe(false);
  });

  it('forgets a stored customer Stripe no longer has, for checkout and receipts', async () => {
    t.d1.sqlite.prepare('INSERT INTO stripe_customers (user_id, stripe_customer_id, created_at) VALUES (?, ?, ?)').run(userId, 'cus_testmode', Date.now());
    expect((await t.call('POST', '/api/v1/billing/portal')).body.type).toBe('invalid_state');
    t.d1.sqlite.prepare('INSERT INTO stripe_customers (user_id, stripe_customer_id, created_at) VALUES (?, ?, ?)').run(userId, 'cus_testmode', Date.now());
    const id = await checkout();
    expect(stripe.lastCheckout().get('customer_email')).toBe('buyer@example.com');
    expect(stripe.lastCheckout().has('customer_update[address]')).toBe(false);
    expect(sql('SELECT count(*) AS n FROM stripe_customers')).toEqual({ n: 0 });
    stripe.pay(id);
    await stripeWebhook(event('checkout.session.completed', { id }));
    expect(await balance()).toBe(10_000_000);
    expect(sql('SELECT stripe_customer_id AS id FROM stripe_customers')).toEqual({ id: 'cus_new1' });
  });

  it('credits the amount a buyer chose on a "customer chooses" price', async () => {
    await paidTopUp('price_anyusd0001', { amount: 4200, tax: 840 });
    expect(await balance()).toBe(42_000_000);
  });

  it('accepts thin events, which carry only the related object', async () => {
    const id = await checkout();
    stripe.pay(id);
    const thin = { id: 'evt_test_thin1', object: 'v2.core.event', type: 'v1.checkout.session.completed', livemode: false, created: new Date().toISOString(), related_object: { id, type: 'checkout.session', url: `/v1/checkout/sessions/${id}` } };
    expect(await stripeWebhook(thin)).toBe(200);
    expect(await balance()).toBe(10_000_000);
    expect(sql("SELECT type, provider FROM webhook_events WHERE id = 'stripe:evt_test_thin1'")).toEqual({ type: 'checkout.session.completed', provider: 'stripe' });
  });

  it('waits for a delayed payment method and credits it when the money arrives', async () => {
    const id = await checkout();
    stripe.pay(id, { unpaid: true });
    await stripeWebhook(event('checkout.session.completed', { id }));
    expect(await balance()).toBe(0);
    expect(sql('SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NULL')).toEqual({ n: 0 });
    stripe.sessions.set(id, { ...stripe.sessions.get(id)!, payment_status: 'paid' });
    await stripeWebhook(event('checkout.session.async_payment_succeeded', { id }));
    expect(await balance()).toBe(10_000_000);
  });

  it('refuses bad, stale and missing signatures, and accepts any matching one while a secret is rolled', async () => {
    const id = await checkout();
    stripe.pay(id);
    const e = event('checkout.session.completed', { id });
    const raw = JSON.stringify(e);
    expect(await stripeWebhook(e, 't=1,v1=deadbeef')).toBe(401);
    expect(await stripeWebhook(e, await stripeSignature(raw, Math.floor(Date.now() / 1000) - 600))).toBe(401);
    expect(await stripeWebhook(e, await stripeSignature(raw, undefined, 'whsec_someOtherSecretValue0000'))).toBe(401);
    expect(await stripeWebhook(e, '')).toBe(401);
    expect(await balance()).toBe(0);
    const now = Math.floor(Date.now() / 1000);
    const rolled = `t=${now},v1=${await hmacHex('whsec_oldSecretStillActive00000', `${now}.${raw}`)},v1=${await hmacHex(STRIPE_SECRET, `${now}.${raw}`)},v0=00`;
    expect(await stripeWebhook(e, rolled)).toBe(200);
    expect(await balance()).toBe(10_000_000);
  });

  it('credits a paid session whose webhook never arrived from the nightly check', async () => {
    const id = await checkout();
    stripe.pay(id);
    const summary = await billingSweep(t.env as never, db(), paymentProviders(t.env as never), new Date(), { nightly: true });
    expect(summary.credited).toBe(1);
    expect(await balance()).toBe(10_000_000);
  });

  it('rejects a paid session with mismatched identity, price, currency or amounts', async () => {
    const id = await checkout();
    stripe.pay(id);
    const paid = stripe.sessions.get(id)!;
    const client = stripeFrom(t.env as never)!;
    for (const changed of [
      { ...paid, id: 'cs_test_other' },
      { ...paid, client_reference_id: 'unrelated-request' },
      { ...paid, metadata: { ...(paid.metadata as Json), userId: 'other-user' } },
      { ...paid, metadata: { ...(paid.metadata as Json), attemptId: 'another-attempt' } },
      { ...paid, price: 'price_25usd00001' },
      { ...paid, currency: 'gbp' },
      { ...paid, amount_total: 0 },
      { ...paid, total_details: { amount_tax: 1200 } },
      { ...paid, payment_status: 'no_payment_required' },
      { ...paid, payment_intent: null },
    ]) {
      stripe.sessions.set(id, changed);
      await expect(creditStripeCheckout(db(), client, id, new Date())).rejects.toThrow();
      expect(await balance()).toBe(0);
    }
  });

  it('leaves alone sessions, refunds and disputes of sales this app did not start', async () => {
    stripe.sessions.set('cs_test_link', { id: 'cs_test_link', status: 'complete', payment_status: 'paid', client_reference_id: null, metadata: {}, price: 'price_10usd00001', currency: 'usd', amount_total: 1000, total_details: { amount_tax: 0 }, payment_intent: 'pi_link' });
    await stripeWebhook(event('checkout.session.completed', { id: 'cs_test_link' }));
    stripe.sessions.set('cs_test_crm', { ...stripe.sessions.get('cs_test_link')!, id: 'cs_test_crm', client_reference_id: 'crm-lead-123' });
    await stripeWebhook(event('checkout.session.completed', { id: 'cs_test_crm' }));
    const pi = stripe.foreignPayment();
    stripe.refund(pi, 500);
    await stripeWebhook(event('charge.refunded', { id: `ch_${pi.slice(3)}` }));
    await stripeWebhook(event('charge.dispute.created', { id: stripe.dispute(pi, 500) }));
    expect(sql('SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NULL')).toEqual({ n: 0 });
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ balanceMicros: 0, frozen: false });
  });

  it('ignores events from the other mode', async () => {
    const id = await checkout();
    stripe.pay(id);
    await stripeWebhook(event('checkout.session.completed', { id }, { livemode: true }));
    expect(await balance()).toBe(0);
    expect(sql('SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NULL')).toEqual({ n: 0 });
  });
});

describe('Stripe refunds and disputes', () => {
  it('takes each refund off the balance once, in proportion to the credit, net of tax', async () => {
    const { pi, charge } = await paidTopUp('price_25usd00001', { tax: 500 }); // $30 paid, $25 credited
    stripe.refund(pi, 600); // a fifth of what was paid
    await stripeWebhook(event('charge.refunded', { id: charge }));
    await stripeWebhook(event('refund.created', { id: stripe.refunds[0]!.id }));
    expect(await balance()).toBe(20_000_000);
    stripe.refund(pi, 2400);
    await stripeWebhook(event('refund.updated', { id: stripe.refunds[0]!.id }));
    expect(await balance()).toBe(0);
    expect((await t.call('GET', '/api/v1/billing/transactions')).body.map((x: { kind: string }) => x.kind)).toEqual(['refund', 'refund', 'topup']);
  });

  it('waits for a pending refund, and gives the credit back when a refund fails after it was taken', async () => {
    const { pi, charge } = await paidTopUp();
    const id = stripe.refund(pi, 1200, 'pending');
    await stripeWebhook(event('charge.refunded', { id: charge }));
    expect(await balance()).toBe(10_000_000);
    expect(sql('SELECT error FROM webhook_events WHERE processed_at IS NULL').error).toMatch(/has not succeeded yet/);
    stripe.refunds[0]!.status = 'succeeded';
    await billingSweep(t.env as never, db(), paymentProviders(t.env as never), new Date(Date.now() + 120_000), { nightly: false });
    expect(await balance()).toBe(0);
    stripe.refunds[0]!.status = 'failed';
    await stripeWebhook(event('refund.failed', { id }));
    await stripeWebhook(event('refund.updated', { id })); // once only
    expect(await balance()).toBe(10_000_000);
    expect(t.d1.sqlite.prepare("SELECT title FROM alerts WHERE title LIKE 'Stripe refund%'").all()).toEqual([{ title: expect.stringMatching(/failed after it was taken off the balance; the credit was given back/) }]);
    // The failed refund no longer counts: refunding half of the payment again takes half the credit.
    stripe.refund(pi, 600);
    await stripeWebhook(event('refund.created', { id: stripe.refunds[0]!.id }));
    expect(await balance()).toBe(5_000_000);
  });

  it('keeps a refund that arrives before the credit until the credit is recorded', async () => {
    const id = await checkout();
    const { pi, charge } = stripe.pay(id);
    stripe.refund(pi, 600);
    await stripeWebhook(event('charge.refunded', { id: charge }));
    expect(sql('SELECT error FROM webhook_events WHERE processed_at IS NULL').error).toMatch(/has not been credited yet/);
    await stripeWebhook(event('checkout.session.completed', { id }));
    await billingSweep(t.env as never, db(), paymentProviders(t.env as never), new Date(Date.now() + 120_000), { nightly: false });
    expect(await balance()).toBe(5_000_000);
    expect(sql('SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NULL')).toEqual({ n: 0 });
  });

  it('freezes the account on a dispute, and takes the money when the bank withdraws it', async () => {
    const { pi } = await paidTopUp();
    // An inquiry: the account is held, nothing is taken yet.
    const inquiry = stripe.dispute(pi, 1200, 'warning_needs_response');
    await stripeWebhook(event('charge.dispute.created', { id: inquiry }));
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ frozen: true, balanceMicros: 10_000_000 });
    const frozenAt = sql('SELECT frozen_at AS at FROM billing_accounts WHERE user_id = ?', userId).at;
    // It becomes a chargeback, later: the hold keeps the time it began.
    stripe.disputes.get(inquiry)!.status = 'needs_response';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 86_400_000);
    const withdrawn = event('charge.dispute.funds_withdrawn', { id: inquiry });
    await stripeWebhook(withdrawn, await stripeSignature(JSON.stringify(withdrawn)));
    await stripeWebhook(event('charge.dispute.funds_withdrawn', { id: inquiry }));
    vi.useRealTimers();
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ frozen: true, balanceMicros: 0 });
    expect(sql('SELECT frozen_at AS at FROM billing_accounts WHERE user_id = ?', userId).at).toBe(frozenAt);
    expect(t.d1.sqlite.prepare("SELECT title FROM alerts WHERE source = 'billing' AND severity = 'critical'").all()).toEqual([{ title: `Stripe dispute by user ${userId}: account frozen` }]);
    const priceVersion = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1').version;
    expect((await t.call('POST', '/api/v1/instances', { name: 'a', regionId: 'tyo1', storageGb: 10, priceVersion }, { 'idempotency-key': 'a' })).body.type).toBe('account_frozen');
  });

  it('caps concurrent refund events at the original credit', async () => {
    const { pi } = await paidTopUp();
    stripe.refund(pi, 1200);
    stripe.refund(pi, 1200);
    const { schema } = await import('@cloudbrowser/db');
    const events = [event('refund.created', { id: stripe.refunds[0]!.id }), event('refund.created', { id: stripe.refunds[1]!.id })];
    for (const e of events) await db().insert(schema.webhookEvents).values({ id: `stripe:${e.id}`, provider: 'stripe', type: e.type, payload: e, receivedAt: new Date() });
    const client = stripeFrom(t.env as never)!;
    await Promise.all(events.map((e) => processStripeWebhook(t.env as never, db(), client, `stripe:${e.id}`)));
    expect(await balance()).toBe(0);
    expect(sql("SELECT sum(amount_micros) AS amount FROM balance_transactions WHERE kind = 'refund'")).toEqual({ amount: -10_000_000 });
  });
});

describe('Creem beside Stripe', () => {
  it('still credits, refunds and opens receipts for Creem payments while Stripe takes new top-ups', async () => {
    // A Creem checkout started before Stripe was configured.
    Object.assign(t.env, { STRIPE_SECRET_KEY: undefined });
    const creemId = String((await t.call('POST', '/api/v1/billing/checkout', { productId: 'prod_creem10' })).body.url).split('/').pop()!;
    Object.assign(t.env, STRIPE_CONFIG);
    expect((await t.call('GET', '/api/v1/billing')).body.provider).toBe('stripe');

    const order = creem.pay(creemId);
    expect(await creemWebhook({ id: 'creem_evt_1', eventType: 'checkout.completed', object: { id: creemId } })).toBe(200);
    expect(await balance()).toBe(10_000_000);
    // Only ever paid through Creem: the receipts button opens Creem's portal.
    expect((await t.call('POST', '/api/v1/billing/portal')).body.url).toBe('https://creem-portal.test/cust_creem1');

    await creemWebhook({ id: 'creem_evt_2', eventType: 'refund.created', object: { id: 'ref_c1', refund_amount: 550, refund_currency: 'USD', status: 'succeeded', order: { id: order } } });
    expect(await balance()).toBe(5_000_000);

    // After a Stripe payment, Stripe's portal comes first.
    await paidTopUp();
    expect((await t.call('POST', '/api/v1/billing/portal')).body.url).toBe('https://billing.stripe.test/p/session/cus_new1');
    expect(sql("SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NULL")).toEqual({ n: 0 });
  });

  it('still applies Stripe refunds and chargebacks after top-ups are handed back to Creem', async () => {
    const { pi } = await paidTopUp('price_25usd00001', { tax: 0 });
    Object.assign(t.env, { STRIPE_TOPUP_PRICES: '' }); // the documented way back to Creem
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ provider: 'creem', topUps: [{ productId: 'prod_creem10' }] });
    stripe.refund(pi, 500);
    await stripeWebhook(event('refund.created', { id: stripe.refunds[0]!.id }));
    expect(await balance()).toBe(20_000_000);
    await stripeWebhook(event('charge.dispute.created', { id: stripe.dispute(pi, 2000) }));
    expect((await t.call('GET', '/api/v1/billing')).body).toMatchObject({ frozen: true, balanceMicros: 0 });
    // The receipts of Stripe payments stay reachable.
    expect((await t.call('POST', '/api/v1/billing/portal')).body.url).toBe('https://billing.stripe.test/p/session/cus_new1');
    // A Stripe price is no longer sold.
    expect((await t.call('POST', '/api/v1/billing/checkout', { productId: 'price_25usd00001' })).body.type).toBe('validation_failed');
  });

  it('keeps a Stripe event until Stripe is configured, then applies it', async () => {
    const id = await checkout();
    stripe.pay(id);
    Object.assign(t.env, { STRIPE_SECRET_KEY: undefined }); // Stripe off entirely: Creem takes top-ups
    expect(await stripeWebhook(event('checkout.session.completed', { id }))).toBe(200);
    expect(await balance()).toBe(0);
    const later = new Date(Date.now() + 120_000);
    expect((await billingSweep(t.env as never, db(), paymentProviders(t.env as never), later, { nightly: false })).webhooks).toBe(0);
    Object.assign(t.env, STRIPE_CONFIG);
    expect((await billingSweep(t.env as never, db(), paymentProviders(t.env as never), later, { nightly: false })).webhooks).toBe(1);
    expect(await balance()).toBe(10_000_000);
  });
});

describe('Stripe client details', () => {
  it('form-encodes nested objects and arrays the way Stripe reads them', () => {
    expect(decodeURIComponent(formEncode({ a: 1, b: { c: 'x', d: [{ e: true }] }, skip: undefined, none: null }))).toBe('a=1&b[c]=x&b[d][0][e]=true');
  });

  it('reads prices, keeping archived ones out', () => {
    expect(parsePrice({ id: 'price_x', type: 'one_time', currency: 'usd', unit_amount: 1500, product: { name: 'Credit', active: true } })).toEqual({ id: 'price_x', name: 'Credit', priceCents: 1500, currency: 'USD', billingType: 'onetime' });
    expect(parsePrice({ id: 'price_x', type: 'one_time', currency: 'usd', unit_amount: null, custom_unit_amount: { minimum: null, preset: null } }).priceCents).toBe(50);
    expect(parsePrice({ id: 'price_x', active: false, type: 'one_time', currency: 'usd', unit_amount: 1500 }).billingType).toBe('archived');
    expect(parsePrice({ id: 'price_x', type: 'one_time', currency: 'usd', unit_amount: 1500, product: { name: 'Old', active: false } }).billingType).toBe('archived');
    expect(parsePrice({ id: 'price_x', type: 'one_time', currency: 'usd', unit_amount: 1500, currency_options: { usd: {}, eur: {} } }).billingType).toBe('multi_currency');
    expect(parsePrice({ id: 'price_x', type: 'one_time', currency: 'usd', unit_amount: 1500, currency_options: { usd: {} } }).billingType).toBe('onetime');
  });

  it('verifies signatures over the timestamp and the raw body', async () => {
    const raw = '{"id":"evt_1"}';
    const at = 1_800_000_000;
    const header = await stripeSignature(raw, at);
    expect(await verifyStripeSignature(STRIPE_SECRET, raw, header, at * 1000)).toBe(true);
    expect(await verifyStripeSignature(STRIPE_SECRET, `${raw} `, header, at * 1000)).toBe(false);
    expect(await verifyStripeSignature(STRIPE_SECRET, raw, header, (at + 301) * 1000)).toBe(false);
    expect(await verifyStripeSignature(STRIPE_SECRET, raw, header.replace('v1=', 'v0='), at * 1000)).toBe(false);
  });
});
