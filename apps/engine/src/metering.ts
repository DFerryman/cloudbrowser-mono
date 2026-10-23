/**
 * Usage metering and balance enforcement (page 6), every minute from the engine's cron:
 *  - charges each browser for what it used since the last run, at its region's provider price times
 *    the markups: compute while running, plus the boot and shutdown time the engine measured (AWS
 *    bills those minutes too) unless the operator turned that off; the dedicated IP, storage (data
 *    volume and system disk) and snapshots for as long as it exists; data sent to the internet as
 *    reported by its agent, at AWS's data-out price plus the TURN relay's;
 *  - records the usage per browser, item and day in `usage_records` and takes it from the owner's
 *    prepaid balance (pilot: recorded at the real prices, nothing taken);
 *  - when a balance reaches zero, records it (the session view warns) and puts the user's running
 *    browsers to sleep immediately; a frozen account also sleeps at once;
 *  - puts suspended browsers to sleep (operator kill switch).
 * Data and IPs are never touched here. Creating, waking and deleted browsers are not charged.
 */
import {
  BYTES_PER_GB,
  BrowserTier,
  splitUsagePeriod,
  tierSheet,
  costRates,
  customerRates,
  type Rates,
  type UsageItem,
} from '@cloudbrowser/contracts';
import { billingRequired, prepaidAccess, prepaidBalance, reservedTotalSql, newId, eventRow, operationRow, priceSheets, pricingSettings, raiseAlert, schema, usageDay } from '@cloudbrowser/db';
import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { EngineDeps } from './context.js';
import { requestStop } from './scheduler.js';
import { reconcileReservations, beginRetention } from './prepaid.js';

const { browserInstances, instanceHealth, operations, events, usageRecords, billingAccounts, backups, placements, resources, browserReservations, balanceTransactions } = schema;

/** A missed cron run is not billed beyond this. */
const MAX_METER_STEP_MS = 5 * 60_000;
/** One boot or shutdown is never billed beyond its operation's deadline. */
const MAX_TRANSITION_MS = 20 * 60_000;
/** States in which a browser holds its IP and volume and is charged for them. */
const NOT_BILLED = ['creating', 'failed', 'purged'];
/**
 * A create waiting for capacity or for its provider has not run yet (a browser's first run sets
 * last_active_at): like one still creating, it is not charged.
 */
const CREATE_WAITING = sql`${browserInstances.status} IN ('waiting_capacity', 'provider_issue') AND ${browserInstances.lastActiveAt} IS NULL`;

