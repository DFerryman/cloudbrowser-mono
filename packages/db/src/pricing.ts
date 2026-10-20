import { DEFAULT_PRICING_SETTINGS, ProviderPriceSheet, type PricingSettings } from '@cloudbrowser/contracts';
import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema.js';

type Db = DrizzleD1Database<typeof schema>;

/** The operator's pricing settings (one row, seeded by the migrations). */
export async function pricingSettings(db: Db): Promise<PricingSettings> {
  const [row] = await db.select().from(schema.pricingSettings).where(eq(schema.pricingSettings.id, 1));
  if (!row) return DEFAULT_PRICING_SETTINGS;
  return {
    markupPercent: row.markupPercent,
    fixedMarkupPercent: row.fixedMarkupPercent,
    transferMarkupPercent: row.transferMarkupPercent,
    relayGbMicros: row.relayGbMicros,
    billTransitions: row.billTransitions,
    minBalanceMicros: row.minBalanceMicros,
    lowBalanceMicros: row.lowBalanceMicros,
    paymentFeeBps: row.paymentFeeBps,
    paymentFeeFixedCents: row.paymentFeeFixedCents,
  };
}

export interface StoredSheet {
  regionId: string;
  sheet: ProviderPriceSheet;
  fetchedAt: Date;
}

/** Every region's last price sheet read from the provider, keyed by product region. */
export async function priceSheets(db: Db): Promise<Map<string, StoredSheet>> {
  const rows = await db.select().from(schema.providerPrices);
  const regions = new Map((await db.select().from(schema.regions)).map((r) => [r.id, r]));
  const out = new Map<string, StoredSheet>();
  for (const r of rows) {
    const region = regions.get(r.regionId);
    if (!region || region.executor !== r.executor || region.providerRegion !== r.providerRegion) continue;
    const parsed = ProviderPriceSheet.safeParse(r.sheet);
    if (parsed.success && r.fetchedAt) out.set(r.regionId, { regionId: r.regionId, sheet: parsed.data, fetchedAt: r.fetchedAt });
  }
  return out;
}
