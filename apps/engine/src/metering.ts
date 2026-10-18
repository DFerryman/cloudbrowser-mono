/**
 * Usage metering and balance enforcement (page 6), every minute from the engine's cron:
 *  - charges each browser for what it used since the last run, at its region's provider price times
 *    the markup: compute while running; the dedicated IP, storage (data volume and system disk) and
 *    snapshots for as long as it exists; data sent to the internet as reported by its agent;
 *  - records the usage per browser, item and day in `usage_records` and takes it from the owner's
 *    prepaid balance (pilot: recorded at the real prices, nothing taken);
 *  - when a balance reaches zero, records it (the session view warns) and puts the user's running
 *    browsers to sleep immediately; a frozen account also sleeps at once;
 *  - puts suspended browsers to sleep (operator kill switch).
 *  - counts a free trial browser's running time, sleeps it when its 10 minutes are used, and
 *    deletes it 7 days after it last went to sleep unless the user added credit (page 6). A trial
 *    browser is metered at its AWS cost but charged nothing, so operators see what trials cost.
 * Data and IPs are never touched here. Creating, waking and deleted browsers are not charged.
 */
import {
  BYTES_PER_GB,
  splitUsagePeriod,
  TRIAL,
  costRates,
  customerRates,
  type Rates,
  type UsageItem,
} from '@cloudbrowser/contracts';
import { billingRequired, prepaidAccess, prepaidBalance, reservedTotalSql, newId, eventRow, operationRow, priceSheets, pricingSettings, raiseAlert, schema, usageDay, userCaps } from '@cloudbrowser/db';
import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { EngineDeps } from './context.js';
import { requestStop } from './scheduler.js';
import { reconcileReservations, beginRetention } from './prepaid.js';

const { browserInstances, instanceHealth, operations, events, usageRecords, billingAccounts, backups, placements, resources, browserReservations, balanceTransactions } = schema;

/** A missed cron run is not billed beyond this. */
const MAX_METER_STEP_MS = 5 * 60_000;
/** States in which a browser holds its IP and volume and is charged for them. */
const NOT_BILLED = ['creating', 'failed', 'purged'];

