/**
 * Thin client for the Stripe API (page 6). Stripe is the preferred payment provider: when its
 * settings are valid it takes every new top-up, otherwise Creem does (./providers.ts). Users top
 * up by buying one-time USD Prices in a Stripe-hosted Checkout Session; each price's name and
 * amount are read from Stripe, so the amounts on offer are set in the Stripe dashboard. A price
 * whose customer chooses what to pay (`custom_unit_amount`) lets the buyer pick the amount there.
 *
 * Unlike Creem, Stripe is not a merchant of record: the account holder (a UK company) sells the
 * credit itself. So every checkout calculates VAT and sales tax with Stripe Tax, collects the
 * billing address (evidence of the buyer's country) and business tax ids (reverse charge), issues
 * an invoice that confirms the right to withdraw, asks the buyer to accept the Terms and to have
 * the credit added at once (UK and EU cancellation rules), and stays in USD (Adaptive Pricing off),
 * the balance's currency.
 * 3D Secure (Strong Customer Authentication) is handled by Checkout itself.
 *
 * No SDK: plain fetch with form-encoded bodies, pinned to one API version so responses keep their
 * shape whatever the account's default version is. Responses are parsed defensively because
 * related objects may arrive expanded or as bare ids.
 */
import type { Env } from '../env.js';
import { BillingError, idOf, type CreemProduct } from './creem.js';

export const STRIPE_API = 'https://api.stripe.com';
/**
 * Every request names this version (the current one in October 2026); webhooks, which arrive in
 * the endpoint's own version, are only read for an event's type and object id. Checkout here sends
 * neither `payment_method_types` nor `ui_mode`, which this version no longer accepts in their old forms.
 */
export const STRIPE_API_VERSION = '2026-09-30.endive';
/** Stripe's smallest USD charge, what a "customer chooses" price allows when it sets no minimum. */
const USD_MINIMUM_CHARGE_CENTS = 50;

/** A Stripe error answer: `param` names the request field Stripe objected to. */
export class StripeError extends BillingError {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly param: string | null) {
    super(message);
  }
}

/** A Checkout Session as Stripe reports it: the source of truth for what was paid. */
export interface StripeCheckout {
  id: string;
  /** `open`, `complete` or `expired`. */
  status: string;
  /** `paid`, `unpaid` (a delayed payment method is still on its way) or `no_payment_required`. */
  paymentStatus: string;
  clientReferenceId: string | null;
  priceIds: string[];
  customerId: string | null;
  paymentIntentId: string | null;
  /** Authoritative settled amounts in the smallest unit, never the mutable catalog price. */
  currency: string | null;
  totalCents: number | null;
  taxCents: number | null;
  metadata: Record<string, unknown>;
}

/** A refund or a dispute: money taken back from one payment. */
export interface StripeReversal {
  id: string;
  status: string;
  amountCents: number | null;
  currency: string | null;
  paymentIntentId: string | null;
}

