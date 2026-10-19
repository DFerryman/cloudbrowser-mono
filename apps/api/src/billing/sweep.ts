/**
 * The api Worker's billing cron (every 5 minutes; page 6):
 *  - processes webhook events whose queue message was lost or failed;
 *  - refreshes the top-up products from Creem once an hour;
 *  - warns once each as available credit falls below 24, 6 and 1 hours of the account's combined
 *    spending, and once when it falls below the low-balance threshold (unless a funded-time
 *    warning already went out);
 *  - after usable credit runs out: names the stopped browsers and their deletion time, reminds a
 *    day before deletion, then permanently deletes each browser at its seven-day reservation
 *    deadline; unused held credit is released;
 *  - emails the notices the engine queues (unexpected stops, paused networks);
 *  - once a night, credits top-ups whose webhook never arrived (Creem's checkout is re-read).
 */
import { DATA_KEPT_DAYS, MICROS_PER_USD, RUNWAY_WARNING_HOURS } from '@cloudbrowser/contracts';
import { accountRunway, billingRequired, operationRow, pricingSettings, schema, type Db } from '@cloudbrowser/db';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { Creem } from './creem.js';
import { notifyHub, refreshTopupPacks } from './ledger.js';
import { retentionState } from './retention.js';
import { creditCheckout, pendingWebhooks, processWebhook } from './webhooks.js';

const { billingAccounts, auditLog, browserInstances, user, topupCheckouts, topupPacks, operations, events, browserReservations, regions, userNotices } = schema;
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A warning is re-armed once funded time is this much above its threshold again (no flapping). */
const REARM_FACTOR = 1.25;

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
    const { lowBalanceMicros } = await pricingSettings(db);
    // Low balance: one email per dip below the threshold, unless a funded-time warning already said more.
    const low = await db
      .select()
      .from(billingAccounts)
      .where(and(sql`${billingAccounts.balanceMicros} - coalesce((SELECT sum(reserved_micros) FROM browser_reservations WHERE user_id = ${billingAccounts.userId}),0) BETWEEN 1 AND ${lowBalanceMicros}`,
        isNull(billingAccounts.lowNotifiedAt), isNull(billingAccounts.runwayWarnedHours)));
    for (const a of low) {
      await sendEmail(env, db, a.userId, lowBalanceMessage(`${env.APP_URL}/billing`));
      await db.update(billingAccounts).set({ lowNotifiedAt: now }).where(eq(billingAccounts.userId, a.userId));
      summary.lowBalance++;
    }
    await db
      .update(billingAccounts)
      .set({ lowNotifiedAt: null })
      .where(and(isNotNull(billingAccounts.lowNotifiedAt), sql`${billingAccounts.balanceMicros} - coalesce((SELECT sum(reserved_micros) FROM browser_reservations WHERE user_id = ${billingAccounts.userId}),0) > ${lowBalanceMicros}`));

    // Usable credit ran out: name the stopped browsers and their deletion time when it happens,
    // again after three days, and a final reminder a day before deletion.
    const out = await db.select().from(billingAccounts).where(isNotNull(billingAccounts.exhaustedAt));
    for (const a of out) {
      const endedAt = a.exhaustedAt!.getTime();
      const retention = await retentionState(db, a.userId);
      const first = retention.retained[0];
      if (!first || first.deletesAt.getTime() <= now.getTime()) continue;
      const stage = now.getTime() >= first.deletesAt.getTime() - DAY ? 'final' : now.getTime() - endedAt >= 3 * DAY ? 'd3' : 'd0';
      const action = `billing.notice.${stage}.${endedAt}`;
      const [sent] = await db.select({ id: auditLog.id }).from(auditLog)
        .where(and(eq(auditLog.target, `user:${a.userId}`), eq(auditLog.action, action))).limit(1);
      if (sent) continue;
      await sendEmail(env, db, a.userId, await retentionMessage(db, retention, stage, `${env.APP_URL}/billing`));
      await db.insert(auditLog).values({ actor: 'billing', action, target: `user:${a.userId}`, createdAt: now });
      summary.notices++;
    }
  }

  summary.userNotices = await sendUserNotices(env, db, now);

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

type Message = { subject: string; text: string };

const usd = (micros: number) => `$${(micros / MICROS_PER_USD).toFixed(2)}`;
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
function duration(hours: number, zh = false) {
  if (hours < 1) return zh ? `${Math.max(1, Math.round(hours * 60))} 分钟` : `${Math.max(1, Math.round(hours * 60))} minutes`;
  const n = Math.floor(hours);
  return zh ? `${n} 小时` : `${n} hour${n === 1 ? '' : 's'}`;
}

