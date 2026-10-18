import type { Entitlements } from '@cloudbrowser/contracts';
import { billingRequired, schema, usageMonth, userCaps as sharedUserCaps, type Db } from '@cloudbrowser/db';
import { and, desc, eq, gte, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { planOf } from './billing/sync.js';
import { problem } from './problem.js';

const { caps, browserInstances, operations, controlFlags, spendSnapshots, quotaSnapshots, regions, activeUsage } = schema;

/** Statuses that hold a browser slot (a dedicated IP and a volume). */
const HOLDS_SLOT = sql`${browserInstances.status} NOT IN ('purged', 'failed', 'deleting')`;
/** Statuses that hold (or are about to hold) a running VM. */
export const RUNNING_STATUSES = ['creating', 'starting', 'running', 'stopping', 'waiting_capacity'];

export async function capsFor(db: Db, scopes: string[]): Promise<Map<string, number>> {
  const rows = await db.select().from(caps).where(inArray(caps.scope, scopes));
  const out = new Map<string, number>();
  // Later scopes win, so pass the most specific scope last.
  for (const scope of scopes) for (const r of rows) if (r.scope === scope) out.set(r.metric, r.limit);
  return out;
}

/** Pilot defaults, then what the subscription buys, then operator overrides (page 6). */
export const userCaps = sharedUserCaps;

/**
 * The invite-only pilot runs on `user:default` caps (plan `pilot`). A Creem subscription writes
 * its own caps (plan `personal`/`pro`); once billing is required, no subscription means `none`.
 */
export async function entitlementsFor(db: Db, userId: string, now = new Date()): Promise<Entitlements> {
  const c = await userCaps(db, userId);
  return {
    plan: await planOf(db, userId, now, await billingRequired(db)),
    maxBrowsers: c.get('instances') ?? 0,
    maxRunning: c.get('running') ?? 0,
    idleTimeoutMaxS: c.get('idle_timeout_max_s') ?? 1800,
    ipChangesPerMonth: c.get('ip_changes_per_month') ?? 0,
    hoursPerMonth: c.get('hours_per_month') ?? null,
  };
}

/** Active seconds this month (metered by the engine) and when the hours ran out, if they did. */
export async function activeTime(db: Db, userId: string, now = new Date()) {
  const [row] = await db
    .select()
    .from(activeUsage)
    .where(and(eq(activeUsage.userId, userId), eq(activeUsage.month, usageMonth(now))));
  return { seconds: row?.seconds ?? 0, exhaustedAt: row?.exhaustedAt ?? null };
}

async function count(db: Db, where: ReturnType<typeof and>) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(browserInstances).where(where);
  return Number(row?.n ?? 0);
}

export async function usage(db: Db, userId: string) {
  return {
    browsers: await count(db, and(eq(browserInstances.userId, userId), HOLDS_SLOT)),
    running: await count(db, and(eq(browserInstances.userId, userId), inArray(browserInstances.status, RUNNING_STATUSES))),
    hoursUsed: Math.round(((await activeTime(db, userId)).seconds / 3600) * 10) / 10,
  };
}

/** Whether a region has room for a new browser: region cap and provider quota headroom. */
export async function regionAcceptingNew(db: Db, regionId: string): Promise<boolean> {
  try {
    await checkRegionRoom(db, regionId);
    return true;
  } catch {
    return false;
  }
}

async function checkRegionRoom(db: Db, regionId: string) {
  const [region] = await db.select().from(regions).where(eq(regions.id, regionId));
  if (!region?.enabled) throw problem(409, 'region_unavailable', 'This region is not available.');
  const regionCaps = await capsFor(db, [`region:${regionId}`]);
  const global = await capsFor(db, ['global']);
  const inRegion = await count(db, and(eq(browserInstances.regionId, regionId), HOLDS_SLOT));
  if (inRegion >= (regionCaps.get('instances') ?? Infinity)) throw problem(409, 'region_unavailable');

  // Provider quota headroom from the reconciler's latest snapshot (page 10).
  const headroom = global.get('quota_headroom_min') ?? 2;
  const latest = await db
    .select()
    .from(quotaSnapshots)
    .where(eq(quotaSnapshots.region, region.providerRegion))
    .orderBy(desc(quotaSnapshots.takenAt))
    .limit(3);
  for (const q of latest) {
    if (q.metric === 'static_ips' && q.limit - q.used < headroom) throw problem(409, 'region_unavailable');
  }
}

/**
 * Bounded before created (page 10, rule 5): plan, region and global caps, provider quota headroom,
 * the spend guard and the circuit breaker are all checked before a create is admitted.
 */
