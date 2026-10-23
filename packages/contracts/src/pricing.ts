import { z } from 'zod';
import { RegionId } from './regions.js';
import type { BrowserTier } from './tiers.js';

/**
 * Prices (page 6). What the provider charges us comes from its price list for the browser's own
 * region (AWS Price List API, refreshed by the engine at least twice a day); nothing here is a
 * price. Data sent to the viewer also crosses Cloudflare's TURN relay, which bills per GB it
 * delivers: that is added to the AWS transfer cost (`relayGbMicros`). Customers pay each cost
 * times its operator-set markup (compute, fixed resources, transfer; e.g. 130 → cost × 1.3),
 * metered per minute and taken from a prepaid balance.
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
  /**
   * Premium's first launch candidate, its price and machine; its fallbacks are priced in
   * `instanceTypes`. Absent where Premium is not offered or one of its types has no price.
   * The fields above describe Basic.
   */
  premium: z.object({
    instanceType: z.string(),
    vmHour: z.number().nonnegative(),
    machine: z.object({ vcpu: z.number().positive(), memoryGb: z.number().positive() }).nullable(),
  }).nullish(),
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

/**
 * The sheet as a browser of this tier sees it: its machine and hourly price in place of Basic's,
 * so every pricing function applies unchanged. Null where the tier is not offered. Pure.
 */
export function tierSheet(sheet: ProviderPriceSheet, tier: BrowserTier): ProviderPriceSheet | null {
  if (tier === 'basic') return sheet;
  const t = sheet.premium;
  return t ? { ...sheet, instanceType: t.instanceType, vmHour: t.vmHour, machine: t.machine } : null;
}

/**
 * How much more than its tier's machine a machine launched for a capacity shortage may cost.
 * Basic's fallbacks cost a fraction of a percent more in most regions. No launch goes above it.
 */
export const FALLBACK_PRICE_TOLERANCE = 0.05;

/**
 * The hourly price a browser's machine is billed at (any unit). One that costs more than its
 * tier's machine, but within the fallback tolerance, was launched for a capacity shortage: the
 * user pays the tier's price they confirmed. One that costs even more is an older machine the
 * browser keeps, billed at its own price, like a cheaper one. Pure.
 */
export function billedVmHour(machineHour: number, tierHour: number | undefined): number {
  return tierHour !== undefined && machineHour > tierHour && machineHour <= tierHour * (1 + FALLBACK_PRICE_TOLERANCE) ? tierHour : machineHour;
}

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

/** What turns provider costs into customer prices: the markups and the relay's cost. */
export type PriceFactors = Pick<PricingSettings, 'markupPercent' | 'fixedMarkupPercent' | 'transferMarkupPercent' | 'relayGbMicros'>;

/**
 * The cost of each unit to us, in micro-dollars. Transfer is AWS's data-out price plus the TURN
 * relay's per-GB price: the live view's video, nearly all of a browser's traffic, is billed by both. Pure.
 */
export function costRates(sheet: ProviderPriceSheet, relayGbMicros = 0): Rates {
  const m = (usd: number) => Math.round(usd * MICROS_PER_USD);
  return {
    compute: m(sheet.vmHour),
    ip: m(sheet.ipHour),
    storage: m(sheet.volumeGbMonth),
    snapshot: m(sheet.snapshotGbMonth),
    transfer: m(sheet.transferOutGb) + relayGbMicros,
  };
}

/** Customer prices: each cost times its markup, rounded to a micro-dollar. Pure. */
export function customerRates(sheet: ProviderPriceSheet, factors: PriceFactors): Rates {
  const cost = costRates(sheet, factors.relayGbMicros);
  const up = (micros: number, percent: number) => Math.round((micros * percent) / 100);
  return {
    compute: up(cost.compute, factors.markupPercent),
    ip: up(cost.ip, factors.fixedMarkupPercent),
    storage: up(cost.storage, factors.fixedMarkupPercent),
    snapshot: up(cost.snapshot, factors.fixedMarkupPercent),
    transfer: up(cost.transfer, factors.transferMarkupPercent),
  };
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
  /**
   * Premium here: its rates (compute differs; the fixed resources are the same as Basic's),
   * machine and price version. Null where Premium is not offered or not priced. `rates`,
   * `machine` and `version` above are Basic's.
   */
  premium: z.object({
    rates: Rates,
    machine: z.object({ vcpu: z.number(), memoryGb: z.number() }).nullable(),
    version: z.string(),
  }).nullable().optional(),
});
export type RegionPricing = z.infer<typeof RegionPricing>;

/**
 * Operator settings for customer prices and the prepaid balance (admin console). Every markup is
 * at least 100 (never below cost); the console also refuses one that the payment provider's
 * percentage fee would push below cost.
 */
export const PricingSettings = z.object({
  /** Compute (the VM, per running hour): price = AWS on-demand price × markupPercent / 100. */
  markupPercent: z.number().int().min(100).max(1000),
  /** Dedicated IP, data volume and system disk, charged awake or asleep: AWS price × this / 100. */
  fixedMarkupPercent: z.number().int().min(100).max(1000),
  /** Data sent to the internet (mostly the live view): (AWS data-out + relay) × this / 100. */
  transferMarkupPercent: z.number().int().min(100).max(1000),
  /** Cloudflare TURN relay price per GB it delivers to the viewer, in micro-dollars ($0.05 = 50000). */
  relayGbMicros: z.number().int().min(0).max(1_000_000),
  /**
   * Bill the minutes AWS charges while a browser boots (wake, first start) and shuts down (Chrome
   * closing, the profile archive upload, the OS halting) as running time. Off: those minutes are ours.
   */
  billTransitions: z.boolean(),
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
  fixedMarkupPercent: 120,
  transferMarkupPercent: 120,
  relayGbMicros: 50_000,
  billTransitions: true,
  minBalanceMicros: 1 * MICROS_PER_USD,
  lowBalanceMicros: 2 * MICROS_PER_USD,
  paymentFeeBps: 390,
  paymentFeeFixedCents: 40,
};

/** The smallest markup the payment provider's percentage fee leaves at or above cost. Pure. */
export const minimumMarkupPercent = (paymentFeeBps: number) => 100 + Math.ceil(paymentFeeBps / 100);
