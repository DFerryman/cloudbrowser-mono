import { afterEach, describe, expect, it, vi } from 'vitest';
import { AwsExecutor, FakeExecutor, MemoryFakeStore, type Executor, type FakeRecord, type OpContext, type Placement, type VmSpec } from '../src/index.js';
import { Ec2Client } from '../src/aws/client.js';
import { FakeEc2 } from './fake-ec2.js';

const REGION = 'ap-northeast-1';
const ZONE = `${REGION}a`;
const cancelled = new Error('operation superseded');
const context = (step: string): OpContext => ({
  operationId: 'op1', step, token: `op1:${step}:1`,
  tags: { 'cb:managed': 'true', 'cb:env': 'test', 'cb:instance': 'inst1', 'cb:op': 'op1', 'cb:gen': '1' },
  deadline: Date.now() + 60_000,
});

function aws() {
  const ec2 = new FakeEc2();
  let active = true;
  let cancelAfter: string | null = null;
  const assertActive = async () => { if (!active) throw cancelled; };
  const ex = new AwsExecutor({
    mode: 'runtime', accessKeyId: 'test', secretAccessKey: 'test',
    regions: { [REGION]: { subnets: { [ZONE]: 'subnet-a' }, securityGroupId: 'sg1' } },
    appUrl: 'https://app.test', agentImage: 'agent:test', browserImage: 'browser:test',
    endpoint: () => 'https://ec2.test/', sleep: async () => {}, pollMs: 1,
    fetch: async (input, init) => {
      const response = await ec2.fetch(input, init);
      if (ec2.calls.at(-1)?.action === cancelAfter) active = false;
      return response;
    },
  });
  return { ex, ec2, ctx: (step: string) => ({ ...context(step), assertActive }), cancelAfter: (action: string) => { cancelAfter = action; } };
}

async function machineParts(ex: Executor) {
  const ip = await ex.allocateIp(context('ip'), REGION);
  const nic = await ex.ensureNetworkInterface(context('nic'), REGION, ip);
  const vol = await ex.ensureVolume(context('volume'), REGION, nic.zone, 10);
  const spec: VmSpec = { instanceId: 'inst1', zone: nic.zone, nicId: nic.nicId, volumeId: vol.volumeId, bootstrapToken: 'bootstrap', gatewayUrl: 'wss://gateway.test' };
  return { ip, nic, vol, spec };
}

async function machine(ex: Executor) {
  const { ip, nic, vol, spec } = await machineParts(ex);
  const vm = await ex.ensureVm(context('vm'), REGION, spec);
  const p: Placement = { providerRegion: REGION, zone: nic.zone, vmId: vm.vmId, nicId: nic.nicId, volumeId: vol.volumeId, ipAllocationId: ip.allocationId, ipAddress: ip.address };
  return { p, vm, vol };
}

afterEach(() => { vi.useRealTimers(); });

