/**
 * Billing endpoints (page 6). Access is never granted from a redirect: checkout, plan and unit
 * changes go to Creem, and entitlements change only from Creem's own subscription state
 * (webhooks, or a re-fetch right after a change we made).
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  BillingState,
  ChangeBrowsersBody,
  ChangePlanBody,
  CheckoutBody,
  PRO_MIN_BROWSERS,
  Problem,
  RedirectResult,
  planFamily,
  planLimits,
  type PlanKey,
} from '@cloudbrowser/contracts';
import { newId, schema, usageMonth, userCaps } from '@cloudbrowser/db';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { creemFrom, type Creem } from '../billing/creem.js';
import { DATA_KEPT_DAYS } from '../billing/sweep.js';
import { accessOf, bestSubscription, syncSubscription } from '../billing/sync.js';
import type { AppEnv } from '../env.js';
import { usage } from '../limits.js';
import { problem } from '../problem.js';

const { subscriptions, billingCustomers, checkoutAttempts, activeUsage, auditLog } = schema;

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

function requireCreem(c: Context<AppEnv>): Creem {
  const creem = creemFrom(c.env);
  if (!creem) throw problem(503, 'billing_unavailable', 'Billing is not set up on this deployment.');
  return creem;
}

async function billingState(c: Context<AppEnv>): Promise<BillingState> {
  const db = c.get('db');
  const user = c.get('user');
  const now = new Date();
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
  const best = bestSubscription(subs, now);
  const shown = best?.sub ?? [...subs].sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime())[0];
  const [used] = await db
    .select()
    .from(activeUsage)
    .where(and(eq(activeUsage.userId, user.id), eq(activeUsage.month, usageMonth(now))));
  const included = (await userCaps(db, user.id)).get('hours_per_month');
  const ended = subs.length > 0 && !best ? Math.max(...subs.map((s) => s.accessEndedAt?.getTime() ?? 0)) : 0;
  return {
    enabled: creemFrom(c.env) !== null,
    subscription: shown
      ? {
          plan: shown.plan as PlanKey,
          browsers: shown.units,
          status: shown.status,
          access: accessOf(shown, now),
          currentPeriodEnd: shown.currentPeriodEnd?.toISOString() ?? null,
        }
      : null,
    hours: { used: Math.round(((used?.seconds ?? 0) / 3600) * 10) / 10, included: included ?? null },
    dataKeptUntil: ended ? new Date(ended + DATA_KEPT_DAYS * 86_400_000).toISOString() : null,
  };
}

async function currentSubscription(c: Context<AppEnv>) {
  const subs = await c.get('db').select().from(subscriptions).where(eq(subscriptions.userId, c.get('user').id));
  return bestSubscription(subs, new Date())?.sub ?? null;
}

billingRoute.openapi(
  createRoute({ method: 'get', path: '/billing', tags: ['billing'], responses: { 200: json(BillingState, 'Plan, status and active hours') } }),
  async (c) => c.json(await billingState(c), 200),
);

billingRoute.openapi(
  createRoute({
    method: 'post',
    path: '/billing/checkout',
    tags: ['billing'],
    description: 'Starts a Creem hosted checkout. Access follows from the webhook, never from the redirect.',
    request: { body: { content: { 'application/json': { schema: CheckoutBody } }, required: true } },
    responses: { 200: json(RedirectResult, 'Creem checkout URL'), ...problems },
  }),
  async (c) => {
    const creem = requireCreem(c);
    const db = c.get('db');
    const user = c.get('user');
    const { plan, browsers } = c.req.valid('json');
    if (await currentSubscription(c)) throw problem(409, 'invalid_state', 'You already have a plan. Change it from the billing page.');
    const pro = planFamily(plan) === 'pro';
    if (pro && browsers < PRO_MIN_BROWSERS) throw problem(400, 'validation_failed', `Pro starts at ${PRO_MIN_BROWSERS} browsers.`);
    const attemptId = newId();
    await db.insert(checkoutAttempts).values({ id: attemptId, userId: user.id, plan, browsers: pro ? browsers : 1, createdAt: new Date() });
    const out = await creem.createCheckout({
      plan,
      units: pro ? browsers : undefined,
      requestId: attemptId,
      successUrl: `${c.env.APP_URL}/billing/success`,
      email: user.email,
      metadata: { userId: user.id, attemptId },
    });
    if (out.id) await db.update(checkoutAttempts).set({ checkoutId: out.id }).where(eq(checkoutAttempts.id, attemptId));
    return c.json({ url: out.url }, 200);
  },
);

billingRoute.openapi(
  createRoute({
    method: 'post',
    path: '/billing/portal',
    tags: ['billing'],
    description: 'Creem customer portal: cancel, payment method, invoices.',
    responses: { 200: json(RedirectResult, 'Creem customer portal URL'), ...problems },
  }),
  async (c) => {
    const creem = requireCreem(c);
    const [cust] = await c.get('db').select().from(billingCustomers).where(eq(billingCustomers.userId, c.get('user').id));
    if (!cust) throw problem(409, 'invalid_state', 'You do not have a subscription yet.');
    return c.json({ url: await creem.portalUrl(cust.creemCustomerId) }, 200);
  },
);

/** Refuses a change that would leave the user with more browsers than the new plan allows. */
async function checkFits(c: Context<AppEnv>, plan: PlanKey, browsers: number) {
  const have = (await usage(c.get('db'), c.get('user').id)).browsers;
  const allowed = planLimits(plan, browsers).maxBrowsers;
  if (have > allowed) {
    throw problem(409, 'too_many_browsers', `You have ${have} browsers; the new plan allows ${allowed}. Delete browsers first.`);
  }
}

