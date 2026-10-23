/**
 * Stripe webhooks (page 6), the counterpart of ./webhooks.ts for Creem. The receiver checks the
 * `Stripe-Signature` over the raw body, stores the event as `stripe:<event id>` (duplicates are
 * ignored) and answers at once; processing runs from the same `cloudbrowser-billing` queue, with
 * the api's cron as a backstop for lost messages.
 *
 * Nothing in a webhook body is trusted beyond the event's type and object id: a top-up is credited
 * only from Stripe's own record of the Checkout Session (re-fetched), once per PaymentIntent;
 * refunds and disputes are applied from Stripe's refund and dispute records, with the same
 * proportional, capped ledger rules as Creem's. Payments this app did not start (no `attemptId`)
 * are left alone, so the Stripe account can also be used for other sales.
 *
 * Both payload formats a Stripe event destination can send are accepted: snapshot events
 * (`data.object`) and thin events (`v1.`-prefixed type, `related_object`). Stripe may send one
 * change as two events, so every effect is idempotent per object, not per event.
 */
import { raiseAlert, schema, type Db } from '@cloudbrowser/db';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { BillingError } from './creem.js';
import { applyBalance, centsToMicros, freezeAccount, notifyHub } from './ledger.js';
import { stripeWebhookSecret, verifyStripeSignature, type Stripe } from './stripe.js';

const { webhookEvents, topupCheckouts, topupPacks, stripeCustomers, balanceTransactions, billingAccounts, auditLog } = schema;

/** Stored Stripe events are keyed `stripe:<event id>`, apart from Creem's ids. */
export const STRIPE_EVENT_PREFIX = 'stripe:';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Returns 401 for a bad or stale signature, 200 otherwise (including duplicates). */
export async function receiveStripeWebhook(env: Env, db: Db, raw: string, signature: string | undefined, now = new Date()): Promise<number> {
  const secret = stripeWebhookSecret(env);
  if (!secret || !(await verifyStripeSignature(secret, raw, signature, now.getTime()))) return 401;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 400;
  }
  const id = str(event.id);
  if (!id) return 400;
  const key = `${STRIPE_EVENT_PREFIX}${id}`;
  // Thin events name the same types with a `v1.` prefix.
  const type = str(event.type)?.replace(/^v1\./, '') ?? 'unknown';
  const fresh = await db
    .insert(webhookEvents)
    .values({ id: key, provider: 'stripe', type, payload: event, receivedAt: now })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (fresh.length && env.BILLING) await env.BILLING.send({ eventId: key }).catch((e) => console.error('billing enqueue failed', e));
  return 200;
}

/**
 * Credits a paid top-up Checkout Session. Idempotent: the PaymentIntent is the balance reference.
 * Returns the user credited, or null if there was nothing (yet) to credit.
 */
