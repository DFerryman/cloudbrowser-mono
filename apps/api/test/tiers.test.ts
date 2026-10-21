import { beforeEach, describe, expect, it } from 'vitest';
import { setup, signIn, SIMULATED_SHEET } from './helpers.js';

/** What the simulator reports where it offers Premium (fake executor `prices`). */
const PREMIUM_SHEET = {
  ...SIMULATED_SHEET,
  instanceTypes: { 'fake.large': 0.1, 'fake.xlarge': 0.21 },
  premium: { instanceType: 'fake.xlarge', vmHour: 0.21, machine: { vcpu: 4, memoryGb: 8 } },
};

let t: ReturnType<typeof setup>;
type Pricing = { regionId: string; version: string; rates: { compute: number }; premium: { version: string; rates: { compute: number }; machine: { vcpu: number; memoryGb: number } } | null };
const pricing = async (regionId = 'tyo1') => (await t.call('GET', '/api/v1/pricing')).body.find((p: Pricing) => p.regionId === regionId) as Pricing;
const create = (body: Record<string, unknown>, key: string) =>
  t.call('POST', '/api/v1/instances', { name: key, regionId: 'tyo1', storageGb: 10, ...body }, { 'idempotency-key': key });
const offerPremium = () => t.d1.sqlite.exec(`UPDATE caps SET "limit" = 1 WHERE scope = 'user:default' AND metric = 'premium'`);

beforeEach(async () => {
  t = setup();
  // Tokyo offers Premium; Sydney prices Basic only, like a region without Premium machines.
  t.d1.sqlite.prepare(`UPDATE provider_prices SET sheet = ? WHERE region_id = 'tyo1'`).run(JSON.stringify(PREMIUM_SHEET));
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('pilot@example.com')`);
  await signIn(t, 'pilot@example.com');
});

describe('premium browsers', () => {
  it('prices Premium separately: its own compute rate, machine and price version', async () => {
    const tokyo = await pricing('tyo1');
    expect(tokyo.premium).toMatchObject({ machine: { vcpu: 4, memoryGb: 8 } });
    // 0.21 USD an hour at the default 120% compute markup; Basic is 0.10.
    expect(tokyo.premium!.rates.compute).toBe(252_000);
    expect(tokyo.rates.compute).toBe(120_000);
    expect(tokyo.premium!.version).not.toBe(tokyo.version);
    expect((await pricing('syd1')).premium).toBeNull();
    const regions = (await t.call('GET', '/api/v1/regions')).body as { id: string; premium: unknown }[];
    expect(regions.find((r) => r.id === 'tyo1')?.premium).toMatchObject({ availability: 'available' });
    expect(regions.find((r) => r.id === 'syd1')?.premium).toBeNull();
  });

  it('shows Premium stock beside Basic stock: each counts the vCPUs its machine holds', async () => {
    const now = Date.now();
    // 12 vCPUs of room: six Basic browsers (2 each) or three Premium (4 each).
    t.d1.sqlite.exec(`UPDATE regions SET executor = 'aws-ec2' WHERE id = 'tyo1';
      UPDATE provider_prices SET executor = 'aws-ec2' WHERE region_id = 'tyo1';
      INSERT INTO aws_provider_regions (region_id, provider_region, opt_in_status, status, capacity, vcpu_capacity, basic_vcpus, premium_vcpus, premium_offered, checked_at)
        VALUES ('tyo1', 'ap-northeast-1', 'opt-in-not-required', 'ready', 10, 12, 2, 4, 1, ${now});`);
    const tokyo = () => t.call('GET', '/api/v1/regions').then((r) => (r.body as { id: string; inventory: { available: number }; premium: { availability: string; inventory: { available: number; status: string } } }[]).find((x) => x.id === 'tyo1')!);
    expect(await tokyo()).toMatchObject({ inventory: { available: 6 }, premium: { availability: 'available', inventory: { available: 3, status: 'ready' } } });
    // The last Premium slot reads as low stock, as Basic's does.
    t.d1.sqlite.exec(`UPDATE aws_provider_regions SET vcpu_capacity = 4 WHERE region_id = 'tyo1'`);
    expect(await tokyo()).toMatchObject({ inventory: { available: 2 }, premium: { availability: 'limited', availabilityReason: 'low_stock', inventory: { available: 1 } } });
  });

  it('is off until the operator offers it', async () => {
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.premium).toBe(false);
    const refused = await create({ tier: 'premium', priceVersion: (await pricing()).premium!.version }, 'p1');
    expect(refused).toMatchObject({ status: 403, body: { type: 'plan_limit', limit: 'premium' } });
    expect(t.d1.sqlite.prepare('SELECT COUNT(*) n FROM browser_instances').get()).toEqual({ n: 0 });
  });

  it('creates a Premium browser on the Premium machine at the Premium price', async () => {
    offerPremium();
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.premium).toBe(true);
    const p = await pricing();
    // The Basic price version does not confirm Premium's price.
    expect(await create({ tier: 'premium', priceVersion: p.version }, 'stale')).toMatchObject({ status: 409, body: { type: 'price_changed' } });
    const created = await create({ tier: 'premium', priceVersion: p.premium!.version }, 'p1');
    expect(created.status).toBe(202);
    await t.settle();
    const inst = (await t.call('GET', `/api/v1/instances/${created.body.instanceId}`)).body;
    expect(inst).toMatchObject({ tier: 'premium', status: 'running' });
    expect(t.d1.sqlite.prepare(`SELECT instance_type FROM placements WHERE instance_id = ?`).get(inst.id)).toEqual({ instance_type: 'fake.xlarge' });
    // The confirmed price caps what a capacity fallback may launch.
    const op = t.d1.sqlite.prepare(`SELECT params FROM operations WHERE id = ?`).get(created.body.operationId) as { params: string };
    expect(JSON.parse(op.params)).toMatchObject({ maxVmHour: 0.21 });
    // Never sleep quotes 24 hours of the Premium machine.
    const quote = (await t.call('GET', `/api/v1/instances/${inst.id}/never-sleep`)).body;
    expect(quote.day.computeMicros).toBe(252_000 * 24);
    // Basic browsers are unchanged.
    const basic = await create({ priceVersion: p.version }, 'b1');
    expect(basic.status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${basic.body.instanceId}`)).body.tier).toBe('basic');
    expect(t.d1.sqlite.prepare(`SELECT instance_type FROM placements WHERE instance_id = ?`).get(basic.body.instanceId)).toEqual({ instance_type: 'fake.large' });
  });

  it('refuses Premium where the region does not offer it', async () => {
    offerPremium();
    const sydney = await pricing('syd1');
    expect(await create({ tier: 'premium', regionId: 'syd1', priceVersion: sydney.version }, 'p1')).toMatchObject({ status: 409, body: { type: 'region_unavailable' } });
  });

  it('keeps the free trial on Basic', async () => {
    offerPremium();
    t.d1.sqlite.exec(`UPDATE control_flags SET value = 'true' WHERE key = 'billing_required'`);
    t.d1.sqlite.prepare(`UPDATE provider_prices SET sheet = ? WHERE region_id = 'syd1'`).run(JSON.stringify(PREMIUM_SHEET));
    const sydney = await pricing('syd1');
    const refused = await create({ tier: 'premium', regionId: 'syd1', trial: true, storageGb: 2, priceVersion: sydney.premium!.version }, 'trial');
    expect(refused).toMatchObject({ status: 400, body: { type: 'validation_failed' } });
  });
});
