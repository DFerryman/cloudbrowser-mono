import { planLimits, subscriptionAccess } from '@cloudbrowser/contracts';
import { meterAndEnforce } from '@cloudbrowser/engine';
import { createDb } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { billingSweep } from '../src/billing/sweep.js';
import { creemFrom } from '../src/billing/creem.js';
import { setup, signIn } from './helpers.js';

const SECRET = 'whsec_test';
const BASE = 'https://test-api.creem.io';
const PRODUCTS = { personal_monthly: 'prod_pm', personal_yearly: 'prod_py', pro_monthly: 'prod_rm', pro_yearly: 'prod_ry' };

/**
 * A stand-in for Creem's API (page 6). Field names follow Creem's docs and must be confirmed against
 * recorded test-mode payloads before launch.
 */
class FakeCreem {
  subs = new Map<string, Record<string, unknown>>();
  checkouts: Record<string, unknown>[] = [];
  calls: { method: string; path: string; body: unknown }[] = [];

  subscription(id: string, patch: Partial<{ status: string; product: string; units: number; userId: string; end: string }>) {
    const prev = this.subs.get(id) as Record<string, unknown> | undefined;
    const items = (prev?.items as Record<string, unknown>[] | undefined) ?? [{ id: `item_${id}`, units: 1 }];
    const next = {
      id,
      object: 'subscription',
      status: patch.status ?? prev?.status ?? 'active',
      product: { id: patch.product ?? (prev?.product as { id: string } | undefined)?.id ?? PRODUCTS.personal_monthly },
      customer: { id: 'cust_1', email: 'pilot@example.com' },
      items: [{ ...items[0], units: patch.units ?? items[0]!.units }],
      current_period_end_date: patch.end ?? prev?.current_period_end_date ?? '2026-12-01T00:00:00.000Z',
      metadata: patch.userId ? { userId: patch.userId } : (prev?.metadata ?? {}),
    };
    this.subs.set(id, next);
    return next;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    this.calls.push({ method, path: url.pathname, body });
    if (init?.headers && (init.headers as Record<string, string>)['x-api-key'] !== 'creem_test_key') return new Response('no key', { status: 401 });
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'POST' && url.pathname === '/v1/checkouts') {
      this.checkouts.push(body);
      return ok({ id: `ch_${this.checkouts.length}`, checkout_url: `https://checkout.test/ch_${this.checkouts.length}` });
    }
    if (method === 'GET' && url.pathname === '/v1/subscriptions') {
      const s = this.subs.get(url.searchParams.get('subscription_id') ?? '');
      return s ? ok(s) : new Response('not found', { status: 404 });
    }
    const up = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)\/upgrade$/);
    if (method === 'POST' && up) return ok(this.subscription(up[1]!, { product: body.product_id }));
    const upd = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (method === 'POST' && upd) return ok(this.subscription(upd[1]!, { units: body.items[0].units }));
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

