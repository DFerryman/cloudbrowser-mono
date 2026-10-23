/**
 * Live data in the prerendered public site (docs/deploy-cloudflare.md, "AI crawlers and search").
 * The web build prerenders the public pages and their markdown for crawlers that run no
 * JavaScript; prices and the regions open for new browsers change at runtime, so the paths below
 * run this Worker first (run_worker_first in wrangler.jsonc). It reads the built file from the
 * assets, replaces each `<!--live:NAME-->fallback<!--/live:NAME-->` slot with current figures from
 * the public price list, and adds them as offers to the page's JSON-LD. When prices cannot be
 * read, the file's own fallback text stays. Nothing here depends on the visitor.
 */
import { browserEstimate, MICROS_PER_USD, TIERS, type BrowserTier, type PublicPricing, type Rates } from '@cloudbrowser/contracts';
import { createDb } from '@cloudbrowser/db';
import { Hono, type Context } from 'hono';
import { isAdminOrigin } from './admin/access.js';
import type { AppEnv, Env } from './env.js';
import { publicPricing } from './routes/public.js';

/** Public path → the built file it is made from (home.html is served at /; see apps/web/src/site/seo/pages.ts). */
const LIVE_PAGES: Record<string, string> = {
  '/': '/home',
  '/pricing': '/pricing',
  '/index.md': '/index.md',
  '/pricing.md': '/pricing.md',
  '/llms.txt': '/llms.txt',
  '/llms-full.txt': '/llms-full.txt',
};

/** Prices change a few times a day at most; crawlers do not need them fresher than this. */
const PRICES_TTL_MS = 10 * 60_000;
const FAILED_TTL_MS = 60_000;
let cached: { at: number; ok: boolean; pricing: PublicPricing | null } | null = null;

/** The public price list, from this isolate's memory for ten minutes; null when it cannot be read. */
export async function cachedPricing(env: Env, now = Date.now()): Promise<{ pricing: PublicPricing | null; at: number }> {
  if (cached && now - cached.at < (cached.ok ? PRICES_TTL_MS : FAILED_TTL_MS)) return cached;
  try {
    cached = { at: now, ok: true, pricing: await publicPricing(createDb(env.DB)) };
  } catch (e) {
    console.error('site prices unavailable', e);
    cached = { at: now, ok: false, pricing: null };
  }
  return cached;
}

/** For tests: forget the cached price list. */
export const resetSiteCache = () => void (cached = null);

export interface PriceRow {
  place: string;
  tier: BrowserTier;
  /** Per hour while running: compute plus the IP and storage (the pricing page's headline figure). */
  running: number;
  /** Per hour while asleep: the IP and storage alone. */
  asleep: number;
  /** Per GB sent. */
  transfer: number;
}

const countries = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

/** "Tokyo, Japan", as the web app names a region in English (region-names.ts). */
function place(r: PublicPricing['regions'][number]): string {
  if (!r.country || r.city === r.name) return r.name;
  if (['HK', 'SG', 'BH'].includes(r.country)) return r.city;
  let country = r.country;
  try {
    country = countries?.of(r.country) ?? r.country;
  } catch {
    // Unknown code: show it as is.
  }
  return `${r.city}, ${country}`;
}

/**
 * What a browser costs in each region taking new browsers, per tier, as the pricing page shows
 * it: Premium where the operator offers it and the region prices it.
 */
export function priceRows(pricing: PublicPricing): PriceRow[] {
  const rows: PriceRow[] = [];
  const add = (r: PublicPricing['regions'][number], tier: BrowserTier, rates: Rates) => {
    const e = browserEstimate(rates, { storageGb: r.defaultStorageGb, rootVolumeGb: r.rootVolumeGb, backups: false });
    rows.push({ place: place(r), tier, running: e.runningTotalHour, asleep: e.alwaysOnHour, transfer: rates.transfer });
  };
  for (const r of pricing.regions) {
    if (!r.available || !r.acceptingNew || !r.rates) continue;
    add(r, 'basic', r.rates);
    if (pricing.premiumOffered && r.premium && (r.premiumAvailability ?? 'unavailable') !== 'unavailable') add(r, 'premium', r.premium.rates);
  }
  return rows.sort((a, b) => a.place.localeCompare(b.place) || a.tier.localeCompare(b.tier));
}

/** Like the web app's money(): cents from a dollar up, enough digits below it to be exact. */
export function usd(micros: number): string {
  const v = micros / MICROS_PER_USD;
  const max = v === 0 || Math.abs(v) >= 1 ? 2 : 4;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: max }).format(v);
}

