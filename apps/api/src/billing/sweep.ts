/**
 * The api Worker's billing cron (every 5 minutes; page 6):
 *  - processes webhook events whose queue message was lost or failed;
 *  - refreshes the top-up products from Creem once an hour;
 *  - sends the credit emails (funded-time and low-balance warnings, credit ran out / deletion
 *    reminders) and the notices the engine queues; see ../notifications/user.ts for each one's rule;
 *  - permanently deletes each browser at its seven-day reservation deadline after usable credit
 *    runs out; unused held credit is released. Never while a dispute hold is on: the clock is
 *    paused until an operator lifts it (unfreezeAccount);
 *  - once a night, credits top-ups whose webhook never arrived (Creem's checkout is re-read).
 */
import { billingRequired, operationRow, schema, type Db } from '@cloudbrowser/db';
import { and, eq, gte, isNotNull, isNull, lte, notInArray, sql, type Column } from 'drizzle-orm';
import type { Env } from '../env.js';
import { lowBalanceNotices, retentionNotices, runwayWarnings, sendUserNotices } from '../notifications/user.js';
import type { Creem } from './creem.js';
import { notifyHub, refreshTopupPacks } from './ledger.js';
import { creditCheckout, pendingWebhooks, processWebhook } from './webhooks.js';

const { auditLog, billingAccounts, browserInstances, topupCheckouts, topupPacks, operations, events, browserReservations } = schema;
const DAY = 86_400_000;
const notFrozen = (userId: Column | string) => sql`NOT EXISTS (SELECT 1 FROM ${billingAccounts} WHERE ${billingAccounts.userId} = ${userId} AND ${billingAccounts.frozenAt} IS NOT NULL)`;

export async function billingSweep(env: Env, db: Db, creem: Creem | null, now: Date, opts: { nightly: boolean }) {
  const summary = { webhooks: 0, packs: 0, runway: 0, lowBalance: 0, notices: 0, deleted: 0, credited: 0, userNotices: 0 };
  if (creem) {
    for (const id of await pendingWebhooks(db, now)) {
      try {
        await processWebhook(env, db, creem, id, now);
        summary.webhooks++;
      } catch (e) {
        console.error('webhook retry failed', id, e);
      }
    }
    const [anyPack] = await db.select({ id: topupPacks.productId }).from(topupPacks).limit(1);
    if (!anyPack || now.getUTCMinutes() < 5) summary.packs = await refreshTopupPacks(db, creem, now);
  }

  if (await billingRequired(db)) {
    summary.runway = await runwayWarnings(env, db, now);
    summary.lowBalance = await lowBalanceNotices(env, db, now);
    summary.notices = await retentionNotices(env, db, now);
  }

  summary.userNotices = await sendUserNotices(env, db, now);

  if (await billingRequired(db)) {
    const due = await db.selectDistinct({ userId: browserReservations.userId }).from(browserReservations)
      .where(and(lte(browserReservations.retentionEndsAt, now), notFrozen(browserReservations.userId)));
    for (const a of due) summary.deleted += await deleteBrowsers(env, db, a.userId, now);
  }

  if (opts.nightly && creem) {
    // Top-ups paid in the last 3 days whose webhook never arrived. Checkouts never opened have no id.
    const open = await db
      .select()
      .from(topupCheckouts)
      .where(and(isNull(topupCheckouts.creditedAt), isNotNull(topupCheckouts.checkoutId), gte(topupCheckouts.createdAt, new Date(now.getTime() - 3 * DAY))));
    for (const c of open) {
      try {
        const userId = await creditCheckout(db, creem, c.checkoutId!, now);
        if (userId) {
          summary.credited++;
          await notifyHub(env, userId);
        }
      } catch (e) {
        console.error('nightly top-up check failed', c.id, e);
      }
    }
  }
  return summary;
}

/** Permanently reclaims browsers whose individual seven-day retention deadline is due. */
async function deleteBrowsers(env: Env, db: Db, userId: string, now: Date): Promise<number> {
  const live = await db
    .select({ id: browserInstances.id })
    .from(browserInstances)
    .where(and(eq(browserInstances.userId, userId), notInArray(browserInstances.status, ['deleting', 'purged', 'failed']),
      sql`EXISTS (SELECT 1 FROM ${browserReservations} WHERE ${browserReservations.instanceId} = ${browserInstances.id} AND ${browserReservations.retentionEndsAt} <= ${now.getTime()} AND ${browserReservations.retentionStartedAt} IS NOT NULL)`));
  let n = 0;
  for (const inst of live) {
    try {
      const op = operationRow({ instanceId: inst.id, userId: null, kind: 'delete', params: { reason: 'billing', purgeNow: true }, now });
      // Recheck the reservation in the deletion transaction. A sufficient concurrent top-up
      // restores its deposit and cancels expiry even if this sweep selected it earlier, and a
      // dispute hold placed meanwhile pauses it.
      const eligible = sql`EXISTS (SELECT 1 FROM ${browserReservations} WHERE ${browserReservations.instanceId} = ${inst.id}
        AND ${browserReservations.retentionStartedAt} IS NOT NULL AND ${browserReservations.retentionEndsAt} <= ${now.getTime()})
        AND EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.id} = ${inst.id} AND ${browserInstances.status} NOT IN ('deleting', 'purged', 'failed'))
        AND ${notFrozen(userId)}`;
      const exists = sql`EXISTS (SELECT 1 FROM ${operations} WHERE ${operations.id} = ${op.id})`;
      const [inserted] = await db.batch([
        db.insert(operations).select(sql`SELECT ${op.id}, ${inst.id}, NULL, 'delete', 'queued', NULL, 0, NULL, NULL, NULL,
          ${op.deadlineAt.getTime()}, NULL, NULL, ${JSON.stringify(op.params)}, ${now.getTime()}, ${now.getTime()}, NULL WHERE ${eligible}`)
          .returning({ id: operations.id }),
        db.update(browserInstances).set({ desiredState: 'deleted', updatedAt: now }).where(and(eq(browserInstances.id, inst.id), exists)),
        db.update(browserReservations).set({ reservedMicros: 0, updatedAt: now }).where(and(eq(browserReservations.instanceId, inst.id), exists)),
        db.insert(events).select(sql`SELECT NULL, ${userId}, 'instance.updated', ${JSON.stringify({ instanceId: inst.id, operationId: op.id })}, ${now.getTime()} WHERE ${exists}`),
        db.insert(auditLog).select(sql`SELECT NULL, 'billing', 'operation.delete', ${`instance:${inst.id}`}, ${JSON.stringify({ operationId: op.id, reason: 'billing' })}, ${now.getTime()} WHERE ${exists}`),
      ]);
      if (inserted.length) {
        n++;
        await env.OPERATIONS.send({ operationId: op.id }).catch((e) => console.error('billing delete enqueue failed', op.id, e));
      }
    } catch {
      // Another operation is running for it (one unfinished operation per browser); the next sweep tries again.
    }
  }
  if (n) await notifyHub(env, userId);
  return n;
}
