/**
 * Whether a region can take a new browser, and what the user should know before choosing it.
 * AWS publishes no live on-demand capacity, so this combines what can be known: the operator's
 * switches, the inventory AWS quotas still allow, and how recent launches there went
 * (a capacity shortage, or a provider failure such as an encryption key the account may not use).
 */
import { AWS_REGION_FACTS, awsLatencyProbeUrl, estimateRttMs, type Region, type RegionInventory } from '@cloudbrowser/contracts';
import { awaitingRefresh, awsInventory, blocksRegion, type InventoryUnavailableReason, launchHealthByRegion, launchVerifiedAt, openProviderIssue, priceSheets, recentCapacityAt, schema, type Db, type LaunchHealthRow } from '@cloudbrowser/db';
import { asc } from 'drizzle-orm';
import { regionAcceptingNew } from './limits.js';

export function availabilityOf(input: {
  enabled: boolean;
  /** Room under the region cap and AWS quotas. */
  acceptingNew: boolean;
  /** Browsers the inventory still allows; null when the region has no inventory. */
  stock: number | null;
  /** Why the inventory is unavailable, when it is: not the same as no room left. */
  inventoryReason?: InventoryUnavailableReason | null;
  health: LaunchHealthRow[];
  now: Date;
}): Pick<Region, 'availability' | 'availabilityReason'> {
  if (!input.enabled) return { availability: 'unavailable', availabilityReason: 'closed' };
  const issue = openProviderIssue(input.health, input.now);
  if (issue) return { availability: 'unavailable', availabilityReason: blocksRegion(issue) ? 'blocked' : 'provider_issue' };
  if (!input.acceptingNew) return { availability: 'unavailable', availabilityReason: input.inventoryReason ? (awaitingRefresh(input.inventoryReason) ? 'refreshing' : 'closed') : input.stock === 0 ? 'no_stock' : 'closed' };
  const shortage = Math.max(0, ...input.health.map((r) => recentCapacityAt(r, input.now)));
  const success = Math.max(0, ...input.health.map((r) => r.lastSuccessAt?.getTime() ?? 0));
  if (shortage > success) return { availability: 'limited', availabilityReason: 'capacity' };
  if (input.stock === 1) return { availability: 'limited', availabilityReason: 'low_stock' };
  return { availability: 'available', availabilityReason: null };
}

/** A region's inventory as the API shows it, for `available` browsers of one tier. */
function inventoryView(inventory: { checked_at: number | null; availability: string }, available: number): RegionInventory {
  return {
    available,
    checkedAt: inventory.checked_at ? new Date(inventory.checked_at).toISOString() : null,
    status: inventory.availability === 'ready' ? 'ready' : 'unavailable',
    constraint: inventory.availability === 'ready' ? 'quota' : 'sync_unavailable',
  };
}

/** Regions a user can see: offered ones, and any AWS region a browser may already live in. */
export async function listedRegions(db: Db) {
  const [rows, inventory] = await Promise.all([db.select().from(schema.regions).orderBy(asc(schema.regions.id)), awsInventory(db)]);
  return rows
    .filter((r) => r.enabled || r.executor !== 'fake')
    .map((row) => ({ row, inventory: inventory.get(row.id) ?? null }))
    .filter((r) => !['not-enabled', 'not-supported'].includes(r.inventory?.status ?? ''));
}

/** The caller's approximate location, from Cloudflare's request metadata. */
export function callerLocation(req: Request): { lat: number; lon: number } | null {
  const cf = (req as Request & { cf?: { latitude?: string; longitude?: string } }).cf;
  const lat = Number(cf?.latitude);
  const lon = Number(cf?.longitude);
  return cf?.latitude && cf.longitude && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Every listed region as the API shows it, with availability and a latency estimate. */
export async function regionViews(db: Db, from: { lat: number; lon: number } | null, now = new Date()): Promise<Region[]> {
  const [listed, health, sheets] = await Promise.all([listedRegions(db), launchHealthByRegion(db), priceSheets(db)]);
  return Promise.all(listed.map(async ({ row: r, inventory }) => {
    const stock = inventory ? inventory.available : null;
    const acceptingNewBase = r.enabled && (stock !== null ? stock > 0 : await regionAcceptingNew(db, r.id));
    const facts = r.executor === 'aws-ec2' ? AWS_REGION_FACTS[r.providerRegion] : undefined;
    const rows = health.get(r.id) ?? [];
    const inventoryReason = inventory?.reason ?? null;
    const { availability, availabilityReason } = availabilityOf({ enabled: r.enabled, acceptingNew: acceptingNewBase, stock, inventoryReason, health: rows, now });
    // Premium where the region prices a Premium machine and, under AWS inventory, offers one.
    const premiumOffered = !!sheets.get(r.id)?.sheet.premium && (!inventory || !!inventory.premium_offered);
    const premiumStock = inventory ? inventory.availableByTier.premium : null;
    const premium = premiumOffered ? {
      ...availabilityOf({
        enabled: r.enabled,
        acceptingNew: r.enabled && (premiumStock !== null ? premiumStock > 0 : await regionAcceptingNew(db, r.id, 'premium')),
        stock: premiumStock,
        inventoryReason,
        health: rows,
        now,
      }),
      ...(inventory && premiumStock !== null ? { inventory: inventoryView(inventory, premiumStock) } : {}),
    } : null;
    return {
      id: r.id,
      name: r.name,
      country: r.country,
      city: r.city,
      timezone: r.timezone,
      enabled: r.enabled,
      acceptingNew: availability !== 'unavailable',
      ...(inventory ? { inventory: inventoryView(inventory, inventory.available) } : {}),
      probeUrl: r.probeUrl ?? (r.executor === 'aws-ec2' ? awsLatencyProbeUrl(r.providerRegion) : null),
      area: facts?.area ?? null,
      availability,
      availabilityReason,
      launchVerifiedAt: launchVerifiedAt(rows)?.toISOString() ?? null,
      estimatedRttMs: facts && from ? estimateRttMs(from, facts) : null,
      premium,
    };
  }));
}