export async function meterUsage(deps: EngineDeps, options: { minIntervalMs?: number } = {}) {
  const { db } = deps;
  const now = deps.now();
  const summary = { metered: 0, chargedMicros: 0, stopped: 0 };
  const prepaid = await billingRequired(db);
  if (prepaid) await reconcileReservations(deps);
  const settings = await pricingSettings(db);
  const sheets = await priceSheets(db);
  const rows = await db.select({ inst: browserInstances, health: instanceHealth }).from(browserInstances)
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
    .where(and(notInArray(browserInstances.status, NOT_BILLED), sql`NOT (${CREATE_WAITING})`));
  const actual = new Map((await db.select().from(placements).where(eq(placements.status, 'current'))).map((p) => [p.instanceId, p]));
  const holds = new Map((await db.select().from(browserReservations)).map((h) => [h.instanceId, h]));
  const ids = rows.map((r) => r.inst.id);
  const retained = ids.length ? await db.select().from(resources).where(inArray(resources.instanceId, ids)) : [];
  const snapshots = ids.length ? await db.select().from(backups).where(and(inArray(backups.instanceId, ids), eq(backups.kind, 'snapshot'), eq(backups.status, 'complete'))) : [];
  for (const { inst, health } of rows) {
    // Cron enforcement still runs each minute; settlement can skip unchanged short windows.
    if (health?.baseMeteredAt && !health.pendingComputeMs && !health.transitionMs && options.minIntervalMs
      && now.getTime() - health.baseMeteredAt.getTime() < options.minIntervalMs) {
      // Settle immediately at depletion/expiry so the atomic stop guard sees the actual debit.
      if (inst.status !== 'running' || (await prepaidAccess(db, inst.userId, inst.id, now)).allowed) continue;
    }
    const running = inst.status === 'running';
    const from = health?.baseMeteredAt?.getTime() ?? now.getTime();
    const baseFrom = new Date(Math.max(from, now.getTime() - MAX_METER_STEP_MS));
    const origin = health?.meteredAt?.getTime() ?? inst.lastActiveAt?.getTime() ?? now.getTime();
    const computeFrom = new Date(Math.max(origin, now.getTime() - MAX_METER_STEP_MS));
    const pendingMs = health?.pendingComputeMs ?? 0;
    const transitionMs = health?.transitionMs ?? 0;
    const tx = health?.netTxBytes ?? null;
    const billedTx = health?.netTxBilledBytes ?? null;
    const txBytes = tx === null || billedTx === null ? 0 : tx >= billedTx ? tx - billedTx : tx;
    if (!health) await db.insert(instanceHealth).values({ instanceId: inst.id }).onConflictDoNothing();
    const claim = sql`EXISTS (SELECT 1 FROM ${instanceHealth} WHERE ${instanceHealth.instanceId} = ${inst.id}
      AND ${instanceHealth.baseMeteredAt} IS ${health?.baseMeteredAt?.getTime() ?? null}
      AND ${instanceHealth.meteredAt} IS ${health?.meteredAt?.getTime() ?? null}
      AND ${instanceHealth.pendingComputeMs} = ${pendingMs}
      AND ${instanceHealth.transitionMs} = ${transitionMs}
      AND (${instanceHealth.baseMeteredAt} IS NULL OR ${instanceHealth.baseMeteredAt} < ${now.getTime()}))
      AND EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.id} = ${inst.id}
        AND ${browserInstances.status} = ${inst.status} AND ${browserInstances.desiredState} = ${inst.desiredState})`;
    const priced = sheets.get(inst.regionId);
    const placement = actual.get(inst.id);
    const missingType = priced && placement?.instanceType && priced.sheet.instanceTypes[placement.instanceType] === undefined;
    if (!priced || missingType) {
      if (missingType) await raiseAlert(db, { source: 'billing', severity: 'warning', title: `Missing price for ${placement.instanceType} in ${inst.regionId}`, detail: { instanceId: inst.id }, dedupeKey: `machine-price:${inst.regionId}:${placement.instanceType}` }, now);
      continue;
    }
    // The machine's own price; a placement that has not recorded its type yet uses its tier's.
    const cost = costRates(tierSheet(priced.sheet, BrowserTier.catch('basic').parse(inst.tier)) ?? priced.sheet, settings.relayGbMicros);
    if (placement?.instanceType) cost.compute = Math.round(priced.sheet.instanceTypes[placement.instanceType]! * 1_000_000);
    const removed = inst.status === 'deleting';
    const hold = holds.get(inst.id);
    const retaining = !!hold?.retentionStartedAt;
    const free: Rates = { compute: 0, ip: 0, storage: 0, snapshot: 0, transfer: 0 };
    const quoted = removed ? free : retaining ? { ...hold.rates, compute: 0, transfer: 0, snapshot: 0 } : { ...customerRates(priced.sheet, settings), snapshot: 0 };
    if (!removed && !retaining) quoted.compute = Math.round(cost.compute * settings.markupPercent / 100);
    const rootGb = placement?.rootVolumeGb ?? priced.sheet.rootVolumeGb;
    const ledger = retained.filter((r) => r.instanceId === inst.id);
    const live = ledger.filter((r) => r.state !== 'deleted' && r.providerId !== null);
    const roots = ledger.filter((r) => r.kind === 'volume' && r.tags['cb:kind'] === 'root_volume');
    const rootCount = roots.length ? live.filter((r) => r.kind === 'volume' && r.tags['cb:kind'] === 'root_volume').length : live.filter((r) => r.kind === 'vm').length;
    const dataCount = live.filter((r) => r.kind === 'volume' && r.tags['cb:kind'] !== 'root_volume').length;
    const storageGb = removed ? inst.storageGb * dataCount + rootGb * rootCount : inst.storageGb + rootGb;
    const ipCount = removed ? live.filter((r) => r.kind === 'ip').length : 1;
    const hasSnapshot = removed ? live.some((r) => r.kind === 'snapshot') : snapshots.some((s) => s.instanceId === inst.id);
    type Entry = { day: string; item: UsageItem; quantity: number; price: number; cost: number };
    const entries: Entry[] = [];
    const add = (day: string, item: UsageItem, quantity: number, price = quoted[item]) => {
      if (quantity <= 0) return;
      const previous = entries.find((e) => e.day === day && e.item === item && e.price === price);
      if (previous) previous.quantity += quantity;
      else entries.push({ day, item, quantity, price, cost: cost[item] });
    };
    for (const part of splitUsagePeriod(baseFrom, now)) {
      add(part.day, 'ip', part.hours * ipCount);
      add(part.day, 'storage', storageGb * part.monthFraction);
      if (hasSnapshot) add(part.day, 'snapshot', inst.storageGb * part.monthFraction);
    }
    if (running) for (const part of splitUsagePeriod(computeFrom, now)) add(part.day, 'compute', part.hours);
    // Running time settled by a stop follows the same missed-run cap as running time metered here.
    if (pendingMs > 0) add(usageDay(now), 'compute', Math.min(pendingMs, MAX_METER_STEP_MS) / 3_600_000);
    // Boot and shutdown, measured by the operations; recorded at cost even when not charged.
    if (transitionMs > 0) add(usageDay(now), 'compute', Math.min(transitionMs, MAX_TRANSITION_MS) / 3_600_000, settings.billTransitions ? quoted.compute : 0);
    add(usageDay(now), 'transfer', txBytes / BYTES_PER_GB);
    const stmts: BatchItem<'sqlite'>[] = [];
    const reference = `usage:${inst.id}:${from}:${now.getTime()}`;
    const journal = sql`EXISTS (SELECT 1 FROM ${balanceTransactions} WHERE ${balanceTransactions.reference} = ${reference} AND ${balanceTransactions.appliedAt} IS NULL)`;
    const paidEntries = entries.filter((e) => e.price > 0);
    const balance = sql`coalesce((SELECT balance_micros FROM billing_accounts WHERE user_id=${inst.userId}),0)`;
    const spendable = retaining ? sql`min(max(0,${balance}),coalesce((SELECT reserved_micros FROM browser_reservations WHERE instance_id=${inst.id}),0))`
      : sql`max(0,${balance}-${reservedTotalSql(inst.userId)})`;
    if (prepaid && paidEntries.length) {
      // This internal journal is created in the same transaction as usage and the cursor. It caps
      // a multi-browser debit at spendable credit and allocates that exact payment across items.
      const eligible = retaining && hold?.retentionEndsAt && now >= hold.retentionEndsAt ? sql`0` : claim;
      // Compute all allocations before changing usage rows, in the journal's single INSERT.
      // Repeatedly rewriting this JSON once per item used most of the billing write quota.
      stmts.push(db.insert(balanceTransactions).select(sql`WITH charges(idx,day,item,price,cost,q) AS
        (VALUES ${sql.join(paidEntries.map((e, i) => sql`(${i},${e.day},${e.item},${e.price},${e.cost},${e.quantity})`), sql`,`)}),
        deltas AS (SELECT c.idx,c.day,c.item,round((coalesce(u.quantity,0)+c.q)*c.price)-coalesce(u.amount_micros,0) AS delta
          FROM charges c LEFT JOIN usage_records u ON u.instance_id=${inst.id} AND u.day=c.day AND u.item=c.item
            AND u.unit_price_micros=c.price AND u.unit_cost_micros=c.cost),
        budget AS (SELECT min(${spendable},coalesce(sum(delta),0)) AS amount FROM deltas),
        allocated AS (SELECT day,item,min(delta,max(0,budget.amount-coalesce(sum(delta) OVER
          (ORDER BY idx ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS amount FROM deltas,budget)
        SELECT ${newId(now.getTime())},${inst.userId},'usage',-(SELECT amount FROM budget),${reference},NULL,NULL,NULL,NULL,
          json_object('itemCharges',json((SELECT json_group_object(day || ':' || item,amount) FROM allocated))),
          'engine',${now.getTime()},NULL WHERE ${eligible}`)
        .onConflictDoNothing().returning({ amountMicros: balanceTransactions.amountMicros }));
    }
    for (const e of entries) {
      const itemCharge = prepaid && paidEntries.length ? sql`coalesce((SELECT json_extract(description,${`$.itemCharges."${e.day}:${e.item}"`}) FROM balance_transactions WHERE reference=${reference} AND applied_at IS NULL),0)` : sql`0`;
      stmts.push(db.insert(usageRecords).select(sql`SELECT ${inst.id},${inst.userId},${inst.regionId},${e.item},${e.day},${e.price},${e.cost},${e.quantity},round(${e.quantity}*${e.price}),round(${e.quantity}*${e.cost}),${itemCharge},${now.getTime()} WHERE ${claim}`)
        .onConflictDoUpdate({ target: [usageRecords.instanceId, usageRecords.item, usageRecords.day, usageRecords.unitPriceMicros, usageRecords.unitCostMicros], set: {
          chargedMicros: sql`${usageRecords.chargedMicros}+${itemCharge}`, quantity: sql`${usageRecords.quantity}+excluded.quantity`,
          amountMicros: sql`round((${usageRecords.quantity}+excluded.quantity)*${usageRecords.unitPriceMicros})`,
          costMicros: sql`round((${usageRecords.quantity}+excluded.quantity)*${usageRecords.unitCostMicros})`, updatedAt: now,
        } }));
    }
    if (prepaid && paidEntries.length) {
      const actualDebit = sql`coalesce((SELECT amount_micros FROM balance_transactions WHERE reference=${reference} AND applied_at IS NULL),0)`;
      stmts.push(db.update(billingAccounts).set({ balanceMicros: sql`${billingAccounts.balanceMicros}+${actualDebit}`, updatedAt: now }).where(and(eq(billingAccounts.userId, inst.userId), journal, claim)));
      if (retaining) stmts.push(db.update(browserReservations).set({ reservedMicros: sql`max(0,${browserReservations.reservedMicros}+${actualDebit})`, updatedAt: now }).where(and(eq(browserReservations.instanceId, inst.id), journal, claim)));
      stmts.push(db.update(balanceTransactions).set({ appliedAt: now }).where(and(eq(balanceTransactions.reference, reference), isNull(balanceTransactions.appliedAt), claim)));
    }
    stmts.push(db.update(instanceHealth).set({ baseMeteredAt: now, meteredAt: running ? now : null, pendingComputeMs: 0, transitionMs: 0, ...(tx !== null ? { netTxBilledBytes: tx } : {}) })
      .where(and(eq(instanceHealth.instanceId, inst.id), claim)).returning({ id: instanceHealth.instanceId }));
    const result = await db.batch(stmts as [BatchItem<'sqlite'>,...BatchItem<'sqlite'>[]]);
    if ((result.at(-1) as {id:string}[]).length) {
      summary.metered++;
      if (prepaid && paidEntries.length) summary.chargedMicros -= Number((result[0] as {amountMicros:number}[])[0]?.amountMicros ?? 0);
    }
  }
  summary.stopped = await enforce(deps, prepaid, now);
  return summary;
}