beforeEach(async () => {
  t = setup();
  creem = new FakeCreem();
  vi.stubGlobal('fetch', creem.fetch);
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('pilot@example.com')`);
  Object.assign(t.env, {
    CREEM_API_BASE: BASE,
    CREEM_API_KEY: 'creem_test_key',
    CREEM_WEBHOOK_SECRET: SECRET,
    CREEM_PRODUCT_PERSONAL_MONTHLY: PRODUCTS.personal_monthly,
    CREEM_PRODUCT_PERSONAL_YEARLY: PRODUCTS.personal_yearly,
    CREEM_PRODUCT_PRO_MONTHLY: PRODUCTS.pro_monthly,
    CREEM_PRODUCT_PRO_YEARLY: PRODUCTS.pro_yearly,
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

describe('plans', () => {
  it('maps every plan to its limits', () => {
    expect(planLimits('personal_monthly')).toMatchObject({ maxBrowsers: 1, maxRunning: 1, hoursPerMonth: 60, idleTimeoutMaxS: 1800, storageGb: 20, fpsMax: 30, snapshotRetentionDays: 7 });
    expect(planLimits('personal_yearly', 5).maxBrowsers).toBe(1);
    expect(planLimits('pro_monthly', 3)).toMatchObject({ maxBrowsers: 3, maxRunning: 3, hoursPerMonth: 180, idleTimeoutMaxS: 3600, storageGb: 30, fpsMax: 60, snapshotRetentionDays: 14 });
    expect(planLimits('pro_yearly', 1).maxBrowsers).toBe(2); // Pro minimum
    expect(planLimits('pro_yearly', 500).maxBrowsers).toBe(50);
  });

  it('grants access by status: grace for past due, until period end after cancel', () => {
    const now = new Date('2026-11-10T00:00:00Z');
    const end = new Date('2026-11-20T00:00:00Z');
    const past = new Date('2026-11-01T00:00:00Z');
    const at = (status: string, currentPeriodEnd: Date | null = end, pastDueSince: Date | null = null) =>
      subscriptionAccess({ status, currentPeriodEnd, pastDueSince }, now);
    expect(at('active')).toBe('active');
    expect(at('trialing')).toBe('active');
    expect(at('scheduled_cancel')).toBe('ending');
    expect(at('canceled')).toBe('ending');
    expect(at('canceled', past)).toBe('none');
    expect(at('past_due', end, new Date('2026-11-05T00:00:00Z'))).toBe('grace');
    expect(at('past_due', end, new Date('2026-11-02T00:00:00Z'))).toBe('none');
    expect(at('paused')).toBe('none');
    expect(at('expired')).toBe('none');
    expect(at('something_new')).toBe('none');
  });
});

describe('billing', () => {
  it('stays on the pilot plan without a subscription, and requires one once billing is on', async () => {
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.plan).toBe('pilot');
    t.d1.sqlite.exec(`INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', 0)`);
    const me = (await t.call('GET', '/api/v1/me')).body;
    expect(me.entitlements).toMatchObject({ plan: 'none', maxBrowsers: 0 });
    const res = await t.call('POST', '/api/v1/instances', { name: 'x', regionId: 'tyo1' }, { 'idempotency-key': 'n1' });
    expect(res.body.type).toBe('plan_limit');
  });

  it('grants access only from the webhook, never from the checkout redirect', async () => {
    const checkout = await t.call('POST', '/api/v1/billing/checkout', { plan: 'pro_monthly', browsers: 3 });
    expect(checkout.body.url).toBe('https://checkout.test/ch_1');
    expect(creem.checkouts[0]).toMatchObject({ product_id: PRODUCTS.pro_monthly, units: 3, metadata: { userId } });
    expect((await t.call('POST', '/api/v1/billing/checkout', { plan: 'pro_monthly', browsers: 1 })).status).toBe(400);
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.plan).toBe('pilot'); // nothing granted yet

    creem.subscription('sub_1', { status: 'active', product: PRODUCTS.pro_monthly, units: 3, userId });
    expect(await webhook(event('checkout.completed', { id: 'ch_1', request_id: creem.checkouts[0]!.request_id, customer: { id: 'cust_1' }, subscription: { id: 'sub_1' }, metadata: { userId } }))).toBe(200);
    const me = (await t.call('GET', '/api/v1/me')).body;
    expect(me.entitlements).toMatchObject({ plan: 'pro', maxBrowsers: 3, maxRunning: 3, hoursPerMonth: 180, idleTimeoutMaxS: 3600 });
    const billing = (await t.call('GET', '/api/v1/billing')).body;
    expect(billing).toMatchObject({ enabled: true, subscription: { plan: 'pro_monthly', browsers: 3, access: 'active' }, hours: { used: 0, included: 180 } });
    expect((await t.call('POST', '/api/v1/billing/portal')).body.url).toBe('https://portal.test/cust_1');
    expect((await t.call('POST', '/api/v1/billing/checkout', { plan: 'personal_monthly' })).body.type).toBe('invalid_state');
  });

  it('rejects bad signatures and ignores duplicates', async () => {
    const e = event('subscription.paid', { id: 'sub_x' });
    expect(await webhook(e, 'deadbeef')).toBe(401);
    expect(await webhook(e, 'not-hex')).toBe(401);
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM webhook_events').get()).toEqual({ n: 0 });
    creem.subscription('sub_x', { userId });
    expect(await webhook(e)).toBe(200);
    expect(await webhook(e)).toBe(200);
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM webhook_events').get()).toEqual({ n: 1 });
    expect(creem.calls.filter((c) => c.path === '/v1/subscriptions')).toHaveLength(1);
  });

  it('ends in Creem’s state whatever the order and number of deliveries', async () => {
    creem.subscription('sub_2', { status: 'active', product: PRODUCTS.personal_monthly, userId });
    const paid = event('subscription.paid', { id: 'sub_2', metadata: { userId } });
    const update = event('subscription.update', { id: 'sub_2' });
    // The update (to Pro, 4 browsers) arrives before `paid`, and every event is delivered 3 times.
    creem.subscription('sub_2', { product: PRODUCTS.pro_yearly, units: 4 });
    for (let i = 0; i < 3; i++) for (const e of [update, paid]) await webhook(e);
    expect((await t.call('GET', '/api/v1/me')).body.entitlements).toMatchObject({ plan: 'pro', maxBrowsers: 4 });
    const state = t.d1.sqlite.prepare(`SELECT plan, units, status FROM subscriptions`).all();
    expect(state).toEqual([{ plan: 'pro_yearly', units: 4, status: 'active' }]);
  });

  it('changes browsers on Pro with proration, and refuses to drop below the browsers in use', async () => {
    creem.subscription('sub_3', { status: 'active', product: PRODUCTS.pro_monthly, units: 2, userId });
    await webhook(event('subscription.paid', { id: 'sub_3' }));
    for (const k of ['a', 'b']) await t.call('POST', '/api/v1/instances', { name: k, regionId: 'tyo1' }, { 'idempotency-key': k });
    await t.settle();
    expect((await t.call('POST', '/api/v1/instances', { name: 'c', regionId: 'tyo1' }, { 'idempotency-key': 'c' })).body.type).toBe('plan_limit');

    const more = await t.call('POST', '/api/v1/billing/browsers', { browsers: 3 });
    expect(more.body.subscription.browsers).toBe(3);
    expect(creem.calls.find((c) => c.path === '/v1/subscriptions/sub_3')?.body).toEqual({
      items: [{ id: 'item_sub_3', units: 3 }],
      update_behavior: 'proration-charge-immediately',
    });
    // Creation is allowed right away, from Creem's re-fetched state.
    expect((await t.call('POST', '/api/v1/instances', { name: 'c', regionId: 'tyo1' }, { 'idempotency-key': 'c2' })).status).toBe(202);
    await t.settle();
    expect((await t.call('POST', '/api/v1/billing/browsers', { browsers: 2 })).body.type).toBe('too_many_browsers');
    expect((await t.call('POST', '/api/v1/billing/plan', { plan: 'personal_monthly' })).body.type).toBe('too_many_browsers');
  });

  it('upgrades Personal to Pro', async () => {
    creem.subscription('sub_4', { status: 'active', product: PRODUCTS.personal_monthly, userId });
    await webhook(event('subscription.paid', { id: 'sub_4' }));
    const res = await t.call('POST', '/api/v1/billing/plan', { plan: 'pro_monthly', browsers: 2 });
    expect(res.body.subscription).toMatchObject({ plan: 'pro_monthly', browsers: 2 });
    expect(creem.calls.find((c) => c.path === '/v1/subscriptions/sub_4/upgrade')?.body).toEqual({
      product_id: PRODUCTS.pro_monthly,
      update_behavior: 'proration-charge-immediately',
    });
  });

  it('puts browsers to sleep when access ends, keeps them 30 days, then deletes them', async () => {
    creem.subscription('sub_5', { status: 'active', product: PRODUCTS.personal_monthly, userId });
    await webhook(event('subscription.paid', { id: 'sub_5' }));
    await t.call('POST', '/api/v1/instances', { name: 'w', regionId: 'tyo1' }, { 'idempotency-key': 'w' });
    await t.settle();
    const [inst] = (await t.call('GET', '/api/v1/instances')).body;
    expect(inst.status).toBe('running');

    creem.subscription('sub_5', { status: 'expired' });
    await webhook(event('subscription.expired', { id: 'sub_5' }));
    expect((await t.call('GET', '/api/v1/me')).body.entitlements).toMatchObject({ plan: 'none', maxRunning: 0 });

    // The engine's minute cron sleeps it at once; starts are refused.
    const db = createDb(t.d1 as never);
    const engineDeps = { db, now: () => new Date(), notify: () => {} } as never;
    expect((await meterAndEnforce(engineDeps)).stopped).toBe(1);
    await t.env.OPERATIONS.send({ operationId: (t.d1.sqlite.prepare(`SELECT id FROM operations WHERE kind = 'stop'`).get() as { id: string }).id });
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${inst.id}`)).body.status).toBe('sleeping');
    expect((await t.call('POST', `/api/v1/instances/${inst.id}/start`, undefined, { 'idempotency-key': 's' })).body.type).toBe('plan_limit');

    const billing = (await t.call('GET', '/api/v1/billing')).body;
    expect(billing.subscription.access).toBe('none');
    const keptUntil = Date.parse(billing.dataKeptUntil);
    expect(keptUntil - Date.now()).toBeGreaterThan(29 * 86_400_000);

    // Day 1: a notice. Day 30: the browsers are deleted (restorable 7 more days, then purged).
    const sweep = (days: number) => billingSweep(t.env as never, db, creemFrom(t.env as never), new Date(Date.now() + days * 86_400_000), { nightly: false });
    expect((await sweep(1)).notices).toBe(1);
    expect((await sweep(1)).notices).toBe(0);
    expect(t.emails.at(-1)?.text).toMatch(/kept until/);
    expect((await sweep(30)).deleted).toBe(1);
    await t.settle();
    expect(t.d1.sqlite.prepare(`SELECT desired_state AS d FROM browser_instances`).get()).toEqual({ d: 'deleted' });
  });

  it('revokes on a full refund and only logs a partial one', async () => {
    creem.subscription('sub_6', { status: 'active', product: PRODUCTS.personal_monthly, userId });
    await webhook(event('subscription.paid', { id: 'sub_6' }));
    await webhook(event('refund.created', { id: 'ref_1', refund_amount: 500, transaction: { amount_paid: 2900 }, subscription: { id: 'sub_6' } }));
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.plan).toBe('personal');
    await webhook(event('refund.created', { id: 'ref_2', refund_amount: 2900, transaction: { amount_paid: 2900 }, subscription: { id: 'sub_6' } }));
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.plan).toBe('none');
    // A later sync from Creem does not undo the revocation.
    await webhook(event('subscription.update', { id: 'sub_6' }));
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.plan).toBe('none');
  });

  it('refuses starts once the month’s hours are used up', async () => {
    creem.subscription('sub_7', { status: 'active', product: PRODUCTS.personal_monthly, userId });
    await webhook(event('subscription.paid', { id: 'sub_7' }));
    await t.call('POST', '/api/v1/instances', { name: 'h', regionId: 'tyo1' }, { 'idempotency-key': 'h' });
    await t.settle();
    const [inst] = (await t.call('GET', '/api/v1/instances')).body;
    await t.call('POST', `/api/v1/instances/${inst.id}/stop`, undefined, { 'idempotency-key': 'st' });
    await t.settle();
    const month = new Date().toISOString().slice(0, 7);
    t.d1.sqlite.prepare(`INSERT INTO active_usage (user_id, month, seconds) VALUES (?, ?, ?)`).run(userId, month, 60 * 3600);
    expect((await t.call('GET', '/api/v1/me')).body.usage.hoursUsed).toBe(60);
    expect((await t.call('POST', `/api/v1/instances/${inst.id}/start`, undefined, { 'idempotency-key': 'go' })).body.type).toBe('hours_exhausted');
  });

  it('answers 503 when Creem is not configured', async () => {
    Object.assign(t.env, { CREEM_API_KEY: undefined });
    expect((await t.call('POST', '/api/v1/billing/checkout', { plan: 'personal_monthly' })).body.type).toBe('billing_unavailable');
    expect((await t.call('GET', '/api/v1/billing')).body.enabled).toBe(false);
  });
});
