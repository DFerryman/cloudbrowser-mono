/**
 * Administrator notifications: everything operators are told about the platform. All of them are
 * operator alerts (`raiseAlert`, `@cloudbrowser/db`): they are listed in the console until
 * acknowledged. `deliverAlerts` sends critical alerts to ALERT_EMAILS (default: the admin
 * allowlist), and all severities to the chat webhook, batched per 5-minute sweep.
 *
 * Raised by other Workers: circuit breaker and drift (reconciler), projected spend at 80% / 100% of
 * the budget (reconciler), missing prices (engine), failed launches and purges (engine), Stripe
 * and Creem disputes and failed Stripe refunds (billing webhooks). Raised here, from the api's cron:
 *
 * | Alert                         | When                                           | How often                         |
 * |-------------------------------|------------------------------------------------|-----------------------------------|
 * | Region inventory unavailable  | An enabled region cannot take browsers for 10+ min: AWS quota used up, snapshot stale, refresh failing, or prices missing | Once per problem, one alert per kind for all regions; one recovery alert once it has held 10 min |
 * | User milestone                | Total users pass 10, 20, 50, 100, 500, …       | Once per milestone, ever          |
 * | Promotion budget used up      | A task reached its maximum completions         | Once per budget (raised again if the budget changes) |
 */