/**
 * Funded-time warnings at 24, 6 and 1 hours of the account's combined spending (page 6). Each is
 * sent once while credit keeps falling. A warning re-arms only when funded time is clearly above
 * its threshold again, so a browser starting and stopping near a threshold does not repeat it.
 */
async function runwayWarnings(env: Env, db: Db, now: Date): Promise<number> {
  const accounts = await db.select({ userId: billingAccounts.userId, warned: billingAccounts.runwayWarnedHours }).from(billingAccounts)
    .where(and(isNull(billingAccounts.exhaustedAt), isNull(billingAccounts.frozenAt),
      sql`(${billingAccounts.runwayWarnedHours} IS NOT NULL OR EXISTS (SELECT 1 FROM browser_instances b WHERE b.user_id = ${billingAccounts.userId}
        AND (b.trial_state IS NULL OR b.trial_state = 'converted') AND b.status NOT IN ('deleting', 'purged', 'failed')))`));
  const thresholds = [...RUNWAY_WARNING_HOURS].sort((a, b) => a - b);
  let sent = 0;
  for (const a of accounts) {
    const runway = await accountRunway(db, a.userId, now);
    const hours = runway.fundedUntil ? (runway.fundedUntil.getTime() - now.getTime()) / HOUR : Infinity;
    let warned = a.warned;
    while (warned !== null && hours >= warned * REARM_FACTOR) warned = thresholds.find((t) => t > warned!) ?? null;
    const due = thresholds.find((t) => hours < t);
    if (due !== undefined && (warned === null || due < warned)) {
      await sendEmail(env, db, a.userId, runwayMessage(due, hours, runway, `${env.APP_URL}/billing`));
      warned = due;
      sent++;
    }
    if (warned !== a.warned) await db.update(billingAccounts).set({ runwayWarnedHours: warned }).where(eq(billingAccounts.userId, a.userId));
  }
  return sent;
}

function runwayMessage(due: number, hours: number, runway: { availableMicros: number; burnHourMicros: number; fundedUntil: Date | null }, url: string): Message {
  const until = runway.fundedUntil ? ` (until ${utc(runway.fundedUntil)})` : '';
  const untilZh = runway.fundedUntil ? `（至 ${utc(runway.fundedUntil)}）` : '';
  return {
    subject: due === 1 ? 'Your Nevazu credit runs out within an hour' : `Your Nevazu credit lasts less than ${due} hours`,
    text:
      `At your current spending of ${usd(runway.burnHourMicros)} per hour across your browsers, your available credit of ${usd(runway.availableMicros)} lasts about ${duration(hours)}${until}. ` +
      `When it runs out, every paid browser stops at once, including browsers set to Never sleep. They are kept for ${DATA_KEPT_DAYS} days and then deleted unless you add credit. Add credit: ${url}\n\n` +
      `按你所有浏览器目前每小时 ${usd(runway.burnHourMicros)} 的花费，可用余额 ${usd(runway.availableMicros)} 约可使用 ${duration(hours, true)}${untilZh}。` +
      `余额用完时，所有付费浏览器会立即停止（包括设为“永不休眠”的浏览器），保留 ${DATA_KEPT_DAYS} 天后若仍未充值将被删除。充值：${url}`,
  };
}

function lowBalanceMessage(url: string): Message {
  return {
    subject: 'Your Nevazu balance is low',
    text:
      `Your prepaid balance is running low. When available credit is used up, browser access stops immediately. Your held deposit then pays fixed IP and disk costs for seven days. Add credit: ${url}\n\n` +
      `你的预付余额即将用完。可用余额不足时立即停止使用，已预留余额仅支付接下来七天的 IP 和磁盘保留费。充值：${url}`,
  };
}

