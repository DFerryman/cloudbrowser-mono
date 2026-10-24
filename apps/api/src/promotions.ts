/**
 * Promotions: tasks that reward users with credit. Operators define each task in the console
 * (criterion, target, reward, window, budget); this module measures progress from the data the
 * platform already keeps, records a completion once, and credits the reward to the balance with a
 * unique reference, so a retried request or sweep never pays twice.
 *
 * Completion is checked when the user opens Promotions and by the api's 5-minute cron. A closed
 * account earns nothing more: its rewards not yet credited are dropped when it closes (closure.ts).
 *
 * Rewards of tasks that need a top-up are capped per account at PROMOTION_TOPUP_SHARE_PERCENT of
 * its paid top-ups, so credit from promotions can never carry an account that does not pay.
 */
import { PROMOTION_ACTIVE_DAY_MINUTES, PROMOTION_TOPUP_SHARE_PERCENT, PromotionCriterion, type PromotionTask } from '@cloudbrowser/contracts';
import { schema, usageDay, type Db } from '@cloudbrowser/db';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { applyBalance, notifyHub } from './billing/ledger.js';
import type { Env } from './env.js';

const { promotionTasks, promotionCompletions } = schema;

type TaskRow = typeof promotionTasks.$inferSelect;
type Completion = typeof promotionCompletions.$inferSelect;

/** Users whose running time may have changed since the previous sweep (with slack for a missed run). */
const RECENT_USAGE_MS = 30 * 60_000;
/** How long after its last recorded heartbeat a viewer session is counted as still open. */
const HEARTBEAT_SLACK_MS = 60_000;
/** Completions recorded or credited per sweep. */
const SWEEP_LIMIT = 200;

export const promotionReference = (taskId: string, userId: string) => `promotion:${taskId}:${userId}`;

/** Minutes from hours, rounded to 0.001 first so 20 × (1/60 h) is 20, not 19. */
const minutes = (hours: SQL) => sql`CAST(round(${hours} * 60, 3) AS INTEGER)`;

/**
 * Minutes a set of viewer sessions was open. The viewer heartbeats every 15 s and stamps
 * `last_seen_at` at most once a minute, so a session really ended within about a minute of it. A tab
 * closed without saying so is only given `ended_at` when the browser later sleeps (up to its idle
 * timeout later), so the end is capped at the last heartbeat + 1 minute.
 */
const viewedMs = sql`sum(max(0, min(coalesce(ended_at, last_seen_at + ${HEARTBEAT_SLACK_MS}), last_seen_at + ${HEARTBEAT_SLACK_MS}) - started_at))`;
const viewedMinutes = sql`CAST(round(${viewedMs} / 60000.0, 3) AS INTEGER)`;

/**
 * One row per user `(user_id, value)` with the task's progress in its criterion's unit. `users`
 * narrows the users considered (a column filter on `user_id`). Activity before `starts_at` does
 * not count; running time is kept per UTC day, so it counts from the start of that day.
 */
