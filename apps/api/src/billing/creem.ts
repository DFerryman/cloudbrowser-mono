/**
 * Thin client for the Creem API (page 6). Creem is the merchant of record. Users top up a prepaid
 * balance by buying one-time products; each product's name and price are read from Creem, so the
 * amounts on offer are set in the Creem dashboard. Paths and fields follow Creem's public docs;
 * every response is parsed defensively because nested objects may arrive expanded or as bare ids.
 */
import type { Env } from '../env.js';

export class BillingError extends Error {}

export interface CreemProduct {
  id: string;
  name: string;
  /** Price in the smallest currency unit (cents). */
  priceCents: number;
  currency: string;
  /** `onetime` for top-ups; recurring products are never offered. */
  billingType: string;
}

/** A checkout as Creem reports it: the source of truth for what was paid. */
export interface CreemCheckout {
  id: string;
  status: string;
  requestId: string | null;
  productId: string | null;
  customerId: string | null;
  orderId: string | null;
  orderStatus: string | null;
  /** Authoritative settled order amounts, never the mutable product catalog price. */
  orderCurrency: string | null;
  paidCents: number | null;
  taxCents: number | null;
  metadata: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
export const idOf = (v: unknown): string | null => str(v) ?? str(obj(v).id);

export function parseProduct(o: Record<string, unknown>): CreemProduct {
  return {
    id: String(o.id),
    name: str(o.name) ?? String(o.id),
    priceCents: Math.round(Number(o.price ?? 0)),
    currency: (str(o.currency) ?? '').toUpperCase(),
    billingType: str(o.billing_type) ?? 'unknown',
  };
}

/** Normalizes a checkout object (from the API or a `checkout.completed` webhook body). */
export function parseCheckout(o: Record<string, unknown>): CreemCheckout {
  const order = obj(o.order);
  return {
    id: String(o.id),
    status: str(o.status) ?? 'unknown',
    requestId: str(o.request_id),
    productId: idOf(o.product),
    customerId: idOf(o.customer),
    orderId: idOf(o.order),
    orderStatus: str(order.status),
    orderCurrency: str(order.currency)?.toUpperCase() ?? null,
    paidCents: typeof order.amount_paid === 'number' ? order.amount_paid : typeof order.amount === 'number' ? order.amount : null,
    taxCents: typeof order.tax_amount === 'number' ? order.tax_amount : null,
    metadata: obj(o.metadata),
  };
}

export interface Creem {
  /** The top-up products configured for this deployment (CREEM_TOPUP_PRODUCTS). */
  topupProductIds: string[];
  getProduct(id: string): Promise<CreemProduct>;
  createCheckout(input: { productId: string; requestId: string; successUrl: string; email: string; metadata: Record<string, string> }): Promise<{ id: string; url: string }>;
  getCheckout(id: string): Promise<CreemCheckout>;
  portalUrl(customerId: string): Promise<string>;
}

/** Null when billing is not configured (the pilot runs without payments). */
export function creemFrom(env: Env): Creem | null {
  const base = env.CREEM_API_BASE;
  const key = env.CREEM_API_KEY;
  const products = (env.CREEM_TOPUP_PRODUCTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!base || !key || !env.CREEM_WEBHOOK_SECRET || products.length === 0) return null;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base!.replace(/\/$/, '')}${path}`, {
      method,
      headers: { 'x-api-key': key!, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new BillingError(`Creem ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    topupProductIds: products,
    async getProduct(id) {
      return parseProduct(await call<Record<string, unknown>>('GET', `/v1/products?product_id=${encodeURIComponent(id)}`));
    },
    async createCheckout(input) {
      const out = await call<{ id?: string; checkout_url?: string }>('POST', '/v1/checkouts', {
        product_id: input.productId,
        request_id: input.requestId,
        success_url: input.successUrl,
        customer: { email: input.email },
        metadata: input.metadata,
      });
      if (!out.checkout_url) throw new BillingError('Creem returned no checkout_url');
      return { id: out.id ?? '', url: out.checkout_url };
    },
    async getCheckout(id) {
      return parseCheckout(await call<Record<string, unknown>>('GET', `/v1/checkouts?checkout_id=${encodeURIComponent(id)}`));
    },
    async portalUrl(customerId) {
      const out = await call<{ customer_portal_link?: string }>('POST', '/v1/customers/billing', { customer_id: customerId });
      if (!out.customer_portal_link) throw new BillingError('Creem returned no customer_portal_link');
      return out.customer_portal_link;
    },
  };
}

/** HMAC-SHA256 of the raw body, hex, in the `creem-signature` header; compared in constant time. */
export async function verifyWebhookSignature(secret: string, raw: string, given: string | undefined): Promise<boolean> {
  if (!given || !/^[0-9a-f]+$/i.test(given)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.toLowerCase().charCodeAt(i);
  return diff === 0;
}
