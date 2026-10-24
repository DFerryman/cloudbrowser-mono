import { createDb, schema } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { QUOTA_LIMIT_MAX_AGE_MS, REGION_REFRESH_MS, RegionUnusable, quotaLimit, refreshRegions } from '../src/aws-provider.js';

const MIN = 60_000;

function setup() {
  const d1 = createTestD1();
  const db = createDb(d1);
  const now = Date.now();
  d1.sqlite.exec(`UPDATE regions SET executor='aws-ec2'`);
  const regions = (d1.sqlite.prepare('SELECT id, provider_region AS code FROM regions').all() as { id: string; code: string }[]);
  const catalog = (id: string, checkedAt: number | null, extra = '') => d1.sqlite.exec(`INSERT INTO aws_provider_regions (region_id,provider_region,opt_in_status,status,capacity,checked_at)
    SELECT id,provider_region,'opted-in','ready',5,${checkedAt ?? 'NULL'} FROM regions WHERE id='${id}'; ${extra}`);
  const row = async (id: string) => (await db.select().from(schema.awsProviderRegions).where(eq(schema.awsProviderRegions.regionId, id)))[0]!;
  const logs: { event: string; [k: string]: unknown }[] = [];
  const deps = (clock: () => number, observe: (code: string, regionId: string) => Promise<void>, budgetMs = 3 * MIN) => ({
    force: false, catalogDue: false, budgetMs, clock, observe,
    metadata: async () => ({}),
    log: (event: string, fields: Record<string, unknown>) => { logs.push({ event, ...fields }); },
  });
  // What syncRegion writes: the time this region was observed, not when the run began.
  const observedAt = (clock: () => number) => async (_code: string, regionId: string) => {
    await db.update(schema.awsProviderRegions).set({ checkedAt: new Date(clock()), status: 'ready', lastError: null, syncFailures: 0 }).where(eq(schema.awsProviderRegions.regionId, regionId));
  };
  return { d1, db, now, regions, catalog, row, logs, deps, observedAt };
}

it('refreshes the oldest snapshots first, stamps each with its own observation, and skips fresh ones', async () => {
  const { db, now, regions, catalog, row, deps } = setup();
  const [a, b, c] = regions;
  catalog(a!.id, now - 30 * MIN);
  catalog(b!.id, now - MIN);
  catalog(c!.id, now - 15 * MIN);
  let clock = now;
  const order: string[] = [];
  const out = await refreshRegions(db, regions.slice(0, 3).map((r) => ({ code: r.code, optIn: 'opted-in' })), deps(() => clock, async (code, regionId) => {
    order.push(code);
    clock += 30_000; // each region takes 30 seconds
    await db.update(schema.awsProviderRegions).set({ checkedAt: new Date(clock) }).where(eq(schema.awsProviderRegions.regionId, regionId));
  }));
  expect(order).toEqual([a!.code, c!.code]);
  expect(out).toMatchObject({ fresh: 1, taken: [], deferred: [], failed: [] });
  // Different times, both later than the run's start.
  expect((await row(a!.id)).checkedAt!.getTime()).toBeGreaterThan(now);
  expect((await row(c!.id)).checkedAt!.getTime()).toBeGreaterThan((await row(a!.id)).checkedAt!.getTime());
  expect((await row(b!.id)).checkedAt!.getTime()).toBe(now - MIN);
  expect((await row(a!.id)).syncLeaseUntil).toBeNull();
});

it('lets runs overlap without refreshing a region twice or skipping the others', async () => {
  const { db, now, regions, catalog, deps, observedAt } = setup();
  for (const r of regions) catalog(r.id, now - 25 * MIN);
  const discovered = regions.map((r) => ({ code: r.code, optIn: 'opted-in' }));
  const seen: string[] = [];
  let release = () => {};
  const slow = new Promise<void>((r) => { release = r; });
  const record = observedAt(() => Date.now());
  // The first run is stuck on its first region (a slow AWS call); the second takes the rest.
  const first = refreshRegions(db, discovered.slice(0, 1), deps(Date.now, async (code, id) => { seen.push(code); await slow; await record(code, id); }));
  await new Promise((r) => setTimeout(r, 20));
  const second = await refreshRegions(db, discovered, deps(Date.now, async (code, id) => { seen.push(code); await record(code, id); }));
  release();
  await first;
  expect(second.taken).toEqual([regions[0]!.code]);
  expect(second.refreshed.map((r) => r.region).sort()).toEqual(regions.slice(1).map((r) => r.code).sort());
  expect(seen.filter((c) => c === regions[0]!.code)).toHaveLength(1);
  // An expired lease (a run killed mid-region) does not hold the region forever.
  await db.update(schema.awsProviderRegions).set({ syncLeaseUntil: new Date(now - 1), checkedAt: new Date(now - REGION_REFRESH_MS - MIN) });
  const third = await refreshRegions(db, discovered, deps(Date.now, record));
  expect(third.refreshed).toHaveLength(regions.length);
});

