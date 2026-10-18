/**
 * Metered usage (page 6), read from `usage_records` (written by the engine every minute):
 * account level (every browser of the user, including deleted ones) and per browser.
 */
import { UsageItem, type AccountUsage, type InstanceUsage, type RegionId, type UsageTotals } from '@cloudbrowser/contracts';
import { schema, type Db } from '@cloudbrowser/db';
import { and, eq, inArray, like } from 'drizzle-orm';

const { usageRecords, browserInstances } = schema;

const emptyByItem = () => Object.fromEntries(UsageItem.options.map((i) => [i, 0])) as Record<UsageItem, number>;

function totals(rows: { item: string; amountMicros: number }[]): UsageTotals {
  const byItem = emptyByItem();
  for (const r of rows) byItem[r.item as UsageItem] = (byItem[r.item as UsageItem] ?? 0) + r.amountMicros;
  return { totalMicros: Object.values(byItem).reduce((a, b) => a + b, 0), byItem };
}

/** `YYYY-MM`, defaulting to the current month (UTC); anything else is refused by the caller's schema. */
export const monthOf = (month: string | undefined, now = new Date()) => (month && /^\d{4}-\d{2}$/.test(month) ? month : now.toISOString().slice(0, 7));

export async function monthTotals(db: Db, userId: string, month: string): Promise<UsageTotals> {
  const rows = await db
    .select({ item: usageRecords.item, amountMicros: usageRecords.amountMicros })
    .from(usageRecords)
    .where(and(eq(usageRecords.userId, userId), like(usageRecords.day, `${month}-%`)));
  return totals(rows);
}

export async function accountUsage(db: Db, userId: string, month: string): Promise<AccountUsage> {
  const rows = await db
    .select()
    .from(usageRecords)
    .where(and(eq(usageRecords.userId, userId), like(usageRecords.day, `${month}-%`)));
  const ids = [...new Set(rows.map((r) => r.instanceId))];
  const instances = ids.length ? await db.select().from(browserInstances).where(inArray(browserInstances.id, ids)) : [];
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.amountMicros);
  return {
    month,
    ...totals(rows),
    byBrowser: ids
      .map((id) => {
        const inst = instances.find((i) => i.id === id);
        return {
          instanceId: id,
          name: inst?.name ?? id,
          regionId: (inst?.regionId ?? 'syd1') as RegionId,
          deleted: !inst || inst.status === 'deleting' || inst.status === 'purged',
          ...totals(rows.filter((r) => r.instanceId === id)),
        };
      })
      .sort((a, b) => b.totalMicros - a.totalMicros),
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, totalMicros]) => ({ day, totalMicros })),
  };
}

export async function instanceUsage(db: Db, instanceId: string, month: string, now: InstanceUsage['now']): Promise<InstanceUsage> {
  const rows = await db
    .select()
    .from(usageRecords)
    .where(and(eq(usageRecords.instanceId, instanceId), like(usageRecords.day, `${month}-%`)));
  const days = [...new Set(rows.map((r) => r.day))].sort();
  return {
    month,
    totalMicros: rows.reduce((a, r) => a + r.amountMicros, 0),
    items: UsageItem.options.map((item) => {
      const mine = rows.filter((r) => r.item === item);
      return { item, quantity: mine.reduce((a, r) => a + r.quantity, 0), amountMicros: mine.reduce((a, r) => a + r.amountMicros, 0) };
    }),
    byDay: days.map((day) => {
      const t = totals(rows.filter((r) => r.day === day));
      return { day, totalMicros: t.totalMicros, byItem: t.byItem };
    }),
    now,
  };
}
