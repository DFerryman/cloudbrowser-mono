import { MICROS_PER_USD, TRIAL, type Entitlements } from '@cloudbrowser/contracts';
import { awsInventory, billingRequired, blocksRegion, convertTrialStatements, launchHealthFor, openProviderIssue, prepaidBalance, reservationQuote, reservationWrite, pricingSettings, schema, userCaps as sharedUserCaps, type Db } from '@cloudbrowser/db';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { storageLimits } from './pricing.js';
import { problem } from './problem.js';

const { caps, browserInstances, operations, controlFlags, quotaSnapshots, regions, billingAccounts, browserReservations } = schema;

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
    // Every browser a user owns may run at once; there is no separate running limit.
    maxRunning: c.get('instances') ?? 0,
    idleTimeoutMaxS: c.get('idle_timeout_max_s') ?? 3600,
    // A separate switch, not an idle timeout: 1 offers Never sleep (still subject to credit), 0 does not.
    neverSleep: (c.get('never_sleep') ?? 0) === 1,
    maxStorageGb: (await storageLimits(db, userId)).maxGb,
  };
}

export const billingAccount = prepaidBalance;

/** Payment disputes block new resources and wakes, including free trial resources and pilot use. */
export async function requireUnfrozen(db: Db, userId: string) {
  const account = await billingAccount(db, userId);
  if (account.frozenAt) throw problem(403, 'account_frozen', 'Your account is on hold because of a payment dispute. Contact support.');
  return account;
}

/** An unconverted free trial browser (page 6). */
export const isTrial = (row: { trialState: string | null }) => row.trialState === 'active' || row.trialState === 'ended';

/**
 * Paying turns the user's trial browser into a normal one, with the same data and IP: from then on
 * it is charged like any other browser and is no longer reclaimed after 7 days.
 */
