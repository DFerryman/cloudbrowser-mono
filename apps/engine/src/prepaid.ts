import { DATA_KEPT_DAYS } from '@cloudbrowser/contracts';
import { billingRequired, prepaidAccess, prepaidBalance, pricingSettings, reservationQuote, reservationWrite, reservedTotalSql, schema, type Db } from '@cloudbrowser/db';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { StepFailed, type EngineDeps, type StepEnv } from './context.js';
import { errorMessages, retryD1 } from './errors.js';

const { browserInstances, browserReservations, billingAccounts, operations, viewerSessions } = schema;

/** Legacy assets receive a safe seven-day window; a deployment never destroys their data at once. */
export async function reconcileReservations(deps: EngineDeps) {
  const { db } = deps;
  if (!(await billingRequired(db))) return;
  const now = deps.now();
  const all = await db.select().from(browserInstances);
  const holds = new Map((await db.select().from(browserReservations)).map((hold) => [hold.instanceId, hold]));
  const pending = await db.select().from(operations).where(isNull(operations.finishedAt));
  const { minBalanceMicros } = await pricingSettings(db);
  for (const inst of all) {
    const hold = holds.get(inst.id);
    const removed = inst.desiredState === 'deleted' || ['deleting', 'purged', 'failed'].includes(inst.status);
    if (removed) {
      // Historic purged browsers often have no deposit. Do not write them every minute.
      // Recheck lifecycle in SQL so a concurrent funded recovery cannot lose its new deposit.
      if (hold && hold.reservedMicros > 0) await retryD1(async () => {
        await db.update(browserReservations).set({ reservedMicros: 0, updatedAt: now }).where(and(
          eq(browserReservations.instanceId, inst.id), gt(browserReservations.reservedMicros, 0),
          sql`EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.id} = ${inst.id}
            AND (${browserInstances.desiredState} = 'deleted' OR ${browserInstances.status} IN ('deleting', 'purged', 'failed')))`,
        ));
      }, deps.sleep);
      continue;
    }
    if (hold?.retentionStartedAt) continue;
    const resize = pending.find((o) => o.instanceId === inst.id && o.kind === 'resize_volume');
    const target = Number((resize?.params as { sizeGb?: number } | null)?.sizeGb ?? inst.storageGb);
    const quote = await reservationQuote(db, inst.regionId, { ...inst, instanceId: inst.id, storageGb: Math.max(inst.storageGb, target) }, now);
    if (!quote) continue;
    const account = await prepaidBalance(db, inst.userId);
    // A dispute hold pauses these decisions: no deposit is taken and no retention clock starts
    // (a price change would otherwise start one) until an operator lifts it.
    if (account.frozenAt) continue;
    try {
      if (account.availableMicros + (hold?.reservedMicros ?? 0) >= quote.requiredMicros + (hold ? 1 : Math.max(1, minBalanceMicros))) {
        if (!hold || hold.requiredMicros !== quote.requiredMicros || hold.reservedMicros < hold.requiredMicros) await reservationWrite(db, inst.userId, inst.id, quote, now);
      } else if (!hold) {
        await db.insert(billingAccounts).values({ userId: inst.userId, balanceMicros: 0, updatedAt: now }).onConflictDoNothing();
        await db.insert(browserReservations).values({ instanceId: inst.id, userId: inst.userId, ...quote,
          reservedMicros: Math.min(quote.requiredMicros, account.availableMicros), retentionStartedAt: now,
          retentionEndsAt: new Date(now.getTime() + DATA_KEPT_DAYS * 86_400_000), updatedAt: now,
        }).onConflictDoNothing();
        await db.update(billingAccounts).set({ exhaustedAt: now, updatedAt: now }).where(and(eq(billingAccounts.userId, inst.userId), isNull(billingAccounts.exhaustedAt)));
      } else if (hold.requiredMicros !== quote.requiredMicros || hold.reservedMicros < hold.requiredMicros) {
        await db.update(browserReservations).set({ requiredMicros: quote.requiredMicros, rates: quote.rates, fixedHourMicros: quote.fixedHourMicros,
          retentionStartedAt: now, retentionEndsAt: new Date(now.getTime() + DATA_KEPT_DAYS * 86_400_000), updatedAt: now,
        }).where(and(eq(browserReservations.instanceId, inst.id), isNull(browserReservations.retentionStartedAt)));
        await db.update(billingAccounts).set({ exhaustedAt: now, updatedAt: now }).where(and(eq(billingAccounts.userId, inst.userId), isNull(billingAccounts.exhaustedAt)));
      }
    } catch (e) {
      // The funding trigger arbitrates concurrent admissions; try the fresh balance next tick.
      if (!errorMessages(e).some((message) => message.includes('insufficient_prepaid_reserve'))) throw e;
    }
  }
}

/** Called by operation fencing before any new provider-side cost; cleanup always remains possible. */
export async function assertOperationFunded(env: StepEnv) {
  if (!['create', 'start', 'recover', 'restore', 'undelete', 'resize_volume'].includes(env.op.kind)) return;
  const account = await prepaidBalance(env.deps.db, env.instance.userId);
  if (account.frozenAt) throw new StepFailed('Your account is frozen because of a payment dispute.');
  if (!(await billingRequired(env.deps.db))) return;
  const [hold] = await env.deps.db.select().from(browserReservations).where(eq(browserReservations.instanceId, env.instance.id));
  if (!hold || hold.retentionStartedAt || hold.reservedMicros < hold.requiredMicros || account.availableMicros <= 0) {
    throw new StepFailed('Insufficient prepaid credit. Usage is stopped; existing data and IP are kept for seven days.');
  }
}

/**
 * Enter retention without deleting anything. The held credit can then fund only fixed assets.
 * Only credit that is gone counts: a dispute hold stops browsers but never starts the clock.
 */
export async function beginRetention(db: Db, userId: string, now: Date) {
  const insufficient = sql`EXISTS (SELECT 1 FROM ${billingAccounts} WHERE ${billingAccounts.userId} = ${userId}
    AND ${billingAccounts.frozenAt} IS NULL AND ${billingAccounts.balanceMicros} - ${reservedTotalSql(userId)} <= 0)`;
  await db.batch([
    db.update(browserReservations).set({ retentionStartedAt: now,
      retentionEndsAt: new Date(now.getTime() + DATA_KEPT_DAYS * 86_400_000), updatedAt: now,
    }).where(and(eq(browserReservations.userId, userId), isNull(browserReservations.retentionStartedAt), insufficient)),
    db.update(billingAccounts).set({ exhaustedAt: now, updatedAt: now }).where(and(eq(billingAccounts.userId, userId), isNull(billingAccounts.exhaustedAt), insufficient)),
    db.update(viewerSessions).set({ endedAt: now }).where(and(eq(viewerSessions.userId, userId), isNull(viewerSessions.endedAt), insufficient)),
    db.update(browserInstances).set({ desiredState: 'stopped', updatedAt: now }).where(and(eq(browserInstances.userId, userId),
      inArray(browserInstances.status, ['creating', 'starting', 'running', 'waiting_capacity', 'needs_attention']), insufficient)),
  ]);
}
