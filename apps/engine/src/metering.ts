/**
 * Usage metering and balance enforcement (page 6), every minute from the engine's cron:
 *  - charges each browser for what it used since the last run, at its region's provider price times
 *    the markup: compute while running; the dedicated IP, storage (data volume and system disk) and
 *    snapshots for as long as it exists; data sent to the internet as reported by its agent;
 *  - records the usage per browser, item and day in `usage_records` and takes it from the owner's
 *    prepaid balance (pilot: recorded at the real prices, nothing taken);
 *  - when a balance reaches zero, records it (the session view warns) and puts the user's running
 *    browsers to sleep 10 minutes later; a frozen account sleeps at once;
 *  - puts suspended browsers to sleep (operator kill switch).
 *  - counts a free trial browser's running time, sleeps it when its 10 minutes are used, and
 *    deletes it 7 days after it last went to sleep unless the user added credit (page 6). A trial
 *    browser is metered at its AWS cost but charged nothing, so operators see what trials cost.
 * Data and IPs are never touched here. Creating, waking and deleted browsers are not charged.
 */
import {
  BALANCE_GRACE_MS,
  BYTES_PER_GB,
  HOURS_PER_MONTH,
  TRIAL,
  costRates,
  customerRates,
  type Rates,
  type UsageItem,
} from '@cloudbrowser/contracts';
import { billingRequired, eventRow, operationRow, priceSheets, pricingSettings, raiseAlert, schema, usageDay, userCaps } from '@cloudbrowser/db';
import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { EngineDeps } from './context.js';
import { requestStop } from './scheduler.js';

const { browserInstances, instanceHealth, operations, events, usageRecords, billingAccounts, backups, placements, resources } = schema;

/** A missed cron run is not billed beyond this. */
const MAX_METER_STEP_MS = 5 * 60_000;
/** States in which a browser holds its IP and volume and is charged for them. */
const NOT_BILLED = ['creating', 'failed', 'purged'];
const RUNNING = ['creating', 'starting', 'running', 'waiting_capacity'];

