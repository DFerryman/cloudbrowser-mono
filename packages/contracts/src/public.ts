import { z } from 'zod';
import { RegionPricing } from './pricing.js';
import { RegionId } from './regions.js';

/**
 * Signed-out pages (`/api/public/*`): the price list and the service status. Nothing here is
 * about one user; it is the same for every visitor and may be cached briefly.
 */
export const PublicPricing = z.object({
  regions: z.array(
    RegionPricing.omit({ version: true }).extend({
      name: z.string(),
      /** False when the region takes no new browsers right now (existing ones keep working). */
      acceptingNew: z.boolean(),
    }),
  ),
  /** The least available credit needed to create or wake a paid browser. */
  minBalanceMicros: z.number().int(),
  /** Days a browser and its data are kept after available credit runs out. */
  retentionDays: z.number().int(),
  trial: z.object({ regionId: RegionId, minutes: z.number().int(), storageGb: z.number().int(), keptDays: z.number().int() }),
});
export type PublicPricing = z.infer<typeof PublicPricing>;

export const ComponentStatus = z.enum(['operational', 'degraded', 'outage']);
export type ComponentStatus = z.infer<typeof ComponentStatus>;

export const PublicStatus = z.object({
  status: ComponentStatus,
  checkedAt: z.string(),
  components: z.array(z.object({ id: z.enum(['api', 'database', 'automation']), status: ComponentStatus })),
  regions: z.array(
    z.object({
      regionId: RegionId,
      status: ComponentStatus,
      /** Existing browsers can be opened. */
      enabled: z.boolean(),
      /** New browsers can be created. */
      acceptingNew: z.boolean(),
    }),
  ),
  /** An operator paused new browsers everywhere; existing browsers keep working. */
  creationPaused: z.boolean(),
});
export type PublicStatus = z.infer<typeof PublicStatus>;
