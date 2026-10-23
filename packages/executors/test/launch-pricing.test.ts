import { describe, expect, it } from 'vitest';
import { AwsExecutor, FakeExecutor, MemoryFakeStore, type Executor, type OpContext, type VmSpec } from '../src/index.js';
import { FakeEc2 } from './fake-ec2.js';

const REGION = 'ap-northeast-1';
const ctx = (step: string): OpContext => ({
  operationId: 'op-price', step, token: `op-price:${step}:1`,
  tags: { 'cb:managed': 'true', 'cb:env': 'test', 'cb:instance': 'browser1', 'cb:op': 'op-price', 'cb:gen': '1' },
  deadline: Date.now() + 60_000,
});

function setup() {
  const ec2 = new FakeEc2();
  const ex = new AwsExecutor({
    mode: 'runtime', accessKeyId: 'test', secretAccessKey: 'test',
    regions: { [REGION]: { subnets: { [`${REGION}a`]: 'subnet-a' }, securityGroupId: 'sg1' } },
    appUrl: 'https://app.test', agentImage: 'agent:test', browserImage: 'browser:test',
    endpoint: () => 'https://ec2.test/', fetch: ec2.fetch, sleep: async () => {}, pollMs: 1,
  });
  return { ex, ec2 };
}

async function parts(ex: Executor): Promise<VmSpec> {
  const ip = await ex.allocateIp(ctx('ip'), REGION);
  const nic = await ex.ensureNetworkInterface(ctx('nic'), REGION, ip);
  const vol = await ex.ensureVolume(ctx('volume'), REGION, nic.zone, 10);
  return { instanceId: 'browser1', nicId: nic.nicId, zone: nic.zone, volumeId: vol.volumeId, bootstrapToken: 'bootstrap', gatewayUrl: 'wss://gateway.test',
    maxVmHour: 0.11072, instanceTypePrices: { 'c7i-flex.large': 0.11072, 'c6i.large': 0.111, 'c5.large': 0.111 },
  };
}

describe('new launches respect the confirmed compute price', () => {
  it('tries fallback machines up to 5% above the quoted price after the quoted type has no capacity, never more', async () => {
    const { ex, ec2 } = setup();
    const spec = await parts(ex);
    ec2.fail = (action) => action === 'RunInstances' ? { code: 'InsufficientInstanceCapacity', status: 500 } : null;
    // Basic's fallbacks cost a fraction of a percent more than its first machine.
    await expect(ex.ensureVm(ctx('vm'), REGION, spec)).rejects.toMatchObject({ errorClass: 'capacity' });
    expect(ec2.calls.filter((c) => c.action === 'RunInstances').map((c) => c.params.InstanceType)).toEqual(['c7i-flex.large', 'c6i.large', 'c5.large']);
    ec2.calls.length = 0;
    spec.instanceTypePrices!['c6i.large'] = 0.11072 * 1.05 + 0.0001;
    spec.instanceTypePrices!['c5.large'] = 0.2;
    await expect(ex.ensureVm(ctx('vm2'), REGION, spec)).rejects.toMatchObject({ errorClass: 'capacity' });
    expect(ec2.calls.filter((c) => c.action === 'RunInstances').map((c) => c.params.InstanceType)).toEqual(['c7i-flex.large']);
    expect(ec2.instances.size).toBe(0);
  });

  it('launches nothing when the quoted machine itself costs more than confirmed: prices rose since', async () => {
    const { ex, ec2 } = setup();
    const spec = await parts(ex);
    spec.maxVmHour = 0.11;
    spec.instanceTypePrices = { 'c7i-flex.large': 0.11072, 'c6i.large': 0.2, 'c5.large': 0.2 };
    await expect(ex.ensureVm(ctx('vm'), REGION, spec)).rejects.toMatchObject({ errorClass: 'capacity', reason: 'price' });
    expect(ec2.calls.some((c) => c.action === 'RunInstances')).toBe(false);
  });

  it.each([0.11072, 0.1, 0.111])('allows a fallback costing %s USD/hour within the confirmed cap', async (fallbackPrice) => {
    const { ex, ec2 } = setup();
    const spec = await parts(ex);
    spec.instanceTypePrices!['c6i.large'] = fallbackPrice;
    ec2.fail = (action, params) => action === 'RunInstances' && params.InstanceType === 'c7i-flex.large' ? { code: 'InsufficientInstanceCapacity', status: 500 } : null;
    expect((await ex.ensureVm(ctx('vm'), REGION, spec)).instanceType).toBe('c6i.large');
    expect(ec2.calls.filter((c) => c.action === 'RunInstances').map((c) => c.params.InstanceType)).toEqual(['c7i-flex.large', 'c6i.large']);
  });

  it.each(['missing-price', 'missing-cap', 'invalid-cap'] as const)('fails closed before launching when the quote has %s', async (invalid) => {
    const { ex, ec2 } = setup();
    const spec = await parts(ex);
    if (invalid === 'missing-price') delete spec.instanceTypePrices!['c6i.large'];
    else spec.maxVmHour = invalid === 'missing-cap' ? undefined : NaN;
    await expect(ex.ensureVm(ctx('vm'), REGION, spec)).rejects.toMatchObject({ errorClass: 'invalid' });
    expect(ec2.calls.some((c) => c.action === 'RunInstances')).toBe(false);
  });

  it('retains original per-type idempotency tokens when an expensive first candidate is filtered', async () => {
    const { ex, ec2 } = setup();
    const spec = await parts(ex);
    spec.maxVmHour = 0.1;
    spec.instanceTypePrices!['c6i.large'] = 0.1;
    expect((await ex.ensureVm(ctx('vm'), REGION, spec)).instanceType).toBe('c6i.large');
    expect(ec2.calls.find((c) => c.action === 'RunInstances')?.params.ClientToken).toBe('op-price:vm:1:1');
  });

  it('resolves an existing VM even if current launch prices no longer fit the original cap', async () => {
    const { ex, ec2 } = setup();
    const spec = await parts(ex);
    const first = await ex.ensureVm(ctx('vm'), REGION, spec);
    const again = await ex.ensureVm(ctx('vm'), REGION, { ...spec, maxVmHour: 0.001, instanceTypePrices: {} });
    expect(again.vmId).toBe(first.vmId);
    expect(ec2.calls.filter((c) => c.action === 'RunInstances')).toHaveLength(1);
  });

  it.each(['aws', 'fake'] as const)('%s inventory reports the actual grown data volume size', async (kind) => {
    const ex = kind === 'aws' ? setup().ex : new FakeExecutor({ store: new MemoryFakeStore(), mode: 'runtime' });
    const spec = await parts(ex);
    await ex.resizeVolume(ctx('resize'), REGION, spec.volumeId, 24);
    const found = (await ex.listManaged(ctx('inventory'), REGION)).find((r) => r.providerId === spec.volumeId);
    expect(found).toMatchObject({ kind: 'volume', sizeGb: 24 });
  });
});
