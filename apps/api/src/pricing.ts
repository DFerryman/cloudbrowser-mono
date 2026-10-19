/**
 * Customer prices (page 6): each region's provider price sheet (read by the engine from the AWS
 * Price List API) times the operator's markup. Priced actions carry the price version the user
 * was shown; if prices changed meanwhile, the action is refused with `price_changed`.
 */
import {
  REGION_INFO,
  browserEstimate,
  customerRates,
  priceVersion,
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

/** The customer price of one region now, or null before its prices were read from the provider. */
export async function regionPrice(db: Db, regionId: string): Promise<RegionPrice | null> {
  const stored = (await priceSheets(db)).get(regionId);
  if (!stored) return null;
  const { markupPercent } = await pricingSettings(db);
  const rates = customerRates(stored.sheet, markupPercent);
  return { sheet: stored.sheet, rates, version: priceVersion(rates, stored.sheet.rootVolumeGb), fetchedAt: stored.fetchedAt };
}

/** Existing browsers show their observed machine and root disk, not the new-browser default. */
export async function instancePrice(db: Db, instanceId: string, regionId: string): Promise<RegionPrice | null> {
  const p = await regionPrice(db, regionId);
  if (!p) return null;
  const [placement] = await db.select().from(schema.placements).where(and(eq(schema.placements.instanceId, instanceId), eq(schema.placements.status, 'current')));
  const actual = placement?.instanceType ? p.sheet.instanceTypes[placement.instanceType] : p.sheet.vmHour;
  if (actual === undefined) return null;
  const sheet = { ...p.sheet, vmHour: actual, rootVolumeGb: placement?.rootVolumeGb ?? p.sheet.rootVolumeGb };
  return { ...p, sheet, rates: { ...customerRates(sheet, (await pricingSettings(db)).markupPercent), snapshot: 0 } };
}

/** Like regionPrice, but refuses the action when there is no price or the user saw an older one. */
export async function requirePrice(db: Db, regionId: string, shownVersion: string | undefined): Promise<RegionPrice> {
  if (shownVersion === undefined) throw problem(400, 'validation_failed', 'Review the current prices before confirming this action.');
  const p = await regionPrice(db, regionId);
  if (!p) throw problem(503, 'price_unavailable', 'Prices for this region are being updated. Try again in a few minutes.');
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
  const regions = (await db.select().from(schema.regions).orderBy(asc(schema.regions.id))).filter((r) => r.id in REGION_INFO);
  const sheets = await priceSheets(db);
  const { markupPercent } = await pricingSettings(db);
  const storage = await storageLimits(db, userId);
  return regions.map((r) => {
    const stored = sheets.get(r.id);
    const rates = stored ? customerRates(stored.sheet, markupPercent) : null;
    return {
      regionId: r.id as RegionId,
      available: !!stored,
      source: stored?.sheet.source ?? null,
      updatedAt: stored?.fetchedAt.toISOString() ?? null,
      rates,
      rootVolumeGb: stored?.sheet.rootVolumeGb ?? 0,
      machine: stored?.sheet.machine ?? null,
      defaultStorageGb: storage.defaultGb,
      maxStorageGb: storage.maxGb,
      version: stored && rates ? priceVersion(rates, stored.sheet.rootVolumeGb) : null,
    };
  });
}

/** What one browser costs per hour right now (running or not) and per month while it is kept. */
export function currentBurn(p: RegionPrice | null, inst: { status: string; storageGb: number; backupsEnabled: boolean; trialState?: string | null }) {
  if (!p || ['active', 'ended'].includes(inst.trialState ?? '') || ['creating', 'failed', 'deleting', 'purged'].includes(inst.status)) return { hourMicros: 0, runningHourMicros: p?.rates.compute ?? 0, alwaysOnMonthMicros: 0 };
  const e = browserEstimate(p.rates, { storageGb: inst.storageGb, rootVolumeGb: p.sheet.rootVolumeGb, backups: false });
  return { hourMicros: e.alwaysOnHour + (inst.status === 'running' ? e.runningHour : 0), runningHourMicros: e.runningHour, alwaysOnMonthMicros: e.alwaysOnMonth };
}
