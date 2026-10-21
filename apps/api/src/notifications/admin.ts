/**
 * Administrator notifications: everything operators are told about the platform. All of them are
 * operator alerts (`raiseAlert`, `@cloudbrowser/db`): they are listed in the console until
 * acknowledged. `deliverAlerts` sends critical alerts to ALERT_EMAILS (default: the admin
 * allowlist), and all severities to the chat webhook, batched per 5-minute sweep.
 *
 * Raised by other Workers: circuit breaker and drift (reconciler), projected spend at 80% / 100% of
 * the budget (reconciler), missing prices (engine), failed launches and purges (engine), Creem
 * disputes (billing webhooks). Raised here, from the api's cron:
 *
 * | Alert                         | When                                           | How often                         |
 * |-------------------------------|------------------------------------------------|-----------------------------------|
 * | Region out of inventory       | An enabled region's available inventory < 1    | Once per shortage; "restocked" once when it recovers |
 * | User milestone                | Total users pass 10, 20, 50, 100, 500, …       | Once per milestone, ever          |
 * | Promotion budget used up      | A task reached its maximum completions         | Once per budget (raised again if the budget changes) |
 */
import { awsInventory, raiseAlert, schema, type Db } from '@cloudbrowser/db';
import { asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { clearState, getState, sendTo, setState } from './send.js';
import { DEFAULT_ADMIN_EMAIL } from '../admin/access.js';

const { alerts, regions, promotionTasks } = schema;

export const USER_MILESTONES = [10, 20, 50, 100, 500, 1_000, 2_000, 5_000, 10_000];

/** Where operator email goes: ALERT_EMAILS, or the console's allowlist when that is unset. */
export function alertRecipients(env: Env) {
  const list = env.ALERT_EMAILS?.trim() ? env.ALERT_EMAILS : (env.ADMIN_EMAIL_ALLOWLIST ?? DEFAULT_ADMIN_EMAIL);
  return list.split(',').map((e) => e.trim()).filter(Boolean);
}

/** Processes new alerts once: critical-only email, all severities to chat; all remain in the console until acknowledged. */
export async function deliverAlerts(env: Env, db: Db, now = new Date()): Promise<number> {
  const pending = await db.select().from(alerts).where(isNull(alerts.sentAt)).orderBy(asc(alerts.createdAt)).limit(50);
  if (!pending.length) return 0;
  const lines = pending.map((a) => `[${a.severity.toUpperCase()}] ${a.source}: ${a.title}`);
  const link = env.ADMIN_URL ? new URL('/alerts', env.ADMIN_URL).href : `${env.APP_URL}/admin/alerts`;
  const emails = alertRecipients(env);
  const emailAlerts = pending.filter((a) => a.severity === 'critical');
  try {
    if (env.ALERT_WEBHOOK_URL) {
      // Slack-compatible incoming webhook payload (also accepted by Mattermost, Discord's /slack, Feishu bots).
      const res = await fetch(env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `${lines.join('\n')}\n${link}` }),
      });
      if (!res.ok) throw new Error(`alert webhook HTTP ${res.status}`);
    }
    if (emailAlerts.length && emails.length && env.EMAIL) {
      for (const to of emails) {
        await sendTo(env, to, {
          subject: `[CRITICAL] Nevazu: ${emailAlerts.length === 1 ? emailAlerts[0]!.title : `${emailAlerts.length} new alerts`}`,
          text: `${emailAlerts.map((a) => `[${a.severity.toUpperCase()}] ${a.source}: ${a.title}`).join('\n')}\n\n${link}`,
        }, 'Nevazu alerts');
      }
    }
  } catch (e) {
    console.error('alert delivery failed; retrying next sweep', e);
    return 0;
  }
  // Also finish info/warning alerts when no webhook is configured, so they do not stay queued forever.
  await db.update(alerts).set({ sentAt: now }).where(inArray(alerts.id, pending.map((a) => a.id)));
  return pending.length;
}