export async function meterUsage(deps: EngineDeps) {
  const { db } = deps;
  const now = deps.now();
  const summary = { metered: 0, chargedMicros: 0, stopped: 0 };
  const prepaid = await billingRequired(db);
  if (prepaid) await reconcileReservations(deps);
  const { markupPercent } = await pricingSettings(db);
  const sheets = await priceSheets(db);
  const rows = await db.select({ inst: browserInstances, health: instanceHealth }).from(browserInstances)
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
    .where(notInArray(browserInstances.status, NOT_BILLED));
  const actual = new Map((await db.select().from(placements).where(eq(placements.status, 'current'))).map((p) => [p.instanceId, p]));
  const holds = new Map((await db.select().from(browserReservations)).map((h) => [h.instanceId, h]));
  const ids = rows.map((r) => r.inst.id);
  const retained = ids.length ? await db.select().from(resources).where(inArray(resources.instanceId, ids)) : [];
  const snapshots = ids.length ? await db.select().from(backups).where(and(inArray(backups.instanceId, ids), eq(backups.kind, 'snapshot'), eq(backups.status, 'complete'))) : [];
  for (const { inst, health } of rows) {
    const running = inst.status === 'running';
    const trial = inst.trialState === 'active' || inst.trialState === 'ended';
    const from = health?.baseMeteredAt?.getTime() ?? now.getTime();
    const baseFrom = new Date(Math.max(from, now.getTime() - MAX_METER_STEP_MS));
    const origin = health?.meteredAt?.getTime() ?? inst.lastActiveAt?.getTime() ?? now.getTime();
    const computeFrom = new Date(Math.max(origin, now.getTime() - MAX_METER_STEP_MS));
    const pendingMs = health?.pendingComputeMs ?? 0;
    const trialMillis = running && inst.trialState === 'active' ? Math.min(TRIAL.runningSeconds * 1000 - Math.max(inst.trialUsedMs, inst.trialUsedS * 1000), Math.max(0, now.getTime() - origin)) : 0;
    const tx = health?.netTxBytes ?? null;
    const billedTx = health?.netTxBilledBytes ?? null;
    const txBytes = tx === null || billedTx === null ? 0 : tx >= billedTx ? tx - billedTx : tx;
    if (!health) await db.insert(instanceHealth).values({ instanceId: inst.id }).onConflictDoNothing();
    const claim = sql`EXISTS (SELECT 1 FROM ${instanceHealth} WHERE ${instanceHealth.instanceId} = ${inst.id}
      AND ${instanceHealth.baseMeteredAt} IS ${health?.baseMeteredAt?.getTime() ?? null}
      AND ${instanceHealth.meteredAt} IS ${health?.meteredAt?.getTime() ?? null}
      AND ${instanceHealth.pendingComputeMs} = ${pendingMs}
      AND (${instanceHealth.baseMeteredAt} IS NULL OR ${instanceHealth.baseMeteredAt} < ${now.getTime()}))
      AND EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.id} = ${inst.id}
        AND ${browserInstances.status} = ${inst.status} AND ${browserInstances.desiredState} = ${inst.desiredState})`;
    const priced = sheets.get(inst.regionId);
    const placement = actual.get(inst.id);
    const missingType = priced && placement?.instanceType && priced.sheet.instanceTypes[placement.instanceType] === undefined;
    if (!priced || missingType) {
      if (missingType) await raiseAlert(db, { source: 'billing', severity: 'warning', title: `Missing price for ${placement.instanceType} in ${inst.regionId}`, detail: { instanceId: inst.id }, dedupeKey: `machine-price:${inst.regionId}:${placement.instanceType}` }, now);
      // Trial enforcement is independent of AWS price availability and the five-minute billing cap.
      if (trialMillis > 0) await db.batch([
        db.update(browserInstances).set({ trialUsedMs: sql`min(${TRIAL.runningSeconds * 1000}, max(${browserInstances.trialUsedMs}, ${browserInstances.trialUsedS} * 1000) + ${trialMillis})`,
          trialUsedS: sql`cast(min(${TRIAL.runningSeconds * 1000}, max(${browserInstances.trialUsedMs}, ${browserInstances.trialUsedS} * 1000) + ${trialMillis}) / 1000 AS integer)`,
          trialState: sql`CASE WHEN max(${browserInstances.trialUsedMs}, ${browserInstances.trialUsedS} * 1000) + ${trialMillis} >= ${TRIAL.runningSeconds * 1000} THEN 'ended' ELSE 'active' END`, updatedAt: now,
        }).where(and(eq(browserInstances.id, inst.id), eq(browserInstances.trialState, 'active'), claim)),
        db.update(instanceHealth).set({ meteredAt: now }).where(and(eq(instanceHealth.instanceId, inst.id), claim)),
      ]);
      continue;
    }
    const cost = costRates(priced.sheet);
    if (placement?.instanceType) cost.compute = Math.round(priced.sheet.instanceTypes[placement.instanceType]! * 1_000_000);
    const removed = inst.status === 'deleting';
    const hold = holds.get(inst.id);
    const retaining = !!hold?.retentionStartedAt;
    const free: Rates = { compute: 0, ip: 0, storage: 0, snapshot: 0, transfer: 0 };
    const quoted = trial || removed ? free : retaining ? { ...hold.rates, compute: 0, transfer: 0, snapshot: 0 } : { ...customerRates(priced.sheet, markupPercent), snapshot: 0 };
    if (!trial && !removed && !retaining) quoted.compute = Math.round(cost.compute * markupPercent / 100);
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
    const add = (day: string, item: UsageItem, quantity: number) => {
      if (quantity <= 0) return;
      const previous = entries.find((e) => e.day === day && e.item === item);
      if (previous) previous.quantity += quantity;
      else entries.push({ day, item, quantity, price: quoted[item], cost: cost[item] });
    };
    for (const part of splitUsagePeriod(baseFrom, now)) {
      add(part.day, 'ip', part.hours * ipCount);
      add(part.day, 'storage', storageGb * part.monthFraction);
      if (hasSnapshot) add(part.day, 'snapshot', inst.storageGb * part.monthFraction);
    }
    if (running) for (const part of splitUsagePeriod(computeFrom, now)) add(part.day, 'compute', part.hours);
    if (pendingMs > 0) add(usageDay(now), 'compute', pendingMs / 3_600_000);
    add(usageDay(now), 'transfer', txBytes / BYTES_PER_GB);
    const stmts: BatchItem<'sqlite'>[] = [];
    const reference = `usage:${inst.id}:${from}:${now.getTime()}`;
    const journal = sql`EXISTS (SELECT 1 FROM ${balanceTransactions} WHERE ${balanceTransactions.reference} = ${reference} AND ${balanceTransactions.appliedAt} IS NULL)`;
    const paidEntries = entries.filter((e) => e.price > 0);
    const debit = paidEntries.length ? sql`(WITH charges(day,item,price,cost,q) AS (VALUES ${sql.join(paidEntries.map((e) => sql`(${e.day},${e.item},${e.price},${e.cost},${e.quantity})`), sql`,`)})
      SELECT coalesce(sum(round((coalesce(u.quantity,0)+c.q)*c.price)-coalesce(u.amount_micros,0)),0)
      FROM charges c LEFT JOIN usage_records u ON u.instance_id=${inst.id} AND u.day=c.day AND u.item=c.item AND u.unit_price_micros=c.price AND u.unit_cost_micros=c.cost)` : sql`0`;
    const balance = sql`coalesce((SELECT balance_micros FROM billing_accounts WHERE user_id=${inst.userId}),0)`;
    const spendable = retaining ? sql`min(max(0,${balance}),coalesce((SELECT reserved_micros FROM browser_reservations WHERE instance_id=${inst.id}),0))`
      : sql`max(0,${balance}-${reservedTotalSql(inst.userId)})`;
    if (prepaid && paidEntries.length) {
      // This internal journal is created in the same transaction as usage and the cursor. It caps
      // a multi-browser debit at spendable credit and allocates that exact payment across items.
      const eligible = retaining && hold?.retentionEndsAt && now >= hold.retentionEndsAt ? sql`0` : claim;
      stmts.push(db.insert(balanceTransactions).select(sql`SELECT ${newId(now.getTime())},${inst.userId},'usage',-min(${spendable},${debit}),${reference},NULL,NULL,NULL,NULL,'{}','engine',${now.getTime()},NULL WHERE ${eligible}`)
        .onConflictDoNothing().returning({ amountMicros: balanceTransactions.amountMicros }));
      stmts.push(db.update(balanceTransactions).set({ description: sql`json_object('remainingMicros',-${balanceTransactions.amountMicros})` }).where(and(eq(balanceTransactions.reference, reference), isNull(balanceTransactions.appliedAt))));
    }
    for (const e of entries) {
      const previous = sql`SELECT quantity,amount_micros FROM usage_records WHERE instance_id=${inst.id} AND day=${e.day} AND item=${e.item} AND unit_price_micros=${e.price} AND unit_cost_micros=${e.cost}`;
      const delta = sql`round((coalesce((SELECT quantity FROM (${previous})),0)+${e.quantity})*${e.price})-coalesce((SELECT amount_micros FROM (${previous})),0)`;
      if (prepaid && paidEntries.length) stmts.push(db.update(balanceTransactions).set({ description: sql`json_set(${balanceTransactions.description},'$.itemCharge',min(coalesce(json_extract(${balanceTransactions.description},'$.remainingMicros'),0),${delta}))` })
        .where(and(eq(balanceTransactions.reference, reference), isNull(balanceTransactions.appliedAt), claim)));
      const itemCharge = prepaid && paidEntries.length ? sql`coalesce((SELECT json_extract(description,'$.itemCharge') FROM balance_transactions WHERE reference=${reference} AND applied_at IS NULL),0)` : sql`0`;
      stmts.push(db.insert(usageRecords).select(sql`SELECT ${inst.id},${inst.userId},${inst.regionId},${e.item},${e.day},${e.price},${e.cost},${e.quantity},round(${e.quantity}*${e.price}),round(${e.quantity}*${e.cost}),${itemCharge},${now.getTime()} WHERE ${claim}`)
        .onConflictDoUpdate({ target: [usageRecords.instanceId, usageRecords.item, usageRecords.day, usageRecords.unitPriceMicros, usageRecords.unitCostMicros], set: {
          chargedMicros: sql`${usageRecords.chargedMicros}+${itemCharge}`, quantity: sql`${usageRecords.quantity}+excluded.quantity`,
          amountMicros: sql`round((${usageRecords.quantity}+excluded.quantity)*${usageRecords.unitPriceMicros})`,
          costMicros: sql`round((${usageRecords.quantity}+excluded.quantity)*${usageRecords.unitCostMicros})`, updatedAt: now,
        } }));
      if (prepaid && paidEntries.length) stmts.push(db.update(balanceTransactions).set({ description: sql`json_set(${balanceTransactions.description},'$.remainingMicros',max(0,json_extract(${balanceTransactions.description},'$.remainingMicros')-json_extract(${balanceTransactions.description},'$.itemCharge')))` })
        .where(and(eq(balanceTransactions.reference, reference), isNull(balanceTransactions.appliedAt), claim)));
    }
    if (prepaid && paidEntries.length) {
      const actualDebit = sql`coalesce((SELECT amount_micros FROM balance_transactions WHERE reference=${reference} AND applied_at IS NULL),0)`;
      stmts.push(db.update(billingAccounts).set({ balanceMicros: sql`${billingAccounts.balanceMicros}+${actualDebit}`, updatedAt: now }).where(and(eq(billingAccounts.userId, inst.userId), journal, claim)));
      if (retaining) stmts.push(db.update(browserReservations).set({ reservedMicros: sql`max(0,${browserReservations.reservedMicros}+${actualDebit})`, updatedAt: now }).where(and(eq(browserReservations.instanceId, inst.id), journal, claim)));
      stmts.push(db.update(balanceTransactions).set({ appliedAt: now }).where(and(eq(balanceTransactions.reference, reference), isNull(balanceTransactions.appliedAt), claim)));
    }
    if (trialMillis > 0) stmts.push(db.update(browserInstances).set({ trialUsedMs: sql`min(${TRIAL.runningSeconds * 1000},max(${browserInstances.trialUsedMs},${browserInstances.trialUsedS}*1000)+${trialMillis})`,
      trialUsedS: sql`cast(min(${TRIAL.runningSeconds * 1000},max(${browserInstances.trialUsedMs},${browserInstances.trialUsedS}*1000)+${trialMillis})/1000 AS integer)`,
      trialState: sql`CASE WHEN max(${browserInstances.trialUsedMs},${browserInstances.trialUsedS}*1000)+${trialMillis}>=${TRIAL.runningSeconds * 1000} THEN 'ended' ELSE 'active' END`, updatedAt: now,
    }).where(and(eq(browserInstances.id,inst.id),eq(browserInstances.trialState,'active'),claim)));
    stmts.push(db.update(instanceHealth).set({ baseMeteredAt: now, meteredAt: running ? now : null, pendingComputeMs: 0, ...(tx !== null ? { netTxBilledBytes: tx } : {}) })
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
    const paid = all.filter((r) => r.userId === userId && !['active', 'ended'].includes(r.trialState ?? ''));
    if (prepaid && paid.length && (account.availableMicros <= 0 || account.frozenAt)) {
      await beginRetention(db, userId, now);
      if (!account.exhaustedAt) {
        await db.insert(events).values(eventRow(userId, 'entitlements.updated', { balance: true }, now));
        deps.notify(userId);
      }
    }
    const cap = ((await userCaps(db, userId)).get('running') ?? 0) === 0;
    for (const inst of all.filter((r) => r.userId === userId)) {
      let reason: string | null = account.frozenAt ? 'frozen' : inst.suspendedAt ? 'suspended' : cap ? 'plan' : null;
      const access = await prepaidAccess(db, userId, inst.id, now);
      if (!reason && access.reason === 'trial') {
        reason = 'trial';
        await db.update(browserInstances).set({ trialState: 'ended', trialUsedS: TRIAL.runningSeconds, trialUsedMs: TRIAL.runningSeconds * 1000, updatedAt: now }).where(and(eq(browserInstances.id, inst.id), eq(browserInstances.trialState, 'active')));
      }
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

/**
 * Deletes and purges free trial browsers that were not converted (no credit added) 7 days after
 * they last went to sleep (page 6). The delete is a normal operation; its purge follows at once.
 */
export async function reclaimTrials(deps: EngineDeps) {
  const { db } = deps;
  const now = deps.now();
  const due = await db
    .select({ id: browserInstances.id, userId: browserInstances.userId })
    .from(browserInstances)
    .where(
      and(
        inArray(browserInstances.trialState, ['active', 'ended']),
        lte(browserInstances.trialReclaimAt, now),
        inArray(browserInstances.status, ['sleeping', 'needs_attention']),
      ),
    );
  let n = 0;
  for (const inst of due) {
    const row = operationRow({ instanceId: inst.id, userId: null, kind: 'delete', params: { reason: 'trial_expired', purgeNow: true }, now });
    try {
      const eligible = sql`EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.id} = ${inst.id}
        AND ${browserInstances.trialState} IN ('active', 'ended') AND ${browserInstances.trialReclaimAt} <= ${now.getTime()}
        AND ${browserInstances.status} IN ('sleeping', 'needs_attention'))`;
      const [inserted] = await db.batch([
        db.insert(operations).select(sql`SELECT ${row.id}, ${inst.id}, NULL, 'delete', 'queued', NULL, 0, NULL, NULL, NULL,
          ${row.deadlineAt.getTime()}, NULL, NULL, ${JSON.stringify(row.params)}, ${now.getTime()}, ${now.getTime()}, NULL WHERE ${eligible}`)
          .returning({ id: operations.id }),
        db.update(browserInstances).set({ desiredState: 'deleted', updatedAt: now })
          .where(and(eq(browserInstances.id, inst.id), sql`EXISTS (SELECT 1 FROM ${operations} WHERE ${operations.id} = ${row.id})`)),
        db.insert(events).select(sql`SELECT NULL, ${inst.userId}, 'operation.updated', ${JSON.stringify({ operationId: row.id, instanceId: inst.id })}, ${now.getTime()}
          WHERE EXISTS (SELECT 1 FROM ${operations} WHERE ${operations.id} = ${row.id})`),
      ]);
      if (inserted.length) { deps.notify(inst.userId); n++; }
    } catch {
      // Another operation is running for it; the next minute tries again.
    }
  }
  return n;
}