export async function meterUsage(deps: EngineDeps) {
  const { db } = deps;
  const now = deps.now();
  const day = usageDay(now);
  const summary = { metered: 0, chargedMicros: 0, stopped: 0 };
  const prepaid = await billingRequired(db);
  const { markupPercent } = await pricingSettings(db);
  const sheets = await priceSheets(db);

  const rows = await db
    .select({ inst: browserInstances, health: instanceHealth })
    .from(browserInstances)
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
    .where(notInArray(browserInstances.status, NOT_BILLED));
  const actual = new Map((await db.select().from(placements).where(eq(placements.status, 'current'))).map((p) => [p.instanceId, p]));
  const ids = rows.map((r) => r.inst.id);
  const deleting = rows.filter((r) => r.inst.status === 'deleting').map((r) => r.inst.id);
  const retained = deleting.length ? await db.select().from(resources).where(inArray(resources.instanceId, deleting)) : [];
  const withSnapshots = new Set(
    ids.length
      ? (
          await db
            .selectDistinct({ id: backups.instanceId })
            .from(backups)
            .where(and(inArray(backups.instanceId, ids), eq(backups.kind, 'snapshot'), eq(backups.status, 'complete'), sql`${backups.reason} <> 'recover'`))
        ).map((r) => r.id)
      : [],
  );
  for (const { inst, health } of rows) {
    const running = inst.status === 'running';
    const step = (from: Date | null | undefined) => Math.max(0, Math.min(MAX_METER_STEP_MS, now.getTime() - (from?.getTime() ?? now.getTime()))) / 3_600_000;
    const baseHours = step(health?.baseMeteredAt);
    const computeHours = running ? step(health?.meteredAt) : 0;
    const tx = health?.netTxBytes ?? null;
    const billedTx = health?.netTxBilledBytes ?? null;
    const txBytes = tx === null || billedTx === null ? 0 : tx >= billedTx ? tx - billedTx : tx;
    if (!health) await db.insert(instanceHealth).values({ instanceId: inst.id }).onConflictDoNothing();

    // Every statement uses the same old cursor and commits in one D1 transaction. A failed batch
    // leaves the cursor intact; a concurrent or delayed cron cannot charge twice or move it back.
    const cursor = health?.baseMeteredAt?.getTime() ?? null;
    const claim = sql`EXISTS (SELECT 1 FROM ${instanceHealth}
      WHERE ${instanceHealth.instanceId} = ${inst.id}
      AND ${instanceHealth.baseMeteredAt} IS ${cursor}
      AND (${instanceHealth.baseMeteredAt} IS NULL OR ${instanceHealth.baseMeteredAt} < ${now.getTime()}))`;
    const trial = inst.trialState === 'active' || inst.trialState === 'ended';
    const priced = sheets.get(inst.regionId);
    const placement = actual.get(inst.id);
    const missingType = priced && placement?.instanceType && priced.sheet.instanceTypes[placement.instanceType] === undefined;
    // Keep the billing cursor intact until this actual machine is priced. Trial minutes remain
    // enforceable even if AWS pricing is unavailable; their separate compute cursor still advances.
    if (!priced || missingType) {
      if (missingType) await raiseAlert(db, { source: 'billing', severity: 'warning', title: `Missing price for ${placement.instanceType} in ${inst.regionId}`, detail: { instanceId: inst.id }, dedupeKey: `machine-price:${inst.regionId}:${placement.instanceType}` }, now);
      if (inst.trialState === 'active' && computeHours > 0) {
        const seconds = Math.round(computeHours * 3600);
        const trialClaim = sql`EXISTS (SELECT 1 FROM ${instanceHealth} WHERE ${instanceHealth.instanceId} = ${inst.id}
          AND ${instanceHealth.meteredAt} IS ${health?.meteredAt?.getTime() ?? null}
          AND (${instanceHealth.meteredAt} IS NULL OR ${instanceHealth.meteredAt} < ${now.getTime()}))`;
        await db.batch([
          db.update(browserInstances).set({ trialUsedS: sql`${browserInstances.trialUsedS} + ${seconds}`,
            trialState: sql`CASE WHEN ${browserInstances.trialUsedS} + ${seconds} >= ${TRIAL.runningSeconds} THEN 'ended' ELSE 'active' END`, updatedAt: now,
          }).where(and(eq(browserInstances.id, inst.id), eq(browserInstances.trialState, 'active'), trialClaim)),
          db.update(instanceHealth).set({ meteredAt: now }).where(and(eq(instanceHealth.instanceId, inst.id), trialClaim)),
        ]);
      } else if (inst.trialState === 'active' && !health?.meteredAt && running) {
        await db.update(instanceHealth).set({ meteredAt: now }).where(and(eq(instanceHealth.instanceId, inst.id), isNull(instanceHealth.meteredAt)));
      }
      continue;
    }
    const cost = costRates(priced.sheet);
    if (placement?.instanceType) cost.compute = Math.round(priced.sheet.instanceTypes[placement.instanceType]! * 1_000_000);
    const rootVolumeGb = placement?.rootVolumeGb ?? priced.sheet.rootVolumeGb;
    const free: Rates = { compute: 0, ip: 0, storage: 0, snapshot: 0, transfer: 0 };
    // Deleted browsers are no longer billed to customers. The platform still incurs costs
    // for resources retained by the seven-day system restore window or an incomplete purge.
    const removed = inst.status === 'deleting';
    const price = trial || removed ? free : customerRates(priced.sheet, markupPercent);
    const ledger = removed ? retained.filter((r) => r.instanceId === inst.id) : [];
    const live = ledger.filter((r) => r.state !== 'deleted' && r.providerId !== null);
    const roots = ledger.filter((r) => r.kind === 'volume' && r.tags['cb:kind'] === 'root_volume');
    const rootCount = roots.length ? live.filter((r) => r.kind === 'volume' && r.tags['cb:kind'] === 'root_volume').length : live.filter((r) => r.kind === 'vm').length;
    const dataCount = live.filter((r) => r.kind === 'volume' && r.tags['cb:kind'] !== 'root_volume').length;
    const storageGb = removed ? inst.storageGb * dataCount + rootVolumeGb * rootCount : inst.storageGb + rootVolumeGb;
    const quantities: Record<UsageItem, number> = {
      compute: computeHours,
      ip: baseHours * (removed ? live.filter((r) => r.kind === 'ip').length : 1),
      storage: (storageGb * baseHours) / HOURS_PER_MONTH,
      snapshot: (removed ? live.some((r) => r.kind === 'snapshot') : inst.backupsEnabled && withSnapshots.has(inst.id)) ? (inst.storageGb * baseHours) / HOURS_PER_MONTH : 0,
      transfer: txBytes / BYTES_PER_GB,
    };
    const items = (Object.keys(quantities) as UsageItem[]).filter((item) => quantities[item] > 0);
    const charged = () => db.select({ amount: sql<number>`coalesce(sum(${usageRecords.chargedMicros}), 0)` }).from(usageRecords).where(and(eq(usageRecords.instanceId, inst.id), eq(usageRecords.day, day)));
    const stmts: BatchItem<'sqlite'>[] = [charged()];
    // Calculate rounding deltas from the rows inside the transaction, never from a stale JS copy.
    const deltas = items.map((item) => {
      const existing = sql`SELECT ${usageRecords.quantity} AS q, ${usageRecords.amountMicros} AS a
        FROM ${usageRecords} WHERE ${usageRecords.instanceId} = ${inst.id}
        AND ${usageRecords.item} = ${item} AND ${usageRecords.day} = ${day}
        AND ${usageRecords.unitPriceMicros} = ${price[item]} AND ${usageRecords.unitCostMicros} = ${cost[item]}`;
      return sql`(round((coalesce((SELECT q FROM (${existing})), 0) + ${quantities[item]}) * ${price[item]})
        - coalesce((SELECT a FROM (${existing})), 0))`;
    });
    const debit = deltas.length ? sql.join(deltas, sql` + `) : sql`0`;
    if (prepaid && items.length) {
      stmts.push(db.insert(billingAccounts).select(sql`SELECT ${inst.userId}, -(${debit}), NULL, NULL, NULL, NULL, NULL, ${now.getTime()} WHERE ${claim}`)
        .onConflictDoUpdate({ target: billingAccounts.userId, set: {
          balanceMicros: sql`${billingAccounts.balanceMicros} + excluded.balance_micros`, updatedAt: now,
        } }));
    }
    for (const item of items) {
      const q = quantities[item];
      stmts.push(db.insert(usageRecords).select(sql`SELECT ${inst.id}, ${inst.userId}, ${inst.regionId}, ${item}, ${day}, ${price[item]}, ${cost[item]},
          ${q}, round(${q} * ${price[item]}), round(${q} * ${cost[item]}), ${prepaid ? Math.round(q * price[item]) : 0}, ${now.getTime()} WHERE ${claim}`)
        .onConflictDoUpdate({
          target: [usageRecords.instanceId, usageRecords.item, usageRecords.day, usageRecords.unitPriceMicros, usageRecords.unitCostMicros],
          set: {
            chargedMicros: sql`${usageRecords.chargedMicros} + ${prepaid ? sql`round((${usageRecords.quantity} + excluded.quantity) * ${usageRecords.unitPriceMicros}) - ${usageRecords.amountMicros}` : sql`0`}`,
            quantity: sql`${usageRecords.quantity} + excluded.quantity`,
            amountMicros: sql`round((${usageRecords.quantity} + excluded.quantity) * ${usageRecords.unitPriceMicros})`,
            costMicros: sql`round((${usageRecords.quantity} + excluded.quantity) * ${usageRecords.unitCostMicros})`,
            updatedAt: now,
          },
        }));
    }

    if (inst.trialState === 'active' && computeHours > 0) {
      const seconds = Math.round(computeHours * 3600);
      stmts.push(db.update(browserInstances).set({
        trialUsedS: sql`${browserInstances.trialUsedS} + ${seconds}`,
        trialState: sql`CASE WHEN ${browserInstances.trialUsedS} + ${seconds} >= ${TRIAL.runningSeconds} THEN 'ended' ELSE 'active' END`,
        updatedAt: now,
      }).where(and(eq(browserInstances.id, inst.id), eq(browserInstances.trialState, 'active'), claim)));
    }
    stmts.push(db.update(instanceHealth)
      .set({ baseMeteredAt: now, meteredAt: running ? now : null, ...(tx !== null ? { netTxBilledBytes: tx } : {}) })
      .where(and(eq(instanceHealth.instanceId, inst.id), claim))
      .returning({ id: instanceHealth.instanceId }));
    stmts.push(charged());
    const results = await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    const claimed = results.at(-2) as { id: string }[];
    if (claimed.length) {
      summary.metered++;
      summary.chargedMicros += Number((results.at(-1) as { amount: number }[])[0]!.amount) - Number((results[0] as { amount: number }[])[0]!.amount);
    }
  }

  summary.stopped = await enforce(deps, prepaid, now);
  return summary;
}

