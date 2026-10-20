/**
 * Signed-out data for the public site (`/api/public/*`): the price list and the service status.
 * GET only, no session, the same answer for every visitor, cacheable for a minute. Nothing about a single user or browser is exposed.
 */
import { DATA_KEPT_DAYS, TRIAL, costRates, type ComponentStatus, type PublicPricing, type PublicStatus } from '@cloudbrowser/contracts';
import { priceSheets, pricingSettings, schema, trialMinutes } from '@cloudbrowser/db';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { regionViews } from '../availability.js';
import type { AppEnv } from '../env.js';
import { allRegionPricing } from '../pricing.js';

const { awsProviderState, controlFlags, quotaSnapshots } = schema;

/** AWS catalog sync runs every five minutes; the legacy quota snapshot runs hourly. */
const CATALOG_STALE_MS = 30 * 60_000;
const QUOTA_STALE_MS = 90 * 60_000;

export const publicRoute = new Hono<AppEnv>();

publicRoute.use('*', async (c, next) => {
  await next();
  if (c.res.ok) c.header('cache-control', 'public, max-age=60');
});

publicRoute.get('/pricing', async (c) => {
  const db = c.get('db');
  // The same answer for everyone (it is cached): no latency estimate from the caller's location.
  const listed = (await regionViews(db, null)).filter((r) => r.enabled);
  const prices = new Map((await allRegionPricing(db, null)).map((p) => [p.regionId, p]));
  const [sheets, settings] = await Promise.all([priceSheets(db), pricingSettings(db)]);
  const out: PublicPricing = {
    regions: listed.flatMap((r) => {
      const p = prices.get(r.id);
      if (!p) return [];
      const { version: _version, ...rest } = p;
      const sheet = sheets.get(r.id)?.sheet;
      return [{ ...rest, name: r.name, city: r.city, country: r.country, area: r.area, availability: r.availability, acceptingNew: r.acceptingNew,
        cost: sheet ? costRates(sheet, settings.relayGbMicros) : null }];
    }),
    model: {
      computeMarkupPercent: settings.markupPercent,
      fixedMarkupPercent: settings.fixedMarkupPercent,
      transferMarkupPercent: settings.transferMarkupPercent,
      relayGbMicros: settings.relayGbMicros,
      billTransitions: settings.billTransitions,
    },
    minBalanceMicros: settings.minBalanceMicros,
    retentionDays: DATA_KEPT_DAYS,
    trial: { regionId: TRIAL.regionId, minutes: await trialMinutes(db), storageGb: TRIAL.storageGb, keptDays: TRIAL.keptDays },
  };
  return c.json(out);
});

publicRoute.get('/status', async (c) => {
  const db = c.get('db');
  const now = new Date();
  let database: ComponentStatus = 'operational';
  let regionRows: PublicStatus['regions'] = [];
  let creationPaused = false;
  let automation: ComponentStatus | null = null;
  try {
    const [listed, [freeze], [snapshot], [provider]] = await Promise.all([
      regionViews(db, null, now),
      db.select().from(controlFlags).where(eq(controlFlags.key, 'creation_freeze')),
      db.select({ takenAt: quotaSnapshots.takenAt }).from(quotaSnapshots).orderBy(desc(quotaSnapshots.takenAt)).limit(1),
      db.select({ catalogAt: awsProviderState.catalogAt }).from(awsProviderState).where(eq(awsProviderState.id, 1)),
    ]);
    creationPaused = freeze?.value === 'true';
    // Prefer the frequent provider heartbeat. Older deployments only have hourly snapshots.
    const heartbeat = provider?.catalogAt ?? snapshot?.takenAt;
    if (heartbeat) automation = now.getTime() - heartbeat.getTime() > (provider?.catalogAt ? CATALOG_STALE_MS : QUOTA_STALE_MS) ? 'degraded' : 'operational';
    // Regions not offered (switched off by the operator) are not shown, rather than reported down.
    // A region whose stock is used up is working as intended, not degraded.
    regionRows = listed.filter((r) => r.enabled).map((r) => {
      const acceptingNew = !creationPaused && r.acceptingNew;
      const status: ComponentStatus = creationPaused || r.availabilityReason === 'provider_issue' || r.availabilityReason === 'blocked' || r.availabilityReason === 'capacity' ? 'degraded' : 'operational';
      return {
        regionId: r.id, status, enabled: r.enabled, acceptingNew, name: r.name, city: r.city, country: r.country, area: r.area,
        availability: creationPaused ? 'unavailable' as const : r.availability, availabilityReason: creationPaused ? 'closed' as const : r.availabilityReason,
        launchVerifiedAt: r.launchVerifiedAt,
      };
    });
  } catch (e) {
    console.error('status check failed', e);
    database = 'outage';
  }
  const components: PublicStatus['components'] = [
    { id: 'api', status: 'operational' },
    { id: 'database', status: database },
    ...(automation ? [{ id: 'automation' as const, status: automation }] : []),
  ];
  const all = [...components.map((x) => x.status), ...regionRows.map((r) => r.status)];
  const out: PublicStatus = {
    status: all.includes('outage') ? (database === 'outage' ? 'outage' : 'degraded') : all.includes('degraded') ? 'degraded' : 'operational',
    checkedAt: now.toISOString(),
    components,
    regions: regionRows,
    creationPaused,
  };
  return c.json(out);
});