export async function creditStripeCheckout(db: Db, stripe: Stripe, sessionId: string, now: Date): Promise<string | null> {
  const c = await stripe.getCheckout(sessionId);
  if (c.id !== sessionId) throw new BillingError('Checkout identity mismatch');
  // Every top-up session carries its attempt id in its own metadata. Without it the session is
  // another sale on the same account (a payment link, another integration), even with a
  // client_reference_id of its own.
  const attemptId = str(c.metadata.attemptId);
  if (!attemptId) return null;
  const [attempt] = await db.select().from(topupCheckouts).where(eq(topupCheckouts.id, attemptId));
  if (!attempt || attempt.provider !== 'stripe' || (attempt.checkoutId && attempt.checkoutId !== sessionId)) throw new BillingError(`Cannot match checkout ${c.id} to a local request`);
  const userId = attempt.userId;
  if (c.clientReferenceId !== attempt.id || c.metadata.userId !== userId) throw new BillingError('Checkout metadata mismatch');
  // Open or expired, or paid with a delayed method whose money has not arrived yet
  // (`checkout.session.async_payment_succeeded` follows).
  if (c.status !== 'complete' || c.paymentStatus === 'unpaid') return null;
  if (c.paymentStatus !== 'paid' || !c.paymentIntentId) throw new BillingError('Completed checkout has no settled payment');
  const productId = c.priceIds[0];
  if (c.priceIds.length !== 1 || productId !== attempt.productId) throw new BillingError('Checkout price mismatch');
  if (c.currency !== 'USD' || c.totalCents === null || c.taxCents === null
    || c.totalCents <= 0 || c.taxCents < 0 || c.taxCents >= c.totalCents || !Number.isSafeInteger(centsToMicros(c.totalCents - c.taxCents))) throw new BillingError('Checkout has no valid paid USD amounts');
  const netCents = c.totalCents - c.taxCents;
  const [pack] = await db.select().from(topupPacks).where(eq(topupPacks.productId, productId));
  if (c.customerId) {
    const [owner] = await db.select().from(stripeCustomers).where(eq(stripeCustomers.stripeCustomerId, c.customerId));
    if (owner && owner.userId !== userId) throw new BillingError('Checkout customer belongs to another user');
    await db.insert(stripeCustomers).values({ userId, stripeCustomerId: c.customerId, createdAt: now }).onConflictDoNothing();
  }
  await applyBalance(
    db,
    {
      userId,
      kind: 'topup',
      amountMicros: centsToMicros(netCents),
      orderId: c.paymentIntentId,
      grossAmountCents: c.totalCents,
      currency: c.currency,
      reference: `order:${c.paymentIntentId}`,
      productId,
      description: pack?.name ?? 'Prepaid credit',
      actor: 'stripe',
    },
    now,
  );
  await db.update(topupCheckouts).set({ checkoutId: c.id, creditedAt: now }).where(eq(topupCheckouts.id, attempt.id));
  return userId;
}

/**
 * The credited top-up a reversal names, or null for a payment this app never took. A top-up of
 * ours that is not credited yet throws: webhooks may arrive out of order, so the event stays
 * pending until the checkout credit is recorded.
 */
async function creditedPayment(db: Db, stripe: Stripe, paymentIntentId: string) {
  const [payment] = await db.select().from(balanceTransactions).where(eq(balanceTransactions.reference, `order:${paymentIntentId}`));
  if (payment && payment.kind === 'topup' && payment.currency === 'USD' && payment.grossAmountCents) return payment;
  if (!str((await stripe.paymentIntentMetadata(paymentIntentId)).attemptId)) return null;
  throw new BillingError(`Payment ${paymentIntentId} has not been credited yet`);
}

/**
 * Takes every succeeded refund of a payment off the balance, once per refund. A refund still
 * pending keeps the event pending (it is retried) until Stripe settles it; failed and canceled
 * refunds take nothing. A card refund can still fail weeks after it succeeded: the money stays
 * with us, so a `refund-failed:` row gives the credit back and takes the refund out of the
 * payment's refunded total (its gross is negative), so a later refund of the same payment is
 * still measured correctly. Operators are told.
 */
async function applyRefunds(db: Db, stripe: Stripe, paymentIntentId: string, now: Date): Promise<string | null> {
  const payment = await creditedPayment(db, stripe, paymentIntentId);
  if (!payment) return null;
  let waiting: string | null = null;
  for (const r of await stripe.listRefunds(paymentIntentId)) {
    if (r.status === 'pending' || r.status === 'requires_action') waiting = r.id;
    if (r.status === 'failed' || r.status === 'canceled') {
      const [taken] = await db.select().from(balanceTransactions).where(eq(balanceTransactions.reference, `refund:${r.id}`));
      if (taken?.appliedAt && taken.grossAmountCents) {
        const restored = await applyBalance(db, {
          userId: payment.userId, kind: 'refund', amountMicros: -taken.amountMicros, reference: `refund-failed:${r.id}`, description: 'Refund failed: credit restored', actor: 'stripe',
          orderId: paymentIntentId, grossAmountCents: -taken.grossAmountCents, currency: payment.currency ?? undefined,
        }, now);
        if (restored) {
          await raiseAlert(db, {
            source: 'billing', severity: 'warning',
            title: `Stripe refund ${r.id} for user ${payment.userId} ${r.status} after it was taken off the balance; the credit was given back`,
            detail: { userId: payment.userId, refundId: r.id, paymentIntentId, amountMicros: -taken.amountMicros },
          }, now);
        }
      }
    }
    if (r.status !== 'succeeded') continue;
    if (r.amountCents === null || r.amountCents <= 0 || r.currency !== payment.currency) throw new BillingError('Refund has invalid amount or currency');
    await applyBalance(db, {
      userId: payment.userId, kind: 'refund', amountMicros: 0, reference: `refund:${r.id}`, description: 'Refund', actor: 'stripe',
      currency: payment.currency ?? undefined, reversal: { orderId: paymentIntentId, grossAmountCents: r.amountCents },
    }, now);
  }
  if (waiting) throw new BillingError(`Refund ${waiting} has not succeeded yet`);
  return payment.userId;
}

