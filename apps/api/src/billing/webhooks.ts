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
  if (c.id !== checkoutId) throw new BillingError('Checkout identity mismatch');
  const [attempt] = c.requestId ? await db.select().from(topupCheckouts).where(eq(topupCheckouts.id, c.requestId)) : [];
  if (!attempt || (attempt.checkoutId && attempt.checkoutId !== checkoutId)) throw new BillingError(`Cannot match checkout ${c.id} to a local request`);
  const userId = attempt.userId;
  if ((c.metadata.userId && c.metadata.userId !== userId) || (c.metadata.attemptId && c.metadata.attemptId !== attempt.id)) throw new BillingError('Checkout metadata mismatch');
  if (c.status !== 'completed') return null;
  if (c.orderStatus !== 'paid' || !c.orderId) throw new BillingError('Completed checkout has no settled order');
  const productId = c.productId;
  if (!productId || productId !== attempt.productId) throw new BillingError('Checkout product mismatch');
  if (c.orderCurrency !== 'USD' || !Number.isSafeInteger(c.paidCents) || !Number.isSafeInteger(c.taxCents)
    || c.paidCents! <= 0 || c.taxCents! < 0 || c.taxCents! >= c.paidCents! || !Number.isSafeInteger(centsToMicros(c.paidCents! - c.taxCents!))) throw new BillingError('Checkout has no valid paid USD amounts');
  const netCents = c.paidCents! - c.taxCents!;
  const [pack] = await db.select().from(topupPacks).where(eq(topupPacks.productId, productId));
  if (c.customerId) {
    const [owner] = await db.select().from(billingCustomers).where(eq(billingCustomers.creemCustomerId, c.customerId));
    if (owner && owner.userId !== userId) throw new BillingError('Checkout customer belongs to another user');
  }
  if (c.customerId) await db.insert(billingCustomers).values({ userId, creemCustomerId: c.customerId, createdAt: now }).onConflictDoNothing();
  await applyBalance(
    db,
    {
      userId,
      kind: 'topup',
      amountMicros: centsToMicros(netCents),
      orderId: c.orderId,
      grossAmountCents: c.paidCents!,
      currency: c.orderCurrency,
      reference: `order:${c.orderId ?? c.id}`,
      productId,
      description: pack?.name ?? 'Prepaid credit',
      actor: 'creem',
    },
    now,
  );
  if (attempt) await db.update(topupCheckouts).set({ checkoutId: c.id, creditedAt: now }).where(eq(topupCheckouts.id, attempt.id));
  return userId;
}

/** Reversals must name the exact credited payment; a customer alone is ambiguous. */
async function paymentFor(db: Db, o: Record<string, unknown>) {
  const orderId = idOf(o.order) ?? idOf(obj(o.transaction).order);
  if (!orderId) throw new BillingError('Reversal has no order id');
  const [payment] = await db.select().from(balanceTransactions).where(eq(balanceTransactions.reference, `order:${orderId}`));
  if (!payment || payment.kind !== 'topup' || payment.currency !== 'USD' || !payment.grossAmountCents) {
    // Webhooks may arrive out of order. Leave this event pending until checkout credit is recorded.
    throw new BillingError(`Payment ${orderId} has not been credited yet`);
  }
  return { payment, orderId };
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
      case 'refund.created':
      case 'dispute.created': {
        const dispute = row.type === 'dispute.created';
        const { payment, orderId } = await paymentFor(db, o);
        userId = payment.userId;
        const cents = Number(dispute ? o.amount : o.refund_amount ?? o.amount ?? NaN);
        const reversalId = str(o.id);
        const currency = str(dispute ? o.currency : o.refund_currency ?? o.currency)?.toUpperCase();
        if (!reversalId || !Number.isSafeInteger(cents) || cents <= 0 || currency !== payment.currency) throw new BillingError('Reversal has invalid id, amount or currency');
        if (!dispute && o.status !== 'succeeded') throw new BillingError('Refund has not succeeded');
        if (dispute) await freezeAccount(db, userId, 'dispute', now);
        await applyBalance(db, {
          userId, kind: dispute ? 'dispute' : 'refund', amountMicros: 0,
          reference: `${dispute ? 'dispute' : 'refund'}:${reversalId}`, description: dispute ? 'Payment disputed' : 'Refund', actor: 'creem',
          currency, reversal: { orderId, grossAmountCents: cents },
        }, now);
        if (dispute) await raiseAlert(db, { source: 'billing', severity: 'critical', title: `Creem dispute by user ${userId}: account frozen`, detail: { eventId, userId } }, now);
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

/** Pending events, including out-of-order reversals, keep retrying until reconciled. */
export async function pendingWebhooks(db: Db, now: Date) {
  const rows = await db
    .select({ id: webhookEvents.id, attempts: webhookEvents.attempts })
    .from(webhookEvents)
    .where(and(isNull(webhookEvents.processedAt), lt(webhookEvents.receivedAt, new Date(now.getTime() - 60_000))));
  return rows.map((r) => r.id);
}
