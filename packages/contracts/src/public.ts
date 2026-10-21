import { z } from 'zod';
import { RegionPricing, Rates } from './pricing.js';
import { Region, RegionId } from './regions.js';

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
      /** What each unit costs us there (AWS list price; transfer includes the relay), before markups. */
      cost: Rates.nullable(),
      /** The same for a Premium browser (only compute differs); null where Premium is not offered. */
      premiumCost: Rates.nullable().optional(),
      /** Whether new Premium browsers can be created there; null where Premium is not offered. */
      premiumAvailability: z.enum(['available', 'limited', 'unavailable']).nullable().optional(),
    }).merge(Region.pick({ city: true, country: true, area: true, availability: true })),
  ),
  /** The pricing model, published: price = cost × the markup for that kind of cost ÷ 100. */
  model: z.object({
    computeMarkupPercent: z.number().int(),
    fixedMarkupPercent: z.number().int(),
    transferMarkupPercent: z.number().int(),
    /** The TURN relay's price per GB, included in each region's transfer cost. */
    relayGbMicros: z.number().int(),
    /** Boot and shutdown minutes are charged as running time. */
    billTransitions: z.boolean(),
  }),
  /** Whether new accounts may create Premium browsers (the operator's `premium` switch for user:default). */
  premiumOffered: z.boolean().optional(),
  /** The least available credit needed to create or wake a paid browser. */
  minBalanceMicros: z.number().int(),
  /** Days a browser and its data are kept after available credit runs out. */
  retentionDays: z.number().int(),
  /** Credit granted once when a new account is registered; zero disables the offer. */
  signupCreditMicros: z.number().int().nonnegative(),
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
    }).merge(Region.pick({ name: true, city: true, country: true, area: true, availability: true, availabilityReason: true, launchVerifiedAt: true })),
  ),
  /** An operator paused new browsers everywhere; existing browsers keep working. */
  creationPaused: z.boolean(),
});
export type PublicStatus = z.infer<typeof PublicStatus>;
