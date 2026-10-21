import { z } from 'zod';

/**
 * Promotions: tasks that reward users with credit while they learn the product. Operators pick
 * what counts as done from these criteria and set a target in the criterion's unit.
 */
export const PromotionCriterion = z.enum([
  /**
   * One browser has been used for `target` minutes in total: its live view open, over any number
   * of sessions. Only one viewer can be open per browser, so time is never counted twice.
   */
  'browser_used_minutes',
  /** One browser has run for `target` minutes in total (billed time: boot and shutdown included). */
  'browser_running_minutes',
  /** All the user's browsers together have run for `target` minutes. */
  'total_running_minutes',
  /** The live view has been open for `target` minutes in total, across all browsers. */
  'live_view_minutes',
  /** `target` browsers created (deleted ones count; failed creates do not). */
  'browsers_created',
  /** `target` US dollars of paid top-ups. */
  'topup_usd',
  /** Two-step verification is on (target 1). */
  'two_factor_enabled',
  /** At least `target` passkeys added. */
  'passkeys_added',
  /**
   * `target` different UTC days on which the live view was open for at least
   * PROMOTION_ACTIVE_DAY_MINUTES minutes in total (any browsers).
   */
  'active_days',
  /** Browsers created in `target` different regions (deleted ones count; failed creates do not). */
  'regions_used',
  /** `target` storage upgrades that finished (a browser's data volume grown). */
  'storage_resized',
  /** `target` US dollars of usage actually charged to the balance (trial usage is never charged). */
  'paid_usage_usd',
  /** `target` separate paid top-ups (a refunded or disputed one does not count). */
  'topups_count',
]);
export type PromotionCriterion = z.infer<typeof PromotionCriterion>;

/** The unit each criterion's target and progress are counted in. */
export const PROMOTION_UNIT: Record<PromotionCriterion, 'minutes' | 'browsers' | 'usd' | 'step' | 'passkeys' | 'days' | 'regions' | 'times' | 'topups'> = {
  browser_used_minutes: 'minutes',
  browser_running_minutes: 'minutes',
  total_running_minutes: 'minutes',
  live_view_minutes: 'minutes',
  browsers_created: 'browsers',
  topup_usd: 'usd',
  two_factor_enabled: 'step',
  passkeys_added: 'passkeys',
  active_days: 'days',
  regions_used: 'regions',
  storage_resized: 'times',
  paid_usage_usd: 'usd',
  topups_count: 'topups',
};

/** Live-view minutes in one UTC day that make it an active day (`active_days`). */
export const PROMOTION_ACTIVE_DAY_MINUTES = 5;

/** The most one task can pay. Rewards stay small: they help users explore, never fund their usage. */
export const PROMOTION_MAX_REWARD_MICROS = 10_000_000;

/**
 * Rewards from tasks that need a top-up are capped per account at this share of its paid top-ups
 * (net of refunds and disputes). A reward that would go past it waits until the account has added
 * enough credit, so promotions can never fund an account's usage on their own.
 */
export const PROMOTION_TOPUP_SHARE_PERCENT = 50;

export const LocalizedText = z.object({ en: z.string().trim().min(1).max(500), 'zh-CN': z.string().trim().min(1).max(500) });

/** A task as the signed-in user sees it, with their progress. */
export const PromotionTask = z.object({
  id: z.string(),
  title: LocalizedText,
  description: LocalizedText,
  actionUrl: z.string().nullable(),
  criterion: PromotionCriterion,
  target: z.number().int(),
  progress: z.number().int(),
  rewardMicros: z.number().int(),
  status: z.enum(['pending', 'completed']),
  /** True when the account cannot earn it yet: the task needs a paid top-up first. */
  needsTopup: z.boolean(),
  /**
   * More paid top-up the account needs before this reward fits under its cap
   * (PROMOTION_TOPUP_SHARE_PERCENT of its top-ups); 0 when it fits or no top-up was made yet.
   */
  topupToUnlockMicros: z.number().int(),
  completedAt: z.string().nullable(),
  endsAt: z.string().nullable(),
});
export type PromotionTask = z.infer<typeof PromotionTask>;

/** The operator's definition of a task (console). */
export const PromotionTaskInput = z.object({
  title: LocalizedText,
  description: LocalizedText,
  actionUrl: z.string().trim().max(200).regex(/^\/(?!\/)/, 'must be a path in the app, starting with /').nullable(),
  criterion: PromotionCriterion,
  target: z.number().int().min(1).max(1_000_000),
  /** At most $10 per task (PROMOTION_MAX_REWARD_MICROS). */
  rewardMicros: z.number().int().min(0).max(PROMOTION_MAX_REWARD_MICROS),
  enabled: z.boolean(),
  requiresTopup: z.boolean(),
  sortOrder: z.number().int().min(-1000).max(1000),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime().nullable(),
  maxCompletions: z.number().int().min(1).max(10_000_000).nullable(),
});
export type PromotionTaskInput = z.infer<typeof PromotionTaskInput>;

export const PROMOTION_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
