/**
 * The api Worker's billing cron (every 5 minutes; page 6):
 *  - processes webhook events whose queue message was lost or failed;
 *  - refreshes the top-up products from Creem once an hour;
 *  - emails once when a balance falls below the low-balance threshold;
 *  - after usable credit runs out: sends retention notices, then permanently deletes each browser
 *    at its seven-day reservation deadline; unused held credit is released;
 *  - once a night, credits top-ups whose webhook never arrived (Creem's checkout is re-read).
 */
import { DATA_KEPT_DAYS } from '@cloudbrowser/contracts';
import { billingRequired, operationRow, pricingSettings, reservedTotalSql, schema, type Db } from '@cloudbrowser/db';
import { and, eq, gte, isNotNull, isNull, like, lte, notInArray, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { Creem } from './creem.js';
import { notifyHub, refreshTopupPacks } from './ledger.js';
import { creditCheckout, pendingWebhooks, processWebhook } from './webhooks.js';

const { billingAccounts, auditLog, browserInstances, user, topupCheckouts, topupPacks, operations, events, browserReservations } = schema;
const DAY = 86_400_000;
const NOTICE_DAYS = [0, 3, 6];

export async function billingSweep(env: Env, db: Db, creem: Creem | null, now: Date, opts: { nightly: boolean }) {
  const summary = { webhooks: 0, packs: 0, lowBalance: 0, notices: 0, deleted: 0, credited: 0 };
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
    const { lowBalanceMicros } = await pricingSettings(db);
    // Low balance: one email per dip below the threshold.
    const low = await db
      .select()
      .from(billingAccounts)
      .where(and(sql`${billingAccounts.balanceMicros} - coalesce((SELECT sum(reserved_micros) FROM browser_reservations WHERE user_id = ${billingAccounts.userId}),0) BETWEEN 1 AND ${lowBalanceMicros}`, isNull(billingAccounts.lowNotifiedAt)));
    for (const a of low) {
      await sendEmail(env, db, a.userId, 'low');
      await db.update(billingAccounts).set({ lowNotifiedAt: now }).where(eq(billingAccounts.userId, a.userId));
      summary.lowBalance++;
    }
    await db
      .update(billingAccounts)
      .set({ lowNotifiedAt: null })
      .where(and(isNotNull(billingAccounts.lowNotifiedAt), sql`${billingAccounts.balanceMicros} - coalesce((SELECT sum(reserved_micros) FROM browser_reservations WHERE user_id = ${billingAccounts.userId}),0) > ${lowBalanceMicros}`));

    // Usable credit ran out: notices during the seven-day retention period.
    const out = await db.select().from(billingAccounts).where(isNotNull(billingAccounts.exhaustedAt));
    for (const a of out) {
      const endedAt = a.exhaustedAt!.getTime();
      const days = Math.floor((now.getTime() - endedAt) / DAY);
      const sent = await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.target, `user:${a.userId}`), like(auditLog.action, 'billing.notice.%')));
      const sentFor = (d: number) => sent.some((r) => r.action === `billing.notice.d${d}.${endedAt}`);
      for (const d of NOTICE_DAYS) {
        if (days >= d && !sentFor(d) && days < DATA_KEPT_DAYS && (await holdsBrowsers(db, a.userId))) {
          await sendEmail(env, db, a.userId, 'ended', new Date(endedAt + DATA_KEPT_DAYS * DAY), d);
          await db.insert(auditLog).values({ actor: 'billing', action: `billing.notice.d${d}.${endedAt}`, target: `user:${a.userId}`, createdAt: now });
          summary.notices++;
          break; // one email per sweep
        }
      }
    }
  }

  if (await billingRequired(db)) {
    const due = await db.selectDistinct({ userId: browserReservations.userId }).from(browserReservations).where(lte(browserReservations.retentionEndsAt, now));
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

async function holdsBrowsers(db: Db, userId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(browserInstances)
    .where(and(eq(browserInstances.userId, userId), notInArray(browserInstances.status, ['deleting', 'purged', 'failed'])));
  return Number(row?.n ?? 0) > 0;
}

async function sendEmail(env: Env, db: Db, userId: string, kind: 'low' | 'ended', deleteOn?: Date, day?: number) {
  const [u] = await db.select().from(user).where(eq(user.id, userId));
  if (!u || !env.EMAIL) return;
  const url = `${env.APP_URL}/billing`;
  const date = deleteOn?.toISOString().slice(0, 10) ?? '';
  const message =
    kind === 'low'
      ? {
          subject: 'Your CloudBrowser balance is low',
          text:
            `Your prepaid balance is running low. When available credit is used up, browser access stops immediately. Your held deposit then pays fixed IP and disk costs for seven days. Add credit: ${url}\n\n` +
            `你的预付余额即将用完。可用余额不足时立即停止使用，已预留余额仅支付接下来七天的 IP 和磁盘保留费。充值：${url}`,
        }
      : {
          subject: (day ?? 0) >= 6 ? 'Your CloudBrowser browsers will be deleted soon' : 'Your CloudBrowser balance has run out',
          text:
            `Your prepaid balance has run out, so your browsers are asleep. Their reserved credit pays only fixed IP and disk retention costs, and they are kept until ${date}; ` +
            `after that they are deleted and the IPs are released. Add credit to keep them: ${url}\n\n` +
            `你的预付余额已用完，浏览器已进入休眠。预留余额仅支付 IP 和磁盘保留费，数据将保留到 ${date}，之后会被删除并释放 IP。充值即可保留：${url}`,
        };
  try {
    await env.EMAIL.send({ from: { email: env.EMAIL_FROM ?? 'no-reply@example.com', name: 'CloudBrowser' }, to: u.email, ...message });
  } catch (e) {
    console.error('billing email failed', userId, e);
  }
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
      // restores its deposit and cancels expiry even if this sweep selected it earlier.
      const eligible = sql`EXISTS (SELECT 1 FROM ${browserReservations} WHERE ${browserReservations.instanceId} = ${inst.id}
        AND ${browserReservations.retentionStartedAt} IS NOT NULL AND ${browserReservations.retentionEndsAt} <= ${now.getTime()})
        AND EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.id} = ${inst.id} AND ${browserInstances.status} NOT IN ('deleting', 'purged', 'failed'))`;
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
