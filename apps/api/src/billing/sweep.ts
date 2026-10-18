/**
 * The api Worker's billing cron (every 5 minutes; page 6):
 *  - processes webhook events whose queue message was lost or failed;
 *  - refreshes the top-up products from Creem once an hour;
 *  - emails once when a balance falls below the low-balance threshold;
 *  - after a balance ran out: emails on day 1, 14 and 28, then deletes the browsers on day 30
 *    (soft delete, so they stay restorable for 7 more days, then purge releases data and IPs);
 *  - once a night, credits top-ups whose webhook never arrived (Creem's checkout is re-read).
 */
import { BALANCE_GRACE_MS, DATA_KEPT_DAYS } from '@cloudbrowser/contracts';
import { billingRequired, pricingSettings, schema, type Db } from '@cloudbrowser/db';
import { and, eq, gte, isNotNull, isNull, like, lte, notInArray, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { systemOperation } from '../ops.js';
import type { Creem } from './creem.js';
import { notifyHub, refreshTopupPacks } from './ledger.js';
import { creditCheckout, pendingWebhooks, processWebhook } from './webhooks.js';

const { billingAccounts, auditLog, browserInstances, user, topupCheckouts, topupPacks } = schema;
const DAY = 86_400_000;
const NOTICE_DAYS = [1, 14, 28];

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
      .where(and(gte(billingAccounts.balanceMicros, 1), lte(billingAccounts.balanceMicros, lowBalanceMicros), isNull(billingAccounts.lowNotifiedAt)));
    for (const a of low) {
      await sendEmail(env, db, a.userId, 'low');
      await db.update(billingAccounts).set({ lowNotifiedAt: now }).where(eq(billingAccounts.userId, a.userId));
      summary.lowBalance++;
    }
    await db
      .update(billingAccounts)
      .set({ lowNotifiedAt: null })
      .where(and(isNotNull(billingAccounts.lowNotifiedAt), sql`${billingAccounts.balanceMicros} > ${lowBalanceMicros}`));

    // Balance ran out: notices, then deletion after 30 days.
    const out = await db.select().from(billingAccounts).where(and(isNotNull(billingAccounts.exhaustedAt), lte(billingAccounts.balanceMicros, 0)));
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
      if (days >= DATA_KEPT_DAYS) summary.deleted += await deleteBrowsers(env, db, a.userId, now);
    }
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
  const minutes = Math.round(BALANCE_GRACE_MS / 60_000);
  const message =
    kind === 'low'
      ? {
          subject: 'Your CloudBrowser balance is low',
          text:
            `Your prepaid balance is running low. When it reaches zero, running browsers go to sleep ${minutes} minutes later. Add credit: ${url}\n\n` +
            `你的预付余额即将用完。余额为零后，运行中的浏览器会在 ${minutes} 分钟后进入休眠。充值：${url}`,
        }
      : {
          subject: (day ?? 0) >= 28 ? 'Your CloudBrowser browsers will be deleted soon' : 'Your CloudBrowser balance has run out',
          text:
            `Your prepaid balance has run out, so your browsers are asleep. Their dedicated IPs and storage are still charged, and they are kept until ${date}; ` +
            `after that they are deleted and the IPs are released. Add credit to keep them: ${url}\n\n` +
            `你的预付余额已用完，浏览器已进入休眠。专属 IP 和存储仍会计费，数据将保留到 ${date}，之后会被删除并释放 IP。充值即可保留：${url}`,
        };
  try {
    await env.EMAIL.send({ from: { email: env.EMAIL_FROM ?? 'no-reply@example.com', name: 'CloudBrowser' }, to: u.email, ...message });
  } catch (e) {
    console.error('billing email failed', userId, e);
  }
}

/** Soft-deletes every browser of a user whose balance ran out 30 days ago (page 6). */
async function deleteBrowsers(env: Env, db: Db, userId: string, now: Date): Promise<number> {
  const live = await db
    .select({ id: browserInstances.id })
    .from(browserInstances)
    .where(and(eq(browserInstances.userId, userId), notInArray(browserInstances.status, ['deleting', 'purged', 'failed'])));
  let n = 0;
  for (const inst of live) {
    try {
      await systemOperation(
        env,
        db,
        {
          instanceId: inst.id,
          userId,
          kind: 'delete',
          actor: 'billing',
          params: { reason: 'billing' },
          before: [db.update(browserInstances).set({ desiredState: 'deleted', updatedAt: now }).where(eq(browserInstances.id, inst.id))],
        },
        now,
      );
      n++;
    } catch {
      // Another operation is running for it (one unfinished operation per browser); the next sweep tries again.
    }
  }
  if (n) await notifyHub(env, userId);
  return n;
}
