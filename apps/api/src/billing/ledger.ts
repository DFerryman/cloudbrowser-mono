/**
 * The prepaid balance (page 6). Usage is taken from it by the engine every minute; everything else
 * (top-ups, refunds, disputes, operator credits) is a `balance_transactions` row with a unique
 * reference, applied in one D1 batch so a retried webhook or click never changes a balance twice.
 */
import { MICROS_PER_USD, type TopUpPack } from '@cloudbrowser/contracts';
import { eventRow, newId, pricingSettings, schema, type Db } from '@cloudbrowser/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { Creem } from './creem.js';
import { convertTrials } from '../limits.js';

const { balanceTransactions, billingAccounts, events, topupPacks, auditLog } = schema;

export type BalanceKind = 'topup' | 'refund' | 'dispute' | 'adjustment';

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
  change: { userId: string; kind: BalanceKind; amountMicros: number; reference: string; productId?: string | null; description?: string | null; actor: string },
  now: Date,
): Promise<boolean> {
  const amount = sql`coalesce((SELECT ${balanceTransactions.amountMicros} FROM ${balanceTransactions} WHERE ${balanceTransactions.reference} = ${change.reference} AND ${balanceTransactions.appliedAt} IS NULL), 0)`;
  const [inserted] = await db.batch([
    db
      .insert(balanceTransactions)
      .values({
        id: newId(now.getTime()),
        userId: change.userId,
        kind: change.kind,
        amountMicros: change.amountMicros,
        reference: change.reference,
        productId: change.productId ?? null,
        description: change.description ?? null,
        actor: change.actor,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: balanceTransactions.id }),
    db.insert(billingAccounts).values({ userId: change.userId, balanceMicros: 0, updatedAt: now }).onConflictDoNothing(),
    db
      .update(billingAccounts)
      .set({ balanceMicros: sql`${billingAccounts.balanceMicros} + ${amount}`, updatedAt: now })
      .where(eq(billingAccounts.userId, change.userId)),
    db
      .update(balanceTransactions)
      .set({ appliedAt: now })
      .where(and(eq(balanceTransactions.reference, change.reference), isNull(balanceTransactions.appliedAt))),
    // Back above zero: the 30-day deletion clock and the sleep timer stop.
    db
      .update(billingAccounts)
      .set({ exhaustedAt: null })
      .where(and(eq(billingAccounts.userId, change.userId), sql`${billingAccounts.balanceMicros} > 0`)),
    db.insert(events).values(eventRow(change.userId, 'entitlements.updated', { balance: true }, now)),
    db.insert(auditLog).values({
      actor: change.actor,
      action: `balance.${change.kind}`,
      target: `user:${change.userId}`,
      detail: { amountMicros: change.amountMicros, reference: change.reference },
      createdAt: now,
    }),
  ]);
  if (inserted.length > 0 && change.amountMicros > 0) {
    // Paying converts a free trial browser into a normal one (same data and IP), if the balance is enough to run it.
    const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, change.userId));
    if ((account?.balanceMicros ?? 0) >= (await pricingSettings(db)).minBalanceMicros) {
      const converted = await convertTrials(db, change.userId, now);
      if (converted.length) {
        await db.insert(events).values(converted.map((c) => eventRow(change.userId, 'instance.updated', { instanceId: c.id }, now)));
      }
    }
  }
  return inserted.length > 0;
}

/** Freezes an account after a dispute: nothing runs or is created until an operator unfreezes it. */
export async function freezeAccount(db: Db, userId: string, reason: string, now: Date) {
  await db.insert(billingAccounts).values({ userId, balanceMicros: 0, updatedAt: now }).onConflictDoNothing();
  await db.update(billingAccounts).set({ frozenAt: now, frozenReason: reason, updatedAt: now }).where(eq(billingAccounts.userId, userId));
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
