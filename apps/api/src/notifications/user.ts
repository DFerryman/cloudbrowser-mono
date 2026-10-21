/**
 * User-facing notifications: emails about the user's own account. Sent by the api's 5-minute cron
 * (sign-in codes are sent on request). Every email has a rule that keeps it from repeating:
 *
 * | Email                         | When                                              | How often at most                                      |
 * |-------------------------------|---------------------------------------------------|--------------------------------------------------------|
 * | Sign-in code                  | The user asks for one                             | Rate limited per IP and address (AUTH_LIMITER)         |
 * | Registration link / already registered | Sign-up, or sign-in for an address with no account | Rate limited per IP and address (AUTH_LIMITER)  |
 * | Credit lasts < 24 / 6 / 1 h   | Funded time at current spending crosses each mark | Once per mark while credit keeps falling; re-armed 25% above it |
 * | Low balance                   | Available credit drops below the console's threshold | Once per dip, and no sooner than LOW_BALANCE_COOLDOWN_MS after the last one; skipped when a funded-time warning already went out |
 * | Credit ran out / browsers will be deleted | Usable credit is gone            | Three in total: when it happens, after 3 days, 1 day before deletion |
 * | Browser stopped / network paused | The engine stopped a browser or paused its network | Once per event (the engine's notice id) |
 * | Reward credited               | A promotion's reward reached the balance          | One email for all rewards credited together, at most one per REWARD_COOLDOWN_MS |
 *
 * Security, credit-exhaustion and browser notices are never held back: they are rare and the user
 * must act on them. Only the advisory ones (low balance, rewards) have a cooldown.
 */
import { DATA_KEPT_DAYS, MICROS_PER_USD, RUNWAY_WARNING_HOURS } from '@cloudbrowser/contracts';
import { accountRunway, pricingSettings, schema, type Db } from '@cloudbrowser/db';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { retentionState } from '../billing/retention.js';
import { cooledDown, sendTo, sendToUser, setState, type Message } from './send.js';

const { billingAccounts, auditLog, regions, userNotices, promotionCompletions, promotionTasks } = schema;
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A funded-time warning is re-armed once funded time is this much above its threshold again (no flapping). */
const REARM_FACTOR = 1.25;
/** A balance hovering around the threshold (small top-ups, a browser starting and stopping) emails once in this time. */
export const LOW_BALANCE_COOLDOWN_MS = 3 * DAY;
/** Rewards credited within this time of the last reward email wait and go out together in the next one. */
export const REWARD_COOLDOWN_MS = DAY;
/** Rewards earned close together (several tasks finished at once) are collected for this long first. */
export const REWARD_BATCH_MS = 10 * 60_000;

const usd = (micros: number) => `$${(micros / MICROS_PER_USD).toFixed(2)}`;
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
function duration(hours: number, zh = false) {
  if (hours < 1) return zh ? `${Math.max(1, Math.round(hours * 60))} 分钟` : `${Math.max(1, Math.round(hours * 60))} minutes`;
  const n = Math.floor(hours);
  return zh ? `${n} 小时` : `${n} hour${n === 1 ? '' : 's'}`;
}
const available = sql`${billingAccounts.balanceMicros} - coalesce((SELECT sum(reserved_micros) FROM browser_reservations WHERE user_id = ${billingAccounts.userId}),0)`;

// ---------------------------------------------------------------------------------------------
// Sign-in

/**
 * Sign-in codes. `wrangler dev` simulates sends locally, so in development the code is also logged.
 */
export async function sendSignInCode(env: Env, to: string, code: string) {
  if (env.ENVIRONMENT === 'development') console.log(`[dev] sign-in code for ${to}: ${code}`);
  if (!env.EMAIL && env.ENVIRONMENT === 'development') return;
  await sendTo(env, to, {
    subject: `Your Nevazu sign-in code: ${code}`,
    text: `Your sign-in code is ${code}\n\nIt expires in 5 minutes. If you did not ask for it, ignore this email.\n\n你的登录验证码是 ${code}，5 分钟内有效。如果不是你本人操作，请忽略此邮件。`,
    html: `<p>Your sign-in code is</p><p style="font-size:24px;font-weight:600;letter-spacing:4px;font-family:monospace">${code}</p><p>It expires in 5 minutes. If you did not ask for it, ignore this email.</p><hr><p>你的登录验证码是 <b>${code}</b>，5 分钟内有效。如果不是你本人操作，请忽略此邮件。</p>`,
  });
}

/**
 * Registration links (sign-up page, or a sign-in attempt for an address with no account). The link
 * opens the app's confirmation page, which completes sign-up on a click: mail scanners that fetch
 * links in advance cannot use up the single-use token.
 */
