import { sql } from 'drizzle-orm';
import type { Db } from './index.js';

export type AwsInventory = { region_id: string; checked_at: number | null; status: string; quota_available: number; monthly_unit_micros: number; budget_remaining_micros: number; inventory_mode: string; availability: string };
/** The same SQL view is checked by the transactional create trigger. Budgets are shared across regions. */
export async function awsInventory(db: Db) {
  const rows = await db.all<AwsInventory>(sql`SELECT * FROM aws_region_inventory`);
  return new Map(rows.map((r) => [r.region_id, { ...r, available: r.availability !== 'ready' || r.monthly_unit_micros<=0 ? 0 : Math.max(0, Math.min(r.quota_available, r.inventory_mode === 'quota' ? r.quota_available : Math.floor(r.budget_remaining_micros / r.monthly_unit_micros))) }]));
}