/** Applies one stored Stripe event. Idempotent: re-running it gives the same final state. */
export async function processStripeWebhook(env: Env, db: Db, stripe: Stripe, eventId: string, now = new Date()): Promise<void> {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventId));
  if (!row || row.processedAt || row.provider !== 'stripe') return;
  const objectId = str(obj(obj(row.payload.data).object).id) ?? str(obj(row.payload.related_object).id);
  let userId: string | null = null;
  try {
    // An event from the other mode (a test endpoint pointed here) cannot be read back with this key.
    const otherMode = typeof row.payload.livemode === 'boolean' && row.payload.livemode !== stripe.livemode;
    if (objectId && !otherMode) {
      switch (row.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          userId = await creditStripeCheckout(db, stripe, objectId, now);
          break;
        case 'charge.refunded':
        case 'charge.refund.updated':
        case 'refund.created':
        case 'refund.updated':
        case 'refund.failed': {
          // charge.refunded carries the charge; the others carry the refund itself.
          const paymentIntentId = await stripe.paymentIntentOf(row.type === 'charge.refunded' ? 'charges' : 'refunds', objectId);
          if (paymentIntentId) userId = await applyRefunds(db, stripe, paymentIntentId, now);
          break;
        }
        case 'charge.dispute.created':
        case 'charge.dispute.funds_withdrawn': {
          const d = await stripe.getDispute(objectId);
          const payment = d.paymentIntentId ? await creditedPayment(db, stripe, d.paymentIntentId) : null;
          if (!payment) break;
          userId = payment.userId;
          if (d.amountCents === null || d.amountCents <= 0 || d.currency !== payment.currency) throw new BillingError('Dispute has invalid amount or currency');
          // Frozen once: a second freeze (the inquiry becoming a chargeback) would move frozen_at
          // and lose the deletion time unfreezeAccount gives back.
          const [account] = await db.select({ frozenAt: billingAccounts.frozenAt }).from(billingAccounts).where(eq(billingAccounts.userId, userId));
          if (!account?.frozenAt) await freezeAccount(db, userId, 'dispute', now);
          // An inquiry (`warning_…`) takes no money yet, and a prevented dispute is refunded (the
          // refund events debit it). The amount is taken when the bank actually withdraws it;
          // funds_withdrawn follows an inquiry that becomes a chargeback.
          if (!d.status.startsWith('warning_') && d.status !== 'prevented') {
            await applyBalance(db, {
              userId, kind: 'dispute', amountMicros: 0, reference: `dispute:${d.id}`, description: 'Payment disputed', actor: 'stripe',
              currency: payment.currency ?? undefined, reversal: { orderId: d.paymentIntentId!, grossAmountCents: d.amountCents },
            }, now);
          }
          await raiseAlert(db, { source: 'billing', severity: 'critical', title: `Stripe dispute by user ${userId}: account frozen`, detail: { eventId, userId, disputeId: d.id, status: d.status }, dedupeKey: `stripe-dispute:${d.id}` }, now);
          break;
        }
        default:
          break; // logged by being stored
      }
    }
    await db.batch([
      db.update(webhookEvents).set({ processedAt: now, error: null, attempts: row.attempts + 1 }).where(eq(webhookEvents.id, eventId)),
      db.insert(auditLog).values({
        actor: 'stripe',
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