export async function convertTrials(db: Db, userId: string, now: Date) {
  const funded = (await billingRequired(db)) ? sql`EXISTS (SELECT 1 FROM browser_reservations
    WHERE instance_id = browser_instances.id AND retention_started_at IS NULL AND reserved_micros >= required_micros)` : sql`1`;
  const [, converted] = await db.batch(convertTrialStatements(db, userId, now, funded));
  return converted;
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

export const trialSecondsLeft = (row: { trialUsedS: number; trialUsedMs?: number }) => Math.ceil(Math.max(0, TRIAL.runningSeconds * 1000 - Math.max(row.trialUsedMs ?? 0, row.trialUsedS * 1000)) / 1000);

const usd = (micros: number) => `$${(micros / MICROS_PER_USD).toFixed(2)}`;

/**
 * Creating or waking a browser costs money from then on, so it needs the minimum balance (unless
 * the deployment runs the free pilot). A frozen account can do neither.
 */
export async function admitSpend(db: Db, userId: string, action: string, additionalReserveMicros = 0) {
  const account = await requireUnfrozen(db, userId);
  if (!(await billingRequired(db))) return;
  const { minBalanceMicros } = await pricingSettings(db);
  if (account.availableMicros < Math.max(1, minBalanceMicros) + additionalReserveMicros) {
    throw problem(
      402,
      'insufficient_balance',
      `Your available balance is ${usd(account.availableMicros)}; ${usd(Math.max(1, minBalanceMicros) + additionalReserveMicros)} is needed to ${action}, including its seven-day refundable fixed-resource deposit. Add credit on the Billing page.`,
    );
  }
}

/** Atomically funds the seven-day deposit before an existing browser can incur new costs. */
export async function admitInstanceSpend(db: Db, userId: string, inst: { id: string; regionId: string; storageGb: number; backupsEnabled: boolean }, action: string,
  next: { storageGb?: number; backupsEnabled?: boolean } = {}) {
  await requireUnfrozen(db, userId);
  if (!(await billingRequired(db))) return;
  const quote = await reservationQuote(db, inst.regionId, { ...inst, ...next, instanceId: inst.id });
  if (!quote) throw problem(503, 'price_unavailable', 'Prices are unavailable; new resource costs cannot be authorized.');
  const [held] = await db.select().from(browserReservations).where(eq(browserReservations.instanceId, inst.id));
  await admitSpend(db, userId, action, Math.max(0, quote.requiredMicros - (held?.reservedMicros ?? 0)));
  try { await reservationWrite(db, userId, inst.id, quote); }
  catch (e) {
    if (String(e).includes('insufficient_prepaid_reserve')) throw problem(402, 'insufficient_balance', 'Available credit changed. Add credit to fund this browser and its seven-day deposit.');
    throw e;
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
  // The provider itself failed a VM or disk here: another browser would fail the same way. An
  // encryption key the account may not use blocks the region until an operator reopens it;
  // other failures pause it for a while, then a create is let through as a probe.
  const issue = openProviderIssue(await launchHealthFor(db, regionId), new Date());
  if (issue) {
    throw problem(409, 'region_unavailable', blocksRegion(issue)
      ? "New browsers can't be created in this region until we fix a provider configuration problem. Choose another region."
      : 'New browsers are paused in this region while we fix a provider problem. Choose another region or try again later.');
  }
  const inventory = (await awsInventory(db)).get(regionId);
  if (inventory) {
    if (inventory.available < 1) throw problem(409, 'region_unavailable', 'AWS has no room for another browser in this region right now. Choose another region.', { limit: 'no_stock' });
    return;
  }
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
 * and the circuit breaker are all checked before a create is admitted. Spend never limits it.
 */
export async function admitCreate(db: Db, userId: string, regionId: string, now: Date, opts: { trial?: boolean } = {}) {
  await requireUnfrozen(db, userId);
  const [freeze] = await db.select().from(controlFlags).where(eq(controlFlags.key, 'creation_freeze'));
  if (freeze?.value === 'true') throw problem(503, 'creation_frozen', 'New browsers are temporarily unavailable.');

  const global = await capsFor(db, ['global']);
  const providerManaged = (await awsInventory(db)).has(regionId);

  const c = await userCaps(db, userId);
  const u = await usage(db, userId);
  if (u.browsers >= (c.get('instances') ?? 0)) {
    throw problem(403, 'plan_limit', `Your account allows ${c.get('instances') ?? 0} browsers.`, { limit: 'instances' });
  }
  // The free trial needs no credit (page 6).
  if (!opts.trial) {
    const quote = await reservationQuote(db, regionId, { storageGb: (await storageLimits(db, userId)).defaultGb, backupsEnabled: false });
    if (!quote) throw problem(503, 'price_unavailable', 'Prices for this region are unavailable.');
    await admitSpend(db, userId, 'create a browser', quote.requiredMicros);
  }
  await checkRegionRoom(db, regionId);
  const total = await count(db, HOLDS_SLOT);
  if (!providerManaged && total >= (global.get('instances') ?? Infinity)) throw problem(503, 'region_unavailable');
  const [recent] = await db
    .select({ n: sql<number>`count(*)`, oldest: sql<number | null>`min(${operations.createdAt})` })
    .from(operations)
    .where(and(eq(operations.kind, 'create'), gte(operations.createdAt, new Date(now.getTime() - 600_000))));
  if (Number(recent?.n ?? 0) >= (global.get('creates_per_10_min') ?? Infinity)) {
    // A pause, not a freeze: room returns as the oldest create in the window ages out.
    const minutes = Math.max(1, Math.ceil((Number(recent?.oldest ?? now.getTime()) + 600_000 - now.getTime()) / 60_000));
    throw problem(503, 'creation_frozen', `Many browsers were created in the last 10 minutes. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`, { limit: 'create_rate' });
  }
}

/** Before every start: suspension, balance, and the legacy region and global running caps. */
export async function admitStart(db: Db, userId: string, instanceId: string, regionId: string) {
  await requireUnfrozen(db, userId);
  const [inst] = await db
    .select()
    .from(browserInstances)
    .where(eq(browserInstances.id, instanceId));
  if (inst?.suspendedAt) throw problem(403, 'suspended', 'This browser is suspended. Contact support.');
  if (inst && isTrial(inst) && inst.trialState === 'active' && trialSecondsLeft(inst) > 0) {
    // Free trial minutes left: waking is free.
  } else if (inst && isTrial(inst)) {
    await admitInstanceSpend(db, userId, inst, 'continue this browser after the free trial');
    await convertTrials(db, userId, new Date());
  } else if (inst) {
    await admitInstanceSpend(db, userId, inst, 'wake a browser');
  }

  const others = and(ne(browserInstances.id, instanceId), inArray(browserInstances.status, RUNNING_STATUSES));
  const regionCaps = await capsFor(db, [`region:${regionId}`]);
  const providerManaged = (await awsInventory(db)).has(regionId);
  if (!providerManaged && (await count(db, and(eq(browserInstances.regionId, regionId), others))) >= (regionCaps.get('running') ?? Infinity)) {
    throw problem(503, 'capacity_unavailable', 'This region is busy right now. Try again in a few minutes.');
  }
  const global = await capsFor(db, ['global']);
  if (!providerManaged && (await count(db, others)) >= (global.get('running') ?? Infinity)) {
    throw problem(503, 'capacity_unavailable', 'We are busy right now. Try again in a few minutes.');
  }
}