/** Names every kept browser and its deletion time, and the exact top-up that keeps all of them. */
async function retentionMessage(db: Db, r: Awaited<ReturnType<typeof retentionState>>, stage: 'd0' | 'd3' | 'final', url: string): Promise<Message> {
  const ids = [...new Set(r.retained.map((b) => b.regionId))];
  const names = new Map((await db.select({ id: regions.id, name: regions.name }).from(regions).where(inArray(regions.id, ids))).map((x) => [x.id, x.name]));
  const lines = r.retained.map((b) => `• ${b.name} (${names.get(b.regionId) ?? b.regionId}): ${utc(b.deletesAt)}`).join('\n');
  const deleteOn = utc(r.retained[0]!.deletesAt);
  const need = usd(r.restoreNeededMicros ?? 0);
  const intro = {
    d0: 'Your available credit ran out, so your paid browsers were stopped. They are kept, with their data and IP addresses, until the time shown for each, and then permanently deleted:',
    d3: 'Your browsers are still stopped because your credit ran out. Unless you add credit, they will be permanently deleted at these times:',
    final: 'This is the last reminder. Unless you add credit, these browsers and their data will be permanently deleted within 24 hours, and their IP addresses released:',
  }[stage];
  const introZh = {
    d0: '你的可用余额已用完，付费浏览器已停止。它们的数据和 IP 会保留到下列时间，之后将被永久删除：',
    d3: '由于余额用完，你的浏览器仍处于停止状态。若不充值，它们将在下列时间被永久删除：',
    final: '最后提醒：若不充值，以下浏览器及其数据将在 24 小时内被永久删除，IP 地址将被释放：',
  }[stage];
  return {
    subject: { d0: 'Your Nevazu credit ran out: your browsers have stopped', d3: `Your Nevazu browsers will be deleted from ${deleteOn}`, final: 'Final reminder: your Nevazu browsers will be deleted within 24 hours' }[stage],
    text:
      `${intro}\n${lines}\n\n` +
      `To keep them, add at least ${need}. Your balance must cover each kept browser's ${DATA_KEPT_DAYS}-day IP and disk deposit (${usd(r.depositsMicros)} in total) plus the ${usd(r.minBalanceMicros)} minimum balance; a smaller top-up is added to your balance but does not stop the deletion. ` +
      `After that, your browsers stay asleep until you open each one: none restarts by itself, so running charges begin again only when you choose. Add credit: ${url}\n\n` +
      `${introZh}\n${lines}\n\n` +
      `如需保留，请至少充值 ${need}。余额需覆盖每个保留浏览器 ${DATA_KEPT_DAYS} 天的 IP 和磁盘预留（共 ${usd(r.depositsMicros)}）以及 ${usd(r.minBalanceMicros)} 最低余额；金额不足时会计入余额，但不会停止删除。` +
      `充值后浏览器仍保持休眠，需要你逐个打开才会恢复，不会自动启动，因此只有在你选择时才会重新开始运行计费。充值：${url}`,
  };
}

/** Emails the notices the engine queued (it has no email binding), oldest first. */
async function sendUserNotices(env: Env, db: Db, now: Date): Promise<number> {
  const pending = await db.select().from(userNotices).where(isNull(userNotices.sentAt)).orderBy(asc(userNotices.createdAt)).limit(50);
  for (const n of pending) {
    const message = noticeMessage(n.kind, n.data, `${env.APP_URL}/browsers${n.instanceId ? `/${n.instanceId}` : ''}`);
    if (message) await sendEmail(env, db, n.userId, message);
    await db.update(userNotices).set({ sentAt: now }).where(eq(userNotices.id, n.id));
  }
  return pending.length;
}

function noticeMessage(kind: string, data: Record<string, unknown>, url: string): Message | null {
  const name = typeof data.name === 'string' ? data.name : 'your browser';
  if (kind === 'network_paused') {
    return {
      subject: `Network paused on your Nevazu browser "${name}"`,
      text:
        `The security check could not confirm that "${name}" uses only its dedicated IP address, so its network was paused to make sure no other address is used. ` +
        `It stays paused until you open the browser and choose Check again; it does not resume by itself. Contact support if this persists: ${url}\n\n` +
        `安全检查未能确认“${name}”只使用其专属 IP，为确保不会使用其他地址，其网络已暂停。网络会一直暂停，直到你打开浏览器并选择“重新检查”，不会自动恢复。如持续出现请联系支持：${url}`,
    };
  }
  if (kind !== 'stopped') return null;
  const why = {
    operator: [`An administrator stopped "${name}".`, `管理员停止了“${name}”。`],
    suspended: [`"${name}" was suspended by an administrator and has stopped. It cannot start until the suspension is lifted; contact support if you did not expect this.`, `“${name}”已被管理员暂停使用并停止，解除暂停前无法启动。如有疑问请联系支持。`],
    frozen: [`Your account is on hold because of a payment dispute, so "${name}" has stopped. Nothing can run until support resolves the hold.`, `由于付款争议，你的账户已被冻结，“${name}”已停止。在支持处理完成前无法运行。`],
  }[data.reason as 'operator' | 'suspended' | 'frozen'];
  if (!why) return null;
  return {
    subject: `Your Nevazu browser "${name}" was stopped`,
    text:
      `${why[0]} It will not restart by itself, even if it was set to Never sleep; open it to resume when you are ready. Its data and IP address are kept. ${url}\n\n` +
      `${why[1]}浏览器不会自动重新启动（即使设为“永不休眠”）；准备好后请打开它以恢复。数据和 IP 均会保留。${url}`,
  };
}

async function sendEmail(env: Env, db: Db, userId: string, message: Message) {
  const [u] = await db.select().from(user).where(eq(user.id, userId));
  if (!u || !env.EMAIL) return;
  try {
    await env.EMAIL.send({ from: { email: env.EMAIL_FROM ?? 'no-reply@example.com', name: 'Nevazu' }, to: u.email, ...message });
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
