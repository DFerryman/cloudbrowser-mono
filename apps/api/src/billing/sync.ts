/**
 * Billing state (page 6): Creem is the source of truth. Every webhook and every plan change ends
 * in `syncSubscription`, which re-fetches the subscription from Creem, stores the mirror and
 * recomputes the user's caps under the `billing:<userId>` scope. Event order never matters.
 */
import { planFamily, planLimits, subscriptionAccess, type Access, type Plan, type PlanKey } from '@cloudbrowser/contracts';
import { eventRow, schema, type Db } from '@cloudbrowser/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Env } from '../env.js';
import { BillingError, type Creem } from './creem.js';

const { subscriptions, billingCustomers, caps, events, user, auditLog } = schema;
type SubRow = typeof subscriptions.$inferSelect;

const ACCESS_RANK: Record<Access, number> = { active: 3, ending: 2, grace: 1, none: 0 };

export function accessOf(s: SubRow, now: Date): Access {
  if (s.revokedAt) return 'none';
  return subscriptionAccess(s, now);
}

/** The subscription that decides the user's plan: the one with the best access, then most browsers. */
export function bestSubscription(subs: SubRow[], now: Date): { sub: SubRow; access: Access } | null {
  const ranked = subs
    .map((sub) => ({ sub, access: accessOf(sub, now) }))
    .filter((x) => x.access !== 'none')
    .sort((a, b) => ACCESS_RANK[b.access] - ACCESS_RANK[a.access] || b.sub.units - a.sub.units);
  return ranked[0] ?? null;
}

export async function planOf(db: Db, userId: string, now: Date, required: boolean): Promise<Plan> {
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const best = bestSubscription(subs, now);
  if (best) return planFamily(best.sub.plan as PlanKey);
  return subs.length > 0 || required ? 'none' : 'pilot';
}

/** Wakes the user's EventHub so open dashboards pick up the new entitlements. */
export function notifyHub(env: Env, userId: string): Promise<unknown> {
  const stub = env.EVENT_HUB.get(env.EVENT_HUB.idFromName(userId));
  return stub.fetch(`https://hub/notify?userId=${encodeURIComponent(userId)}`, { method: 'POST' }).catch((e) => console.error('notify failed', e));
}

/**
 * Writes the caps a user's subscriptions grant. With no access left, the caps go to zero: the
 * engine puts running browsers to sleep within a minute and starts are refused; data and IPs stay.
 * Returns true if anything changed.
 */
export async function recomputeEntitlements(env: Env, db: Db, userId: string, now: Date): Promise<boolean> {
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  if (subs.length === 0) return false;
  const best = bestSubscription(subs, now);
  const limits = best ? planLimits(best.sub.plan as PlanKey, best.sub.units) : null;
  const wanted: Record<string, number> = limits
    ? {
        instances: limits.maxBrowsers,
        running: limits.maxRunning,
        hours_per_month: limits.hoursPerMonth,
        idle_timeout_max_s: limits.idleTimeoutMaxS,
        storage_gb: limits.storageGb,
        fps_max: limits.fpsMax,
        snapshot_retention_days: limits.snapshotRetentionDays,
        ip_changes_per_month: limits.ipChangesPerMonth,
      }
    : { instances: 0, running: 0, hours_per_month: 0, ip_changes_per_month: 0 };

  const scope = `billing:${userId}`;
  const current = await db.select().from(caps).where(eq(caps.scope, scope));
  const same =
    current.length === Object.keys(wanted).length && current.every((r) => wanted[r.metric] === r.limit);

  const stmts: BatchItem<'sqlite'>[] = [];
  for (const s of subs) {
    const ended = accessOf(s, now) === 'none';
    if (ended && !s.accessEndedAt) stmts.push(db.update(subscriptions).set({ accessEndedAt: now }).where(eq(subscriptions.id, s.id)));
    if (!ended && s.accessEndedAt) stmts.push(db.update(subscriptions).set({ accessEndedAt: null }).where(eq(subscriptions.id, s.id)));
  }
  if (!same) {
    stmts.push(db.delete(caps).where(eq(caps.scope, scope)));
    stmts.push(db.insert(caps).values(Object.entries(wanted).map(([metric, limit]) => ({ scope, metric, limit }))));
    stmts.push(db.insert(events).values(eventRow(userId, 'entitlements.updated', { plan: best ? best.sub.plan : 'none' }, now)));
    stmts.push(
      db.insert(auditLog).values({
        actor: 'billing',
        action: best ? 'billing.entitlements' : 'billing.access_ended',
        target: `user:${userId}`,
        detail: { plan: best?.sub.plan ?? null, units: best?.sub.units ?? 0, access: best?.access ?? 'none' },
        createdAt: now,
      }),
    );
  }
  if (stmts.length) await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  return !same;
}

/** Re-fetches one subscription from Creem, stores it and recomputes the owner's entitlements. */
export async function syncSubscription(
  env: Env,
  db: Db,
  creem: Creem,
  subscriptionId: string,
  hint: { userId?: string | null },
  now: Date,
): Promise<string> {
  const s = await creem.getSubscription(subscriptionId);
  const plan = creem.planForProduct(s.productId);
  if (!plan) throw new BillingError(`Subscription ${s.id} is for an unknown product ${s.productId}`);

  const [existing] = await db.select().from(subscriptions).where(eq(subscriptions.id, s.id));
  let userId = existing?.userId ?? hint.userId ?? (typeof s.metadata.userId === 'string' ? s.metadata.userId : null);
  if (!userId && s.customerId) {
    const [c] = await db.select().from(billingCustomers).where(eq(billingCustomers.creemCustomerId, s.customerId));
    userId = c?.userId ?? null;
  }
  if (!userId) throw new BillingError(`Cannot match subscription ${s.id} to a user`);
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId));
  if (!u) throw new BillingError(`Subscription ${s.id} names unknown user ${userId}`);

  const pastDue = s.status === 'past_due' || s.status === 'unpaid';
  const row = {
    userId,
    plan,
    productId: s.productId,
    itemId: s.itemId,
    units: planFamily(plan) === 'pro' ? s.units : 1,
    status: s.status,
    currentPeriodEnd: s.currentPeriodEnd,
    pastDueSince: pastDue ? (existing?.pastDueSince ?? now) : null,
    syncedAt: now,
  };
  const stmts: BatchItem<'sqlite'>[] = [
    db
      .insert(subscriptions)
      .values({ id: s.id, ...row, createdAt: now })
      .onConflictDoUpdate({ target: subscriptions.id, set: row }),
  ];
  if (s.customerId) {
    stmts.push(db.insert(billingCustomers).values({ userId, creemCustomerId: s.customerId, createdAt: now }).onConflictDoNothing());
  }
  await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  await recomputeEntitlements(env, db, userId, now);
  return userId;
}

/** Full refund or dispute: no access whatever Creem's status says (page 6, event handling). */
export async function revokeSubscription(env: Env, db: Db, subscriptionId: string, reason: string, now: Date): Promise<string | null> {
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
  if (!s) return null;
  await db
    .update(subscriptions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(subscriptions.id, subscriptionId), isNull(subscriptions.revokedAt)));
  await recomputeEntitlements(env, db, s.userId, now);
  return s.userId;
}
