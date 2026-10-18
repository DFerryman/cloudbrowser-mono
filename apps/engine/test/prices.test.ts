import { createDb, priceSheets, schema, type Db } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { ExecutorError, FakeExecutor, MemoryFakeStore, type OpContext, type Placement } from '@cloudbrowser/executors';
import { eq, ne } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineDeps } from '../src/context.js';
import { refreshPrices } from '../src/prices.js';

const { regions, providerPrices, placements, browserInstances, user } = schema;
const REGION = 'ap-southeast-2';

class PriceWorld {
  d1 = createTestD1();
  db: Db = createDb(this.d1);
  store = new MemoryFakeStore();
  clock = new Date('2026-10-18T00:00:00Z');
  executor = new FakeExecutor({ store: this.store, mode: 'readonly' });

  deps(): EngineDeps {
    return {
      db: this.db,
      mode: 'worker',
      executor: () => this.executor,
      agent: () => { throw new Error('Price refresh must not contact the browser agent'); },
      envName: 'test',
      gatewayUrl: 'wss://gateway.test',
      workerId: 'price-test',
      now: () => this.clock,
      notify: () => {},
      bootstrapSecret: 'unused-by-price-refresh',
      sleep: async () => {},
      archives: null,
      archiveMasterKey: null,
    };
  }

