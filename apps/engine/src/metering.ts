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
import { billingRequired, eventRow, operationRow, priceSheets, pricingSettings, schema, usageDay, userCaps } from '@cloudbrowser/db';
import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { EngineDeps } from './context.js';
import { requestStop } from './scheduler.js';

const { browserInstances, instanceHealth, operations, events, usageRecords, billingAccounts, backups } = schema;

/** A missed cron run is not billed beyond this. */
const MAX_METER_STEP_MS = 5 * 60_000;
/** States in which a browser holds its IP and volume and is charged for them. */
const NOT_BILLED = ['creating', 'failed', 'deleting', 'purged'];
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
  const ids = rows.map((r) => r.inst.id);
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
  const today = ids.length ? await db.select().from(usageRecords).where(and(eq(usageRecords.day, day), inArray(usageRecords.instanceId, ids))) : [];
  const keyOf = (r: { instanceId: string; item: string; unitPriceMicros: number; unitCostMicros: number }) =>
    `${r.instanceId}|${r.item}|${r.unitPriceMicros}|${r.unitCostMicros}`;
  const existing = new Map(today.map((r) => [keyOf(r), r]));

  const debits = new Map<string, number>();
  for (const { inst, health } of rows) {
    const running = inst.status === 'running';
    const step = (from: Date | null | undefined) => Math.max(0, Math.min(MAX_METER_STEP_MS, now.getTime() - (from?.getTime() ?? now.getTime()))) / 3_600_000;
    const baseHours = step(health?.baseMeteredAt);
    const computeHours = running ? step(health?.meteredAt) : 0;
    const tx = health?.netTxBytes ?? null;
    const billedTx = health?.netTxBilledBytes ?? null;
    // The counter restarts at each boot: a lower value than last billed is all new traffic.
    const txBytes = tx === null || billedTx === null ? 0 : tx >= billedTx ? tx - billedTx : tx;

    // Claim this minute for the browser, so an overlapping run cannot bill it twice.
    if (!health) await db.insert(instanceHealth).values({ instanceId: inst.id }).onConflictDoNothing();
    const claimed = await db
      .update(instanceHealth)
      .set({ baseMeteredAt: now, meteredAt: running ? now : null, ...(tx !== null ? { netTxBilledBytes: tx } : {}) })
      .where(
        and(
          eq(instanceHealth.instanceId, inst.id),
          health?.baseMeteredAt ? eq(instanceHealth.baseMeteredAt, health.baseMeteredAt) : isNull(instanceHealth.baseMeteredAt),
        ),
      )
      .returning({ id: instanceHealth.instanceId });
    if (!claimed.length) continue;
    summary.metered++;

    const trial = inst.trialState === 'active' || inst.trialState === 'ended';
    if (inst.trialState === 'active' && computeHours > 0) {
      const used = inst.trialUsedS + Math.round(computeHours * 3600);
      const over = used >= TRIAL.runningSeconds;
      await db
        .update(browserInstances)
        .set({ trialUsedS: used, ...(over ? { trialState: 'ended', updatedAt: now } : {}) })
        .where(eq(browserInstances.id, inst.id));
      if (over) {
        await db.insert(events).values(eventRow(inst.userId, 'instance.updated', { instanceId: inst.id }, now));
        if (await requestStop(deps, inst, 'trial')) summary.stopped++;
      }
    }

    const priced = sheets.get(inst.regionId);
    // Without prices for the region nothing is charged (an alert is raised by the price refresh).
    if (!priced) continue;
    const cost = costRates(priced.sheet);
    const free: Rates = { compute: 0, ip: 0, storage: 0, snapshot: 0, transfer: 0 };
    const price = trial ? free : customerRates(priced.sheet, markupPercent);
    const quantities: Record<UsageItem, number> = {
      compute: computeHours,
      ip: baseHours,
      storage: ((inst.storageGb + priced.sheet.rootVolumeGb) * baseHours) / HOURS_PER_MONTH,
      snapshot: inst.backupsEnabled && withSnapshots.has(inst.id) ? (inst.storageGb * baseHours) / HOURS_PER_MONTH : 0,
      transfer: txBytes / BYTES_PER_GB,
    };

    const stmts: BatchItem<'sqlite'>[] = [];
    let debit = 0;
    for (const item of Object.keys(quantities) as UsageItem[]) {
      const q = quantities[item];
      if (q <= 0) continue;
      const key = { instanceId: inst.id, item, unitPriceMicros: price[item], unitCostMicros: cost[item] };
      const prev = existing.get(keyOf(key));
      const quantity = (prev?.quantity ?? 0) + q;
      const amountMicros = Math.round(quantity * price[item]);
      const costMicros = Math.round(quantity * cost[item]);
      debit += amountMicros - (prev?.amountMicros ?? 0);
      const row = { ...key, userId: inst.userId, regionId: inst.regionId, day, quantity, amountMicros, costMicros, updatedAt: now };
      existing.set(keyOf(key), row);
      stmts.push(
        db
          .insert(usageRecords)
          .values(row)
          .onConflictDoUpdate({
            target: [usageRecords.instanceId, usageRecords.item, usageRecords.day, usageRecords.unitPriceMicros, usageRecords.unitCostMicros],
            set: { quantity, amountMicros, costMicros, updatedAt: now },
          }),
      );
    }
    if (prepaid && debit !== 0) {
      stmts.push(
        db
          .insert(billingAccounts)
          .values({ userId: inst.userId, balanceMicros: -debit, updatedAt: now })
          .onConflictDoUpdate({ target: billingAccounts.userId, set: { balanceMicros: sql`${billingAccounts.balanceMicros} - ${debit}`, updatedAt: now } }),
      );
      debits.set(inst.userId, (debits.get(inst.userId) ?? 0) + debit);
    }
    if (stmts.length) await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    summary.chargedMicros += debit;
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
      await db.batch([
        db.insert(operations).values(row),
        db.update(browserInstances).set({ desiredState: 'deleted', updatedAt: now }).where(eq(browserInstances.id, inst.id)),
        db.insert(events).values(eventRow(inst.userId, 'operation.updated', { operationId: row.id, instanceId: inst.id }, now)),
      ]);
      deps.notify(inst.userId);
      n++;
    } catch {
      // Another operation is running for it; the next minute tries again.
    }
  }
  return n;
}