export async function admitCreate(db: Db, userId: string, regionId: string, now: Date) {
  const [freeze] = await db.select().from(controlFlags).where(eq(controlFlags.key, 'creation_freeze'));
  if (freeze?.value === 'true') throw problem(503, 'creation_frozen', 'New browsers are temporarily unavailable.');

  const global = await capsFor(db, ['global']);
  const [spend] = await db
    .select()
    .from(spendSnapshots)
    .where(eq(spendSnapshots.month, now.toISOString().slice(0, 7)))
    .orderBy(desc(spendSnapshots.takenAt))
    .limit(1);
  const budget = global.get('spend_budget_cents');
  if (spend && budget !== undefined && spend.projectedCents >= budget) {
    throw problem(503, 'spend_guard_active', 'New browsers are temporarily unavailable.');
  }

  const c = await userCaps(db, userId);
  const u = await usage(db, userId);
  if (u.browsers >= (c.get('instances') ?? 0)) {
    throw problem(403, 'plan_limit', `Your plan allows ${c.get('instances') ?? 0} browsers.`, { limit: 'instances' });
  }
  const [daily] = await db
    .select({ n: sql<number>`count(*)` })
    .from(operations)
    .where(and(eq(operations.userId, userId), eq(operations.kind, 'create'), gte(operations.createdAt, new Date(now.getTime() - 86_400_000))));
  if (Number(daily?.n ?? 0) >= (c.get('creates_per_day') ?? Infinity)) {
    throw problem(429, 'plan_limit', 'Too many new browsers today. Try again tomorrow.', { limit: 'creates_per_day' });
  }

  await checkRegionRoom(db, regionId);
  const total = await count(db, HOLDS_SLOT);
  if (total >= (global.get('instances') ?? Infinity)) throw problem(503, 'region_unavailable');
  const [recent] = await db
    .select({ n: sql<number>`count(*)` })
    .from(operations)
    .where(and(eq(operations.kind, 'create'), gte(operations.createdAt, new Date(now.getTime() - 600_000))));
  if (Number(recent?.n ?? 0) >= (global.get('creates_per_10_min') ?? Infinity)) {
    throw problem(503, 'creation_frozen', 'New browsers are temporarily unavailable.');
  }
}

/** Running caps, checked before every start (page 10). */
export async function admitStart(db: Db, userId: string, instanceId: string, regionId: string) {
  const [inst] = await db.select({ suspendedAt: browserInstances.suspendedAt }).from(browserInstances).where(eq(browserInstances.id, instanceId));
  if (inst?.suspendedAt) throw problem(403, 'suspended', 'This browser is suspended. Contact support.');
  const c = await userCaps(db, userId);
  if ((c.get('running') ?? 0) === 0) {
    throw problem(403, 'plan_limit', 'Your plan does not include running browsers. Renew it to wake this one; its data and IP are kept.', { limit: 'running' });
  }
  const hours = c.get('hours_per_month');
  if (hours !== undefined && (await activeTime(db, userId)).seconds >= hours * 3600) {
    throw problem(429, 'hours_exhausted', `This month’s ${hours} active hours are used up. Browsers keep their data and IP.`, { limit: 'hours_per_month' });
  }
  const others = and(ne(browserInstances.id, instanceId), inArray(browserInstances.status, RUNNING_STATUSES));
  const mine = await count(db, and(eq(browserInstances.userId, userId), others));
  if (mine >= (c.get('running') ?? 0)) {
    throw problem(403, 'plan_limit', `Your plan allows ${c.get('running') ?? 0} running browser(s) at a time. Put another one to sleep first.`, {
      limit: 'running',
    });
  }
  const regionCaps = await capsFor(db, [`region:${regionId}`]);
  if ((await count(db, and(eq(browserInstances.regionId, regionId), others))) >= (regionCaps.get('running') ?? Infinity)) {
    throw problem(503, 'capacity_unavailable', 'This region is busy right now. Try again in a few minutes.');
  }
  const global = await capsFor(db, ['global']);
  if ((await count(db, others)) >= (global.get('running') ?? Infinity)) {
    throw problem(503, 'capacity_unavailable', 'We are busy right now. Try again in a few minutes.');
  }
}

export async function admitIpChange(db: Db, userId: string, now: Date) {
  const c = await userCaps(db, userId);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(operations)
    .where(
      and(
        eq(operations.userId, userId),
        eq(operations.kind, 'change_ip'),
        gte(operations.createdAt, monthStart),
        notInArray(operations.status, ['failed', 'canceled']),
      ),
    );
  if (Number(row?.n ?? 0) >= (c.get('ip_changes_per_month') ?? 0)) {
    throw problem(429, 'ip_change_limit', 'You have used this month’s IP change requests.');
  }
}