export interface Stripe {
  /** Live or test mode, from the key; events from the other mode are ignored. */
  livemode: boolean;
  /**
   * The top-up prices configured for this deployment (STRIPE_TOPUP_PRICES). Empty when that is
   * missing or not valid: Stripe then takes no new top-ups but still applies its own events.
   */
  topupProductIds: string[];
  getProduct(id: string): Promise<CreemProduct>;
  /**
   * `termsCheckbox` is false when the dashboard has no Terms URL (the terms are then shown above
   * the pay button); `staleCustomer` when the stored customer no longer exists in this account
   * and mode (Checkout then made a new one).
   */
  createCheckout(input: { priceId: string; attemptId: string; userId: string; email: string; customerId: string | null; appUrl: string }): Promise<{ id: string; url: string; termsCheckbox: boolean; staleCustomer: boolean }>;
  getCheckout(id: string): Promise<StripeCheckout>;
  /** The PaymentIntent a charge or a refund belongs to. */
  paymentIntentOf(object: 'charges' | 'refunds', id: string): Promise<string | null>;
  /** The metadata Checkout copied onto a PaymentIntent (`attemptId` marks our top-ups). */
  paymentIntentMetadata(id: string): Promise<Record<string, unknown>>;
  listRefunds(paymentIntentId: string): Promise<StripeReversal[]>;
  getDispute(id: string): Promise<StripeReversal>;
  portalUrl(customerId: string, returnUrl: string): Promise<string>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const upper = (v: unknown): string | null => str(v)?.toUpperCase() ?? null;

const SECRET_KEY = /^(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}$/;
const WEBHOOK_SECRET = /^whsec_[0-9A-Za-z+/=]{16,}$/;
const PRICE_ID = /^price_[0-9A-Za-z]{8,}$/;

/** The webhook signing secret, or null unless it looks like one (`whsec_…`). */
export function stripeWebhookSecret(env: Env): string | null {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  return secret && WEBHOOK_SECRET.test(secret) ? secret : null;
}

/** The configured price ids, or null unless there is at least one and every one is valid. */
function topupPrices(env: Env): string[] | null {
  const ids = (env.STRIPE_TOPUP_PRICES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length && ids.every((id) => PRICE_ID.test(id)) ? ids : null;
}

/** The buyer accepts these at checkout: the Terms, and the credit being added at once (UK/EU cancellation rules). */
export function termsMessage(appUrl: string) {
  return `I agree to the [Terms of Service](${appUrl}/terms) and the [Refund Policy](${appUrl}/refunds), and ask for the credit to be added to my balance at once. I can still withdraw within 14 days and get back any credit I have not used.`;
}

/** On every invoice: the confirmation, on a durable medium, of the right to withdraw. */
export function invoiceFooter(appUrl: string) {
  return `Prepaid credit, added to your balance at once at your request. Consumers in the UK and the EU may withdraw within 14 days of purchase and get back any credit not yet used: ${appUrl}/refunds. Terms of Service: ${appUrl}/terms.`;
}

/** Stripe's form encoding: nested objects as `a[b]`, arrays as `a[0]`; null and undefined are left out. */
export function formEncode(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const add = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${key}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) add(`${key}[${k}]`, x);
    else out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.toString();
}

/**
 * Normalizes a price (with its product and currency options expanded) into a top-up product, as
 * ./creem.ts reads Creem's. Archived prices are never offered, nor are prices with other
 * currencies: Checkout would charge a buyer in theirs, and the balance is kept in USD.
 */
export function parsePrice(o: Record<string, unknown>): CreemProduct {
  const product = obj(o.product);
  const custom = o.custom_unit_amount ? obj(o.custom_unit_amount) : null;
  const cents = int(o.unit_amount) ?? (custom ? (int(custom.preset) ?? int(custom.minimum) ?? USD_MINIMUM_CHARGE_CENTS) : 0);
  const currency = upper(o.currency) ?? '';
  const archived = o.active === false || product.active === false;
  const otherCurrencies = Object.keys(obj(o.currency_options)).some((c) => c.toUpperCase() !== currency);
  return {
    id: String(o.id),
    name: str(product.name) ?? str(o.nickname) ?? String(o.id),
    priceCents: cents,
    currency,
    billingType: archived ? 'archived' : otherCurrencies ? 'multi_currency' : o.type === 'one_time' ? 'onetime' : (str(o.type) ?? 'unknown'),
  };
}

/** Normalizes a Checkout Session read with `expand[]=line_items`. */
export function parseCheckout(o: Record<string, unknown>): StripeCheckout {
  const lines = Array.isArray(obj(o.line_items).data) ? (obj(o.line_items).data as unknown[]) : [];
  return {
    id: String(o.id),
    status: str(o.status) ?? 'unknown',
    paymentStatus: str(o.payment_status) ?? 'unknown',
    clientReferenceId: str(o.client_reference_id),
    priceIds: lines.map((l) => idOf(obj(l).price)).filter((id): id is string => id !== null),
    customerId: idOf(o.customer),
    paymentIntentId: idOf(o.payment_intent),
    currency: upper(o.currency),
    totalCents: int(o.amount_total),
    taxCents: int(obj(o.total_details).amount_tax),
    metadata: obj(o.metadata),
  };
}

export function parseReversal(o: Record<string, unknown>): StripeReversal {
  return {
    id: String(o.id),
    status: str(o.status) ?? 'unknown',
    amountCents: int(o.amount),
    currency: upper(o.currency),
    paymentIntentId: idOf(o.payment_intent),
  };
}

/**
 * Null unless the secret key and the webhook secret are valid. Stripe takes new top-ups only when
 * every top-up price id is valid too (./providers.ts); without them it still applies the refunds,
 * disputes and late payments of earlier Stripe top-ups and opens their receipts.
 */
export function stripeFrom(env: Env): Stripe | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key || !SECRET_KEY.test(key) || !stripeWebhookSecret(env)) return null;
  const prices = topupPrices(env) ?? [];
  const automaticTax = env.STRIPE_AUTOMATIC_TAX?.trim().toLowerCase() !== 'off';

  async function call<T extends Record<string, unknown>>(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
    const query = method === 'GET' && Object.keys(params).length ? `?${formEncode(params)}` : '';
    const res = await fetch(`${STRIPE_API}${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        'stripe-version': STRIPE_API_VERSION,
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: method === 'POST' ? formEncode(params) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let error: Record<string, unknown> = {};
      try {
        error = obj((JSON.parse(text) as Record<string, unknown>).error);
      } catch {
        // not JSON: the status and text say enough
      }
      throw new StripeError(`Stripe ${method} ${path}: HTTP ${res.status} ${(str(error.message) ?? text).slice(0, 300)}`, res.status, str(error.code), str(error.param));
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
  const at = (id: string) => encodeURIComponent(id);

  return {
    livemode: key.includes('_live_'),
    topupProductIds: prices,
    async getProduct(id) {
      return parsePrice(await call('GET', `/v1/prices/${at(id)}`, { expand: ['product', 'currency_options'] }));
    },
    async createCheckout(input) {
      const ids = { userId: input.userId, attemptId: input.attemptId };
      const message = termsMessage(input.appUrl);
      let customerId = input.customerId;
      let termsCheckbox = true;
      const session = (): Record<string, unknown> => ({
        mode: 'payment',
        line_items: [{ price: input.priceId, quantity: 1 }],
        client_reference_id: input.attemptId,
        success_url: `${input.appUrl}/billing/success`,
        cancel_url: `${input.appUrl}/billing`,
        metadata: ids,
        payment_intent_data: { metadata: ids },
        // A returning buyer keeps one customer (one portal); Checkout saves the address and name
        // they enter on it, which automatic tax and tax id collection need.
        ...(customerId
          ? { customer: customerId, customer_update: { address: 'auto', name: 'auto' } }
          : { customer_email: input.email, customer_creation: 'always' }),
        billing_address_collection: 'required',
        automatic_tax: { enabled: automaticTax },
        tax_id_collection: { enabled: true },
        invoice_creation: { enabled: true, invoice_data: { metadata: ids, footer: invoiceFooter(input.appUrl) } },
        // The balance is kept in USD: the buyer is charged the price's own USD amount, which is
        // what is credited and what refunds are measured against, whatever the dashboard default
        // and even if the price has gained other currencies since it was last read.
        currency: 'usd',
        adaptive_pricing: { enabled: false },
        ...(termsCheckbox
          ? { consent_collection: { terms_of_service: 'required' }, custom_text: { terms_of_service_acceptance: { message } } }
          : { custom_text: { submit: { message } } }),
      });
      // Each refusal below is fixed by changing the request, so a retry gets its own idempotency key.
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await call('POST', '/v1/checkout/sessions', session(), attempt ? `checkout:${input.attemptId}:${attempt}` : `checkout:${input.attemptId}`);
          const url = str(out.url);
          if (!url) throw new BillingError('Stripe returned no checkout url');
          return { id: str(out.id) ?? '', url, termsCheckbox, staleCustomer: customerId !== input.customerId };
        } catch (e) {
          if (!(e instanceof StripeError) || e.status !== 400 || attempt >= 2) throw e;
          // Stripe names the refused field in `param`; its message wording is not documented.
          if (customerId && e.param === 'customer') {
            // Deleted, or from the other mode or another account: Checkout makes a new customer.
            customerId = null;
          } else if (termsCheckbox && /^(consent_collection|custom_text\[terms_of_service_acceptance)/.test(e.param ?? '')) {
            // The checkbox needs a Terms of Service URL in the Stripe dashboard (Settings → Business
            // → Public details). Until one is set, the same words sit above the pay button instead.
            termsCheckbox = false;
          } else {
            throw e;
          }
        }
      }
    },
    async getCheckout(id) {
      return parseCheckout(await call('GET', `/v1/checkout/sessions/${at(id)}`, { expand: ['line_items'] }));
    },
    async paymentIntentOf(object, id) {
      return idOf((await call('GET', `/v1/${object}/${at(id)}`)).payment_intent);
    },
    async paymentIntentMetadata(id) {
      return obj((await call('GET', `/v1/payment_intents/${at(id)}`)).metadata);
    },
    async listRefunds(paymentIntentId) {
      const out = await call('GET', '/v1/refunds', { payment_intent: paymentIntentId, limit: 100 });
      return (Array.isArray(out.data) ? out.data : []).map((r) => parseReversal(obj(r)));
    },
    async getDispute(id) {
      return parseReversal(await call('GET', `/v1/disputes/${at(id)}`));
    },
    async portalUrl(customerId, returnUrl) {
      const url = str((await call('POST', '/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl })).url);
      if (!url) throw new BillingError('Stripe returned no customer portal url');
      return url;
    },
  };
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The `Stripe-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, with
 * one v1 per active secret while one is being rolled. Valid when any v1 matches, compared in
 * constant time, and the timestamp is within five minutes (replays are refused).
 */
export async function verifyStripeSignature(secret: string, raw: string, header: string | undefined, nowMs = Date.now(), toleranceS = 300): Promise<boolean> {
  if (!header) return false;
  let t: number | null = null;
  const given: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === 't' && /^\d+$/.test(value)) t = Number(value);
    else if (name === 'v1' && /^[0-9a-f]{64}$/i.test(value)) given.push(value.toLowerCase());
  }
  if (t === null || !given.length || Math.abs(nowMs / 1000 - t) > toleranceS) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  let match = false;
  for (const sig of given) {
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    match = match || diff === 0;
  }
  return match;
}
