/**
 * The api Worker's billing cron (every 5 minutes; page 6):
 *  - processes webhook events whose queue message was lost or failed;
 *  - recomputes entitlements, so a period end or the end of a grace period takes effect;
 *  - after access ends: emails on day 1, 14 and 28, then deletes the browsers on day 30
 *    (soft delete, so they stay restorable for 7 more days, then purge releases data and IPs);
 *  - once a night, re-syncs every subscription from Creem and records any drift.
 */
import { eventRow, operationRow, schema, type Db } from '@cloudbrowser/db';
import { and, eq, like, notInArray } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { Creem } from './creem.js';
import { accessOf, notifyHub, recomputeEntitlements, syncSubscription } from './sync.js';
import { pendingWebhooks, processWebhook } from './webhooks.js';

const { subscriptions, auditLog, browserInstances, operations, events, user } = schema;
const DAY = 86_400_000;
export const DATA_KEPT_DAYS = 30;
const NOTICE_DAYS = [1, 14, 28];

export async function billingSweep(env: Env, db: Db, creem: Creem | null, now: Date, opts: { nightly: boolean }) {
  const summary = { webhooks: 0, recomputed: 0, notices: 0, deleted: 0, drift: 0 };
  if (creem) {
    for (const id of await pendingWebhooks(db, now)) {
      try {
        await processWebhook(env, db, creem, id, now);
        summary.webhooks++;
      } catch (e) {
        console.error('webhook retry failed', id, e);
      }
    }
  }

  const subs = await db.select().from(subscriptions);
  const users = [...new Set(subs.map((s) => s.userId))];
  for (const userId of users) {
    if (await recomputeEntitlements(env, db, userId, now)) {
      summary.recomputed++;
      await notifyHub(env, userId);
    }
  }

  // Users whose access has ended: notices, then deletion after 30 days.
  const fresh = await db.select().from(subscriptions);
  for (const userId of users) {
    const mine = fresh.filter((s) => s.userId === userId);
    if (mine.some((s) => accessOf(s, now) !== 'none')) continue;
    const endedAt = Math.max(...mine.map((s) => s.accessEndedAt?.getTime() ?? 0));
    if (!endedAt) continue;
    const days = Math.floor((now.getTime() - endedAt) / DAY);
    const sent = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.target, `user:${userId}`), like(auditLog.action, 'billing.notice.%')));
    const sentFor = (d: number) => sent.some((r) => r.action === `billing.notice.d${d}.${endedAt}`);
    for (const d of NOTICE_DAYS) {
      if (days >= d && !sentFor(d) && days < DATA_KEPT_DAYS) {
        await sendNotice(env, db, userId, new Date(endedAt + DATA_KEPT_DAYS * DAY), d);
        await db.insert(auditLog).values({ actor: 'billing', action: `billing.notice.d${d}.${endedAt}`, target: `user:${userId}`, createdAt: now });
        summary.notices++;
        break; // one email per sweep
      }
    }
    if (days >= DATA_KEPT_DAYS) summary.deleted += await deleteBrowsers(env, db, userId, now);
  }

  if (opts.nightly && creem) {
    for (const s of fresh) {
      try {
        const before = { status: s.status, units: s.units, plan: s.plan };
        await syncSubscription(env, db, creem, s.id, { userId: s.userId }, now);
        const [after] = await db.select().from(subscriptions).where(eq(subscriptions.id, s.id));
        if (after && (after.status !== before.status || after.units !== before.units || after.plan !== before.plan)) {
          summary.drift++;
          console.error('ALERT: billing drift', s.id, before, { status: after.status, units: after.units, plan: after.plan });
          await db.insert(auditLog).values({
            actor: 'billing',
            action: 'billing.drift',
            target: `user:${s.userId}`,
            detail: { subscriptionId: s.id, before, after: { status: after.status, units: after.units, plan: after.plan } },
            createdAt: now,
          });
        }
      } catch (e) {
        console.error('nightly billing sync failed', s.id, e);
      }
    }
  }
  return summary;
}

async function sendNotice(env: Env, db: Db, userId: string, deleteOn: Date, day: number) {
  const [u] = await db.select().from(user).where(eq(user.id, userId));
  if (!u || !env.EMAIL) return;
  const date = deleteOn.toISOString().slice(0, 10);
  const url = `${env.APP_URL}/settings`;
  try {
    await env.EMAIL.send({
      from: { email: env.EMAIL_FROM ?? 'no-reply@example.com', name: 'CloudBrowser' },
      to: u.email,
      subject: day >= 28 ? 'Your CloudBrowser browsers will be deleted soon' : 'Your CloudBrowser subscription has ended',
      text:
        `Your subscription has ended, so your browsers are asleep. Their data and dedicated IPs are kept until ${date}; ` +
        `after that they are deleted and the IPs are released. Renew to keep them: ${url}\n\n` +
        `你的订阅已结束，浏览器已进入休眠。数据和专属 IP 将保留到 ${date}，之后会被删除并释放 IP。续订即可保留：${url}`,
    });
  } catch (e) {
    console.error('billing notice failed', userId, e);
  }
}

/** Soft-deletes every browser of a user whose access ended 30 days ago (page 6). */
async function deleteBrowsers(env: Env, db: Db, userId: string, now: Date): Promise<number> {
  const live = await db
    .select({ id: browserInstances.id })
    .from(browserInstances)
    .where(and(eq(browserInstances.userId, userId), notInArray(browserInstances.status, ['deleting', 'purged', 'failed'])));
  if (!live.length) return 0;
  let n = 0;
  for (const inst of live) {
    const op = operationRow({ instanceId: inst.id, userId: null, kind: 'delete', params: { reason: 'billing' }, now });
    try {
      await db.batch([
        db.insert(operations).values(op),
        db.update(browserInstances).set({ desiredState: 'deleted', updatedAt: now }).where(eq(browserInstances.id, inst.id)),
        db.insert(events).values(eventRow(userId, 'instance.updated', { instanceId: inst.id, operationId: op.id }, now)),
        db.insert(auditLog).values({ actor: 'billing', action: 'instance.deleted_unpaid', target: `instance:${inst.id}`, createdAt: now }),
      ]);
      await env.OPERATIONS.send({ operationId: op.id }).catch(() => {}); // the engine's sweep is the backstop
      n++;
    } catch {
      // Another operation is running for it (one unfinished operation per browser); the next sweep tries again.
    }
  }
  if (n) await notifyHub(env, userId);
  return n;
}
