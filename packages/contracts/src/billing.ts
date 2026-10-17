import { z } from 'zod';

/**
 * Plans (page 6). 1 billing unit = 1 browser = 1 dedicated IP. Personal is a fixed-price product;
 * Pro is seat-based (units = browsers, minimum 2). Prices live in Creem; these are the entitlements.
 */
export const PlanKey = z.enum(['personal_monthly', 'personal_yearly', 'pro_monthly', 'pro_yearly']);
export type PlanKey = z.infer<typeof PlanKey>;

export type PlanFamily = 'personal' | 'pro';
export const planFamily = (p: PlanKey): PlanFamily => (p.startsWith('pro') ? 'pro' : 'personal');

export const PRO_MIN_BROWSERS = 2;
export const PRO_MAX_BROWSERS = 50;

/** Working prices in USD cents (page 6); the charged amount is whatever the Creem product says. */
export const PLAN_PRICES: Record<PlanKey, { cents: number; per: 'month' | 'year'; perBrowser: boolean }> = {
  personal_monthly: { cents: 2900, per: 'month', perBrowser: false },
  personal_yearly: { cents: 29000, per: 'year', perBrowser: false },
  pro_monthly: { cents: 2500, per: 'month', perBrowser: true },
  pro_yearly: { cents: 25000, per: 'year', perBrowser: true },
};

export interface PlanLimits {
  maxBrowsers: number;
  maxRunning: number;
  hoursPerMonth: number;
  idleTimeoutMaxS: number;
  storageGb: number;
  fpsMax: number;
  snapshotRetentionDays: number;
  ipChangesPerMonth: number;
}

/** Pure: what a plan with `browsers` units allows. Unit-tested for every plan. */
export function planLimits(plan: PlanKey, browsers = 1): PlanLimits {
  if (planFamily(plan) === 'personal') {
    return { maxBrowsers: 1, maxRunning: 1, hoursPerMonth: 60, idleTimeoutMaxS: 1800, storageGb: 20, fpsMax: 30, snapshotRetentionDays: 7, ipChangesPerMonth: 1 };
  }
  const n = Math.min(PRO_MAX_BROWSERS, Math.max(PRO_MIN_BROWSERS, Math.floor(browsers)));
  return { maxBrowsers: n, maxRunning: n, hoursPerMonth: 60 * n, idleTimeoutMaxS: 3600, storageGb: 30, fpsMax: 60, snapshotRetentionDays: 14, ipChangesPerMonth: n };
}

/**
 * Creem subscription statuses as mirrored. Unknown values are kept as-is and grant nothing.
 * `scheduled_cancel` and `canceled` keep access until the period ends; `past_due`/`unpaid` get a
 * 7-day grace period.
 */
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'unpaid' | 'scheduled_cancel' | 'canceled' | 'paused' | 'expired' | string;

export const GRACE_DAYS = 7;

export type Access = 'active' | 'ending' | 'grace' | 'none';

/** Pure: whether a subscription grants access now. */
export function subscriptionAccess(
  sub: { status: SubscriptionStatus; currentPeriodEnd: Date | null; pastDueSince: Date | null },
  now: Date,
): Access {
  const periodLeft = sub.currentPeriodEnd ? sub.currentPeriodEnd.getTime() > now.getTime() : false;
  switch (sub.status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'scheduled_cancel':
    case 'canceled':
      return periodLeft ? 'ending' : 'none';
    case 'past_due':
    case 'unpaid': {
      const since = sub.pastDueSince ?? now;
      return now.getTime() - since.getTime() < GRACE_DAYS * 86_400_000 ? 'grace' : 'none';
    }
    default:
      return 'none';
  }
}

export const Plan = z.enum(['pilot', 'personal', 'pro', 'none']);
export type Plan = z.infer<typeof Plan>;

export const BillingSubscription = z.object({
  plan: PlanKey,
  browsers: z.number().int(),
  status: z.string(),
  access: z.enum(['active', 'ending', 'grace', 'none']),
  currentPeriodEnd: z.string().nullable(),
});
export type BillingSubscription = z.infer<typeof BillingSubscription>;

export const BillingState = z.object({
  /** False when Creem is not configured on this deployment (the pilot runs without payments). */
  enabled: z.boolean(),
  subscription: BillingSubscription.nullable(),
  hours: z.object({ used: z.number(), included: z.number().nullable() }),
  /** Browsers' data is kept until this date after access ended, then they are deleted. */
  dataKeptUntil: z.string().nullable(),
});
export type BillingState = z.infer<typeof BillingState>;

export const CheckoutBody = z.object({
  plan: PlanKey,
  browsers: z.number().int().min(1).max(PRO_MAX_BROWSERS).default(1),
});
export const ChangeBrowsersBody = z.object({ browsers: z.number().int().min(PRO_MIN_BROWSERS).max(PRO_MAX_BROWSERS) });
export const ChangePlanBody = z.object({ plan: PlanKey, browsers: z.number().int().min(1).max(PRO_MAX_BROWSERS).optional() });
export const RedirectResult = z.object({ url: z.string().url() });
