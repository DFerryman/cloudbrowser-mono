/**
 * Which payment provider does what (page 6). Stripe and Creem are both supported, each configured
 * on its own:
 *  - new top-ups and the receipts button use Stripe when its key, webhook secret and top-up prices
 *    are all valid (./stripe.ts, `stripeFrom`), otherwise Creem when its settings are set,
 *    otherwise top-ups are off;
 *  - each provider keeps processing its own webhooks, checkouts, refunds and disputes whenever it
 *    is configured (Stripe: key and webhook secret), also while the other one takes new top-ups.
 *    Switching providers therefore never strands a payment that is already under way, and
 *    removing only STRIPE_TOPUP_PRICES hands top-ups back to Creem while Stripe's chargebacks still
 *    freeze accounts.
 */
import { schema, type Db } from '@cloudbrowser/db';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { creemFrom, type Creem } from './creem.js';
import { stripeFrom, type Stripe } from './stripe.js';
import { processStripeWebhook } from './stripe-webhooks.js';
import { processWebhook } from './webhooks.js';

const { webhookEvents } = schema;

export interface PaymentProviders {
  stripe: Stripe | null;
  creem: Creem | null;
}
/** One configured provider and its client. */
export type PaymentProvider = { id: 'stripe'; client: Stripe } | { id: 'creem'; client: Creem };

export const NO_PAYMENT_PROVIDERS: PaymentProviders = { stripe: null, creem: null };

export function paymentProviders(env: Env): PaymentProviders {
  return { stripe: stripeFrom(env), creem: creemFrom(env) };
}

/** Where new top-ups go: Stripe when it has top-up prices, then Creem; null when neither can take them. */
export function checkoutProvider(p: PaymentProviders): PaymentProvider | null {
  if (p.stripe?.topupProductIds.length) return { id: 'stripe', client: p.stripe };
  if (p.creem) return { id: 'creem', client: p.creem };
  return null;
}

/** Every configured provider, the one taking top-ups first. */
export function configuredProviders(p: PaymentProviders): PaymentProvider[] {
  return [
    ...(p.stripe ? [{ id: 'stripe', client: p.stripe } as const] : []),
    ...(p.creem ? [{ id: 'creem', client: p.creem } as const] : []),
  ];
}

/**
 * Applies one stored webhook event with the provider that sent it. Returns false, leaving the
 * event pending for the cron, while that provider is not configured.
 */
export async function processStoredWebhook(env: Env, db: Db, providers: PaymentProviders, eventId: string, now = new Date()): Promise<boolean> {
  const [row] = await db.select({ provider: webhookEvents.provider, processedAt: webhookEvents.processedAt }).from(webhookEvents).where(eq(webhookEvents.id, eventId));
  if (!row || row.processedAt) return false;
  if (row.provider === 'stripe') {
    if (!providers.stripe) return false;
    await processStripeWebhook(env, db, providers.stripe, eventId, now);
    return true;
  }
  if (!providers.creem) return false;
  await processWebhook(env, db, providers.creem, eventId, now);
  return true;
}