export async function sendRegistrationLink(env: Env, to: string, url: string, fromSignIn: boolean) {
  if (env.ENVIRONMENT === 'development') console.log(`[dev] registration link for ${to}: ${url}`);
  if (!env.EMAIL && env.ENVIRONMENT === 'development') return;
  const lead = fromSignIn ? 'Someone tried to sign in to Nevazu with this address, but it has no account yet. To create one, open this link:' : 'To finish creating your Nevazu account, open this link:';
  const leadZh = fromSignIn ? '有人使用此邮箱登录 Nevazu，但该邮箱尚未注册。如需创建账户，请打开以下链接：' : '请打开以下链接，完成 Nevazu 账户注册：';
  await sendTo(env, to, {
    subject: 'Create your Nevazu account',
    text: `${lead}\n\n${url}\n\nThe link works once and expires in 30 minutes. If you did not ask for it, ignore this email.\n\n${leadZh}\n${url}\n链接仅可使用一次，30 分钟内有效。如果不是你本人操作，请忽略此邮件。`,
    html: `<p>${lead}</p><p><a href="${url}" style="font-weight:600">Create my account</a></p><p>The link works once and expires in 30 minutes. If you did not ask for it, ignore this email.</p><hr><p>${leadZh}</p><p><a href="${url}">创建我的账户</a></p><p>链接仅可使用一次，30 分钟内有效。如果不是你本人操作，请忽略此邮件。</p>`,
  });
}

/** A sign-up request for an address that already has an account: point to sign-in, sign nobody in. */
export async function sendAlreadyRegistered(env: Env, to: string) {
  const url = `${env.APP_URL}/sign-in`;
  if (env.ENVIRONMENT === 'development') console.log(`[dev] ${to} already has an account`);
  if (!env.EMAIL && env.ENVIRONMENT === 'development') return;
  await sendTo(env, to, {
    subject: 'You already have a Nevazu account',
    text: `Someone asked to create a Nevazu account with this address, but it already has one. Sign in instead: ${url}\n\nIf it was not you, ignore this email; nothing has changed.\n\n有人尝试用此邮箱注册 Nevazu，但该邮箱已有账户。请直接登录：${url}\n如果不是你本人操作，请忽略此邮件，账户没有任何变化。`,
    html: `<p>Someone asked to create a Nevazu account with this address, but it already has one. <a href="${url}">Sign in instead</a>.</p><p>If it was not you, ignore this email; nothing has changed.</p><hr><p>有人尝试用此邮箱注册 Nevazu，但该邮箱已有账户。请直接<a href="${url}">登录</a>。如果不是你本人操作，请忽略此邮件，账户没有任何变化。</p>`,
  });
}

// ---------------------------------------------------------------------------------------------
// Credit

/**
 * Funded-time warnings at 24, 6 and 1 hours of the account's combined spending (page 6). Each is
 * sent once while credit keeps falling. A warning re-arms only when funded time is clearly above
 * its threshold again, so a browser starting and stopping near a threshold does not repeat it.
 */
export async function runwayWarnings(env: Env, db: Db, now: Date): Promise<number> {
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
      await sendToUser(env, db, a.userId, runwayMessage(due, hours, runway, `${env.APP_URL}/billing`));
      warned = due;
      sent++;
    }
    if (warned !== a.warned) await db.update(billingAccounts).set({ runwayWarnedHours: warned }).where(eq(billingAccounts.userId, a.userId));
  }
  return sent;
}

/**
 * Low balance: one email per dip below the threshold, unless a funded-time warning already said
 * more, and never within LOW_BALANCE_COOLDOWN_MS of the previous one (a dip during the cooldown is
 * remembered and emailed once it ends, if the balance is still low).
 */
export async function lowBalanceNotices(env: Env, db: Db, now: Date): Promise<number> {
  const { lowBalanceMicros } = await pricingSettings(db);
  const low = await db
    .select({ userId: billingAccounts.userId })
    .from(billingAccounts)
    .where(and(sql`${available} BETWEEN 1 AND ${lowBalanceMicros}`, isNull(billingAccounts.lowNotifiedAt), isNull(billingAccounts.runwayWarnedHours)));
  let sent = 0;
  for (const a of low) {
    const key = `user:${a.userId}:low_balance`;
    if (!(await cooledDown(db, key, LOW_BALANCE_COOLDOWN_MS, now))) continue;
    await sendToUser(env, db, a.userId, lowBalanceMessage(`${env.APP_URL}/billing`));
    await db.update(billingAccounts).set({ lowNotifiedAt: now }).where(eq(billingAccounts.userId, a.userId));
    await setState(db, key, now.getTime(), now);
    sent++;
  }
  await db
    .update(billingAccounts)
    .set({ lowNotifiedAt: null })
    .where(and(isNotNull(billingAccounts.lowNotifiedAt), sql`${available} > ${lowBalanceMicros}`));
  return sent;
}

/**
 * Usable credit ran out: name the stopped browsers and their deletion time when it happens, again
 * after three days, and a final reminder a day before deletion.
 */
