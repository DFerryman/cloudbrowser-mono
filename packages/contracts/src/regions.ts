import { z } from 'zod';
import { REGION_AREAS } from './aws-regions.js';

export const RegionId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);
export type RegionId = z.infer<typeof RegionId>;

export const DEFAULT_REGION: RegionId = 'syd1';

/** Static facts about each product region. Availability comes from the API. */
export const REGION_INFO: Record<RegionId, { country: 'AU' | 'JP' | 'US'; city: string; timezone: string }> = {
  syd1: { country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney' },
  tyo1: { country: 'JP', city: 'Tokyo', timezone: 'Asia/Tokyo' },
  usw1: { country: 'US', city: 'West', timezone: 'America/Los_Angeles' },
};

export const Region = z.object({
  id: RegionId,
  name: z.string(),
  country: z.string(),
  city: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  /** False when the region cap or provider quota leaves no room for a new browser. */
  acceptingNew: z.boolean(),
  inventory: z.object({ available: z.number().int().nonnegative(), checkedAt: z.string().nullable(), status: z.enum(['ready', 'syncing', 'unavailable']), constraint: z.string().nullable() }).optional(),
  /** URL the client fetches to measure latency from its own network; null when not configured. */
  probeUrl: z.string().nullable(),
  /** Continent group for a long list; null when the region is not in the facts table. */
  area: z.enum(REGION_AREAS).nullable(),
  /**
   * What a new browser can expect here now. `limited`: creation is allowed but may wait or
   * stock is nearly gone; `unavailable`: creation is refused (same as acceptingNew false).
   * `blocked`: the provider refused our account here (e.g. its encryption key), until an operator
   * fixes it; `provider_issue`: a provider failure that is retried after a pause.
   */
  availability: z.enum(['available', 'limited', 'unavailable']),
  availabilityReason: z.enum(['low_stock', 'capacity', 'provider_issue', 'blocked', 'no_stock', 'closed']).nullable(),
  /**
   * When a browser last launched here: null for a region where none has yet (configuration
   * checks passed, but no VM has proved it).
   */
  launchVerifiedAt: z.string().nullable(),
  /** Round trip estimated from the caller's approximate location, before the client measures it. */
  estimatedRttMs: z.number().int().nonnegative().nullable(),
});
export type Region = z.infer<typeof Region>;
