import { z } from 'zod';
import { RegionId } from './regions.js';
import { UsageItem } from './pricing.js';

/**
 * Prepaid, usage-based billing (page 6). Users top up a balance through Creem (one-time payments of
 * the top-up products configured in Creem); browsers draw from it per minute at the prices in
 * `pricing.ts`. When the balance runs out, running browsers sleep 10 minutes later; a sleeping
 * browser's IP and storage keep being charged (the balance can go below zero) for up to 30 days,
 * then the browsers are deleted. Topping up clears the debt and lets them wake again.
 *
 * `pilot`: the invite-only pilot (control flag `billing_required` off). Usage is metered and shown
 * at the real prices, but nothing is taken from a balance.
 */
export const BillingMode = z.enum(['pilot', 'prepaid']);
export type BillingMode = z.infer<typeof BillingMode>;

/** Running browsers sleep this long after the balance runs out (the session view warns). */
export const BALANCE_GRACE_MS = 10 * 60_000;
/** After the balance ran out, browsers are kept this long, then deleted. */
export const DATA_KEPT_DAYS = 30;

/**
 * The free trial (page 6): each user may create one browser for free, once. It runs in one region
 * on the smallest practical setup (a 2 GB data volume, no snapshots, 5-minute auto-sleep) and for
 * 10 minutes of running time in all; then it sleeps. A trial browser is kept 7 days after it last
 * went to sleep, then deleted and purged (its IP released). Adding credit before that turns it
 * into a normal browser with the same data and IP, charged like any other from then on: running
 * time, plus its dedicated IP and storage for as long as it exists (AWS bills both even while the
 * VM is stopped). The trial itself is never charged.
 */
export const TRIAL = {
  regionId: 'syd1',
  runningSeconds: 10 * 60,
  storageGb: 2,
  idleTimeoutS: 300,
  keptDays: 7,
} as const;

export const TrialState = z.enum(['active', 'ended', 'converted']);
export type TrialState = z.infer<typeof TrialState>;

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
  /** False when Creem is not configured on this deployment: no top-ups. */
  enabled: z.boolean(),
  balanceMicros: z.number().int(),
  /** When the balance reached zero; running browsers sleep 10 minutes later. */
  exhaustedAt: z.string().nullable(),
  /** After the balance ran out, browsers are kept until this date, then deleted. */
  dataKeptUntil: z.string().nullable(),
  /** Frozen after a dispute: nothing can run until support resolves it. */
  frozen: z.boolean(),
  minBalanceMicros: z.number().int(),
  lowBalanceMicros: z.number().int(),
  /** What all of the user's browsers cost per hour right now (running ones plus everything kept). */
  burnHourMicros: z.number().int(),
  topUps: z.array(TopUpPack),
  /** This calendar month (UTC). */
  month: UsageTotals.extend({ month: z.string() }),
  /** Whether the user can still start their one free trial, and where. */
  trial: z.object({ eligible: z.boolean(), regionId: RegionId, minutes: z.number().int(), storageGb: z.number().int(), keptDays: z.number().int() }),
});
export type BillingState = z.infer<typeof BillingState>;

export const BalanceTransaction = z.object({
  id: z.string(),
  kind: z.enum(['topup', 'refund', 'dispute', 'adjustment']),
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