import { awsInventory, raiseAlert, schema, type AwsInventory, type Db } from '@cloudbrowser/db';
import { asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { clearState, getState, sendTo, setState } from './send.js';
import { DEFAULT_ADMIN_EMAIL } from '../admin/access.js';

const { alerts, regions, promotionTasks, awsProviderState } = schema;

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

/** A region problem must last this long before it is reported, and a recovery before it is announced. */
export const INVENTORY_ALERT_GRACE_MS = 10 * 60_000;

/**
 * Why an enabled AWS region cannot take new browsers. Only `quota` means AWS has no room: the
 * others are about our own knowledge of the region, and say so.
 */
export type InventoryProblem = 'quota' | 'stale' | 'sync_failed' | 'prices';
type InventoryState = { kind: InventoryProblem | null; since: number; alerted: InventoryProblem | null };

export function inventoryProblem(inv: Pick<AwsInventory, 'availability' | 'reason' | 'last_error'> & { available: number }): InventoryProblem | null {
  if (inv.availability === 'ready') return inv.available < 1 ? 'quota' : null;
  switch (inv.reason) {
    case 'prices': return 'prices';
    case 'sync_failed': return 'sync_failed';
    // Expired while refreshes kept failing: the failure is the news, not the age.
    case 'stale': return inv.last_error ? 'sync_failed' : 'stale';
    case 'pending': return 'stale';
    default: return null;
  }
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
const listed = (items: string[], max = 8) => items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');

/**
 * Enabled regions with AWS inventory. A problem is reported once it has lasted
 * `INVENTORY_ALERT_GRACE_MS`, so a refresh that runs a little late raises nothing; regions with
 * the same problem share one alert, so one refresh outage is one alert, not one per region. A
 * recovery is announced once it has held as long, and only for problems that were reported.
 */
export async function inventoryAlerts(db: Db, now: Date): Promise<number> {
  const [inventory, rows, [provider]] = await Promise.all([
    awsInventory(db), db.select().from(regions).where(eq(regions.enabled, true)), db.select().from(awsProviderState).where(eq(awsProviderState.id, 1)),
  ]);
  const t = now.getTime();
  const confirmed = new Map<InventoryProblem, { region: typeof rows[number]; inv: NonNullable<ReturnType<typeof inventory.get>> }[]>();
  const recovered: { region: typeof rows[number]; available: number; since: number }[] = [];
  let monitored = 0;
  for (const region of rows) {
    const inv = inventory.get(region.id);
    if (!inv || ['not-enabled', 'not-supported'].includes(inv.status)) continue;
    monitored++;
    const key = `admin:inventory:${region.id}`;
    const legacyKey = `admin:inventory_empty:${region.id}`;
    const raw = await getState(db, key);
    let state: InventoryState | null = raw ? JSON.parse(raw) as InventoryState : null;
    // Before 0031 only an alerted shortage was kept; it was reported as having no inventory.
    const legacy = state ? null : await getState(db, legacyKey);
    if (legacy) { state = { kind: 'quota', since: Number(legacy), alerted: 'quota' }; await clearState(db, legacyKey); }
    const kind = inventoryProblem(inv);
    if (kind) {
      if (state?.kind !== kind) state = { kind, since: t, alerted: state?.alerted ?? null };
      if (state.alerted !== kind && t - state.since >= INVENTORY_ALERT_GRACE_MS) {
        confirmed.set(kind, [...confirmed.get(kind) ?? [], { region, inv }]);
        state.alerted = kind;
      }
      await setState(db, key, JSON.stringify(state), now);
    } else if (state) {
      if (!state.alerted) { await clearState(db, key); continue; } // Never reported: nothing to take back.
      if (state.kind !== null) state = { kind: null, since: t, alerted: state.alerted };
      if (t - state.since >= INVENTORY_ALERT_GRACE_MS) {
        recovered.push({ region, available: inv.available, since: state.since });
        await clearState(db, key);
      } else await setState(db, key, JSON.stringify(state), now);
    }
  }

  const name = (r: { name: string; id: string }) => `${r.name} (${r.id})`;
  const lastRun = provider?.lastRun ?? null;
  let raised = 0;
  for (const [kind, hit] of confirmed) {
    const names = hit.map(({ region }) => name(region));
    const one = hit.length === 1 ? names[0]! : null;
    const ages = hit.map(({ inv }) => inv.checked_at ? t - inv.checked_at : null).filter((a): a is number => a !== null);
    const oldest = ages.length ? Math.max(...ages) : null;
    const errors = [...new Set(hit.map(({ inv }) => inv.last_error).filter((e): e is string => !!e))];
    const title = {
      quota: one
        ? `Region ${one} is out of AWS quota: every slot it allows is in use; new browsers cannot be created there`
        : `${hit.length} regions are out of AWS quota: ${listed(names)}; new browsers cannot be created there`,
      stale: `AWS inventory refresh is behind in ${one ? `region ${one}` : `${hit.length} regions (${listed(names)})`}: ${oldest !== null ? `snapshot ${minutes(oldest)} old` : 'never refreshed'}, AWS quota itself is not exhausted; new browsers are paused there until the reconciler refreshes it`,
      sync_failed: `AWS inventory refresh is failing in ${one ? `region ${one}` : `${hit.length} regions (${listed(names)})`}: ${listed(errors, 2) || 'unknown error'}; new browsers are paused there`,
      prices: `Prices are missing or out of date in ${one ? `region ${one}` : `${hit.length} regions (${listed(names)})`}; new browsers are paused there`,
    }[kind];
    // Every AWS region unusable for a reason of ours means the refresh itself is down.
    const outage = kind !== 'quota' && hit.length === monitored && monitored > 1;
    await raiseAlert(db, {
      source: 'api',
      severity: outage ? 'critical' : 'warning',
      title,
      detail: {
        kind,
        regions: hit.map(({ region, inv }) => ({
          regionId: region.id, availability: inv.availability, reason: inv.reason, status: inv.status, quotaAvailable: inv.quota_available,
          checkedAt: inv.checked_at, snapshotAgeMs: inv.checked_at ? t - inv.checked_at : null, lastError: inv.last_error, lastErrorAt: inv.last_error_at, syncFailures: inv.sync_failures,
        })),
        ...(kind === 'quota' ? {} : { lastRun }),
      },
    }, now);
    raised++;
  }
  if (recovered.length) {
    const title = recovered.length === 1
      ? `Region ${name(recovered[0]!.region)} has inventory again (${recovered[0]!.available} available)`
      : `${recovered.length} regions have inventory again: ${listed(recovered.map((r) => `${name(r.region)}: ${r.available}`))}`;
    await raiseAlert(db, { source: 'api', severity: 'info', title, detail: { regions: recovered.map((r) => ({ regionId: r.region.id, available: r.available, recoveredSince: r.since })) } }, now);
    raised++;
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
