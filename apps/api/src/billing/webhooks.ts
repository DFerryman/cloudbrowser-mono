/**
 * Creem webhooks (page 6). The receiver checks the signature over the raw body, stores the event
 * by its id (duplicates are ignored) and answers at once; processing runs from the
 * `cloudbrowser-billing` queue, with the api's cron as a backstop for lost messages.
 *
 * A top-up is credited only from Creem's own record of the checkout (re-fetched, never from the
 * webhook body or the success redirect), once per order.
 */
import { raiseAlert, schema, type Db } from '@cloudbrowser/db';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Env } from '../env.js';
import { BillingError, idOf, type Creem, verifyWebhookSignature } from './creem.js';
import { applyBalance, centsToMicros, freezeAccount, notifyHub } from './ledger.js';

const { webhookEvents, topupCheckouts, topupPacks, billingCustomers, balanceTransactions, auditLog } = schema;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Returns 401 for a bad signature, 200 otherwise (including duplicates). */
export async function receiveWebhook(env: Env, db: Db, raw: string, signature: string | undefined, now = new Date()): Promise<number> {
  if (!env.CREEM_WEBHOOK_SECRET || !(await verifyWebhookSignature(env.CREEM_WEBHOOK_SECRET, raw, signature))) return 401;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 400;
  }
  const id = str(event.id);
  const type = str(event.eventType) ?? str(event.event_type) ?? 'unknown';
  if (!id) return 400;
  const fresh = await db
    .insert(webhookEvents)
    .values({ id, type, payload: event, receivedAt: now })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (fresh.length && env.BILLING) await env.BILLING.send({ eventId: id }).catch((e) => console.error('billing enqueue failed', e));
  return 200;
}

/**
 * Credits a completed top-up checkout. Idempotent: the order id is the balance reference.
 * Returns the user credited, or null if there was nothing (yet) to credit.
 */
export async function creditCheckout(db: Db, creem: Creem, checkoutId: string, now: Date): Promise<string | null> {
  const c = await creem.getCheckout(checkoutId);
  const [attempt] = c.requestId ? await db.select().from(topupCheckouts).where(eq(topupCheckouts.id, c.requestId)) : [];
  const userId = attempt?.userId ?? (typeof c.metadata.userId === 'string' ? c.metadata.userId : null);
  if (!userId) throw new BillingError(`Cannot match checkout ${c.id} to a user`);
  if (c.status !== 'completed' || (c.orderStatus && c.orderStatus !== 'paid')) return null;
  const productId = c.productId ?? attempt?.productId ?? null;
  if (!productId || !creem.topupProductIds.includes(productId)) throw new BillingError(`Checkout ${c.id} is for ${productId ?? 'no product'}, not a top-up`);
  // The pack's price as read from Creem is what the user was offered and what is credited.
  let [pack] = await db.select().from(topupPacks).where(eq(topupPacks.productId, productId));
  if (!pack) {
    const p = await creem.getProduct(productId);
    pack = { productId, name: p.name, amountCents: p.priceCents, currency: p.currency, active: true, fetchedAt: now };
  }
  if (pack.currency !== 'USD' || pack.amountCents <= 0) throw new BillingError(`Top-up product ${productId} has no USD price`);
  if (c.customerId) await db.insert(billingCustomers).values({ userId, creemCustomerId: c.customerId, createdAt: now }).onConflictDoNothing();
  await applyBalance(
    db,
    {
      userId,
      kind: 'topup',
      amountMicros: centsToMicros(pack.amountCents),
      reference: `order:${c.orderId ?? c.id}`,
      productId,
      description: pack.name,
      actor: 'creem',
    },
    now,
  );
  if (attempt) await db.update(topupCheckouts).set({ checkoutId: c.id, creditedAt: now }).where(eq(topupCheckouts.id, attempt.id));
  return userId;
}

/** The user an order, checkout or customer belongs to, from our own records. */
async function userFor(db: Db, o: Record<string, unknown>): Promise<string | null> {
  const orderId = idOf(o.order);
  if (orderId) {
    const [tx] = await db.select({ userId: balanceTransactions.userId }).from(balanceTransactions).where(eq(balanceTransactions.reference, `order:${orderId}`));
    if (tx) return tx.userId;
  }
  const customerId = idOf(o.customer);
  if (customerId) {
    const [c] = await db.select().from(billingCustomers).where(eq(billingCustomers.creemCustomerId, customerId));
    if (c) return c.userId;
  }
  return null;
}

/** Applies one stored event. Idempotent: re-running it gives the same final state. */
export async function processWebhook(env: Env, db: Db, creem: Creem, eventId: string, now = new Date()): Promise<void> {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventId));
  if (!row || row.processedAt) return;
  const o = obj(row.payload.object);
  let userId: string | null = null;
  try {
    switch (row.type) {
      case 'checkout.completed': {
        const checkoutId = str(o.id);
        if (checkoutId) userId = await creditCheckout(db, creem, checkoutId, now);
        break;
      }
      case 'refund.created': {
        // A refund takes the refunded amount back out of the balance (it may go below zero).
        userId = await userFor(db, o);
        const cents = Number(o.refund_amount ?? o.amount ?? NaN);
        const refundId = str(o.id);
        if (userId && refundId && Number.isFinite(cents) && cents > 0) {
          await applyBalance(db, { userId, kind: 'refund', amountMicros: -centsToMicros(cents), reference: `refund:${refundId}`, description: 'Refund', actor: 'creem' }, now);
        }
        break;
      }
      case 'dispute.created': {
        userId = await userFor(db, o);
        const cents = Number(o.amount ?? NaN);
        const disputeId = str(o.id);
        if (userId) {
          await freezeAccount(db, userId, 'dispute', now);
          if (disputeId && Number.isFinite(cents) && cents > 0) {
            await applyBalance(db, { userId, kind: 'dispute', amountMicros: -centsToMicros(cents), reference: `dispute:${disputeId}`, description: 'Payment disputed', actor: 'creem' }, now);
          }
        }
        await raiseAlert(db, { source: 'billing', severity: 'critical', title: `Creem dispute${userId ? ` by user ${userId}` : ''}: account frozen`, detail: { eventId, userId } }, now);
        break;
      }
      default:
        break; // logged by being stored
    }
    await db.batch([
      db.update(webhookEvents).set({ processedAt: now, error: null, attempts: row.attempts + 1 }).where(eq(webhookEvents.id, eventId)),
      db.insert(auditLog).values({
        actor: 'creem',
        action: `webhook.${row.type}`,
        target: userId ? `user:${userId}` : `event:${eventId}`,
        detail: { eventId },
        createdAt: now,
      }),
    ]);
    if (userId) await notifyHub(env, userId);
  } catch (e) {
    await db
      .update(webhookEvents)
      .set({ attempts: row.attempts + 1, error: (e as Error).message.slice(0, 500) })
      .where(eq(webhookEvents.id, eventId));
    throw e;
  }
}

/** Events whose queue message was lost or whose processing failed (retried up to 10 times). */
export async function pendingWebhooks(db: Db, now: Date) {
  const rows = await db
    .select({ id: webhookEvents.id, attempts: webhookEvents.attempts })
    .from(webhookEvents)
    .where(and(isNull(webhookEvents.processedAt), lt(webhookEvents.receivedAt, new Date(now.getTime() - 60_000))));
  return rows.filter((r) => r.attempts < 10).map((r) => r.id);
}