function progressSql(task: TaskRow, users: (column: SQL) => SQL): SQL {
  const from = task.startsAt?.getTime() ?? 0;
  const day = usageDay(new Date(from));
  const criterion = PromotionCriterion.parse(task.criterion);
  switch (criterion) {
    case 'browser_running_minutes':
      return sql`SELECT user_id, max(value) AS value FROM (SELECT user_id, ${minutes(sql`sum(quantity)`)} AS value FROM usage_records
        WHERE item = 'compute' AND day >= ${day} AND ${users(sql`user_id`)} GROUP BY user_id, instance_id) GROUP BY user_id`;
    case 'total_running_minutes':
      return sql`SELECT user_id, ${minutes(sql`sum(quantity)`)} AS value FROM usage_records
        WHERE item = 'compute' AND day >= ${day} AND ${users(sql`user_id`)} GROUP BY user_id`;
    case 'browser_used_minutes':
      return sql`SELECT user_id, max(value) AS value FROM (SELECT user_id, ${viewedMinutes} AS value FROM viewer_sessions
        WHERE started_at >= ${from} AND ${users(sql`user_id`)} GROUP BY user_id, instance_id) GROUP BY user_id`;
    case 'live_view_minutes':
      return sql`SELECT user_id, ${viewedMinutes} AS value FROM viewer_sessions
        WHERE started_at >= ${from} AND ${users(sql`user_id`)} GROUP BY user_id`;
    case 'browsers_created':
      return sql`SELECT user_id, count(*) AS value FROM browser_instances
        WHERE status <> 'failed' AND created_at >= ${from} AND ${users(sql`user_id`)} GROUP BY user_id`;
    case 'topup_usd':
      // Net of refunds and disputes, so a refunded top-up does not count.
      return sql`SELECT user_id, CAST(sum(amount_micros) / 1000000 AS INTEGER) AS value FROM balance_transactions
        WHERE kind IN ('topup', 'refund', 'dispute') AND applied_at IS NOT NULL AND created_at >= ${from} AND ${users(sql`user_id`)} GROUP BY user_id`;
    case 'two_factor_enabled':
      return sql`SELECT id AS user_id, two_factor_enabled AS value FROM "user" WHERE two_factor_enabled = 1 AND ${users(sql`id`)}`;
    case 'passkeys_added':
      return sql`SELECT user_id, count(*) AS value FROM passkey WHERE ${users(sql`user_id`)} GROUP BY user_id`;
    case 'active_days':
      return sql`SELECT user_id, count(*) AS value FROM (SELECT user_id FROM viewer_sessions
        WHERE started_at >= ${from} AND ${users(sql`user_id`)} GROUP BY user_id, date(started_at / 1000, 'unixepoch')
        HAVING ${viewedMs} >= ${PROMOTION_ACTIVE_DAY_MINUTES * 60_000}) GROUP BY user_id`;
    case 'regions_used':
      return sql`SELECT user_id, count(DISTINCT region_id) AS value FROM browser_instances
        WHERE status <> 'failed' AND created_at >= ${from} AND ${users(sql`user_id`)} GROUP BY user_id`;
    case 'storage_resized':
      return sql`SELECT user_id, count(*) AS value FROM operations
        WHERE kind = 'resize_volume' AND status = 'succeeded' AND user_id IS NOT NULL AND created_at >= ${from} AND ${users(sql`user_id`)} GROUP BY user_id`;
    case 'paid_usage_usd':
      return sql`SELECT user_id, CAST(sum(charged_micros) / 1000000 AS INTEGER) AS value FROM usage_records
        WHERE day >= ${day} AND ${users(sql`user_id`)} GROUP BY user_id`;
    case 'topups_count':
      return sql`SELECT user_id, count(*) AS value FROM balance_transactions AS t
        WHERE kind = 'topup' AND applied_at IS NOT NULL AND created_at >= ${from} AND ${users(sql`user_id`)}
          AND NOT EXISTS (SELECT 1 FROM balance_transactions r WHERE r.order_id = t.order_id AND r.kind IN ('refund', 'dispute'))
        GROUP BY user_id`;
  }
}

const hasTopup = (userId: SQL) =>
  sql`EXISTS (SELECT 1 FROM balance_transactions WHERE user_id = ${userId} AND kind = 'topup' AND applied_at IS NOT NULL)`;

/** Paid top-ups, net of refunds and disputes, in micros. */
const paidMicros = (userId: SQL) =>
  sql`(SELECT coalesce(sum(amount_micros), 0) FROM balance_transactions WHERE user_id = ${userId} AND kind IN ('topup', 'refund', 'dispute') AND applied_at IS NOT NULL)`;
/** Rewards already earned from tasks that need a top-up, in micros. */
const toppedRewardMicros = (userId: SQL) =>
  sql`(SELECT coalesce(sum(c.reward_micros), 0) FROM promotion_completions c JOIN promotion_tasks t ON t.id = c.task_id WHERE c.user_id = ${userId} AND t.requires_topup = 1)`;
/** A top-up task's reward fits under the account's cap (PROMOTION_TOPUP_SHARE_PERCENT of its top-ups). */
const withinShare = (userId: SQL, rewardMicros: SQL) =>
  sql`(${toppedRewardMicros(userId)} + ${rewardMicros}) * 100 <= ${paidMicros(userId)} * ${PROMOTION_TOPUP_SHARE_PERCENT}`;

/** Open for new completions: on, started, not ended and with budget left (budget checked on insert). */
const isOpen = (task: TaskRow, now: Date) =>
  task.enabled && (!task.startsAt || task.startsAt <= now) && (!task.endsAt || task.endsAt > now);