  advance(ms: number) {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  async row() {
    return (await this.db.select().from(providerPrices).where(eq(providerPrices.regionId, 'syd1')))[0]!;
  }

  /** A provider VM created before placement machine metadata was recorded. */
  async legacyPlacement() {
    await this.db.insert(user).values({ id: 'u1', name: 'User', email: 'user@test', createdAt: this.clock, updatedAt: this.clock });
    await this.db.insert(browserInstances).values({
      id: 'browser1', userId: 'u1', name: 'Existing browser', regionId: 'syd1', status: 'sleeping', desiredState: 'sleeping',
      idleTimeoutS: 600, locale: 'en-US', screen: 'auto',
      fingerprint: { timezone: 'Australia/Sydney', locale: 'en-US', screen: 'auto', chromeMajor: null },
      createdAt: this.clock, updatedAt: this.clock,
    });
    const runtime = new FakeExecutor({ store: this.store, mode: 'runtime', priceSheet: { rootVolumeGb: 24 } });
    const context = (step: string): OpContext => ({
      operationId: 'legacy-create', step, token: `legacy-create:${step}`,
      tags: { 'cb:managed': 'true', 'cb:env': 'test', 'cb:instance': 'browser1', 'cb:op': 'legacy-create', 'cb:gen': '1' },
      deadline: Date.now() + 30_000,
    });
    const ip = await runtime.allocateIp(context('ip'), REGION);
    const nic = await runtime.ensureNetworkInterface(context('nic'), REGION, ip);
    const volume = await runtime.ensureVolume(context('volume'), REGION, nic.zone, 20);
    const vm = await runtime.ensureVm(context('vm'), REGION, {
      instanceId: 'browser1', zone: nic.zone, nicId: nic.nicId, volumeId: volume.volumeId,
      bootstrapToken: 'test-bootstrap', gatewayUrl: 'wss://gateway.test',
    });
    await runtime.ensureStopped(context('stop'), {
      providerRegion: REGION, zone: vm.zone, vmId: vm.vmId, volumeId: volume.volumeId,
      nicId: nic.nicId, ipAllocationId: ip.allocationId, ipAddress: ip.address,
    });
    await this.db.insert(placements).values({
      id: 'legacy-placement', instanceId: 'browser1', generation: 1, executor: 'fake', providerRegion: REGION,
      zone: vm.zone, vmId: vm.vmId, volumeId: volume.volumeId, networkId: nic.nicId,
      ipAllocationId: ip.allocationId, ipAddress: ip.address, status: 'current', createdAt: this.clock,
    });
  }
}

let w: PriceWorld;
beforeEach(async () => {
  w = new PriceWorld();
  await w.db.delete(regions).where(ne(regions.id, 'syd1'));
  await w.db.update(regions).set({ executor: 'fake', enabled: true }).where(eq(regions.id, 'syd1'));
});
afterEach(() => w.d1.sqlite.close());

describe('provider price refresh and identity', () => {
  it('refreshes within 12 hours when machine configuration changes', async () => {
    await refreshPrices(w.deps());
    const initial = await w.row();
    w.advance(60_000);
    const unchanged = vi.spyOn(w.executor, 'prices');
    expect((await refreshPrices(w.deps())).refreshed).toEqual([]);
    expect(unchanged).not.toHaveBeenCalled();

    w.executor = new FakeExecutor({ store: w.store, mode: 'readonly', priceSheet: { rootVolumeGb: 32 } });
    const changed = vi.spyOn(w.executor, 'prices');
    expect((await refreshPrices(w.deps())).refreshed).toEqual(['syd1']);
    expect(changed).toHaveBeenCalledOnce();
    const current = await w.row();
    expect(current.configurationKey).not.toBe(initial.configurationKey);
    expect(current.sheet).toMatchObject({ rootVolumeGb: 32 });
    expect(current.fetchedAt).toEqual(w.clock);
  });

  it('invalidates the previous quote when changed configuration cannot be priced', async () => {
    await refreshPrices(w.deps());
    w.advance(60_000);
    w.executor = new FakeExecutor({
      store: w.store, mode: 'readonly', priceSheet: { rootVolumeGb: 32 },
      faults: (method) => method === 'prices' ? 'retryable' : null,
    });
    const result = await refreshPrices(w.deps());
    expect(result.failed).toEqual([expect.objectContaining({ regionId: 'syd1', error: expect.stringContaining('prices') })]);
    const current = await w.row();
    expect(current.sheet).toBeNull();
    expect(current.fetchedAt).toBeNull();
    expect(current.lastErrorAt).toEqual(w.clock);
    expect((await priceSheets(w.db)).has('syd1')).toBe(false);
  });

  it('keeps the last good quote during a short provider outage with unchanged configuration', async () => {
    await refreshPrices(w.deps());
    const initial = await w.row();
    w.advance(12 * 3_600_000 + 60_000);
    const read = vi.spyOn(w.executor, 'prices').mockRejectedValue(new ExecutorError('retryable', 'temporary pricing API outage'));
    const result = await refreshPrices(w.deps());
    expect(result.failed).toEqual([{ regionId: 'syd1', error: 'temporary pricing API outage' }]);
    const current = await w.row();
    expect(current.sheet).toEqual(initial.sheet);
    expect(current.fetchedAt).toEqual(initial.fetchedAt);
    expect(current.lastErrorAt).toEqual(w.clock);
    expect((await priceSheets(w.db)).get('syd1')?.sheet).toEqual(initial.sheet);
    // Backoff avoids hammering the provider while continuing to serve that valid quote.
    expect((await refreshPrices(w.deps())).failed).toEqual([]);
    expect(read).toHaveBeenCalledOnce();
  });

  it('discovers legacy machine metadata with read-only calls and prices its actual type', async () => {
    await refreshPrices(w.deps());
    await w.legacyPlacement();
    const realDescribe = w.executor.describe.bind(w.executor);
    const observed = vi.spyOn(w.executor, 'describe').mockImplementation(async (ctx: OpContext, placement: Placement) => ({
      ...await realDescribe(ctx, placement), instanceType: 'fake.legacy',
    }));
    const priced = vi.spyOn(w.executor, 'prices');
    w.advance(60_000);
    expect((await refreshPrices(w.deps())).refreshed).toEqual(['syd1']);
    const [placement] = await w.db.select().from(placements).where(eq(placements.id, 'legacy-placement'));
    expect(placement).toMatchObject({ instanceType: 'fake.legacy', rootVolumeGb: 24 });
    expect(observed).toHaveBeenCalledOnce();
    expect(priced).toHaveBeenCalledWith(expect.objectContaining({ step: 'prices' }), REGION, ['fake.legacy']);
    expect((await w.row()).sheet).toMatchObject({
      instanceType: 'fake.large', rootVolumeGb: 16, instanceTypes: { 'fake.large': 0.1, 'fake.legacy': 0.1 },
    });
    // The historical type does not replace the default machine or require further discovery.
    expect((await refreshPrices(w.deps())).refreshed).toEqual([]);
    expect(observed).toHaveBeenCalledOnce();
  });

  it.each([
    { executor: 'aws-ec2' },
    { providerRegion: 'ap-southeast-1' },
  ])('does not expose stored prices after a region provider change: %j', async (change) => {
    await refreshPrices(w.deps());
    expect((await priceSheets(w.db)).has('syd1')).toBe(true);
    await w.db.update(regions).set(change).where(eq(regions.id, 'syd1'));
    expect((await priceSheets(w.db)).has('syd1')).toBe(false);
  });
});
