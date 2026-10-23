/**
 * The prepaid balance (page 6). Usage is taken from it by the engine every minute; everything else
 * (top-ups, refunds, disputes, operator credits) is a `balance_transactions` row with a unique
 * reference, applied in one D1 batch so a retried webhook or click never changes a balance twice.
 */
import { MICROS_PER_USD, type TopUpPack } from '@cloudbrowser/contracts';
import { eventRow, newId, pricingSettings, reservedTotalSql, schema, type Db } from '@cloudbrowser/db';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { Creem } from './creem.js';

const { balanceTransactions, billingAccounts, events, topupPacks, auditLog, browserInstances, browserReservations } = schema;

/** The reservation's browser is kept: not deleted or being deleted. */
const keptBrowser = sql`EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.id} = ${browserReservations.instanceId} AND ${browserInstances.desiredState} <> 'deleted' AND ${browserInstances.status} NOT IN ('deleting', 'purged', 'failed'))`;
/** The balance covers every kept browser's full deposit plus the minimum balance: retention can end. */
const depositsFunded = (userId: string, minimum: number) => sql`EXISTS (SELECT 1 FROM ${billingAccounts} WHERE ${billingAccounts.userId} = ${userId}
  AND ${billingAccounts.balanceMicros} >= coalesce((SELECT sum(br.required_micros) FROM browser_reservations br JOIN browser_instances bi ON bi.id = br.instance_id WHERE br.user_id = ${userId} AND bi.desired_state <> 'deleted' AND bi.status NOT IN ('deleting', 'purged', 'failed')), 0) + ${minimum})`;

export type BalanceKind = 'topup' | 'refund' | 'dispute' | 'adjustment' | 'promotion' | 'signup';

interface BalanceChange {
  userId: string;
  kind: BalanceKind;
  amountMicros: number;
  reference: string;
  actor: string;
  productId?: string | null;
  description?: string | null;
  orderId?: string;
  grossAmountCents?: number;
  currency?: string;
  reversal?: { orderId: string; grossAmountCents: number };
}

/** Wakes the user's EventHub so open pages pick up the new balance. */
export function notifyHub(env: Env, userId: string): Promise<unknown> {
  const stub = env.EVENT_HUB.get(env.EVENT_HUB.idFromName(userId));
  return stub.fetch(`https://hub/notify?userId=${encodeURIComponent(userId)}`, { method: 'POST' }).catch((e) => console.error('notify failed', e));
}

export const centsToMicros = (cents: number) => Math.round(cents * (MICROS_PER_USD / 100));

/**
 * Adds `amountMicros` (negative to take away) to the user's balance once per `reference`.
 * Returns false if that reference was already applied.
 */
export async function applyBalance(
  db: Db,
  change: BalanceChange,
  now: Date,
): Promise<boolean> {
  // Reversals are calculated in the transaction. Cumulative gross refunds map to the
  // original net credit, so tax and a dispute after a refund cannot overdraw a payment.
  const reversal = change.reversal;
  const appliedAmount = reversal ? sql`(SELECT -max(0,
    round(min(original.gross_amount_cents, coalesce((SELECT sum(gross_amount_cents) FROM balance_transactions WHERE order_id = ${reversal.orderId} AND kind IN ('refund', 'dispute')), 0) + ${reversal.grossAmountCents})
      * 1.0 * original.amount_micros / original.gross_amount_cents)
    + coalesce((SELECT sum(amount_micros) FROM balance_transactions WHERE order_id = ${reversal.orderId} AND kind IN ('refund', 'dispute')), 0))
    FROM balance_transactions AS original WHERE original.reference = ${`order:${reversal.orderId}`} AND original.kind = 'topup' AND original.gross_amount_cents > 0)` : change.amountMicros;
  const amount = sql`coalesce((SELECT ${balanceTransactions.amountMicros} FROM ${balanceTransactions} WHERE ${balanceTransactions.reference} = ${change.reference} AND ${balanceTransactions.appliedAt} IS NULL), 0)`;
  const minimum = Math.max(1, (await pricingSettings(db)).minBalanceMicros);
  const held = reservedTotalSql(change.userId);
  const [inserted] = await db.batch([
    db
      .insert(balanceTransactions)
      .values({
        id: newId(now.getTime()),
        userId: change.userId,
        kind: change.kind,
        amountMicros: appliedAmount,
        orderId: change.orderId ?? reversal?.orderId ?? null,
        grossAmountCents: change.grossAmountCents ?? reversal?.grossAmountCents ?? null,
        currency: change.currency ?? null,
        reference: change.reference,
        productId: change.productId ?? null,
        description: change.description ?? null,
        actor: change.actor,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: balanceTransactions.id, amountMicros: balanceTransactions.amountMicros }),
    db.insert(billingAccounts).values({ userId: change.userId, balanceMicros: 0, updatedAt: now }).onConflictDoNothing(),
    db
      .update(billingAccounts)
      .set({ balanceMicros: sql`${billingAccounts.balanceMicros} + ${amount}`, updatedAt: now })
      .where(eq(billingAccounts.userId, change.userId)),
    // A top-up restores spent retention deposits only when all of them and usable credit fit.
    db.update(browserReservations).set({ reservedMicros: sql`${browserReservations.requiredMicros}`,
      retentionStartedAt: null, retentionEndsAt: null, updatedAt: now,
    }).where(and(eq(browserReservations.userId, change.userId), sql`${amount} > 0`, keptBrowser, depositsFunded(change.userId, minimum))),
    db
      .update(balanceTransactions)
      .set({ appliedAt: now })
      .where(and(eq(balanceTransactions.reference, change.reference), isNull(balanceTransactions.appliedAt))),
    // Back above zero: the retention clock stops once the deposits and usable credit are funded.
    db
      .update(billingAccounts)
      .set({ exhaustedAt: null })
      .where(and(eq(billingAccounts.userId, change.userId), sql`${billingAccounts.balanceMicros} - ${held} >= ${minimum}`)),
    db.insert(events).values(eventRow(change.userId, 'entitlements.updated', { balance: true }, now)),
    db.insert(auditLog).values({
      actor: change.actor,
      action: `balance.${change.kind}`,
      target: `user:${change.userId}`,
      detail: sql`json_object('amountMicros', (SELECT amount_micros FROM balance_transactions WHERE reference = ${change.reference}), 'reference', ${change.reference})`,
      createdAt: now,
    }),
  ]);
  return inserted.length > 0;
}