billingRoute.openapi(
  createRoute({
    method: 'post',
    path: '/billing/plan',
    tags: ['billing'],
    description: 'Switches the subscription to another plan, prorated and charged now.',
    request: { body: { content: { 'application/json': { schema: ChangePlanBody } }, required: true } },
    responses: { 200: json(BillingState, 'New billing state'), ...problems },
  }),
  async (c) => {
    const creem = requireCreem(c);
    const db = c.get('db');
    const user = c.get('user');
    const { plan, browsers } = c.req.valid('json');
    const sub = await currentSubscription(c);
    if (!sub) throw problem(409, 'invalid_state', 'You do not have a plan yet.');
    const pro = planFamily(plan) === 'pro';
    const units = pro ? Math.max(PRO_MIN_BROWSERS, browsers ?? sub.units) : 1;
    await checkFits(c, plan, units);
    if (plan !== sub.plan) await creem.upgrade(sub.id, plan, 'proration-charge-immediately');
    if (pro) {
      // The item can change with the product: re-read it before setting units.
      const fresh = await creem.getSubscription(sub.id);
      if (fresh.itemId && fresh.units !== units) await creem.setUnits(sub.id, fresh.itemId, units, 'proration-charge-immediately');
    }
    await syncSubscription(c.env, db, creem, sub.id, { userId: user.id }, new Date());
    await db.insert(auditLog).values({ actor: `user:${user.id}`, action: 'billing.plan_changed', target: `user:${user.id}`, detail: { from: sub.plan, to: plan, units }, createdAt: new Date() });
    return c.json(await billingState(c), 200);
  },
);

billingRoute.openapi(
  createRoute({
    method: 'post',
    path: '/billing/browsers',
    tags: ['billing'],
    description: 'Pro: changes the number of browsers. Adding is charged now (prorated); removing is credited to the next invoice.',
    request: { body: { content: { 'application/json': { schema: ChangeBrowsersBody } }, required: true } },
    responses: { 200: json(BillingState, 'New billing state'), ...problems },
  }),
  async (c) => {
    const creem = requireCreem(c);
    const db = c.get('db');
    const user = c.get('user');
    const { browsers } = c.req.valid('json');
    const sub = await currentSubscription(c);
    if (!sub || planFamily(sub.plan as PlanKey) !== 'pro') throw problem(409, 'invalid_state', 'Only Pro plans have a number of browsers.');
    await checkFits(c, sub.plan as PlanKey, browsers);
    if (browsers !== sub.units) {
      const itemId = sub.itemId ?? (await creem.getSubscription(sub.id)).itemId;
      if (!itemId) throw problem(409, 'invalid_state', 'This subscription has no seat item.');
      await creem.setUnits(sub.id, itemId, browsers, browsers > sub.units ? 'proration-charge-immediately' : 'proration-charge');
      await syncSubscription(c.env, db, creem, sub.id, { userId: user.id }, new Date());
      await db.insert(auditLog).values({ actor: `user:${user.id}`, action: 'billing.browsers_changed', target: `user:${user.id}`, detail: { from: sub.units, to: browsers }, createdAt: new Date() });
    }
    return c.json(await billingState(c), 200);
  },
);
