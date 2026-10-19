import { z } from 'zod';

/** Operator policy; prices, regions, usage and quotas are provider observations. */
export const AwsProviderSettings = z.object({
  inventoryMode: z.enum(['quota', 'budget']),
  monthlyBudgetMicros: z.number().int().nonnegative().nullable(),
  estimatedHoursPerDay: z.number().min(1).max(24),
});
export type AwsProviderSettings = z.infer<typeof AwsProviderSettings>;
export const AWS_QUOTA_MAX_AGE_MS = 20 * 60_000;
export const AWS_BILLING_MAX_AGE_MS = 26 * 3_600_000;
export const AWS_PRICE_MAX_AGE_MS = 48 * 3_600_000;