/** Freezes an account after a dispute: nothing runs or is created until an operator unfreezes it. */
export async function freezeAccount(db: Db, userId: string, reason: string, now: Date) {
  await db.insert(billingAccounts).values({ userId, balanceMicros: 0, updatedAt: now }).onConflictDoNothing();
  await db.update(billingAccounts).set({ frozenAt: now, frozenReason: reason, updatedAt: now }).where(eq(billingAccounts.userId, userId));
}

/**
 * Lifts a dispute hold. Nothing could be deleted while it was on, so a deletion clock that was
 * already running resumes with the time it had left. A balance that funds every deposit ends
 * retention, as a top-up does; that also repairs clocks earlier versions started for a frozen
 * account that still had credit. Browsers stay asleep until they are opened.
 */
export async function unfreezeAccount(db: Db, userId: string, now: Date) {
  const minimum = Math.max(1, (await pricingSettings(db)).minBalanceMicros);
  const frozenAt = sql`(SELECT ${billingAccounts.frozenAt} FROM ${billingAccounts} WHERE ${billingAccounts.userId} = ${userId})`;
  await db.batch([
    db.update(browserReservations).set({ retentionEndsAt: sql`${browserReservations.retentionEndsAt} + ${now.getTime()} - max(${frozenAt}, ${browserReservations.retentionStartedAt})`, updatedAt: now })
      .where(and(eq(browserReservations.userId, userId), isNotNull(browserReservations.retentionStartedAt), sql`${browserReservations.retentionEndsAt} > ${frozenAt}`)),
    db.update(browserReservations).set({ reservedMicros: sql`${browserReservations.requiredMicros}`, retentionStartedAt: null, retentionEndsAt: null, updatedAt: now })
      .where(and(eq(browserReservations.userId, userId), isNotNull(browserReservations.retentionStartedAt), keptBrowser, depositsFunded(userId, minimum))),
    db.update(billingAccounts).set({ exhaustedAt: null }).where(and(eq(billingAccounts.userId, userId), sql`${billingAccounts.balanceMicros} - ${reservedTotalSql(userId)} >= ${minimum}`)),
    db.update(billingAccounts).set({ frozenAt: null, frozenReason: null, updatedAt: now }).where(eq(billingAccounts.userId, userId)),
    db.insert(events).values(eventRow(userId, 'entitlements.updated', { balance: true }, now)),
  ]);
}

/**
 * Reads the configured top-up products from Creem (name, price, currency) into `topup_packs`.
 * Only one-time USD products are offered: the balance is kept in USD.
 */
export async function refreshTopupPacks(db: Db, creem: Creem, now: Date) {
  const seen: string[] = [];
  for (const id of creem.topupProductIds) {
    try {
      const p = await creem.getProduct(id);
      const usable = p.billingType === 'onetime' && p.currency === 'USD' && p.priceCents > 0;
      if (!usable) console.error('top-up product skipped (needs a one-time USD price)', id, p);
      const values = { name: p.name, amountCents: p.priceCents, currency: p.currency, active: usable, fetchedAt: now };
      await db.insert(topupPacks).values({ productId: id, ...values }).onConflictDoUpdate({ target: topupPacks.productId, set: values });
      seen.push(id);
    } catch (e) {
      console.error('top-up product refresh failed', id, e);
    }
  }
  // Products removed from CREEM_TOPUP_PRODUCTS are no longer offered.
  for (const row of await db.select().from(topupPacks)) {
    if (!creem.topupProductIds.includes(row.productId) && row.active) {
      await db.update(topupPacks).set({ active: false }).where(eq(topupPacks.productId, row.productId));
    }
  }
  return seen.length;
}

/** The top-ups on offer; read from Creem the first time (afterwards the billing cron refreshes them hourly). */
export async function offeredTopupPacks(db: Db, creem: Creem | null, now = new Date()): Promise<TopUpPack[]> {
  if (creem && (await db.select({ id: topupPacks.productId }).from(topupPacks).limit(1)).length === 0) {
    await refreshTopupPacks(db, creem, now).catch((e) => console.error('top-up refresh failed', e));
  }
  return activeTopupPacks(db);
}

export async function activeTopupPacks(db: Db): Promise<TopUpPack[]> {
  const rows = await db.select().from(topupPacks).where(eq(topupPacks.active, true)).orderBy(asc(topupPacks.amountCents));
  return rows.map((r) => ({ productId: r.productId, name: r.name, amountCents: r.amountCents, currency: r.currency }));
}
