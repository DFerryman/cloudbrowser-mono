import { browserEstimate, customerRates, retentionReserve, TRIAL, BYTES_PER_GB, type Rates } from '@cloudbrowser/contracts';
import { and, eq, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from './index.js';
import { billingRequired } from './caps.js';
import { priceSheets, pricingSettings } from './pricing.js';
import { billingAccounts, browserInstances, browserReservations, instanceHealth, placements } from './schema.js';

export const reservedTotalSql = (userId: string) => sql`coalesce((SELECT sum(reserved_micros) FROM browser_reservations WHERE user_id = ${userId}), 0)`;

export async function prepaidBalance(db: Db, userId: string) {
  const [a] = await db.select({ balanceMicros: billingAccounts.balanceMicros, exhaustedAt: billingAccounts.exhaustedAt,
    frozenAt: billingAccounts.frozenAt, trialUsedAt: billingAccounts.trialUsedAt }).from(billingAccounts).where(eq(billingAccounts.userId, userId));
  const [held] = await db.select({ amount: sql<number>`coalesce(sum(${browserReservations.reservedMicros}), 0)` })
    .from(browserReservations).where(eq(browserReservations.userId, userId));
  const balanceMicros = a?.balanceMicros ?? 0;
  const reservedMicros = Number(held?.amount ?? 0);
  return { balanceMicros, reservedMicros, availableMicros: Math.max(0, balanceMicros - reservedMicros),
    exhaustedAt: a?.exhaustedAt ?? null, frozenAt: a?.frozenAt ?? null, trialUsedAt: a?.trialUsedAt ?? null };
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
  const rates = { ...customerRates(priced.sheet, (await pricingSettings(db)).markupPercent), snapshot: 0 };
  const machine = { storageGb: spec.storageGb, rootVolumeGb: placement?.rootVolumeGb ?? priced.sheet.rootVolumeGb, backups: spec.backupsEnabled };
  return { rates, requiredMicros: retentionReserve(rates, machine, now), fixedHourMicros: browserEstimate(rates, machine).alwaysOnHour };
}

/** Must be inserted with creation/asset admission. SQL triggers enforce funding under concurrency. */
export function reservationWrite(db: Db, userId: string, instanceId: string, quote: ReservationQuote, now = new Date()) {
  const values = { userId, ...quote, reservedMicros: quote.requiredMicros, retentionStartedAt: null, retentionEndsAt: null, updatedAt: now };
  return db.insert(browserReservations).values({ instanceId, ...values })
    .onConflictDoUpdate({ target: browserReservations.instanceId, set: values });
}

export type PrepaidAccessReason = 'balance' | 'trial' | 'frozen' | 'suspended' | 'deleted' | null;
export async function prepaidAccess(db: Db, userId: string, instanceId: string, now = new Date()): Promise<{ allowed: boolean; reason: PrepaidAccessReason; deadlineAt: Date | null }> {
  const [row] = await db.select({ inst: browserInstances, health: instanceHealth }).from(browserInstances)
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
    .where(and(eq(browserInstances.id, instanceId), eq(browserInstances.userId, userId)));
  const denied = (reason: PrepaidAccessReason, deadlineAt: Date | null = null) => ({ allowed: false, reason, deadlineAt });
  if (!row || row.inst.desiredState === 'deleted' || ['deleting', 'purged', 'failed'].includes(row.inst.status)) return denied('deleted');
  const a = await prepaidBalance(db, userId);
  if (a.frozenAt) return denied('frozen');
  if (row.inst.suspendedAt) return denied('suspended');
  if (row.inst.trialState === 'active' || row.inst.trialState === 'ended') {
    const remainingMs = Math.max(0, TRIAL.runningSeconds * 1000 - Math.max(row.inst.trialUsedMs, row.inst.trialUsedS * 1000));
    const origin = row.health?.meteredAt?.getTime() ?? row.inst.lastActiveAt?.getTime() ?? 0;
    const deadlineAt = row.inst.status === 'running' && origin ? new Date(origin + remainingMs) : null;
    return row.inst.trialState === 'ended' || remainingMs <= 0 || (deadlineAt && now >= deadlineAt) ? denied('trial', deadlineAt) : { allowed: true, reason: null, deadlineAt };
  }
  if (!(await billingRequired(db))) return { allowed: true, reason: null, deadlineAt: null };
  const [hold] = await db.select().from(browserReservations).where(eq(browserReservations.instanceId, instanceId));
  if (!hold || hold.retentionStartedAt || hold.reservedMicros < hold.requiredMicros || a.availableMicros <= 0) return denied('balance');
  // The gateway closes before another funded minute can be spent. Rechecks can extend this lease
  // only when fresh credit still covers it; input and reconnecting never change trial deadlines.
  const sheets = await priceSheets(db);
  const settings = await pricingSettings(db);
  const all = await db.select({ inst: browserInstances, health: instanceHealth }).from(browserInstances)
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
    .where(and(eq(browserInstances.userId, userId), notInArray(browserInstances.status, ['deleting', 'purged', 'failed'])));
  const machines = new Map((await db.select().from(placements).where(eq(placements.status, 'current'))).map((p) => [p.instanceId, p]));
  const holds = new Map((await db.select().from(browserReservations).where(eq(browserReservations.userId, userId))).map((h) => [h.instanceId, h]));
  let hour = 0;
  let pending = 0;
  for (const { inst, health } of all) {
    if (inst.trialState === 'active' || inst.trialState === 'ended' || holds.get(inst.id)?.retentionStartedAt) continue;
    const sheet = sheets.get(inst.regionId);
    if (!sheet) return denied('balance');
    const rates = customerRates(sheet.sheet, settings.markupPercent);
    const machine = machines.get(inst.id);
    const vmPrice = machine?.instanceType ? sheet.sheet.instanceTypes[machine.instanceType] : sheet.sheet.vmHour;
    if (vmPrice === undefined) return denied('balance');
    rates.compute = Math.round(vmPrice * 1_000_000 * settings.markupPercent / 100);
    const fixed = holds.get(inst.id)?.fixedHourMicros ?? 0;
    const running = inst.status === 'running';
    hour += fixed + (running ? rates.compute : 0);
    const base = health?.baseMeteredAt?.getTime() ?? now.getTime();
    const compute = health?.meteredAt?.getTime() ?? inst.lastActiveAt?.getTime() ?? now.getTime();
    pending += fixed * Math.max(0, now.getTime() - base) / 3_600_000;
    pending += (health?.pendingComputeMs ?? 0) / 3_600_000 * rates.compute;
    if (running) pending += rates.compute * Math.max(0, now.getTime() - compute) / 3_600_000;
    const tx = health?.netTxBytes ?? 0;
    const billed = health?.netTxBilledBytes ?? tx;
    pending += (tx >= billed ? tx - billed : tx) / BYTES_PER_GB * rates.transfer;
  }
  const remaining = Math.max(0, a.availableMicros - Math.ceil(pending));
  const fundedMs = hour > 0 ? Math.floor(remaining / hour * 3_600_000) : 60_000;
  if (fundedMs < 1000) return denied('balance');
  return { allowed: true, reason: null, deadlineAt: new Date(now.getTime() + Math.min(60_000, fundedMs)) };
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
      trialUsedMs: sql`CASE WHEN trial_state = 'active' THEN min(${TRIAL.runningSeconds * 1000}, max(trial_used_ms, trial_used_s * 1000) + ${elapsed}) ELSE trial_used_ms END`,
      trialUsedS: sql`CASE WHEN trial_state = 'active' THEN cast(min(${TRIAL.runningSeconds * 1000}, max(trial_used_ms, trial_used_s * 1000) + ${elapsed}) / 1000 AS integer) ELSE trial_used_s END`,
      trialState: sql`CASE WHEN trial_state = 'active' AND max(trial_used_ms, trial_used_s * 1000) + ${elapsed} >= ${TRIAL.runningSeconds * 1000} THEN 'ended' ELSE trial_state END`,
      lastActiveAt: now,
    }).where(and(eq(browserInstances.id, instanceId), eq(browserInstances.status, 'running'), fence)),
    db.update(instanceHealth).set({ meteredAt: null }).where(and(eq(instanceHealth.instanceId, instanceId), running)),
  ];
}

