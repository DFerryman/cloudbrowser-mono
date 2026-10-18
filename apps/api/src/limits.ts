import { MICROS_PER_USD, TRIAL, type Entitlements } from '@cloudbrowser/contracts';
import { billingRequired, pricingSettings, schema, userCaps as sharedUserCaps, type Db } from '@cloudbrowser/db';
import { and, desc, eq, gte, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { storageLimits } from './pricing.js';
import { problem } from './problem.js';

const { caps, browserInstances, operations, controlFlags, spendSnapshots, quotaSnapshots, regions, billingAccounts } = schema;

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

/** Defaults, then operator overrides. What a user may spend is their prepaid balance (page 6). */
export const userCaps = sharedUserCaps;

/** The pilot (`billing_required` off) is free; otherwise usage is paid from the prepaid balance. */
export async function entitlementsFor(db: Db, userId: string): Promise<Entitlements> {
  const c = await userCaps(db, userId);
  return {
    billing: (await billingRequired(db)) ? 'prepaid' : 'pilot',
    maxBrowsers: c.get('instances') ?? 0,
    maxRunning: c.get('running') ?? 0,
    idleTimeoutMaxS: c.get('idle_timeout_max_s') ?? 1800,
    ipChangesPerMonth: c.get('ip_changes_per_month') ?? 0,
    maxStorageGb: (await storageLimits(db, userId)).maxGb,
  };
}

export async function billingAccount(db: Db, userId: string) {
  const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, userId));
  return { balanceMicros: row?.balanceMicros ?? 0, exhaustedAt: row?.exhaustedAt ?? null, frozenAt: row?.frozenAt ?? null, trialUsedAt: row?.trialUsedAt ?? null };
}

/** An unconverted free trial browser (page 6). */
export const isTrial = (row: { trialState: string | null }) => row.trialState === 'active' || row.trialState === 'ended';

/**
 * Paying turns the user's trial browser into a normal one, with the same data and IP: from then on
 * it is charged like any other browser and is no longer reclaimed after 7 days.
 */
export async function convertTrials(db: Db, userId: string, now: Date) {
  return db
    .update(browserInstances)
    .set({ trialState: 'converted', trialReclaimAt: null, updatedAt: now })
    .where(and(eq(browserInstances.userId, userId), inArray(browserInstances.trialState, ['active', 'ended'])))
    .returning({ id: browserInstances.id });
}

/** Claims the user's one free trial; false if it was used before. */
export async function claimTrial(db: Db, userId: string, now: Date): Promise<boolean> {
  await db.insert(billingAccounts).values({ userId, balanceMicros: 0, updatedAt: now }).onConflictDoNothing();
  const claimed = await db
    .update(billingAccounts)
    .set({ trialUsedAt: now, updatedAt: now })
    .where(and(eq(billingAccounts.userId, userId), sql`${billingAccounts.trialUsedAt} IS NULL`))
    .returning({ id: billingAccounts.userId });
  return claimed.length > 0;
}

export const trialSecondsLeft = (row: { trialUsedS: number }) => Math.max(0, TRIAL.runningSeconds - row.trialUsedS);

const usd = (micros: number) => `$${(micros / MICROS_PER_USD).toFixed(2)}`;

/**
 * Creating or waking a browser costs money from then on, so it needs the minimum balance (unless
 * the deployment runs the free pilot). A frozen account can do neither.
 */
export async function admitSpend(db: Db, userId: string, action: 'create a browser' | 'wake a browser' | 'add storage' | 'turn on snapshots') {
  const account = await billingAccount(db, userId);
  if (account.frozenAt) throw problem(403, 'account_frozen', 'Your account is on hold because of a payment dispute. Contact support.');
  if (!(await billingRequired(db))) return;
  const { minBalanceMicros } = await pricingSettings(db);
  if (account.balanceMicros < Math.max(1, minBalanceMicros)) {
    throw problem(
      402,
      'insufficient_balance',
      `Your balance is ${usd(account.balanceMicros)}; at least ${usd(minBalanceMicros)} is needed to ${action}. Add credit on the Billing page.`,
    );
  }
}

async function count(db: Db, where: ReturnType<typeof and>) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(browserInstances).where(where);
  return Number(row?.n ?? 0);
}

export async function usage(db: Db, userId: string) {
  return {
    browsers: await count(db, and(eq(browserInstances.userId, userId), HOLDS_SLOT)),
    running: await count(db, and(eq(browserInstances.userId, userId), inArray(browserInstances.status, RUNNING_STATUSES))),
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
export async function admitCreate(db: Db, userId: string, regionId: string, now: Date, opts: { trial?: boolean } = {}) {
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
    throw problem(403, 'plan_limit', `Your account allows ${c.get('instances') ?? 0} browsers.`, { limit: 'instances' });
  }
  // The free trial needs no credit (page 6).
  if (!opts.trial) await admitSpend(db, userId, 'create a browser');
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
  const [inst] = await db
    .select({ suspendedAt: browserInstances.suspendedAt, trialState: browserInstances.trialState, trialUsedS: browserInstances.trialUsedS, trialReclaimAt: browserInstances.trialReclaimAt })
    .from(browserInstances)
    .where(eq(browserInstances.id, instanceId));
  if (inst?.suspendedAt) throw problem(403, 'suspended', 'This browser is suspended. Contact support.');
  const c = await userCaps(db, userId);
  if ((c.get('running') ?? 0) === 0) {
    throw problem(403, 'plan_limit', 'Your account cannot run browsers right now. Contact support; data and IPs are kept.', { limit: 'running' });
  }
  if (inst && isTrial(inst) && inst.trialState === 'active' && trialSecondsLeft(inst) > 0) {
    // Free trial minutes left: waking is free.
  } else if (inst && isTrial(inst)) {
    // The trial is used up: with enough credit, waking it converts it into a normal browser.
    const account = await billingAccount(db, userId);
    if (account.frozenAt) throw problem(403, 'account_frozen', 'Your account is on hold because of a payment dispute. Contact support.');
    const { minBalanceMicros } = await pricingSettings(db);
    if (account.balanceMicros < Math.max(1, minBalanceMicros)) {
      const until = inst.trialReclaimAt ? ` It is kept until ${inst.trialReclaimAt.toISOString().slice(0, 10)}.` : '';
      throw problem(402, 'insufficient_balance', `Your free ${TRIAL.runningSeconds / 60} minutes are used. Add at least ${usd(minBalanceMicros)} of credit to keep using this browser with its data and IP.${until}`);
    }
    await convertTrials(db, userId, new Date());
  } else {
    await admitSpend(db, userId, 'wake a browser');
  }
  const others = and(ne(browserInstances.id, instanceId), inArray(browserInstances.status, RUNNING_STATUSES));
  const mine = await count(db, and(eq(browserInstances.userId, userId), others));
  if (mine >= (c.get('running') ?? 0)) {
    throw problem(403, 'plan_limit', `Your account allows ${c.get('running') ?? 0} running browser(s) at a time. Put another one to sleep first.`, {
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

