import { z } from 'zod';
import { RegionId } from './regions.js';
import { UsageItem } from './pricing.js';

/**
 * Prepaid, usage-based billing (page 6). Users top up a balance through Stripe, or through Creem
 * when Stripe is not configured (one-time payments of the top-up prices or products configured
 * there); browsers draw from it per minute at the prices in
 * `pricing.ts`. When the balance runs out, access stops immediately. Seven days of fixed IP/disk/snapshot charges are reserved before a
 * paid browser can be used. Only available credit pays active usage; the deposit pays fixed
 * charges during the seven-day stopped retention window, then the browser is permanently deleted.
 * Normal usage never creates debt; payment reversals may leave a negative balance.
 *
 * `pilot`: the invite-only pilot (control flag `billing_required` off). Usage is metered and shown
 * at the real prices, but nothing is taken from a balance.
 */
export const BillingMode = z.enum(['pilot', 'prepaid']);
export type BillingMode = z.infer<typeof BillingMode>;

/** No unpaid-use grace period. */
export const BALANCE_GRACE_MS = 0;
/** After the balance ran out, browsers are kept this long, then deleted. */
export const DATA_KEPT_DAYS = 7;
/**
 * Funded-time warnings: each is emailed once as available credit falls below that many hours of
 * the account's combined spending, and re-armed only after credit clearly recovers.
 */
export const RUNWAY_WARNING_HOURS = [24, 6, 1] as const;

/** Who takes top-ups: Stripe when it is configured, else Creem (the merchant of record). */
export const PaymentProviderId = z.enum(['stripe', 'creem']);
export type PaymentProviderId = z.infer<typeof PaymentProviderId>;

export const TopUpPack = z.object({
  productId: z.string(),
  name: z.string(),
  /** What the user pays (before tax) and what is added to the balance, in cents. */
  amountCents: z.number().int(),
  currency: z.string(),
});
export type TopUpPack = z.infer<typeof TopUpPack>;

export const UsageTotals = z.object({
  totalMicros: z.number().int(),
  byItem: z.record(UsageItem, z.number().int()),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const BillingState = z.object({
  mode: BillingMode,
  /** False when no payment provider is configured on this deployment: no top-ups. */
  enabled: z.boolean(),
  /** The provider top-ups go to; null when `enabled` is false. */
  provider: PaymentProviderId.nullable(),
  /** Total unspent prepaid credit, including the fixed-resource deposit. */
  balanceMicros: z.number().int(),
  reservedMicros: z.number().int().nonnegative(),
  availableMicros: z.number().int().nonnegative(),
  retentionDays: z.number().int().positive(),
  /** When spendable credit became insufficient and the seven-day retention window began. */
  exhaustedAt: z.string().nullable(),
  /** After the balance ran out, browsers are kept until this date, then deleted. */
  dataKeptUntil: z.string().nullable(),
  /** Frozen after a dispute: nothing can run until support resolves it. */
  frozen: z.boolean(),
  minBalanceMicros: z.number().int(),
  lowBalanceMicros: z.number().int(),
  /** What all of the user's browsers cost per hour right now (running ones plus everything kept). */
  burnHourMicros: z.number().int(),
  /** When available credit runs out at that combined rate; null when nothing is being charged. */
  fundedUntil: z.string().nullable(),
  /**
   * After credit ran out: the browsers being kept, each deleted at `deletesAt` unless credit is
   * added, and the least top-up that keeps all of them and lets them be woken again.
   */
  retained: z.array(z.object({ id: z.string(), name: z.string(), regionId: RegionId, deletesAt: z.string() })),
  restoreNeededMicros: z.number().int().nullable(),
  topUps: z.array(TopUpPack),
  /** This calendar month (UTC). */
  month: UsageTotals.extend({ month: z.string() }),
});
export type BillingState = z.infer<typeof BillingState>;

export const BalanceTransaction = z.object({
  id: z.string(),
  kind: z.enum(['topup', 'refund', 'dispute', 'adjustment', 'promotion', 'signup']),
  amountMicros: z.number().int(),
  description: z.string().nullable(),
  createdAt: z.string(),
});
export type BalanceTransaction = z.infer<typeof BalanceTransaction>;

export const CheckoutBody = z.object({ productId: z.string().min(1).max(128) });
export const RedirectResult = z.object({ url: z.string().url() });

/** Account-level usage for a month: every browser, including deleted ones. */
export const AccountUsage = UsageTotals.extend({
  month: z.string(),
  byBrowser: z.array(
    UsageTotals.extend({
      instanceId: z.string(),
      name: z.string(),
      regionId: RegionId,
      deleted: z.boolean(),
    }),
  ),
  byDay: z.array(z.object({ day: z.string(), totalMicros: z.number().int() })),
});
export type AccountUsage = z.infer<typeof AccountUsage>;

/** One browser's usage for a month, per item with quantities, and per day. */
export const InstanceUsage = z.object({
  month: z.string(),
  totalMicros: z.number().int(),
  items: z.array(z.object({ item: UsageItem, quantity: z.number(), amountMicros: z.number().int() })),
  byDay: z.array(z.object({ day: z.string(), totalMicros: z.number().int(), byItem: z.record(UsageItem, z.number().int()) })),
  /** What this browser costs per hour right now, and per month while it is kept. */
  now: z.object({ hourMicros: z.number().int(), runningHourMicros: z.number().int(), alwaysOnMonthMicros: z.number().int() }),
});
export type InstanceUsage = z.infer<typeof InstanceUsage>;