const tierName = (tier: BrowserTier) => `${tier === 'basic' ? 'Basic' : 'Premium'} (${TIERS[tier].vcpu} vCPU, ${TIERS[tier].memoryGb} GB)`;
const range = (values: number[]) => {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? usd(lo) : `${usd(lo)}–${usd(hi)}`;
};
const asOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** One paragraph: where browsers can be created now and what they cost, as plain text. */
export function summaryText(pricing: PublicPricing, at: number): string | null {
  const rows = priceRows(pricing);
  if (!rows.length) return null;
  const places = [...new Set(rows.map((r) => r.place))];
  const parts = [`As of ${asOf(at)}, new browsers can be created in ${places.length === 1 ? '1 region' : `${places.length} regions`}: ${places.join('; ')}.`];
  for (const tier of ['basic', 'premium'] as const) {
    const of = rows.filter((r) => r.tier === tier);
    if (of.length) parts.push(`A ${tierName(tier)} browser costs ${range(of.map((r) => r.running))} an hour while running and ${range(of.map((r) => r.asleep))} an hour while asleep (its IP and storage), prepaid in USD and metered per minute.`);
  }
  if (pricing.signupCreditMicros > 0) parts.push(`A new account gets ${usd(pricing.signupCreditMicros)} in credit.`);
  return parts.join(' ');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function notes(pricing: PublicPricing, at: number): string[] {
  return [
    `Prices in USD as of ${asOf(at)}. Running = compute, dedicated IP and storage; asleep = the IP and storage alone. Running time is metered per minute.`,
    `Creating or waking a paid browser needs at least ${usd(pricing.minBalanceMicros)} of available credit. Browsers are kept ${pricing.retentionDays} days after available credit runs out.`,
    ...(pricing.signupCreditMicros > 0 ? [`A new account gets ${usd(pricing.signupCreditMicros)} in credit.`] : []),
  ];
}

export function pricesMarkdown(pricing: PublicPricing, at: number): string | null {
  const rows = priceRows(pricing);
  if (!rows.length) return null;
  return [
    '| Region | Machine | Running, per hour | Asleep, per hour | Data sent, per GB |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.place} | ${tierName(r.tier)} | ${usd(r.running)} | ${usd(r.asleep)} | ${usd(r.transfer)} |`),
    '',
    ...notes(pricing, at).map((n) => `- ${n}`),
  ].join('\n');
}

export function pricesHtml(pricing: PublicPricing, at: number): string | null {
  const rows = priceRows(pricing);
  if (!rows.length) return null;
  const cell = 'py-2 pr-3';
  return [
    '<table class="w-full text-left text-sm">',
    `<thead><tr><th class="${cell}">Region</th><th class="${cell}">Machine</th><th class="${cell}">Running, per hour</th><th class="${cell}">Asleep, per hour</th><th class="${cell}">Data sent, per GB</th></tr></thead>`,
    '<tbody>',
    ...rows.map((r) => `<tr><td class="${cell}">${esc(r.place)}</td><td class="${cell}">${esc(tierName(r.tier))}</td><td class="${cell}">${usd(r.running)}</td><td class="${cell}">${usd(r.asleep)}</td><td class="${cell}">${usd(r.transfer)}</td></tr>`),
    '</tbody></table>',
    ...notes(pricing, at).map((n) => `<p class="mt-2">${esc(n)}</p>`),
  ].join('');
}

/** schema.org offers for the application: the range of hourly running prices, in USD. */
export function offers(pricing: PublicPricing): Record<string, unknown> | null {
  const rows = priceRows(pricing);
  if (!rows.length) return null;
  const dollars = (micros: number) => Math.round((micros / MICROS_PER_USD) * 10_000) / 10_000;
  const running = rows.map((r) => r.running);
  return {
    '@type': 'AggregateOffer',
    priceCurrency: 'USD',
    lowPrice: dollars(Math.min(...running)),
    highPrice: dollars(Math.max(...running)),
    offerCount: rows.length,
    url: 'https://nevazu.com/pricing',
    description: 'Price per hour of running time for one browser (compute, dedicated IP and storage), by region and machine tier. Prepaid, metered per minute.',
  };
}

/** Fills every live slot from `values` (by name); a slot without a value keeps its fallback. */
export function fillSlots(text: string, values: Record<string, string | null>): string {
  return text.replace(/<!--live:([a-z-]+)-->([\s\S]*?)<!--\/live:\1-->/g, (_, name: string, fallback: string) => values[name] ?? fallback);
}

/** Sets `offers` on the JSON-LD application node (`…/#app`), leaving everything else as built. */
export function addOffers(html: string, offer: Record<string, unknown>): string {
  return html.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (whole, open: string, json: string, close: string) => {
    let data: { '@graph'?: Record<string, unknown>[] };
    try {
      data = JSON.parse(json);
    } catch {
      return whole;
    }
    const app = data['@graph']?.find((n) => typeof n['@id'] === 'string' && n['@id'].endsWith('/#app'));
    if (!app) return whole;
    app.offers = offer;
    return open + JSON.stringify(data).replace(/</g, '\\u003c') + close;
  });
}

async function serveLive(c: Context<AppEnv>, asset: string) {
  // The operator console's host keeps its own app shell at every path.
  if (isAdminOrigin(c.env, c.req.url)) return c.env.ASSETS.fetch(c.req.raw);
  // A plain request: conditional headers would answer 304 without the body this needs to fill.
  const built = await c.env.ASSETS.fetch(new Request(new URL(asset, c.req.url)));
  if (!built.ok) return built;
  const { pricing, at } = await cachedPricing(c.env);
  let text = await built.text();
  const html = (built.headers.get('content-type') ?? '').includes('text/html');
  const summary = pricing && summaryText(pricing, at);
  text = fillSlots(text, html
    ? { prices: pricing && pricesHtml(pricing, at), summary: summary ? `<p>${esc(summary)}</p>` : null }
    : { 'prices-md': pricing && pricesMarkdown(pricing, at), 'summary-md': summary });
  const offer = html && pricing ? offers(pricing) : null;
  if (offer) text = addOffers(text, offer);
  // The asset's own headers (content type, the security headers from _headers) stay; the body
  // changed, so its ETag and length no longer apply.
  const headers = new Headers(built.headers);
  headers.delete('etag');
  headers.delete('content-length');
  return new Response(text, { status: built.status, headers });
}

export const siteRoute = new Hono<AppEnv>();

// /home is the file behind /, not a page of its own.
siteRoute.get('/home', (c) => (isAdminOrigin(c.env, c.req.url) ? c.env.ASSETS.fetch(c.req.raw) : c.redirect('/', 301)));
for (const [path, asset] of Object.entries(LIVE_PAGES)) siteRoute.get(path, (c) => serveLive(c, asset));
