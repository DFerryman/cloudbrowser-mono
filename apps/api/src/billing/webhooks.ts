/**
 * Creem webhooks (page 6). The receiver checks the signature over the raw body, stores the event
 * by its id (duplicates are ignored) and answers at once; processing runs from the
 * `cloudbrowser-billing` queue, with the api's cron as a backstop for lost messages.
 */
import { schema, type Db } from '@cloudbrowser/db';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Env } from '../env.js';
import { type Creem, verifyWebhookSignature } from './creem.js';
import { notifyHub, revokeSubscription, syncSubscription } from './sync.js';

const { webhookEvents, checkoutAttempts, billingCustomers, auditLog } = schema;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (v && typeof v === 'object' ? str((v as { id?: unknown }).id) : null);
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

/** Applies one stored event. Idempotent: re-running it gives the same final state. */
export async function processWebhook(env: Env, db: Db, creem: Creem, eventId: string, now = new Date()): Promise<void> {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventId));
  if (!row || row.processedAt) return;
  const o = obj(row.payload.object);
  const meta = obj(o.metadata);
  let userId: string | null = null;
  try {
    switch (row.type) {
      case 'checkout.completed': {
        userId = str(meta.userId);
        const requestId = str(o.request_id);
        if (!userId && requestId) {
          const [a] = await db.select().from(checkoutAttempts).where(eq(checkoutAttempts.id, requestId));
          userId = a?.userId ?? null;
        }
        const customerId = idOf(o.customer);
        if (userId && customerId) {
          await db.insert(billingCustomers).values({ userId, creemCustomerId: customerId, createdAt: now }).onConflictDoNothing();
        }
        if (requestId && str(o.id)) {
          await db.update(checkoutAttempts).set({ checkoutId: str(o.id) }).where(eq(checkoutAttempts.id, requestId));
        }
        const subId = idOf(o.subscription);
        if (subId) userId = await syncSubscription(env, db, creem, subId, { userId }, now);
        break;
      }
      case 'subscription.active':
      case 'subscription.paid':
      case 'subscription.update':
      case 'subscription.trialing':
      case 'subscription.scheduled_cancel':
      case 'subscription.canceled':
      case 'subscription.past_due':
      case 'subscription.unpaid':
      case 'subscription.paused':
      case 'subscription.expired': {
        const subId = idOf(o.id) ?? idOf(o.subscription);
        if (subId) userId = await syncSubscription(env, db, creem, subId, { userId: str(meta.userId) }, now);
        break;
      }
      case 'refund.created': {
        const subId = idOf(o.subscription);
        const refunded = Number(o.refund_amount ?? 0);
        const paid = Number(obj(o.transaction).amount_paid ?? obj(o.transaction).amount ?? obj(o.order).amount_paid ?? obj(o.order).amount ?? NaN);
        // Full refund: revoke. Partial refund (or one we cannot size): log only.
        if (subId && Number.isFinite(paid) && refunded >= paid && paid > 0) {
          userId = await revokeSubscription(env, db, subId, 'refund', now);
        }
        break;
      }
      case 'dispute.created': {
        const subId = idOf(o.subscription);
        if (subId) userId = await revokeSubscription(env, db, subId, 'dispute', now);
        console.error('ALERT: Creem dispute', eventId, subId);
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
