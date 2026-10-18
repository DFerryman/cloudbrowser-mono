import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AwsExecutor, bootstrapScript, ExecutorError, type CredentialMode, type OpContext, type Placement } from '../src/index.js';
import { FakeEc2 } from './fake-ec2.js';

const REGION = 'ap-northeast-1';

function setup(mode: CredentialMode = 'runtime', ec2 = new FakeEc2()) {
  const ex = new AwsExecutor({
    mode,
    accessKeyId: 'AKIDTEST',
    secretAccessKey: 'secret',
    regions: { [REGION]: { subnets: { 'ap-northeast-1a': 'subnet-a', 'ap-northeast-1c': 'subnet-c' }, securityGroupId: 'sg-1' } },
    appUrl: 'https://app.example.com',
    agentImage: 'ghcr.io/x/agent:main',
    browserImage: 'ghcr.io/x/browser:main',
    endpoint: () => 'https://ec2.test/',
    fetch: ec2.fetch,
    sleep: async () => {},
    pollMs: 1,
  });
  return { ex, ec2 };
}

const ctx = (step: string, token = `op1:${step}:1`): OpContext => ({
  operationId: 'op1',
  step,
  token,
  tags: { 'cb:managed': 'true', 'cb:env': 'test', 'cb:instance': 'inst1', 'cb:op': 'op1', 'cb:gen': '1' },
  deadline: Date.now() + 60_000,
});

async function create(ex: AwsExecutor) {
  const ip = await ex.allocateIp(ctx('allocate_ip'), REGION);
  const nic = await ex.ensureNetworkInterface(ctx('create_nic'), REGION, ip);
  const vol = await ex.ensureVolume(ctx('create_volume'), REGION, nic.zone, 20);
  const vm = await ex.ensureVm(ctx('create_vm'), REGION, {
    instanceId: 'inst1',
    zone: nic.zone,
    nicId: nic.nicId,
    volumeId: vol.volumeId,
    bootstrapToken: 'boot-token',
    gatewayUrl: 'wss://connect.example.com',
  });
  const p: Placement = { providerRegion: REGION, zone: vm.zone, vmId: vm.vmId, volumeId: vol.volumeId, nicId: nic.nicId, ipAllocationId: ip.allocationId, ipAddress: ip.address };
  return { ip, nic, vol, vm, p };
}