/** Sleeps what may not run: suspended browsers, frozen accounts, and balances that ran out 10 minutes ago. */
async function enforce(deps: EngineDeps, prepaid: boolean, now: Date): Promise<number> {
  const { db } = deps;
  let stopped = 0;

  if (prepaid) {
    // Start (or clear) the clock of balances that ran out; it drives the 10-minute warning and the 30-day deletion.
    const ranOut = await db
      .update(billingAccounts)
      .set({ exhaustedAt: now })
      .where(
        and(
          lte(billingAccounts.balanceMicros, 0),
          isNull(billingAccounts.exhaustedAt),
          // Only browsers that are paid for can run out; a free trial alone never does.
          sql`EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.userId} = ${billingAccounts.userId} AND ${browserInstances.status} NOT IN ('deleting', 'purged', 'failed') AND (${browserInstances.trialState} IS NULL OR ${browserInstances.trialState} = 'converted'))`,
        ),
      )
      .returning({ userId: billingAccounts.userId });
    const toppedUp = await db
      .update(billingAccounts)
      .set({ exhaustedAt: null })
      .where(and(gt(billingAccounts.balanceMicros, 0), isNotNull(billingAccounts.exhaustedAt)))
      .returning({ userId: billingAccounts.userId });
    const changed = [...ranOut, ...toppedUp].map((r) => r.userId);
    if (changed.length) {
      await db.insert(events).values(changed.map((u) => eventRow(u, 'entitlements.updated', { balance: true }, now)));
      for (const u of changed) deps.notify(u);
    }
  }

  const running = await db
    .select({
      id: browserInstances.id,
      userId: browserInstances.userId,
      status: browserInstances.status,
      suspendedAt: browserInstances.suspendedAt,
      trialState: browserInstances.trialState,
    })
    .from(browserInstances)
    .where(inArray(browserInstances.status, RUNNING));
  if (!running.length) return 0;
  const busy = new Set(
    (await db.select({ id: operations.instanceId }).from(operations).where(sql`${operations.finishedAt} IS NULL`)).map((r) => r.id),
  );
  const users = [...new Set(running.map((r) => r.userId))];
  const accounts = new Map((await db.select().from(billingAccounts).where(inArray(billingAccounts.userId, users))).map((a) => [a.userId, a]));

  for (const userId of users) {
    const stoppable = running.filter((r) => r.userId === userId && r.status === 'running' && !busy.has(r.id));
    // A trial stop can race with another operation. Retry it every tick until it is asleep.
    for (const r of stoppable.filter((x) => x.trialState === 'ended')) if (await requestStop(deps, r, 'trial')) stopped++;
    // Suspended by an operator (abuse kill switch, page 10): sleep now.
    for (const r of stoppable.filter((x) => x.suspendedAt)) if (await requestStop(deps, r, 'suspended')) stopped++;

    const account = accounts.get(userId);
    let reason: string | null = null;
    if (account?.frozenAt) reason = 'frozen';
    else if (prepaid && account?.exhaustedAt && now.getTime() - account.exhaustedAt.getTime() >= BALANCE_GRACE_MS) reason = 'balance';
    // An operator can stop a user's browsers by setting their `running` cap to 0.
    else if (((await userCaps(db, userId)).get('running') ?? 0) === 0) reason = 'plan';
    // A free trial browser is not paid from the balance; it stops when its own minutes are used.
    const paid = (x: (typeof stoppable)[number]) => reason !== 'balance' || x.trialState === null || x.trialState === 'converted';
    if (reason) for (const r of stoppable.filter((x) => !x.suspendedAt && paid(x))) if (await requestStop(deps, r, reason)) stopped++;
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
