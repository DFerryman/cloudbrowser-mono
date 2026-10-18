import { z } from 'zod';
import { RegionId } from './regions.js';

/**
 * Prices (page 6). What the provider charges us comes from its price list for the browser's own
 * region (AWS Price List API, refreshed by the engine at least twice a day); nothing here is a
 * price. Customers pay that cost times an operator-set markup (`markupPercent`, e.g. 120 → cost ×
 * 1.2), metered per minute and taken from a prepaid balance.
 *
 * Money is held in micro-dollars (USD × 1,000,000) so per-minute charges add up exactly.
 */
export const MICROS_PER_USD = 1_000_000;
/** Display-only average month for projections. Actual GB-month usage uses calendar periods. */
export const HOURS_PER_MONTH = 730;
/** Data transfer is priced per GiB (AWS "GB"). */
export const BYTES_PER_GB = 1024 ** 3;

/** What one region costs us, in USD, as read from the provider's price list. */
export const ProviderPriceSheet = z.object({
  source: z.enum(['aws-price-list', 'simulated']),
  /** The type browsers launch with (the first allowed type) and its on-demand Linux price per hour. */
  instanceType: z.string(),
  vmHour: z.number().nonnegative(),
  /** Every allowed type; a later one is only used when the first has no capacity. */
  instanceTypes: z.record(z.string(), z.number().nonnegative()),
  /** What the first type gives a browser, from the price list. Missing from sheets stored before it. */
  machine: z.object({ vcpu: z.number().positive(), memoryGb: z.number().positive() }).nullish(),
  /** gp3 per GB-month (data volume and system disk). */
  volumeGbMonth: z.number().nonnegative(),
  /** EBS snapshot storage per GB-month. */
  snapshotGbMonth: z.number().nonnegative(),
  /** One public IPv4 address per hour (charged whether or not the VM runs). */
  ipHour: z.number().nonnegative(),
  /** Data transfer out to the internet per GB, first paid tier. */
  transferOutGb: z.number().nonnegative(),
  /** Size of every VM's system disk (OS and container images), billed like storage. */
  rootVolumeGb: z.number().int().nonnegative(),
  /** Price list publication or effective date, when the provider gives one. */
  effectiveDate: z.string().nullable(),
});
export type ProviderPriceSheet = z.infer<typeof ProviderPriceSheet>;

/** Billable usage of a browser. Each has its own unit and per-unit price. */
export const UsageItem = z.enum(['compute', 'ip', 'storage', 'snapshot', 'transfer']);
export type UsageItem = z.infer<typeof UsageItem>;

export const USAGE_UNITS: Record<UsageItem, 'hour' | 'gb_month' | 'gb'> = {
  compute: 'hour',
  ip: 'hour',
  storage: 'gb_month',
  snapshot: 'gb_month',
  transfer: 'gb',
};

/** Per-unit prices in micro-dollars. */
export const Rates = z.object({
  /** Per hour while the browser runs. */
  compute: z.number().int(),
  /** Per hour while the browser exists (awake or asleep). */
  ip: z.number().int(),
  /** Per GB-month of storage, data volume and system disk. */
  storage: z.number().int(),
  /** Historical/internal snapshot estimates; no user snapshot feature creates new charges. */
  snapshot: z.number().int(),
  /** Per GB sent from the browser to the internet (live view video, uploads). */
  transfer: z.number().int(),
});
export type Rates = z.infer<typeof Rates>;

/** The cost of each unit to us, in micro-dollars. Pure. */
export function costRates(sheet: ProviderPriceSheet): Rates {
  const m = (usd: number) => Math.round(usd * MICROS_PER_USD);
  return {
    compute: m(sheet.vmHour),
    ip: m(sheet.ipHour),
    storage: m(sheet.volumeGbMonth),
    snapshot: m(sheet.snapshotGbMonth),
    transfer: m(sheet.transferOutGb),
  };
}

/** Customer prices: our cost times the markup, rounded to a micro-dollar. Pure. */
export function customerRates(sheet: ProviderPriceSheet, markupPercent: number): Rates {
  const cost = costRates(sheet);
  const up = (micros: number) => Math.round((micros * markupPercent) / 100);
  return { compute: up(cost.compute), ip: up(cost.ip), storage: up(cost.storage), snapshot: up(cost.snapshot), transfer: up(cost.transfer) };
}

/**
 * Identifies the prices a user was shown. Priced actions (create, more storage, snapshots) send it
 * back; if prices changed in between, the action is refused so the user can see the new price.
 */
export function priceVersion(rates: Rates, rootVolumeGb: number): string {
  return [rates.compute, rates.ip, rates.storage, rates.snapshot, rates.transfer, rootVolumeGb].join('.');
}

export interface BrowserEstimate {
  /** Per hour while running (compute only). */
  runningHour: number;
  /** Compute plus the fixed resources per hour while running, excluding variable data transfer. */
  runningTotalHour: number;
  /** Per month for the dedicated IP, charged hourly whether awake or asleep. */
  ipMonth: number;
  /** Per month for the data volume plus the system disk. */
  storageMonth: number;
  /** Per month for snapshot backups (0 when off). */
  snapshotMonth: number;
  /** IP + storage + snapshots: what the browser costs per month even when it never runs. */
  alwaysOnMonth: number;
  alwaysOnHour: number;
}

