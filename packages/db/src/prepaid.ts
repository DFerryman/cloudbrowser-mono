import { browserEstimate, BrowserTier, customerRates, retentionReserve, tierSheet, BYTES_PER_GB, DEFAULT_PRICING_SETTINGS, ProviderPriceSheet, type PriceFactors, type Rates } from '@cloudbrowser/contracts';
import { and, eq, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from './index.js';
import { priceSheets, pricingSettings } from './pricing.js';
import { billingAccounts, browserInstances, browserReservations, controlFlags, instanceHealth, placements, pricingSettings as pricingSettingsTable, providerPrices, regions } from './schema.js';

export const reservedTotalSql = (userId: string) => sql`coalesce((SELECT sum(reserved_micros) FROM browser_reservations WHERE user_id = ${userId}), 0)`;

export async function prepaidBalance(db: Db, userId: string) {
  const [a] = await db.select({ balanceMicros: billingAccounts.balanceMicros, exhaustedAt: billingAccounts.exhaustedAt,
    frozenAt: billingAccounts.frozenAt }).from(billingAccounts).where(eq(billingAccounts.userId, userId));
  const [held] = await db.select({ amount: sql<number>`coalesce(sum(${browserReservations.reservedMicros}), 0)` })
    .from(browserReservations).where(eq(browserReservations.userId, userId));
  const balanceMicros = a?.balanceMicros ?? 0;
  const reservedMicros = Number(held?.amount ?? 0);
  return { balanceMicros, reservedMicros, availableMicros: Math.max(0, balanceMicros - reservedMicros),
    exhaustedAt: a?.exhaustedAt ?? null, frozenAt: a?.frozenAt ?? null };
}

export interface ReservationQuote {
  requiredMicros: number;
  fixedHourMicros: number;
  rates: Rates;
}

/** The displayed fixed-resource prices, including the actual existing VM's root disk. */
export async function reservationQuote(db: Db, regionId: string, spec: { storageGb: number; backupsEnabled: boolean; instanceId?: string }, now = new Date()): Promise<ReservationQuote | null> {
  const priced = (await priceSheets(db)).get(regionId);
  if (!priced) return null;
  const [placement] = spec.instanceId ? await db.select({ rootVolumeGb: placements.rootVolumeGb }).from(placements)
    .where(and(eq(placements.instanceId, spec.instanceId), eq(placements.status, 'current'))) : [];
  const rates = { ...customerRates(priced.sheet, await pricingSettings(db)), snapshot: 0 };
  const machine = { storageGb: spec.storageGb, rootVolumeGb: placement?.rootVolumeGb ?? priced.sheet.rootVolumeGb, backups: spec.backupsEnabled };
  return { rates, requiredMicros: retentionReserve(rates, machine, now), fixedHourMicros: browserEstimate(rates, machine).alwaysOnHour };
}

/** Must be inserted with creation/asset admission. SQL triggers enforce funding under concurrency. */
export function reservationWrite(db: Db, userId: string, instanceId: string, quote: ReservationQuote, now = new Date()) {
  const values = { userId, ...quote, reservedMicros: quote.requiredMicros, retentionStartedAt: null, retentionEndsAt: null, updatedAt: now };
  return db.insert(browserReservations).values({ instanceId, ...values })
    .onConflictDoUpdate({ target: browserReservations.instanceId, set: values });
}

export type PrepaidAccessReason = 'balance' | 'frozen' | 'suspended' | 'deleted' | null;
export interface PrepaidAccess {
  allowed: boolean;
  reason: PrepaidAccessReason;
  /** Gateway authorization lease: paid access must be rechecked at least every minute. */
  deadlineAt: Date | null;
  /** Actual projected depletion within this lease; null when it only needs renewal. */
  balanceDeadlineAt: Date | null;
}
export async function prepaidAccess(db: Db, userId: string, instanceId: string, now = new Date()): Promise<PrepaidAccess> {
  // Authorization is on the signaling/input path. A single D1 batch supplies one current
  // transactional snapshot, rather than serial cross-region requests outlasting the grant.
  // No cached balance, frozen status or ownership may authorize a later renewal.
  const [instanceRows, accounts, holdRows, flags, prices, settingsRows, all, placementRows] = await db.batch([
    db.select({ inst: browserInstances, health: instanceHealth }).from(browserInstances)
      .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
      .where(and(eq(browserInstances.id, instanceId), eq(browserInstances.userId, userId))),
    db.select().from(billingAccounts).where(eq(billingAccounts.userId, userId)),
    db.select().from(browserReservations).where(eq(browserReservations.userId, userId)),
    db.select().from(controlFlags).where(eq(controlFlags.key, 'billing_required')),
    db.select({ price: providerPrices }).from(providerPrices).innerJoin(regions,
      and(eq(regions.id, providerPrices.regionId), eq(regions.executor, providerPrices.executor), eq(regions.providerRegion, providerPrices.providerRegion))),
    db.select().from(pricingSettingsTable).where(eq(pricingSettingsTable.id, 1)),
    db.select({ inst: browserInstances, health: instanceHealth }).from(browserInstances)
      .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
      .where(and(eq(browserInstances.userId, userId), notInArray(browserInstances.status, ['deleting', 'purged', 'failed']))),
    db.select({ machine: placements }).from(placements).innerJoin(browserInstances, eq(browserInstances.id, placements.instanceId))
      .where(and(eq(browserInstances.userId, userId), eq(placements.status, 'current'))),
  ]);
  const [row] = instanceRows;
  const [account] = accounts;
  const holds = new Map(holdRows.map((h) => [h.instanceId, h]));
  const reservedMicros = holdRows.reduce((sum, h) => sum + h.reservedMicros, 0);
  const availableMicros = Math.max(0, (account?.balanceMicros ?? 0) - reservedMicros);
  const denied = (reason: PrepaidAccessReason, deadlineAt: Date | null = null) => ({ allowed: false, reason, deadlineAt, balanceDeadlineAt: null });
  if (!row || row.inst.desiredState === 'deleted' || ['deleting', 'purged', 'failed'].includes(row.inst.status)) return denied('deleted');
  if (account?.frozenAt) return denied('frozen');
  if (row.inst.suspendedAt) return denied('suspended');
  if (flags[0]?.value === 'false') return { allowed: true, reason: null, deadlineAt: null, balanceDeadlineAt: null };
  const hold = holds.get(instanceId);
  if (!hold || hold.retentionStartedAt || hold.reservedMicros < hold.requiredMicros || availableMicros <= 0) return denied('balance');
  // The gateway closes before another funded minute can be spent. Rechecks can extend this lease
  // only when fresh credit still covers it; input and reconnecting never replenish credit.
  const spend = spendProjection({ all, holds, prices, settings: settingsRows[0] ?? DEFAULT_PRICING_SETTINGS, placementRows }, now);
  if (!spend) return denied('balance');
  const hour = spend.hourMicros;
  const remaining = Math.max(0, availableMicros - Math.ceil(spend.pendingMicros));
  const fundedMs = hour > 0 ? Math.floor(remaining / hour * 3_600_000) : 60_000;
  if (fundedMs < 1000) return denied('balance');
  const deadlineAt = new Date(now.getTime() + Math.min(60_000, fundedMs));
  return { allowed: true, reason: null, deadlineAt, balanceDeadlineAt: hour > 0 && fundedMs <= 60_000 ? deadlineAt : null };
}

interface SpendInputs {
  all: { inst: typeof browserInstances.$inferSelect; health: typeof instanceHealth.$inferSelect | null }[];
  holds: Map<string, typeof browserReservations.$inferSelect>;
  prices: { price: typeof providerPrices.$inferSelect }[];
  settings: PriceFactors;
  placementRows: { machine: typeof placements.$inferSelect }[];
}

/**
 * The account's combined spending rate now (fixed resources of every kept paid browser plus
 * compute of the running ones) and the charges accrued but not yet metered. Null when a browser
 * has no price: its spend is unknown, so nothing may be authorized against it.
 */
function spendProjection({ all, holds, prices, settings, placementRows }: SpendInputs, now: Date): { hourMicros: number; pendingMicros: number } | null {
  const sheets = new Map<string, ProviderPriceSheet>();
  for (const { price } of prices) {
    const parsed = ProviderPriceSheet.safeParse(price.sheet);
    if (parsed.success && price.fetchedAt) sheets.set(price.regionId, parsed.data);
  }
  const machines = new Map(placementRows.map(({ machine }) => [machine.instanceId, machine]));
  let hour = 0;
  let pending = 0;
  for (const { inst, health } of all) {
    if (holds.get(inst.id)?.retentionStartedAt) continue;
    const sheet = sheets.get(inst.regionId);
    if (!sheet) return null;
    const machine = machines.get(inst.id);
    // The machine's own price; before its VM exists, its tier's. A capacity fallback that costs
    // more than the tier's machine is billed at the tier's price (metering).
    const tierPrice = tierSheet(sheet, BrowserTier.catch('basic').parse(inst.tier))?.vmHour;
    const ownPrice = machine?.instanceType ? sheet.instanceTypes[machine.instanceType] : tierPrice;
    const vmPrice = ownPrice !== undefined && tierPrice !== undefined ? Math.min(ownPrice, tierPrice) : ownPrice;
    if (vmPrice === undefined) return null;
    // The same rounding as metering: the cost to a micro-dollar first, then the markup.
    const rates = customerRates({ ...sheet, vmHour: vmPrice }, settings);
    const fixed = holds.get(inst.id)?.fixedHourMicros ?? 0;
    const running = inst.status === 'running';
    hour += fixed + (running ? rates.compute : 0);
    const base = health?.baseMeteredAt?.getTime() ?? now.getTime();
    const compute = health?.meteredAt?.getTime() ?? inst.lastActiveAt?.getTime() ?? now.getTime();
    pending += fixed * Math.max(0, now.getTime() - base) / 3_600_000;
    pending += ((health?.pendingComputeMs ?? 0) + (health?.transitionMs ?? 0)) / 3_600_000 * rates.compute;
    if (running) pending += rates.compute * Math.max(0, now.getTime() - compute) / 3_600_000;
    const tx = health?.netTxBytes ?? 0;
    const billed = health?.netTxBilledBytes ?? tx;
    pending += (tx >= billed ? tx - billed : tx) / BYTES_PER_GB * rates.transfer;
  }
  return { hourMicros: hour, pendingMicros: pending };
}

export interface AccountRunway {
  availableMicros: number;
  /** Combined spending rate of all the account's paid browsers right now. */
  burnHourMicros: number;
  /** Available credit after charges accrued but not yet metered. */
  remainingMicros: number;
  /** When remaining credit runs out at that rate; null when nothing is charged or a price is missing. */
  fundedUntil: Date | null;
}

/** How long available credit lasts at the account's combined spending rate (the authorization projection). */
export async function accountRunway(db: Db, userId: string, now = new Date()): Promise<AccountRunway> {
  const [accounts, holdRows, prices, settingsRows, all, placementRows] = await db.batch([
    db.select().from(billingAccounts).where(eq(billingAccounts.userId, userId)),
    db.select().from(browserReservations).where(eq(browserReservations.userId, userId)),
    db.select({ price: providerPrices }).from(providerPrices).innerJoin(regions,
      and(eq(regions.id, providerPrices.regionId), eq(regions.executor, providerPrices.executor), eq(regions.providerRegion, providerPrices.providerRegion))),
    db.select().from(pricingSettingsTable).where(eq(pricingSettingsTable.id, 1)),
    db.select({ inst: browserInstances, health: instanceHealth }).from(browserInstances)
      .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
      .where(and(eq(browserInstances.userId, userId), notInArray(browserInstances.status, ['deleting', 'purged', 'failed']))),
    db.select({ machine: placements }).from(placements).innerJoin(browserInstances, eq(browserInstances.id, placements.instanceId))
      .where(and(eq(browserInstances.userId, userId), eq(placements.status, 'current'))),
  ]);
  const reserved = holdRows.reduce((sum, h) => sum + h.reservedMicros, 0);
  const availableMicros = Math.max(0, (accounts[0]?.balanceMicros ?? 0) - reserved);
  const spend = spendProjection({ all, holds: new Map(holdRows.map((h) => [h.instanceId, h])), prices, settings: settingsRows[0] ?? DEFAULT_PRICING_SETTINGS, placementRows }, now);
  if (!spend) return { availableMicros, burnHourMicros: 0, remainingMicros: availableMicros, fundedUntil: null };
  const remainingMicros = Math.max(0, availableMicros - Math.ceil(spend.pendingMicros));
  const fundedUntil = spend.hourMicros > 0 ? new Date(now.getTime() + Math.floor(remainingMicros / spend.hourMicros * 3_600_000)) : null;
  return { availableMicros, burnHourMicros: spend.hourMicros, remainingMicros, fundedUntil };
}

/** Capture actual running time before changing status; safe inside a fenced stop/delete batch. */
export function settleRunningStatements(db: Db, instanceId: string, now: Date, fence: SQL = sql`1`) {
  const elapsed = sql`max(0, ${now.getTime()} - coalesce((SELECT metered_at FROM instance_health WHERE instance_id = ${instanceId}), last_active_at, ${now.getTime()}))`;
  const running = sql`EXISTS (SELECT 1 FROM browser_instances WHERE id = ${instanceId} AND status = 'running' AND (${fence}))`;
  return [
    db.insert(instanceHealth).values({ instanceId }).onConflictDoNothing(),
    db.update(instanceHealth).set({ pendingComputeMs: sql`${instanceHealth.pendingComputeMs} + coalesce((SELECT ${elapsed} FROM browser_instances WHERE id = ${instanceId}), 0)` })
      .where(and(eq(instanceHealth.instanceId, instanceId), running)),
    db.update(browserInstances).set({
      lastActiveAt: now,
    }).where(and(eq(browserInstances.id, instanceId), eq(browserInstances.status, 'running'), fence)),
    db.update(instanceHealth).set({ meteredAt: null }).where(and(eq(instanceHealth.instanceId, instanceId), running)),
  ];
}