/**
 * Records the completion once, if the task is still open and within its budget at that moment
 * (checked in the same statement, so a burst of completions cannot overspend the budget).
 */
async function recordCompletion(db: Db, task: TaskRow, userId: string, progress: number, now: Date) {
  const rows = await db.all<{ task_id: string }>(sql`INSERT INTO promotion_completions (task_id, user_id, progress, reward_micros, completed_at, credited_at)
    SELECT id, ${userId}, ${progress}, reward_micros, ${now.getTime()}, NULL FROM promotion_tasks
    WHERE id = ${task.id} AND enabled = 1 AND (starts_at IS NULL OR starts_at <= ${now.getTime()}) AND (ends_at IS NULL OR ends_at > ${now.getTime()})
      AND (max_completions IS NULL OR (SELECT count(*) FROM promotion_completions WHERE task_id = ${task.id}) < max_completions)
      AND (requires_topup = 0 OR (${hasTopup(sql`${userId}`)} AND ${withinShare(sql`${userId}`, sql`reward_micros`)}))
      AND NOT EXISTS (SELECT 1 FROM account_closures WHERE user_id = ${userId})
    ON CONFLICT DO NOTHING RETURNING task_id`);
  return rows.length > 0;
}

/** Puts recorded rewards on the balance; safe to repeat (the reference is unique). */
async function creditCompletions(env: Env | null, db: Db, pending: Completion[], tasks: Map<string, TaskRow>, now: Date) {
  const notified = new Set<string>();
  for (const done of pending) {
    try {
      if (done.rewardMicros > 0) {
        const task = tasks.get(done.taskId);
        await applyBalance(db, {
          userId: done.userId,
          kind: 'promotion',
          amountMicros: done.rewardMicros,
          reference: promotionReference(done.taskId, done.userId),
          description: task?.title.en ?? done.taskId,
          actor: 'promotions',
        }, now);
        notified.add(done.userId);
      }
      await db.update(promotionCompletions).set({ creditedAt: now })
        .where(and(eq(promotionCompletions.taskId, done.taskId), eq(promotionCompletions.userId, done.userId), isNull(promotionCompletions.creditedAt)));
    } catch (e) {
      // The completion stays uncredited and the next sweep tries again.
      console.error('promotion credit failed', done.taskId, done.userId, e);
    }
  }
  if (env) await Promise.all([...notified].map((userId) => notifyHub(env, userId)));
  return notified.size;
}

const taskMap = async (db: Db) => new Map((await db.select().from(promotionTasks)).map((t) => [t.id, t]));

/**
 * The tasks the user sees, with their progress. Any task they have just finished is completed and
 * credited first, so opening the page always shows a reward that was earned.
 */
