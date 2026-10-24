import type { BrowserTier } from '@cloudbrowser/contracts';
import { sql } from 'drizzle-orm';
import type { Db } from './index.js';

/** Why a region's inventory is unavailable: not the same as an empty quota (`quota_available` 0). */
export type InventoryUnavailableReason = 'disabled' | 'pending' | 'sync_failed' | 'stale' | 'prices';
export type AwsInventory = {
  region_id: string; checked_at: number | null; status: string; quota_available: number; premium_available: number; premium_offered: number; availability: string;
  reason: InventoryUnavailableReason | null; last_error: string | null; last_error_at: number | null; sync_failures: number;
};
/**
 * Whether an unavailable inventory comes back on its own: a snapshot that is old or not taken yet
 * is refreshed within minutes. A failing refresh or missing prices need an operator.
 */
export const awaitingRefresh = (reason: InventoryUnavailableReason) => reason === 'stale' || reason === 'pending';
/** A snapshot older than this is not used (aws_region_inventory, migrations 0031 and 0037). */
export const INVENTORY_MAX_AGE_MS = 20 * 60_000;
/**
 * Browsers AWS can still allocate per region and tier: quota room minus browsers holding a slot.
 * The same SQL view is checked by the create trigger, inside the create's own transaction.
 */
export async function awsInventory(db: Db) {
  const rows = await db.all<AwsInventory>(sql`SELECT * FROM aws_region_inventory`);
  return new Map(rows.map((r) => {
    const ready = r.availability === 'ready';
    const available: Record<BrowserTier, number> = { basic: ready ? Math.max(0, r.quota_available) : 0, premium: ready ? Math.max(0, r.premium_available ?? 0) : 0 };
    return [r.region_id, { ...r, available: available.basic, availableByTier: available }];
  }));
}
