/**
 * Prices, prepaid billing and usage (page 6). A balance is credited only from Creem's own record
 * of a paid checkout (webhook, or a re-read of the checkout), never from the success redirect.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AccountUsage,
  BalanceTransaction,
  BillingState,
  CheckoutBody,
  DATA_KEPT_DAYS,
  Problem,
  TRIAL,
  RedirectResult,
  RegionPricing,
} from '@cloudbrowser/contracts';
import { accountRunway, newId, pricingSettings, schema } from '@cloudbrowser/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { creemFrom, type Creem } from '../billing/creem.js';
import { offeredTopupPacks } from '../billing/ledger.js';
import { retentionState } from '../billing/retention.js';
import type { AppEnv } from '../env.js';
import { billingAccount, entitlementsFor } from '../limits.js';
import { allRegionPricing, regionPrice } from '../pricing.js';
import { problem } from '../problem.js';
import { accountUsage, monthOf, monthTotals } from '../usage.js';

const { billingCustomers, topupCheckouts, balanceTransactions, browserReservations } = schema;

export const billingRoute = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) {
      throw problem(400, 'validation_failed', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
  },
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({ content: { 'application/json': { schema } }, description });
const problems = {
  400: { content: { 'application/problem+json': { schema: Problem } }, description: 'Invalid request' },
  409: { content: { 'application/problem+json': { schema: Problem } }, description: 'Conflict' },
  503: { content: { 'application/problem+json': { schema: Problem } }, description: 'Billing not configured' },
};
const MonthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });
/** Paging: ask for one more row than is shown to learn whether there is another page. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

function requireCreem(c: Context<AppEnv>): Creem {
  const creem = creemFrom(c.env);
  if (!creem) throw problem(503, 'billing_unavailable', 'Billing is not set up on this deployment.');
  return creem;
}

billingRoute.openapi(
  createRoute({
    method: 'get',
    path: '/pricing',
    tags: ['billing'],
    description: 'Customer prices per region: AWS prices for that region (AWS Price List API) times our markup.',
    responses: { 200: json(z.array(RegionPricing), 'Prices per region') },
  }),
  async (c) => c.json(await allRegionPricing(c.get('db'), c.get('user').id), 200),
);

billingRoute.openapi(
  createRoute({ method: 'get', path: '/billing', tags: ['billing'], responses: { 200: json(BillingState, 'Balance, top-ups and this month’s usage') } }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const now = new Date();
    const creem = creemFrom(c.env);
    const topUps = await offeredTopupPacks(db, creem, now);
    const account = await billingAccount(db, user.id);
    const settings = await pricingSettings(db);
    // One projection for the balance warnings and this page: the account's combined spending rate.
    const [runway, retention] = await Promise.all([accountRunway(db, user.id, now), retentionState(db, user.id)]);
    const [retaining] = await db.select({ until: sql<number | null>`min(${browserReservations.retentionEndsAt})` }).from(browserReservations).where(eq(browserReservations.userId, user.id));
    const month = monthOf(undefined, now);
    const out: BillingState = {
      mode: (await entitlementsFor(db, user.id)).billing,
      enabled: creem !== null,
      balanceMicros: account.balanceMicros,
      reservedMicros: account.reservedMicros,
      availableMicros: account.availableMicros,
      retentionDays: DATA_KEPT_DAYS,
      exhaustedAt: account.exhaustedAt?.toISOString() ?? null,
      dataKeptUntil: retaining?.until ? new Date(retaining.until).toISOString() : null,
      frozen: !!account.frozenAt,
      minBalanceMicros: settings.minBalanceMicros,
      lowBalanceMicros: settings.lowBalanceMicros,
      burnHourMicros: runway.burnHourMicros,
      fundedUntil: runway.fundedUntil?.toISOString() ?? null,
      retained: retention.retained.map((r) => ({ ...r, regionId: r.regionId as BillingState['retained'][number]['regionId'], deletesAt: r.deletesAt.toISOString() })),
      restoreNeededMicros: retention.restoreNeededMicros,
      topUps,
      month: { month, ...(await monthTotals(db, user.id, month)) },
      trial: {
        // The free trial is offered only where usage is paid (not during the free pilot), once.
        eligible: (await entitlementsFor(db, user.id)).billing === 'prepaid' && !account.trialUsedAt && !account.frozenAt,
        regionId: TRIAL.regionId,
        minutes: TRIAL.runningSeconds / 60,
        storageGb: TRIAL.storageGb,
        keptDays: TRIAL.keptDays,
      },
    };
    return c.json(out, 200);
  },
);

billingRoute.openapi(
  createRoute({
    method: 'get',
    path: '/billing/transactions',
    tags: ['billing'],
    description: 'Top-ups, refunds and credits on the balance, newest first (100 by default; page with limit and offset). Usage is under /usage.',
    request: { query: PageQuery },
    responses: { 200: json(z.array(BalanceTransaction), 'Balance transactions') },
  }),
  async (c) => {
    const { limit = 100, offset = 0 } = c.req.valid('query');
    const rows = await c
      .get('db')
      .select()
      .from(balanceTransactions)
      .where(and(eq(balanceTransactions.userId, c.get('user').id), sql`${balanceTransactions.kind} <> 'usage'`))
      .orderBy(desc(balanceTransactions.createdAt), desc(balanceTransactions.id))
      .limit(limit)
      .offset(offset);
    return c.json(
      rows.map((r) => ({ id: r.id, kind: r.kind as BalanceTransaction['kind'], amountMicros: r.amountMicros, description: r.description, createdAt: r.createdAt.toISOString() })),
      200,
    );
  },
);

billingRoute.openapi(
  createRoute({
    method: 'get',
    path: '/usage',
    tags: ['billing'],
    description: 'Account-level usage for a month (UTC), by item, by browser (including deleted ones) and by day.',
    request: { query: MonthQuery },
    responses: { 200: json(AccountUsage, 'Usage') },
  }),
  async (c) => c.json(await accountUsage(c.get('db'), c.get('user').id, monthOf(c.req.valid('query').month)), 200),
);

billingRoute.openapi(
  createRoute({
    method: 'post',
    path: '/billing/checkout',
    tags: ['billing'],
    description: 'Starts a Creem hosted checkout for a top-up. The balance is credited from Creem’s record of the paid checkout, never from the redirect.',
    request: { body: { content: { 'application/json': { schema: CheckoutBody } }, required: true } },
    responses: { 200: json(RedirectResult, 'Creem checkout URL'), ...problems },
  }),
  async (c) => {
    const creem = requireCreem(c);
    const db = c.get('db');
    const user = c.get('user');
    const { productId } = c.req.valid('json');
    const packs = await offeredTopupPacks(db, creem);
    if (!packs.some((p) => p.productId === productId)) throw problem(400, 'validation_failed', 'Unknown top-up.');
    const attemptId = newId();
    await db.insert(topupCheckouts).values({ id: attemptId, userId: user.id, productId, createdAt: new Date() });
    const out = await creem.createCheckout({
      productId,
      requestId: attemptId,
      successUrl: `${c.env.APP_URL}/billing/success`,
      email: user.email,
      metadata: { userId: user.id, attemptId },
    });
    if (out.id) await db.update(topupCheckouts).set({ checkoutId: out.id }).where(eq(topupCheckouts.id, attemptId));
    return c.json({ url: out.url }, 200);
  },
);

billingRoute.openapi(
  createRoute({
    method: 'post',
    path: '/billing/portal',
    tags: ['billing'],
    description: 'Creem customer portal: receipts and invoices for top-ups.',
    responses: { 200: json(RedirectResult, 'Creem customer portal URL'), ...problems },
  }),
  async (c) => {
    const creem = requireCreem(c);
    const [cust] = await c.get('db').select().from(billingCustomers).where(eq(billingCustomers.userId, c.get('user').id));
    if (!cust) throw problem(409, 'invalid_state', 'You have not bought credit yet.');
    return c.json({ url: await creem.portalUrl(cust.creemCustomerId) }, 200);
  },
);