export async function userPromotions(env: Env | null, db: Db, userId: string, now = new Date()): Promise<PromotionTask[]> {
  const tasks = await taskMap(db);
  const completions = new Map((await db.select().from(promotionCompletions).where(eq(promotionCompletions.userId, userId))).map((c) => [c.taskId, c]));
  const [account = { topped: 0, paid: 0, earned: 0 }] = await db.all<{ topped: number; paid: number; earned: number }>(
    sql`SELECT ${hasTopup(sql`${userId}`)} AS topped, ${paidMicros(sql`${userId}`)} AS paid, ${toppedRewardMicros(sql`${userId}`)} AS earned`);
  const { topped, paid } = account;
  let earned = Number(account.earned);
  /** More top-up needed before a top-up task's reward fits under the cap (0: it fits). */
  const toUnlock = (rewardMicros: number) =>
    Math.max(0, Math.ceil(((earned + rewardMicros) * 100) / PROMOTION_TOPUP_SHARE_PERCENT) - Number(paid));
  const progress = new Map<string, number>();
  for (const task of tasks.values()) {
    if (completions.has(task.id) || !isOpen(task, now)) continue;
    const [row] = await db.all<{ value: number }>(progressSql(task, (col) => sql`${col} = ${userId}`));
    const value = Number(row?.value ?? 0);
    progress.set(task.id, value);
    if (value >= task.target && (!task.requiresTopup || (topped && !toUnlock(task.rewardMicros))) && (await recordCompletion(db, task, userId, value, now))) {
      const [done] = await db.select().from(promotionCompletions).where(and(eq(promotionCompletions.taskId, task.id), eq(promotionCompletions.userId, userId)));
      if (done) completions.set(task.id, done);
      if (done && task.requiresTopup) earned += done.rewardMicros;
    }
  }
  const uncredited = [...completions.values()].filter((c) => !c.creditedAt);
  if (uncredited.length) {
    await creditCompletions(env, db, uncredited, tasks, now);
    for (const c of uncredited) completions.set(c.taskId, { ...c, creditedAt: now });
  }
  // Budget left, for pending tasks: one that is used up is no longer offered.
  const counts = new Map((await db.all<{ task_id: string; n: number }>(sql`SELECT task_id, count(*) AS n FROM promotion_completions GROUP BY task_id`)).map((r) => [r.task_id, Number(r.n)]));
  return [...tasks.values()]
    .filter((t) => completions.has(t.id) || (isOpen(t, now) && (t.maxCompletions === null || (counts.get(t.id) ?? 0) < t.maxCompletions)))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((t) => {
      const done = completions.get(t.id);
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        actionUrl: t.actionUrl,
        criterion: PromotionCriterion.parse(t.criterion),
        target: t.target,
        progress: done ? Math.max(done.progress, t.target) : Math.min(progress.get(t.id) ?? 0, t.target),
        rewardMicros: done ? done.rewardMicros : t.rewardMicros,
        status: done ? 'completed' : 'pending',
        needsTopup: !done && t.requiresTopup && !topped,
        topupToUnlockMicros: !done && t.requiresTopup && topped ? toUnlock(t.rewardMicros) : 0,
        completedAt: done ? done.completedAt.toISOString() : null,
        endsAt: t.endsAt ? t.endsAt.toISOString() : null,
      } satisfies PromotionTask;
    });
}

/**
 * Cron: completes and credits tasks finished since the last run without the user opening the
 * page. Time-based criteria only look at users active in the last half hour.
 */
export async function promotionSweep(env: Env | null, db: Db, now = new Date()) {
  const tasks = await taskMap(db);
  let completed = 0;
  for (const task of tasks.values()) {
    if (!isOpen(task, now)) continue;
    // Time-based criteria only look at users active recently (the page catches everyone else).
    const recent = now.getTime() - RECENT_USAGE_MS;
    const users = task.criterion === 'browser_running_minutes' || task.criterion === 'total_running_minutes'
      ? (col: SQL) => sql`${col} IN (SELECT DISTINCT user_id FROM usage_records WHERE item = 'compute' AND updated_at >= ${recent})`
      : task.criterion === 'paid_usage_usd'
        ? (col: SQL) => sql`${col} IN (SELECT DISTINCT user_id FROM usage_records WHERE updated_at >= ${recent})`
      : task.criterion === 'browser_used_minutes' || task.criterion === 'live_view_minutes' || task.criterion === 'active_days'
        ? (col: SQL) => sql`${col} IN (SELECT DISTINCT user_id FROM viewer_sessions WHERE last_seen_at >= ${recent} OR ended_at >= ${recent})`
        : () => sql`1`;
    const candidates = await db.all<{ user_id: string; value: number }>(sql`SELECT p.user_id, p.value FROM (${progressSql(task, users)}) AS p
      WHERE p.value >= ${task.target}
        AND NOT EXISTS (SELECT 1 FROM promotion_completions c WHERE c.task_id = ${task.id} AND c.user_id = p.user_id)
        AND (${task.requiresTopup ? 0 : 1} = 1 OR (${hasTopup(sql`p.user_id`)} AND ${withinShare(sql`p.user_id`, sql`${task.rewardMicros}`)}))
        AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = p.user_id)
        AND NOT EXISTS (SELECT 1 FROM account_closures a WHERE a.user_id = p.user_id)
      LIMIT ${SWEEP_LIMIT}`);
    for (const c of candidates) {
      if (await recordCompletion(db, task, c.user_id, Number(c.value), now)) completed++;
    }
  }
  const pending = await db.select().from(promotionCompletions).where(isNull(promotionCompletions.creditedAt)).orderBy(asc(promotionCompletions.completedAt)).limit(SWEEP_LIMIT);
  const credited = pending.length ? await creditCompletions(env, db, pending, tasks, now) : 0;
  return { completed, credited };
}
