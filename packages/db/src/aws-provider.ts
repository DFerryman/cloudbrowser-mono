import { sql } from 'drizzle-orm';
import type { Db } from './index.js';

export type AwsInventory = { region_id: string; checked_at: number | null; status: string; quota_available: number; availability: string };
/**
 * Browsers AWS can still allocate per region: quota room minus browsers holding a slot. The same
 * SQL view is checked by the create trigger, inside the create's own transaction.
 */
export async function awsInventory(db: Db) {
  const rows = await db.all<AwsInventory>(sql`SELECT * FROM aws_region_inventory`);
  return new Map(rows.map((r) => [r.region_id, { ...r, available: r.availability === 'ready' ? Math.max(0, r.quota_available) : 0 }]));
}
