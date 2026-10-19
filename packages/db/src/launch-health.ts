import { eq } from 'drizzle-orm';
import type { Db } from './index.js';
import { launchHealth } from './schema.js';

export type LaunchOutcome = { kind: 'success' } | { kind: 'capacity' } | { kind: 'failure'; errorClass: string; message: string };
export type LaunchHealthRow = typeof launchHealth.$inferSelect;

/** Advisory: a lost write only makes the next zone choice or region label less informed. */
export async function recordLaunch(db: Db, regionId: string, zone: string | null, outcome: LaunchOutcome, at: Date) {
  const set = outcome.kind === 'success'
    ? { lastSuccessAt: at }
    : outcome.kind === 'capacity'
      ? { lastCapacityAt: at }
      : { lastFailureAt: at, lastFailureClass: outcome.errorClass, lastFailure: outcome.message.slice(0, 500) };
  await db.insert(launchHealth).values({ regionId, zone: zone ?? '', ...set })
    .onConflictDoUpdate({ target: [launchHealth.regionId, launchHealth.zone], set });
}

/** Every region's rows, keyed by region id. The table holds a few rows per region. */
export async function launchHealthByRegion(db: Db): Promise<Map<string, LaunchHealthRow[]>> {
  const out = new Map<string, LaunchHealthRow[]>();
  for (const row of await db.select().from(launchHealth)) out.set(row.regionId, [...(out.get(row.regionId) ?? []), row]);
  return out;
}

/** One region's rows (a few zones), for admission and zone choice. */
export async function launchHealthFor(db: Db, regionId: string): Promise<LaunchHealthRow[]> {
  return db.select().from(launchHealth).where(eq(launchHealth.regionId, regionId));
}

/** Capacity was short in this zone recently, and no launch has succeeded there since. */
export const CAPACITY_MEMORY_MS = 30 * 60_000;
/**
 * After the provider itself failed a VM or disk here for a reason that may pass, new browsers are
 * refused this long; then the next create is let through as a probe, so a fix is picked up
 * without operator action.
 */
export const PROVIDER_ISSUE_MEMORY_MS = 30 * 60_000;
/**
 * AWS does not allow the account to launch here: it may not use the region's encryption key, or
 * IAM or an organization SCP denies a create step there. Every launch fails until someone changes
 * that, so the region stays blocked, without probes paid for by users, until an operator reopens
 * it (`reopenRegion`) or a launch there succeeds.
 */
export const BLOCKING_FAILURE_CLASSES: readonly string[] = ['forbidden'];

export function recentCapacityAt(row: LaunchHealthRow | undefined, now: Date): number {
  const at = row?.lastCapacityAt?.getTime() ?? 0;
  return at && now.getTime() - at < CAPACITY_MEMORY_MS && at > (row?.lastSuccessAt?.getTime() ?? 0) ? at : 0;
}

/** When a browser last launched in the region; null when none has since its rows were kept. */
export function launchVerifiedAt(rows: LaunchHealthRow[]): Date | null {
  const at = Math.max(0, ...rows.map((r) => r.lastSuccessAt?.getTime() ?? 0));
  return at ? new Date(at) : null;
}

export const blocksRegion = (row: LaunchHealthRow | null) => !!row?.lastFailureClass && BLOCKING_FAILURE_CLASSES.includes(row.lastFailureClass);

/**
 * The last provider failure since the region's last successful launch: a blocking one until the
 * region is reopened, any other while still recent.
 */
export function openProviderIssue(rows: LaunchHealthRow[], now: Date): LaunchHealthRow | null {
  const lastSuccess = launchVerifiedAt(rows)?.getTime() ?? 0;
  const issues = rows.filter((r) => {
    const at = r.lastFailureAt?.getTime() ?? 0;
    return at > lastSuccess && (blocksRegion(r) || now.getTime() - at < PROVIDER_ISSUE_MEMORY_MS);
  });
  return issues.sort((a, b) => b.lastFailureAt!.getTime() - a.lastFailureAt!.getTime())[0] ?? null;
}

/**
 * Lifts a region's provider failures after an operator fixed the cause; the next create is the
 * test. Capacity and success history stay.
 */
export function reopenRegion(db: Db, regionId: string) {
  return db.update(launchHealth).set({ lastFailureAt: null, lastFailureClass: null, lastFailure: null }).where(eq(launchHealth.regionId, regionId));
}