/** What one browser costs, in micro-dollars, from per-unit rates. Pure. */
export function browserEstimate(rates: Rates, spec: { storageGb: number; rootVolumeGb: number; backups: boolean }): BrowserEstimate {
  const ipMonth = rates.ip * HOURS_PER_MONTH;
  const storageMonth = rates.storage * (spec.storageGb + spec.rootVolumeGb);
  const snapshotMonth = spec.backups ? rates.snapshot * spec.storageGb : 0;
  const alwaysOnMonth = ipMonth + storageMonth + snapshotMonth;
  const alwaysOnHour = Math.round(alwaysOnMonth / HOURS_PER_MONTH);
  return {
    runningHour: rates.compute,
    runningTotalHour: rates.compute + alwaysOnHour,
    ipMonth,
    storageMonth,
    snapshotMonth,
    alwaysOnMonth,
    alwaysOnHour,
  };
}

/** UTC usage slices; monthly quantities use the actual duration of each billing month. */
export function splitUsagePeriod(from: Date, to: Date): { day: string; hours: number; monthFraction: number }[] {
  let cursor = from.getTime();
  const end = to.getTime();
  if (!Number.isFinite(cursor) || !Number.isFinite(end)) throw new RangeError('Invalid usage period');
  const result: { day: string; hours: number; monthFraction: number }[] = [];
  while (cursor < end) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const next = Math.min(end, Date.UTC(year, month, date.getUTCDate() + 1));
    const monthMs = Date.UTC(year, month + 1, 1) - Date.UTC(year, month, 1);
    const elapsed = next - cursor;
    result.push({ day: date.toISOString().slice(0, 10), hours: elapsed / 3_600_000, monthFraction: elapsed / monthMs });
    cursor = next;
  }
  return result;
}

/** Locks seven days of fixed-resource charges; this remains unspent credit, not an extra fee. */
export function retentionReserve(rates: Rates, spec: { storageGb: number; rootVolumeGb: number; backups: boolean }, now = new Date()): number {
  const slices = splitUsagePeriod(now, new Date(now.getTime() + 7 * 86_400_000));
  const gbMonthRate = rates.storage * (spec.storageGb + spec.rootVolumeGb) + (spec.backups ? rates.snapshot * spec.storageGb : 0);
  return Math.ceil(slices.reduce((amount, slice) => amount + rates.ip * slice.hours + gbMonthRate * slice.monthFraction, 0));
}

/** Ledger estimate (page 10) of a provider resource while it exists, in US cents per month. Pure. */
export function resourceMonthlyCostCents(sheet: ProviderPriceSheet, kind: string, sizeGb = 0): number {
  const cents = (usd: number) => Math.round(usd * 100);
  switch (kind) {
    case 'ip':
      return cents(sheet.ipHour * HOURS_PER_MONTH);
    case 'volume':
      return cents(sheet.volumeGbMonth * sizeGb);
    case 'vm':
      // The VM's system disk bills while the VM exists; running hours are counted separately.
      return cents(sheet.volumeGbMonth * sheet.rootVolumeGb);
    case 'snapshot':
      return cents(sheet.snapshotGbMonth * sizeGb);
    default:
      return 0;
  }
}

export const RegionPricing = z.object({
  regionId: RegionId,
  /** False until the region's prices have been read from the provider: nothing can be bought there yet. */
  available: z.boolean(),
  source: z.enum(['aws-price-list', 'simulated']).nullable(),
  updatedAt: z.string().nullable(),
  rates: Rates.nullable(),
  rootVolumeGb: z.number().int(),
  /** The VM a browser gets here (vCPUs and memory), when the price list says. */
  machine: z.object({ vcpu: z.number(), memoryGb: z.number() }).nullable(),
  /** Size of a new browser's data volume, and the most it can grow to. */
  defaultStorageGb: z.number().int(),
  maxStorageGb: z.number().int(),
  version: z.string().nullable(),
});
export type RegionPricing = z.infer<typeof RegionPricing>;

/** Operator settings for customer prices and the prepaid balance (admin console). */
export const PricingSettings = z.object({
  /** Customer price = provider cost × markupPercent / 100. At least 100 (never below cost). */
  markupPercent: z.number().int().min(100).max(1000),
  /** A browser can only be created or woken with at least this balance. */
  minBalanceMicros: z.number().int().min(0),
  /** Below this balance the app warns the user and emails once. */
  lowBalanceMicros: z.number().int().min(0),
  /** The payment provider's fee, for the margin report only: percent in basis points, plus a fixed fee per payment. */
  paymentFeeBps: z.number().int().min(0).max(5000),
  paymentFeeFixedCents: z.number().int().min(0).max(1000),
});
export type PricingSettings = z.infer<typeof PricingSettings>;

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  markupPercent: 120,
  minBalanceMicros: 1 * MICROS_PER_USD,
  lowBalanceMicros: 2 * MICROS_PER_USD,
  paymentFeeBps: 0,
  paymentFeeFixedCents: 0,
};
