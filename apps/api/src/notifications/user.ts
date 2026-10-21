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
import { renderEmail } from './template.js';
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
function duration(hours: number) {
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const n = Math.floor(hours);
  return `${n} hour${n === 1 ? '' : 's'}`;
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
  await sendTo(env, to, renderEmail(env.APP_URL, {
    subject: `Your Nevazu sign-in code: ${code}`,
    category: 'Account security',
    title: 'Your sign-in code.',
    preview: 'Your one-time code is ready. It expires in 5 minutes.',
    paragraphs: ['Enter this code on the sign-in page to continue to your account.'],
    code,
    note: 'If you did not request this code, you can safely ignore this email. Never share your code with anyone, including Nevazu support.',
  }));
}

/**
 * Registration links (sign-up page, or a sign-in attempt for an address with no account). The link
 * opens the app's confirmation page, which completes sign-up on a click: mail scanners that fetch
 * links in advance cannot use up the single-use token.
 */
export async function sendRegistrationLink(env: Env, to: string, url: string, fromSignIn: boolean) {
  if (env.ENVIRONMENT === 'development') console.log(`[dev] registration link for ${to}: ${url}`);
  if (!env.EMAIL && env.ENVIRONMENT === 'development') return;
  await sendTo(env, to, renderEmail(env.APP_URL, {
    subject: 'Create your Nevazu account',
    category: 'Welcome to Nevazu',
    title: 'Your next browser starts here.',
    preview: 'Confirm your email to finish creating your Nevazu account.',
    paragraphs: [fromSignIn
      ? 'This email address is not linked to a Nevazu account yet. Create one to get started with your own browser in the cloud.'
      : 'You are one step away. Confirm your email to create your Nevazu account and make room for your browser in the cloud.'],
    action: { label: 'Create my account', url },
    note: 'This link works once and expires in 30 minutes. If you did not request an account, you can safely ignore this email.',
  }));
}

