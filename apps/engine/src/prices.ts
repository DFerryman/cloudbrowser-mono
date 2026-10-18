/**
 * Provider prices (page 6): each region's price sheet is read from the provider's price list (AWS
 * Price List API; the `fake` simulator reports its own) and stored in `provider_prices`. Refreshed
 * when older than 12 hours, from the engine's minute cron; after a failure the last good sheet
 * stays in use, the error is recorded, and an alert is raised once the sheet is two days old.
 */
import { raiseAlert, schema } from '@cloudbrowser/db';
import type { ExecutorKind } from '@cloudbrowser/executors';
import { readContext, type EngineDeps } from './context.js';

const { regions, providerPrices } = schema;

export const PRICE_MAX_AGE_MS = 12 * 3_600_000;
/** After a failed refresh, wait this long before trying again. */
const RETRY_AFTER_MS = 15 * 60_000;
const ALERT_AFTER_MS = 48 * 3_600_000;

export async function refreshPrices(deps: EngineDeps, opts: { force?: boolean } = {}) {
  const { db } = deps;
  const now = deps.now();
  const summary = { refreshed: [] as string[], failed: [] as { regionId: string; error: string }[] };
  const all = await db.select().from(regions);
  const stored = new Map((await db.select().from(providerPrices)).map((p) => [p.regionId, p]));
  for (const r of all) {
    const row = stored.get(r.id);
    // Disabled regions are priced too, so an operator sees their prices before enabling them.
    const fresh = row?.fetchedAt && now.getTime() - row.fetchedAt.getTime() < PRICE_MAX_AGE_MS && row.executor === r.executor && row.providerRegion === r.providerRegion;
    const backingOff = row?.lastErrorAt && now.getTime() - row.lastErrorAt.getTime() < RETRY_AFTER_MS;
    if (!opts.force && (fresh || backingOff)) continue;
    try {
      const sheet = await deps.executor(r.executor as ExecutorKind).prices(readContext('prices', deps.envName), r.providerRegion);
      const values = { executor: r.executor, providerRegion: r.providerRegion, sheet, fetchedAt: now, lastError: null, lastErrorAt: null };
      await db.insert(providerPrices).values({ regionId: r.id, ...values }).onConflictDoUpdate({ target: providerPrices.regionId, set: values });
      summary.refreshed.push(r.id);
    } catch (e) {
      const error = (e as Error).message.slice(0, 500);
      summary.failed.push({ regionId: r.id, error });
      await db
        .insert(providerPrices)
        .values({ regionId: r.id, executor: r.executor, providerRegion: r.providerRegion, lastError: error, lastErrorAt: now })
        .onConflictDoUpdate({ target: providerPrices.regionId, set: { lastError: error, lastErrorAt: now } });
      const age = row?.fetchedAt ? now.getTime() - row.fetchedAt.getTime() : Infinity;
      if (r.enabled && age > ALERT_AFTER_MS) {
        await raiseAlert(
          db,
          {
            source: 'engine',
            severity: 'warning',
            title: row?.fetchedAt ? `Prices for ${r.id} are ${Math.floor(age / 3_600_000)} h old` : `No prices for ${r.id}: browsers cannot be created there`,
            detail: { regionId: r.id, error },
            dedupeKey: `prices:${r.id}`,
          },
          now,
        );
      }
    }
  }
  return summary;
}