describe('provider requests respect a superseding operation', () => {
  it('passes cancellation through unchanged even when it happens during AWS request signing', async () => {
    const fetch = vi.fn();
    const client = new Ec2Client({ accessKeyId: 'test', secretAccessKey: 'test', endpoint: () => 'https://ec2.test/', fetch });
    let checks = 0;
    const assertActive = async () => { if (++checks === 2) throw cancelled; };
    await expect(client.call(REGION, 'AllocateAddress', { Domain: 'vpc' }, Date.now() + 60_000, true, assertActive)).rejects.toBe(cancelled);
    expect(checks).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not associate an IP after cancellation during network interface creation', async () => {
    const w = aws();
    const ip = await w.ex.allocateIp(context('ip'), REGION);
    w.cancelAfter('CreateNetworkInterface');
    await expect(w.ex.ensureNetworkInterface(w.ctx('nic'), REGION, ip)).rejects.toBe(cancelled);
    expect(w.ec2.enis.size).toBe(1); // The accepted create remains discoverable for cleanup.
    expect(w.ec2.addresses.get(ip.allocationId)?.eni).toBeUndefined();
    expect(w.ec2.calls.some((c) => c.action === 'AssociateAddress')).toBe(false);
  });

  it('does not attach a profile disk after cancellation during VM creation', async () => {
    const w = aws();
    const { spec, vol } = await machineParts(w.ex);
    w.cancelAfter('RunInstances');
    await expect(w.ex.ensureVm(w.ctx('vm'), REGION, spec)).rejects.toBe(cancelled);
    expect(w.ec2.instances.size).toBe(1);
    expect(w.ec2.volumes.get(vol.volumeId)?.instance).toBeUndefined();
    expect(w.ec2.calls.some((c) => c.action === 'AttachVolume')).toBe(false);
  });

  it('does not attach a restored profile after cancellation during the old disk detach', async () => {
    const w = aws();
    const { p } = await machine(w.ex);
    await w.ex.ensureStopped(context('stop'), p);
    const next = await w.ex.ensureVolume(context('replacement'), REGION, ZONE, 10);
    const attaches = w.ec2.calls.filter((c) => c.action === 'AttachVolume').length;
    w.cancelAfter('DetachVolume');
    await expect(w.ex.swapVolume(w.ctx('swap'), p, next.volumeId)).rejects.toBe(cancelled);
    expect(w.ec2.volumes.get(next.volumeId)?.instance).toBeUndefined();
    expect(w.ec2.calls.filter((c) => c.action === 'AttachVolume')).toHaveLength(attaches);
  });

  it.each(['aws', 'fake'] as const)('%s refuses to start or stop another browser’s VM', async (kind) => {
    const ex = kind === 'aws' ? aws().ex : new FakeExecutor({ store: new MemoryFakeStore(), mode: 'runtime' });
    const { p } = await machine(ex);
    const foreign = { ...context('foreign'), tags: { ...context('foreign').tags, 'cb:instance': 'another-browser' } };
    await expect(ex.ensureStopped(foreign, p)).rejects.toMatchObject({ errorClass: 'forbidden' });
    await ex.ensureStopped(context('stop'), p);
    await expect(ex.ensureRunning(foreign, p)).rejects.toMatchObject({ errorClass: 'forbidden' });
    expect((await ex.describe(context('check'), p)).vm).toBe('stopped');
  });

  it('checks the fake operation again after simulated latency and creates nothing when cancelled', async () => {
    vi.useFakeTimers();
    const store = new MemoryFakeStore();
    const ex = new FakeExecutor({ store, mode: 'runtime', delayMs: 50 });
    let active = true;
    const result = ex.allocateIp({ ...context('ip'), assertActive: async () => { if (!active) throw cancelled; } }, REGION);
    const assertion = expect(result).rejects.toBe(cancelled);
    await vi.advanceTimersByTimeAsync(0);
    active = false;
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(store.records.size).toBe(0);
  });

  it('checks fake sub-mutations after an already accepted create instead of moving the old IP', async () => {
    let active = true;
    class CancellingStore extends MemoryFakeStore {
      override async insert(record: FakeRecord) {
        await super.insert(record);
        if (record.kind === 'network_interface') active = false;
      }
    }
    const store = new CancellingStore();
    const ex = new FakeExecutor({ store, mode: 'runtime' });
    const ip = await ex.allocateIp(context('ip'), REGION);
    const ctx = { ...context('nic'), assertActive: async () => { if (!active) throw cancelled; } };
    await expect(ex.ensureNetworkInterface(ctx, REGION, ip)).rejects.toBe(cancelled);
    expect(store.records.get(ip.allocationId)?.state).toBe('allocated');
    expect(store.records.get(ip.allocationId)?.attrs.nicId).toBeUndefined();
    expect([...store.records.values()].filter((r) => r.kind === 'network_interface')).toHaveLength(1);
  });
});
