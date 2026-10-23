/**
 * Customer prices (page 6): each region's provider price sheet (read by the engine from the AWS
 * Price List API) times the operator's markup. Priced actions carry the price version the user
 * was shown; if prices changed meanwhile, the action is refused with `price_changed`.
 */
import {
  browserEstimate,
  BrowserTier,
  customerRates,
  AWS_PRICE_MAX_AGE_MS,
  priceVersion,
  tierSheet,
  type ProviderPriceSheet,
  type Rates,
  type RegionId,
  type RegionPricing,
} from '@cloudbrowser/contracts';
import { priceSheets, pricingSettings, schema, userCaps, type Db } from '@cloudbrowser/db';
import { and, asc, eq } from 'drizzle-orm';
import { problem } from './problem.js';

/** Data volume of a new browser and the most it can grow to, unless a cap says otherwise. */
export const DEFAULT_STORAGE_GB = 10;
export const DEFAULT_MAX_STORAGE_GB = 100;

export interface RegionPrice {
  sheet: ProviderPriceSheet;
  rates: Rates;
  version: string;
  fetchedAt: Date;
}

/**
 * The customer price of a new browser of this tier in one region now, or null before the
 * region's prices were read from the provider or where the tier is not offered.
 */
export async function regionPrice(db: Db, regionId: string, tier: BrowserTier = 'basic'): Promise<RegionPrice | null> {
  const stored = (await priceSheets(db)).get(regionId);
  const sheet = stored ? tierSheet(stored.sheet, tier) : null;
  if (!stored || !sheet) return null;
  const rates = customerRates(sheet, await pricingSettings(db));
  return { sheet, rates, version: priceVersion(rates, sheet.rootVolumeGb), fetchedAt: stored.fetchedAt };
}

/** Existing browsers show their observed machine and root disk, not the new-browser default. */
export async function instancePrice(db: Db, inst: { id: string; regionId: string; tier: string }): Promise<RegionPrice | null> {
  const tier = BrowserTier.catch('basic').parse(inst.tier);
  // A browser keeps its machine even where its tier is no longer offered to new browsers.
  const tierPrice = await regionPrice(db, inst.regionId, tier);
  const p = tierPrice ?? (await regionPrice(db, inst.regionId));
  if (!p) return null;
  const [placement] = await db.select().from(schema.placements).where(and(eq(schema.placements.instanceId, inst.id), eq(schema.placements.status, 'current')));
  const machine = placement?.instanceType ? p.sheet.instanceTypes[placement.instanceType] : tierPrice?.sheet.vmHour;
  // A capacity fallback that costs more than the tier's machine is billed at the tier's price.
  const actual = machine !== undefined && tierPrice ? Math.min(machine, tierPrice.sheet.vmHour) : machine;
  if (actual === undefined) return null;
  const sheet = { ...p.sheet, vmHour: actual, rootVolumeGb: placement?.rootVolumeGb ?? p.sheet.rootVolumeGb };
  return { ...p, sheet, rates: { ...customerRates(sheet, await pricingSettings(db)), snapshot: 0 } };
}

/**
 * Like regionPrice, but refuses the action when there is no price or the user saw an older one.
 * Actions on an existing browser (more storage) confirm the region's Basic version: its fixed
 * resources cost the same in every tier.
 */
export async function requirePrice(db: Db, regionId: string, shownVersion: string | undefined, tier: BrowserTier = 'basic'): Promise<RegionPrice> {
  if (shownVersion === undefined) throw problem(400, 'validation_failed', 'Review the current prices before confirming this action.');
  const p = await regionPrice(db, regionId, tier);
  if (!p && tier === 'premium' && (await regionPrice(db, regionId))) throw problem(409, 'region_unavailable', 'Premium browsers are not offered in this region. Choose Basic or another region.');
  if (!p) throw problem(503, 'price_unavailable', 'Prices for this region are being updated. Try again in a few minutes.');
  if (p.sheet.source==='aws-price-list' && Date.now()-p.fetchedAt.getTime()>AWS_PRICE_MAX_AGE_MS) throw problem(503,'price_unavailable','The AWS price feed is out of date. New purchases are paused until it refreshes.');
  if (shownVersion !== p.version) {
    throw problem(409, 'price_changed', 'Prices changed since this page was opened. Review the new price and try again.');
  }
  return p;
}

/** Without a user (signed-out price list), only the `user:default` caps apply. */
export async function storageLimits(db: Db, userId: string | null) {
  const caps = await userCaps(db, userId ?? 'default');
  return { defaultGb: caps.get('storage_gb') ?? DEFAULT_STORAGE_GB, maxGb: caps.get('storage_max_gb') ?? DEFAULT_MAX_STORAGE_GB };
}

/** Every region's customer prices, for the create dialog and the price list. */
export async function allRegionPricing(db: Db, userId: string | null): Promise<RegionPricing[]> {
  const regions = (await db.select().from(schema.regions).orderBy(asc(schema.regions.id))).filter((r) => r.enabled || r.executor !== 'fake');
  const sheets = await priceSheets(db);
  const settings = await pricingSettings(db);
  const storage = await storageLimits(db, userId);
  return regions.map((r) => {
    const stored = sheets.get(r.id);
    const rates = stored ? customerRates(stored.sheet, settings) : null;
    const premium = stored ? tierSheet(stored.sheet, 'premium') : null;
    const premiumRates = premium ? customerRates(premium, settings) : null;
    return {
      regionId: r.id as RegionId,
      available: !!stored && (stored.sheet.source!=='aws-price-list' || Date.now()-stored.fetchedAt.getTime()<=AWS_PRICE_MAX_AGE_MS),
      source: stored?.sheet.source ?? null,
      updatedAt: stored?.fetchedAt.toISOString() ?? null,
      rates,
      rootVolumeGb: stored?.sheet.rootVolumeGb ?? 0,
      machine: stored?.sheet.machine ?? null,
      defaultStorageGb: storage.defaultGb,
      maxStorageGb: storage.maxGb,
      version: stored && rates ? priceVersion(rates, stored.sheet.rootVolumeGb) : null,
      premium: premium && premiumRates ? { rates: premiumRates, machine: premium.machine ?? null, version: priceVersion(premiumRates, premium.rootVolumeGb) } : null,
    };
  });
}

/** What one browser costs per hour right now (running or not) and per month while it is kept. */
export function currentBurn(p: RegionPrice | null, inst: { status: string; storageGb: number; backupsEnabled: boolean }) {
  if (!p || ['creating', 'failed', 'deleting', 'purged'].includes(inst.status)) return { hourMicros: 0, runningHourMicros: p?.rates.compute ?? 0, alwaysOnMonthMicros: 0 };
  const e = browserEstimate(p.rates, { storageGb: inst.storageGb, rootVolumeGb: p.sheet.rootVolumeGb, backups: false });
  return { hourMicros: e.alwaysOnHour + (inst.status === 'running' ? e.runningHour : 0), runningHourMicros: e.runningHour, alwaysOnMonthMicros: e.alwaysOnMonth };
}