export async function retentionNotices(env: Env, db: Db, now: Date): Promise<number> {
  const out = await db.select().from(billingAccounts).where(isNotNull(billingAccounts.exhaustedAt));
  let sent = 0;
  for (const a of out) {
    const endedAt = a.exhaustedAt!.getTime();
    const retention = await retentionState(db, a.userId);
    const first = retention.retained[0];
    if (!first || first.deletesAt.getTime() <= now.getTime()) continue;
    const stage = now.getTime() >= first.deletesAt.getTime() - DAY ? 'final' : now.getTime() - endedAt >= 3 * DAY ? 'd3' : 'd0';
    const action = `billing.notice.${stage}.${endedAt}`;
    const [done] = await db.select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.target, `user:${a.userId}`), eq(auditLog.action, action))).limit(1);
    if (done) continue;
    await sendToUser(env, db, a.userId, await retentionMessage(db, retention, stage, `${env.APP_URL}/billing`));
    await db.insert(auditLog).values({ actor: 'billing', action, target: `user:${a.userId}`, createdAt: now });
    sent++;
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

// ---------------------------------------------------------------------------------------------
// Browsers

/** Emails the notices the engine queued (it has no email binding), oldest first. */
export async function sendUserNotices(env: Env, db: Db, now: Date): Promise<number> {
  const pending = await db.select().from(userNotices).where(isNull(userNotices.sentAt)).orderBy(asc(userNotices.createdAt)).limit(50);
  for (const n of pending) {
    const message = noticeMessage(n.kind, n.data, `${env.APP_URL}/browsers${n.instanceId ? `/${n.instanceId}` : ''}`);
    if (message) await sendToUser(env, db, n.userId, message);
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

// ---------------------------------------------------------------------------------------------
// Rewards

/**
 * Reward-credited confirmations. Rewards are collected for REWARD_BATCH_MS after the first one is
 * credited, then confirmed in one email; while a user had one within REWARD_COOLDOWN_MS, new rewards
 * wait and join the next. Nothing is lost: a reward is marked notified only when its email went out
 * (or when there is nothing to tell: no amount, or the user is gone).
 */
export async function rewardNotices(env: Env, db: Db, now: Date): Promise<number> {
  const pending = await db
    .select({ taskId: promotionCompletions.taskId, userId: promotionCompletions.userId, rewardMicros: promotionCompletions.rewardMicros, creditedAt: promotionCompletions.creditedAt, title: promotionTasks.title })
    .from(promotionCompletions)
    .leftJoin(promotionTasks, eq(promotionTasks.id, promotionCompletions.taskId))
    .where(and(isNotNull(promotionCompletions.creditedAt), isNull(promotionCompletions.notifiedAt)))
    .orderBy(asc(promotionCompletions.creditedAt))
    .limit(200);
  const byUser = new Map<string, typeof pending>();
  for (const p of pending) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
  let sent = 0;
  for (const [userId, rows] of byUser) {
    const paid = rows.filter((r) => r.rewardMicros > 0);
    if (paid.length) {
      if (now.getTime() - paid[0]!.creditedAt!.getTime() < REWARD_BATCH_MS) continue;
      const key = `user:${userId}:reward`;
      if (!(await cooledDown(db, key, REWARD_COOLDOWN_MS, now))) continue;
      const [account] = await db.select({ balance: billingAccounts.balanceMicros }).from(billingAccounts).where(eq(billingAccounts.userId, userId));
      // An email that could not go out is retried by the next sweep; a deleted user has nobody to tell.
      const delivered = await sendToUser(env, db, userId, rewardMessage(paid, account?.balance ?? null, `${env.APP_URL}/billing`));
      if (!delivered && env.EMAIL && (await userExists(db, userId))) continue;
      await setState(db, key, now.getTime(), now);
      sent++;
    }
    await db.update(promotionCompletions).set({ notifiedAt: now })
      .where(and(eq(promotionCompletions.userId, userId), inArray(promotionCompletions.taskId, rows.map((r) => r.taskId)), isNull(promotionCompletions.notifiedAt)));
  }
  return sent;
}

async function userExists(db: Db, userId: string) {
  const [u] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId));
  return !!u;
}

function rewardMessage(rows: { rewardMicros: number; title: { en: string; 'zh-CN': string } | null; taskId: string }[], balanceMicros: number | null, url: string): Message {
  const total = rows.reduce((a, r) => a + r.rewardMicros, 0);
  const lines = (zh: boolean) => rows.map((r) => `• ${(zh ? r.title?.['zh-CN'] : r.title?.en) ?? r.taskId}: ${usd(r.rewardMicros)}`).join('\n');
  const balance = balanceMicros === null ? '' : ` Your balance is now ${usd(balanceMicros)}.`;
  const balanceZh = balanceMicros === null ? '' : `当前余额 ${usd(balanceMicros)}。`;
  return {
    subject: rows.length === 1 ? `You earned ${usd(total)} in Nevazu credit` : `You earned ${usd(total)} in Nevazu credit from ${rows.length} rewards`,
    text:
      `Thanks for trying Nevazu. We added ${usd(total)} to your balance for:\n${lines(false)}\n\n` +
      `It is spent like any other credit.${balance} ${url}\n\n` +
      `感谢使用 Nevazu。我们已向你的余额添加 ${usd(total)}，奖励来自：\n${lines(true)}\n\n` +
      `奖励金额与普通余额一样使用。${balanceZh}${url}`,
  };
}