/** No unpaid grace period. Close access first, then reconcile provider power state safely. */
async function enforce(deps: EngineDeps, prepaid: boolean, now: Date): Promise<number> {
  const { db } = deps;
  let stopped = 0;
  const all = await db.select().from(browserInstances).where(notInArray(browserInstances.status, ['deleting', 'purged', 'failed']));
  const users = [...new Set(all.map((r) => r.userId))];
  for (const userId of users) {
    const account = await prepaidBalance(db, userId);
    const paid = all.filter((r) => r.userId === userId);
    if (prepaid && paid.length && (account.availableMicros <= 0 || account.frozenAt)) {
      await beginRetention(db, userId, now);
      if (!account.exhaustedAt) {
        await db.insert(events).values(eventRow(userId, 'entitlements.updated', { balance: true }, now));
        deps.notify(userId);
      }
    }
    for (const inst of all.filter((r) => r.userId === userId)) {
      let reason: string | null = account.frozenAt ? 'frozen' : inst.suspendedAt ? 'suspended' : null;
      const access = await prepaidAccess(db, userId, inst.id, now);
      if (!reason && prepaid && access.reason === 'balance') reason = 'balance';
      if (!reason) continue;
      await db.update(schema.viewerSessions).set({ endedAt: now }).where(and(eq(schema.viewerSessions.instanceId, inst.id), isNull(schema.viewerSessions.endedAt)));
      if (['running', 'starting', 'creating', 'waiting_capacity', 'needs_attention', 'provider_issue'].includes(inst.status)) {
        if (await requestStop(deps, inst, reason)) stopped++;
      }
    }
  }
  return stopped;
}