/** Start paid metering in the same transaction that converts a funded trial. Free time/traffic
 * before this boundary must never be debited after conversion. A concurrent meter's cursor CAS
 * also fails once these cursors move. */
export function convertTrialStatements(db: Db, userId: string, now: Date, condition: SQL = sql`1`) {
  const eligible = sql`browser_instances.user_id = ${userId} AND browser_instances.trial_state IN ('active', 'ended')
    AND browser_instances.desired_state <> 'deleted' AND browser_instances.status NOT IN ('deleting', 'purged', 'failed') AND (${condition})`;
  return [
    db.update(instanceHealth).set({ baseMeteredAt: now,
      meteredAt: sql`CASE WHEN (SELECT status FROM browser_instances WHERE id = ${instanceHealth.instanceId}) = 'running' THEN ${now.getTime()} ELSE NULL END`,
      pendingComputeMs: 0, netTxBilledBytes: sql`${instanceHealth.netTxBytes}`,
    }).where(sql`EXISTS (SELECT 1 FROM browser_instances WHERE browser_instances.id = ${instanceHealth.instanceId} AND ${eligible})`),
    db.update(browserInstances).set({ trialState: 'converted', trialReclaimAt: null, updatedAt: now })
      .where(eligible).returning({ id: browserInstances.id }),
  ] as const;
}
