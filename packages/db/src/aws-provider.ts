import type { BrowserTier } from '@cloudbrowser/contracts';
import { sql } from 'drizzle-orm';
import type { Db } from './index.js';

export type AwsInventory = { region_id: string; checked_at: number | null; status: string; quota_available: number; premium_available: number; premium_offered: number; availability: string };
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