export async function acknowledgeAlert(db: Db, id: number, by: string, now = new Date()) {
  await db.update(alerts).set({ acknowledgedAt: now, acknowledgedBy: by }).where(eq(alerts.id, id));
}

/**
 * Enabled regions with AWS inventory: alerts once when available inventory drops below 1 (new
 * browsers cannot be created there), and once when it is back.
 */
export async function inventoryAlerts(db: Db, now: Date): Promise<number> {
  const [inventory, rows] = await Promise.all([awsInventory(db), db.select().from(regions).where(eq(regions.enabled, true))]);
  let raised = 0;
  for (const region of rows) {
    const inv = inventory.get(region.id);
    if (!inv || ['not-enabled', 'not-supported'].includes(inv.status)) continue;
    const key = `admin:inventory_empty:${region.id}`;
    const empty = await getState(db, key);
    if (inv.available < 1 && !empty) {
      const why = inv.availability === 'ready' ? 'every slot the AWS quota allows is in use' : 'its inventory or prices could not be refreshed';
      await raiseAlert(db, {
        source: 'api',
        severity: 'warning',
        title: `Region ${region.name} (${region.id}) has no inventory left: ${why}; new browsers cannot be created there`,
        detail: { regionId: region.id, availability: inv.availability, status: inv.status, quotaAvailable: inv.quota_available, checkedAt: inv.checked_at },
      }, now);
      await setState(db, key, now.getTime(), now);
      raised++;
    } else if (inv.available >= 1 && empty) {
      await raiseAlert(db, { source: 'api', severity: 'info', title: `Region ${region.name} (${region.id}) has inventory again (${inv.available} available)`, detail: { regionId: region.id, available: inv.available, emptySince: Number(empty) } }, now);
      await clearState(db, key);
      raised++;
    }
  }
  return raised;
}

/** Alerts once when the total number of users passes each milestone (only the highest, if several at once). */
export async function userMilestoneAlerts(db: Db, now: Date): Promise<number> {
  const [{ n } = { n: 0 }] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM "user"`);
  const total = Number(n);
  const reached = USER_MILESTONES.filter((m) => total >= m).at(-1);
  if (!reached) return 0;
  const key = 'admin:users_milestone';
  if (Number(await getState(db, key)) >= reached) return 0;
  await raiseAlert(db, { source: 'api', severity: 'info', title: `Nevazu passed ${reached} users (${total} in total)`, detail: { milestone: reached, total } }, now);
  await setState(db, key, reached, now);
  return 1;
}

/** Alerts once when an enabled promotion has paid out its whole budget and is no longer offered. */
export async function promotionBudgetAlerts(db: Db, now: Date): Promise<number> {
  const full = await db.all<{ id: string; title: string; max: number }>(sql`SELECT t.id, t.title, t.max_completions AS max FROM ${promotionTasks} t
    WHERE t.enabled = 1 AND t.max_completions IS NOT NULL AND (SELECT count(*) FROM promotion_completions c WHERE c.task_id = t.id) >= t.max_completions`);
  let raised = 0;
  for (const t of full) {
    const key = `admin:promotion_budget:${t.id}`;
    if ((await getState(db, key)) === String(t.max)) continue;
    const title = (JSON.parse(t.title) as { en?: string }).en ?? t.id;
    await raiseAlert(db, { source: 'api', severity: 'info', title: `Promotion "${title}" reached its limit of ${t.max} completions and is no longer offered`, detail: { taskId: t.id, maxCompletions: t.max } }, now);
    await setState(db, key, t.max, now);
    raised++;
  }
  return raised;
}

/** The api cron's admin watchers; one failing does not stop the others. */
export async function adminSweep(db: Db, now: Date) {
  const run = (f: (db: Db, now: Date) => Promise<number>) => f(db, now).catch((e) => (console.error('admin notification failed', f.name, e), 0));
  return {
    inventory: await run(inventoryAlerts),
    milestones: await run(userMilestoneAlerts),
    promotions: await run(promotionBudgetAlerts),
  };
}