describe('aws-ec2 executor', () => {
  it('creates a tagged VM with its static IP, data volume and first-boot script, then sleeps and wakes it', async () => {
    const { ex, ec2 } = setup();
    const { vm, vol, p } = await create(ex);
    const inst = ec2.instances.get(vm.vmId)!;
    expect(inst.state).toBe('running');
    expect(inst.type).toBe('m7i-flex.large');
    expect(inst.protected).toBe(true);
    expect(inst.tags).toMatchObject({ 'cb:managed': 'true', 'cb:instance': 'inst1', 'cb:kind': 'vm', 'cb:token': 'op1:create_vm:1' });
    expect(inst.userData).toContain('"bootstrapToken":"boot-token"');
    expect(inst.userData).toContain('ECHO_URL=https://app.example.com/api/echo/ip');
    const run = ec2.calls.find((c) => c.action === 'RunInstances')!.params;
    expect(run).toMatchObject({ ImageId: 'ami-new', 'MetadataOptions.HttpTokens': 'required', 'BlockDeviceMapping.1.Ebs.Encrypted': 'true' });
    expect(ec2.volumes.get(vol.volumeId)).toMatchObject({ instance: vm.vmId, device: '/dev/sdf', status: 'in-use' });

    expect(await ex.verifyEgress(ctx('verify'), p)).toMatchObject({ ok: true, publicAddresses: [p.ipAddress] });
    expect(await ex.ensureStopped(ctx('stop'), p)).toBe('stopped');
    expect(await ex.ensureStopped(ctx('stop'), p)).toBe('stopped');
    expect(await ex.ensureRunning(ctx('start'), p)).toBe('running');
    expect(await ex.describe(ctx('describe'), p)).toEqual({ vm: 'running', publicAddresses: [p.ipAddress], volumeAttached: true });
    // A stopped VM keeps its IP and disk.
    expect(ec2.addresses.get(p.ipAllocationId)?.eni).toBe(p.nicId);
  });

  it('never creates twice for the same token', async () => {
    const { ex, ec2 } = setup();
    const first = await create(ex);
    const again = await create(ex);
    expect(again.p).toEqual(first.p);
    expect(ec2.addresses.size).toBe(1);
    expect(ec2.enis.size).toBe(1);
    expect(ec2.instances.size).toBe(1);
    expect([...ec2.volumes.values()].filter((v) => v.tags['cb:kind'] === 'volume')).toHaveLength(1);
    expect(ec2.calls.filter((c) => c.action === 'AllocateAddress')).toHaveLength(1);
  });

  it('tries the next instance type when one has no capacity', async () => {
    const { ex, ec2 } = setup();
    ec2.fail = (a, p) => (a === 'RunInstances' && p.InstanceType === 'm7i-flex.large' ? { code: 'InsufficientInstanceCapacity', status: 500 } : null);
    const { vm } = await create(ex);
    expect(ec2.instances.get(vm.vmId)?.type).toBe('m6i.large');
    ec2.fail = (a) => (a === 'RunInstances' ? { code: 'InsufficientInstanceCapacity', status: 500 } : null);
    await expect(ex.ensureVm(ctx('create_vm', 'op2:create_vm:1'), REGION, {
      instanceId: 'inst2', zone: 'ap-northeast-1a', nicId: [...ec2.enis.keys()][0]!, volumeId: 'vol-x', bootstrapToken: 't', gatewayUrl: 'wss://g',
    })).rejects.toMatchObject({ errorClass: 'capacity' });
  });

  it('classifies provider errors', async () => {
    const { ex, ec2 } = setup();
    const cls = async (code: string, status: number, call: () => Promise<unknown>) => {
      ec2.fail = () => ({ code, status });
      return call().then(
        () => 'ok',
        (e: ExecutorError) => e.errorClass,
      );
    };
    expect(await cls('UnauthorizedOperation', 403, () => ex.allocateIp(ctx('a'), REGION))).toBe('forbidden');
    ec2.fail = () => null;
    ec2.fail = (a) => (a === 'AllocateAddress' ? { code: 'AddressLimitExceeded', status: 400 } : null);
    expect(await ex.allocateIp(ctx('a2'), REGION).then(() => 'ok', (e: ExecutorError) => e.errorClass)).toBe('quota');
    expect(await cls('RequestLimitExceeded', 503, () => ex.listManaged(ctx('l'), REGION))).toBe('retryable');
    expect(await cls('InternalError', 500, () => ex.ensureVolume(ctx('v'), REGION, 'ap-northeast-1a', 20))).toBe('retryable');
    ec2.fail = () => null;
    // A lost response on a create is an unknown outcome: the journal looks up before retrying.
    const broken = new AwsExecutor({
      ...{ mode: 'runtime' as const, accessKeyId: 'a', secretAccessKey: 's', regions: { [REGION]: { subnets: { 'ap-northeast-1a': 'subnet-a' }, securityGroupId: 'sg' } } },
      appUrl: 'https://a', agentImage: 'a', browserImage: 'b', endpoint: () => 'https://ec2.test/',
      fetch: async (r) => ((await (r as Request).clone().text()).includes('Action=Describe') ? ec2.fetch(r) : Promise.reject(new Error('connection reset'))),
      sleep: async () => {},
    });
    await expect(broken.allocateIp(ctx('a'), REGION)).rejects.toMatchObject({ errorClass: 'unknown_outcome' });
  });

  it('keeps delete rights with the reaper only, and refuses untagged creates', async () => {
    const { ex, ec2 } = setup();
    const { p } = await create(ex);
    await expect(ex.ensureDeleted(ctx('d'), REGION, 'vm', p.vmId)).rejects.toMatchObject({ errorClass: 'forbidden' });
    const untagged = { ...ctx('a', 'tok-untagged'), tags: { ...ctx('a').tags, 'cb:managed': 'false' as 'true' } };
    await expect(ex.allocateIp(untagged, REGION)).rejects.toMatchObject({ errorClass: 'forbidden' });
    const { ex: reaper } = setup('reaper', ec2);
    await expect(reaper.allocateIp(ctx('a', 'tok-r'), REGION)).rejects.toMatchObject({ errorClass: 'forbidden' });
    const { ex: ro } = setup('readonly', ec2);
    await expect(ro.ensureStopped(ctx('s'), p)).rejects.toMatchObject({ errorClass: 'forbidden' });
  });

  it('snapshots, restores into a new volume and swaps it in while stopped', async () => {
    const { ex, ec2 } = setup();
    const { p } = await create(ex);
    const snap = await ex.snapshot(ctx('snapshot_volume'), REGION, p.volumeId);
    expect(await ex.snapshot(ctx('snapshot_volume'), REGION, p.volumeId)).toEqual(snap); // found by token
    expect(ec2.snapshots.size).toBe(1);
    const vol = await ex.ensureVolumeFromSnapshot(ctx('restore_volume'), REGION, p.zone, snap.snapshotId, 20);
    expect(ec2.snapshots.get(snap.snapshotId)?.status).toBe('completed'); // waited for it
    await expect(ex.swapVolume(ctx('swap_volume'), p, vol.volumeId)).rejects.toMatchObject({ errorClass: 'invalid' });
    await ex.ensureStopped(ctx('stop'), p);
    await ex.swapVolume(ctx('swap_volume'), p, vol.volumeId);
    await ex.swapVolume(ctx('swap_volume'), p, vol.volumeId);
    expect(ec2.volumes.get(vol.volumeId)).toMatchObject({ instance: p.vmId, device: '/dev/sdf' });
    expect(ec2.volumes.get(p.volumeId)).toMatchObject({ status: 'available', instance: undefined });
  });

  it('moves the same IP to a replacement VM in another zone (recover)', async () => {
    const { ex, ec2 } = setup();
    const { ip, p } = await create(ex);
    const nic2 = await ex.ensureNetworkInterface(ctx('create_nic', 'op9:create_nic:2'), REGION, ip, 'ap-northeast-1c');
    expect(nic2.zone).toBe('ap-northeast-1c');
    expect(ec2.addresses.get(ip.allocationId)?.eni).toBe(nic2.nicId);
    // The old VM no longer has a public address.
    expect((await ex.verifyEgress(ctx('v'), p)).publicAddresses).toEqual([]);
    expect(ex.zones(REGION)).toEqual(['ap-northeast-1a', 'ap-northeast-1c']);
  });

  it('lists managed resources (not root disks) and deletes everything with the reaper', async () => {
    const { ex, ec2 } = setup();
    const { p } = await create(ex);
    await ex.snapshot(ctx('snapshot_volume'), REGION, p.volumeId);
    const listed = await ex.listManaged(ctx('l'), REGION);
    expect(listed.map((r) => r.kind).sort()).toEqual(['ip', 'network_interface', 'snapshot', 'vm', 'volume']);
    const other = await ex.listManaged({ ...ctx('l'), tags: { ...ctx('l').tags, 'cb:env': 'prod' } }, REGION);
    expect(other).toEqual([]);

    const { ex: reaper } = setup('reaper', ec2);
    for (const r of listed) await reaper.ensureDeleted(ctx('purge'), REGION, r.kind, r.providerId);
    for (const r of listed) await reaper.ensureDeleted(ctx('purge'), REGION, r.kind, r.providerId); // already gone: fine
    expect(await ex.listManaged(ctx('l'), REGION)).toEqual([]);
    expect(ec2.addresses.size).toBe(0);
  });

  it('reads quotas', async () => {
    const { ex } = setup();
    await create(ex);
    expect(await ex.quotas(ctx('q'), REGION)).toEqual([
      { metric: 'static_ips', limit: 5, used: 1 },
      { metric: 'vcpus', limit: 16, used: 2 },
    ]);
  });
});

describe('first-boot script', () => {
  it('is valid bash and carries the agent config safely quoted', () => {
    const script = bootstrapScript({
      instanceId: 'inst1',
      gatewayUrl: "wss://connect.example.com/it's",
      bootstrapToken: 'tok',
      appUrl: 'https://app.example.com/',
      agentImage: 'ghcr.io/x/agent:main',
      browserImage: 'ghcr.io/x/browser:main',
    });
    expect(script.startsWith('#!/bin/bash')).toBe(true);
    expect(script).toContain('ECHO_URL=https://app.example.com/api/echo/ip');
    execFileSync('bash', ['-n'], { input: script });
    // The JSON line, run through bash, comes out intact.
    const line = script.split('\n').find((l) => l.startsWith('printf'))!.replace('>/etc/cloudbrowser/agent.json', '');
    const out = execFileSync('bash', ['-c', line]).toString();
    expect(JSON.parse(out)).toEqual({ instanceId: 'inst1', gatewayUrl: "wss://connect.example.com/it's", bootstrapToken: 'tok' });
  });
});
