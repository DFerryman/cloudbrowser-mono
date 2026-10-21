import type { BrowserTier, Region, RegionPricing } from '@cloudbrowser/contracts';

/**
 * A region's prices as a new browser of this tier sees them: Premium's rates, machine and price
 * version in place of Basic's, so every price view applies unchanged. Unavailable where the
 * region does not offer the tier.
 */
export function pricingForTier(p: RegionPricing, tier: BrowserTier): RegionPricing {
  if (tier === 'basic') return p;
  return p.premium
    ? { ...p, rates: p.premium.rates, machine: p.premium.machine, version: p.premium.version }
    : { ...p, available: false, rates: null, machine: null, version: null };
}

/**
 * Whether a region can take a new browser of this tier, and how many more it has room for, in the
 * shape the region list reads. Premium has its own stock: it needs more of the account's vCPUs.
 */
export function regionForTier(r: Region, tier: BrowserTier): Region {
  if (tier === 'basic') return r;
  const premium = r.premium ?? null;
  const { inventory: _basicStock, ...rest } = r;
  return {
    ...rest,
    ...(premium?.inventory ? { inventory: premium.inventory } : {}),
    acceptingNew: !!premium && premium.availability !== 'unavailable',
    availability: premium?.availability ?? 'unavailable',
    availabilityReason: premium?.availabilityReason ?? null,
  };
}