/** A sign-up request for an address that already has an account: point to sign-in, sign nobody in. */
export async function sendAlreadyRegistered(env: Env, to: string) {
  const url = `${env.APP_URL}/sign-in`;
  if (env.ENVIRONMENT === 'development') console.log(`[dev] ${to} already has an account`);
  if (!env.EMAIL && env.ENVIRONMENT === 'development') return;
  await sendTo(env, to, renderEmail(env.APP_URL, {
    subject: 'You already have a Nevazu account',
    category: 'Your account',
    title: 'Welcome back.',
    preview: 'You already have an account. Sign in to pick up where you left off.',
    paragraphs: ['A Nevazu account already exists for this email address. Sign in with your passkey or request a one-time email code.'],
    action: { label: 'Go to sign in', url },
    note: 'If you did not request this email, you can safely ignore it. Nothing has changed on your account.',
  }));
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

export function runwayMessage(due: number, hours: number, runway: { availableMicros: number; burnHourMicros: number; fundedUntil: Date | null }, url: string): Message {
  return renderEmail(url, {
    subject: due === 1 ? 'Your Nevazu credit runs out within an hour' : `Your Nevazu credit lasts less than ${due} hours`,
    category: 'Balance reminder',
    title: 'Keep your browsers running.',
    preview: `About ${duration(hours)} of credit remains at your current spending.`,
    paragraphs: ['Your available credit is running low. Add credit to keep your paid browsers running without interruption.'],
    details: [
      { label: 'Available credit', value: usd(runway.availableMicros) },
      { label: 'Combined spending', value: `${usd(runway.burnHourMicros)} per hour` },
      { label: 'Estimated time remaining', value: `About ${duration(hours)}` },
      ...(runway.fundedUntil ? [{ label: 'Estimated credit exhaustion', value: utc(runway.fundedUntil) }] : []),
    ],
    afterDetails: [`When credit runs out, every paid browser stops, including those set to Never sleep. Your browsers are kept for ${DATA_KEPT_DAYS} days and then permanently deleted unless you add enough credit.`],
    action: { label: 'Add credit', url },
    note: 'Estimates reflect current spending and may change as you start or stop browsers.',
  });
}

export function lowBalanceMessage(url: string): Message {
  return renderEmail(url, {
    subject: 'Your Nevazu balance is low',
    category: 'Balance reminder',
    title: 'Time for a top-up.',
    preview: 'Add credit before your available balance runs out.',
    paragraphs: ['Your prepaid balance is running low. Add credit now so your browsers are ready when you need them.',
      `When available credit is used up, browser access stops immediately. Your held deposit then pays fixed IP and disk costs for ${DATA_KEPT_DAYS} days. Add enough credit before the retention period ends to avoid permanent deletion.`],
    action: { label: 'Add credit', url },
  });
}

/** Names every kept browser and its deletion time, and the exact top-up that keeps all of them. */
export async function retentionMessage(db: Db, r: Awaited<ReturnType<typeof retentionState>>, stage: 'd0' | 'd3' | 'final', url: string): Promise<Message> {
  const ids = [...new Set(r.retained.map((b) => b.regionId))];
  const names = new Map((await db.select({ id: regions.id, name: regions.name }).from(regions).where(inArray(regions.id, ids))).map((x) => [x.id, x.name]));
  const details = r.retained.map((b) => ({ label: `${b.name} (${names.get(b.regionId) ?? b.regionId})`, value: utc(b.deletesAt) }));
  const deleteOn = utc(r.retained[0]!.deletesAt);
  const need = usd(r.restoreNeededMicros ?? 0);
  const intro = {
    d0: 'Your available credit ran out, so your paid browsers were stopped. They are kept, with their data and IP addresses, until the time shown for each, and then permanently deleted:',
    d3: 'Your browsers are still stopped because your credit ran out. Unless you add credit, they will be permanently deleted at these times:',
    final: 'This is the last reminder. Unless you add credit, these browsers and their data will be permanently deleted within 24 hours, and their IP addresses released:',
  }[stage];
  return renderEmail(url, {
    subject: { d0: 'Your Nevazu credit ran out: your browsers have stopped', d3: `Your Nevazu browsers will be deleted from ${deleteOn}`, final: 'Final reminder: your Nevazu browsers will be deleted within 24 hours' }[stage],
    category: stage === 'final' ? 'Final retention reminder' : 'Browser retention',
    title: stage === 'd0' ? 'Your browsers are on pause.' : stage === 'd3' ? 'Keep what you have built.' : 'Keep your browsers before time runs out.',
    preview: `Add at least ${need} to keep all retained browsers. Deletion begins ${deleteOn}.`,
    paragraphs: [intro],
    details,
    afterDetails: [
      `To keep them, add at least ${need}. Your balance must cover each kept browser's ${DATA_KEPT_DAYS}-day IP and disk deposit (${usd(r.depositsMicros)} in total) plus the ${usd(r.minBalanceMicros)} minimum balance. A smaller top-up is added to your balance but does not stop the deletion.`,
      'After you add enough credit, your browsers stay asleep until you open each one. None restarts by itself; running charges begin again only when you choose.',
    ],
    action: { label: 'Add credit and keep my browsers', url },
    note: 'All deletion times are shown in UTC. Permanently deleted browser data cannot be recovered.',
  });
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

export function noticeMessage(kind: string, data: Record<string, unknown>, url: string): Message | null {
  const name = typeof data.name === 'string' ? data.name : 'your browser';
  if (kind === 'network_paused') {
    return renderEmail(url, {
      subject: `Network paused on your Nevazu browser "${name}"`,
      category: 'Browser security',
      title: 'Network paused to protect your IP.',
      preview: 'Open your browser and choose Check again to review its network status.',
      paragraphs: [`The security check could not confirm that "${name}" uses only its dedicated IP address. Its network was paused to make sure no other address is used.`,
        'The network stays paused until you open the browser and choose Check again. It does not resume by itself. If the issue continues, contact support.'],
      details: [{ label: 'Browser', value: name }, { label: 'Network', value: 'Paused' }],
      action: { label: 'Review browser', url },
    });
  }
  if (kind !== 'stopped') return null;
  const why = {
    operator: `An administrator stopped "${name}". You can open it to resume when you are ready.`,
    suspended: `"${name}" was suspended by an administrator and has stopped. It cannot start until the suspension is lifted. Contact support if you did not expect this.`,
    frozen: `Your account is on hold because of a payment dispute, so "${name}" has stopped. Nothing can run until support resolves the hold.`,
  }[data.reason as 'operator' | 'suspended' | 'frozen'];
  if (!why) return null;
  return renderEmail(url, {
    subject: `Your Nevazu browser "${name}" was stopped`,
    category: 'Browser update',
    title: data.reason === 'operator' ? 'Your browser has stopped.' : 'Your browser needs attention.',
    preview: 'Review the details and next steps for your browser.',
    paragraphs: [why, 'It will not restart by itself, even if it was set to Never sleep. Its data and IP address are kept.'],
    details: [{ label: 'Browser', value: name }, { label: 'Status', value: 'Stopped' }],
    action: { label: 'Review browser', url },
  });
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

export function rewardMessage(rows: { rewardMicros: number; title: { en: string; 'zh-CN': string } | null; taskId: string }[], balanceMicros: number | null, url: string): Message {
  const total = rows.reduce((a, r) => a + r.rewardMicros, 0);
  return renderEmail(url, {
    subject: rows.length === 1 ? `You earned ${usd(total)} in Nevazu credit` : `You earned ${usd(total)} in Nevazu credit from ${rows.length} rewards`,
    category: 'Rewards',
    title: 'A little credit. More possibilities.',
    preview: `${usd(total)} in reward credit has been added to your balance.`,
    paragraphs: [`Thanks for exploring Nevazu. We added ${usd(total)} to your balance for completing ${rows.length === 1 ? 'this task' : 'these tasks'}:`],
    details: rows.map((r) => ({ label: r.title?.en ?? r.taskId, value: usd(r.rewardMicros) })),
    afterDetails: [`Reward credit is spent like any other credit.${balanceMicros === null ? '' : ` Your balance is now ${usd(balanceMicros)}.`}`],
    action: { label: 'View my balance', url },
  });
}
