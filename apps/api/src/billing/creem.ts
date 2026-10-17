/**
 * Thin client for the Creem API (page 6). Creem is the merchant of record and the source of truth
 * for billing. Paths and fields follow Creem's public docs; every response is parsed defensively
 * because nested objects may arrive expanded or as bare ids.
 */
import { PlanKey, type PlanKey as PlanKeyT } from '@cloudbrowser/contracts';
import type { Env } from '../env.js';

export class BillingError extends Error {}

export interface CreemSubscription {
  id: string;
  customerId: string | null;
  productId: string;
  itemId: string | null;
  units: number;
  status: string;
  currentPeriodEnd: Date | null;
  metadata: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (v && typeof v === 'object' ? str((v as { id?: unknown }).id) : null);
const date = (v: unknown): Date | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

/** Normalizes a Creem subscription object (from the API or a webhook body). */
export function parseSubscription(o: Record<string, unknown>): CreemSubscription {
  const items = Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : [];
  const item = items[0];
  const units = Number(item?.units ?? o.units ?? 1);
  return {
    id: String(o.id),
    customerId: idOf(o.customer),
    productId: idOf(o.product) ?? str(item?.product_id) ?? '',
    itemId: str(item?.id),
    units: Number.isFinite(units) && units > 0 ? Math.floor(units) : 1,
    status: String(o.status ?? 'unknown'),
    currentPeriodEnd: date(o.current_period_end_date ?? o.current_period_end),
    metadata: (o.metadata && typeof o.metadata === 'object' ? o.metadata : {}) as Record<string, unknown>,
  };
}

export type UpdateBehavior = 'proration-charge-immediately' | 'proration-charge' | 'proration-none';

export interface Creem {
  products: Record<PlanKeyT, string>;
  planForProduct(productId: string): PlanKeyT | null;
  createCheckout(input: {
    plan: PlanKeyT;
    units?: number;
    requestId: string;
    successUrl: string;
    email: string;
    metadata: Record<string, string>;
  }): Promise<{ id: string; url: string }>;
  getSubscription(id: string): Promise<CreemSubscription>;
  upgrade(id: string, plan: PlanKeyT, behavior: UpdateBehavior): Promise<void>;
  setUnits(id: string, itemId: string, units: number, behavior: UpdateBehavior): Promise<void>;
  portalUrl(customerId: string): Promise<string>;
}

/** Null when billing is not configured (the pilot runs without payments). */
export function creemFrom(env: Env): Creem | null {
  const base = env.CREEM_API_BASE;
  const key = env.CREEM_API_KEY;
  const products: Record<PlanKeyT, string | undefined> = {
    personal_monthly: env.CREEM_PRODUCT_PERSONAL_MONTHLY,
    personal_yearly: env.CREEM_PRODUCT_PERSONAL_YEARLY,
    pro_monthly: env.CREEM_PRODUCT_PRO_MONTHLY,
    pro_yearly: env.CREEM_PRODUCT_PRO_YEARLY,
  };
  if (!base || !key || !env.CREEM_WEBHOOK_SECRET || Object.values(products).some((p) => !p)) return null;
  const ids = products as Record<PlanKeyT, string>;

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
    products: ids,
    planForProduct: (productId) => PlanKey.options.find((p) => ids[p] === productId) ?? null,
    async createCheckout(input) {
      const out = await call<{ id?: string; checkout_url?: string }>('POST', '/v1/checkouts', {
        product_id: ids[input.plan],
        request_id: input.requestId,
        ...(input.units ? { units: input.units } : {}),
        success_url: input.successUrl,
        customer: { email: input.email },
        metadata: input.metadata,
      });
      if (!out.checkout_url) throw new BillingError('Creem returned no checkout_url');
      return { id: out.id ?? '', url: out.checkout_url };
    },
    async getSubscription(id) {
      return parseSubscription(await call<Record<string, unknown>>('GET', `/v1/subscriptions?subscription_id=${encodeURIComponent(id)}`));
    },
    async upgrade(id, plan, behavior) {
      await call('POST', `/v1/subscriptions/${encodeURIComponent(id)}/upgrade`, { product_id: ids[plan], update_behavior: behavior });
    },
    async setUnits(id, itemId, units, behavior) {
      await call('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, { items: [{ id: itemId, units }], update_behavior: behavior });
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