it('starts no region once the budget is spent, leaving it to the next run', async () => {
  const { db, now, regions, catalog, deps } = setup();
  const extra = Array.from({ length: 7 - regions.length }, (_, i) => `xx-test-${i}`);
  for (const r of regions) catalog(r.id, now - 25 * MIN);
  let clock = now;
  const discovered = [...regions.map((r) => r.code), ...extra].map((code) => ({ code, optIn: 'opted-in' }));
  const out = await refreshRegions(db, discovered, deps(() => clock, async () => { clock += 4 * MIN; }, 3 * MIN));
  expect(out.refreshed).toHaveLength(6);
  expect(out.deferred).toHaveLength(1);
});

it('keeps the last snapshot through a failed read, and withdraws it only when AWS says the region is unusable', async () => {
  const { db, now, regions, catalog, row, logs, deps } = setup();
  const [a, b] = regions;
  catalog(a!.id, now - 6 * MIN);
  catalog(b!.id, now - 6 * MIN);
  const out = await refreshRegions(db, [a!, b!].map((r) => ({ code: r.code, optIn: 'opted-in' })), deps(Date.now, async (code) => {
    if (code === a!.code) throw new Error('DescribeVolumes: deadline passed');
    throw new RegionUnusable('Regional browser network is not provisioned');
  }));
  expect(out.failed.map((f) => [f.region, f.unusable, f.failures]).sort()).toEqual([[a!.code, false, 1], [b!.code, true, 1]].sort());
  expect(await row(a!.id)).toMatchObject({ status: 'ready', capacity: 5, lastError: 'DescribeVolumes: deadline passed', syncFailures: 1, syncLeaseUntil: null });
  expect((await row(a!.id)).checkedAt!.getTime()).toBe(now - 6 * MIN);
  expect(await row(b!.id)).toMatchObject({ status: 'unavailable', capacity: 0, lastError: 'Regional browser network is not provisioned' });
  expect(logs.filter((l) => l.event === 'region_failed').map((l) => l.region).sort()).toEqual([a!.code, b!.code].sort());
  // Consecutive failures are counted until a refresh succeeds.
  await refreshRegions(db, [{ code: a!.code, optIn: 'opted-in' }], deps(Date.now, async () => { throw new Error('throttled'); }));
  expect((await row(a!.id)).syncFailures).toBe(2);
  const [{ n }] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM aws_provider_regions WHERE sync_lease_until IS NOT NULL`);
  expect(n).toBe(0);
});

it('keeps a quota limit Service Quotas could not return from the last snapshot, for up to a week', () => {
  const now = Date.now();
  expect(quotaLimit(25, { limit: 20, limitAt: now - MIN }, now - MIN, now)).toEqual({ limit: 25, limitAt: now });
  // A throttled or slow read no longer withdraws the region ("Required AWS quota is unavailable").
  expect(quotaLimit(null, { limit: 20, limitAt: now - 3 * 86_400_000 }, now - MIN, now)).toEqual({ limit: 20, limitAt: now - 3 * 86_400_000 });
  // Snapshots written before limitAt existed are as old as their own observation.
  expect(quotaLimit(null, { limit: 20 }, now - 5 * MIN, now)).toEqual({ limit: 20, limitAt: now - 5 * MIN });
  expect(quotaLimit(null, { limit: 20, limitAt: now - QUOTA_LIMIT_MAX_AGE_MS }, now - MIN, now)).toBeNull();
  expect(quotaLimit(null, undefined, now - MIN, now)).toBeNull();
});
