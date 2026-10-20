import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AwsExecutor, bootstrapScript, ExecutorError, FakeExecutor, LaunchFailed, isRegionDenial, launchFailureClass, MemoryFakeStore, ProviderFailed, type CredentialMode, type Executor, type OpContext, type Placement, type ResourceKind } from '../src/index.js';
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

async function create(ex: Executor) {
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

async function rejectCrossBrowserReuse(ex: Executor) {
  const first = await create(ex);
  const otherCtx = (step: string): OpContext => ({
    ...ctx(step, `op2:${step}:1`), operationId: 'op2',
    tags: { ...ctx(step).tags, 'cb:instance': 'inst2', 'cb:op': 'op2' },
  });
  const ip = await ex.allocateIp(otherCtx('allocate_ip'), REGION);
  const nic = await ex.ensureNetworkInterface(otherCtx('create_nic'), REGION, ip);
  const vol = await ex.ensureVolume(otherCtx('create_volume'), REGION, nic.zone, 20);
  expect(vol.volumeId).not.toBe(first.vol.volumeId);
  const snap = await ex.snapshot(otherCtx('snapshot'), REGION, vol.volumeId);

  // Neither the address owner nor the target owner can transfer a fixed IP across browsers.
  await expect(ex.associateIp(otherCtx('steal_ip'), REGION, nic.nicId, first.ip)).rejects.toMatchObject({ errorClass: 'forbidden' });
  await expect(ex.associateIp(ctx('foreign_nic'), REGION, nic.nicId, first.ip)).rejects.toMatchObject({ errorClass: 'forbidden' });
  expect(await ex.verifyEgress(ctx('original_ip'), first.p)).toMatchObject({ ok: true, publicAddresses: [first.ip.address] });

  await ex.ensureStopped(ctx('stop'), first.p);
  await expect(ex.swapVolume(ctx('foreign_volume'), first.p, vol.volumeId)).rejects.toMatchObject({ errorClass: 'forbidden' });
  expect((await ex.describe(ctx('original_volume'), first.p)).volumeAttached).toBe(true);
  await expect(ex.ensureVolumeFromSnapshot(ctx('foreign_snapshot'), REGION, first.p.zone, snap.snapshotId, 20)).rejects.toMatchObject({ errorClass: 'forbidden' });

  // An accidentally reused operation token must fail instead of adopting the old user's disk.
  await expect(ex.ensureVolume({ ...otherCtx('collision'), token: ctx('create_volume').token }, REGION, nic.zone, 20)).rejects.toMatchObject({ errorClass: 'forbidden' });
}

describe('aws-ec2 executor', () => {
  it('creates a tagged VM with its static IP, data volume and first-boot script, then sleeps and wakes it', async () => {
    const { ex, ec2 } = setup();
    const { vm, vol, p } = await create(ex);
    const inst = ec2.instances.get(vm.vmId)!;
    expect(inst.state).toBe('running');
    expect(inst.type).toBe('c7i-flex.large');
    expect(vm.instanceType).toBe('c7i-flex.large');
    expect(vm.rootVolumeGb).toBe(16);
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
    expect(await ex.describe(ctx('describe'), p)).toEqual({ vm: 'running', instanceType: 'c7i-flex.large', rootVolumeGb: 16, publicAddresses: [p.ipAddress], volumeAttached: true });
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

  it('reports the existing machine and root disk after provider-side changes instead of the launch defaults', async () => {
    const { ex, ec2 } = setup();
    const first = await create(ex);
    ec2.instances.get(first.vm.vmId)!.type = 'm7i-flex.large';
    const root = [...ec2.volumes.values()].find((v) => v.instance === first.vm.vmId && v.tags['cb:kind'] === 'root_volume')!;
    root.size = 24;
    const again = await create(ex);
    expect(again.vm).toMatchObject({ vmId: first.vm.vmId, instanceType: 'm7i-flex.large', rootVolumeGb: 24 });
    expect(await ex.describe(ctx('describe'), first.p)).toMatchObject({ instanceType: 'm7i-flex.large', rootVolumeGb: 24 });
    expect(ec2.calls.filter((c) => c.action === 'RunInstances')).toHaveLength(1);
  });

  it('tries the next instance type when one has no capacity', async () => {
    const { ex, ec2 } = setup();
    ec2.fail = (a, p) => (a === 'RunInstances' && p.InstanceType === 'c7i-flex.large' ? { code: 'InsufficientInstanceCapacity', status: 500 } : null);
    const { vm } = await create(ex);
    expect(ec2.instances.get(vm.vmId)?.type).toBe('c6i.large');
    expect(vm.instanceType).toBe('c6i.large');
    ec2.fail = (a) => (a === 'RunInstances' ? { code: 'InsufficientInstanceCapacity', status: 500 } : null);
    await expect(ex.ensureVm(ctx('create_vm', 'op2:create_vm:1'), REGION, {
      instanceId: 'inst2', zone: 'ap-northeast-1a', nicId: [...ec2.enis.keys()][0]!, volumeId: 'vol-x', bootstrapToken: 't', gatewayUrl: 'wss://g',
    })).rejects.toMatchObject({ errorClass: 'capacity' });
  });

  it('reports why a VM ended during launch, and a new token launches a new VM', async () => {
    const { ex, ec2 } = setup();
    ec2.launchFailure = () => ({ code: 'Client.InvalidKMSKey.InvalidState', message: 'The KMS key provided is in an incorrect state' });
    const ip = await ex.allocateIp(ctx('allocate_ip'), REGION);
    const nic = await ex.ensureNetworkInterface(ctx('create_nic'), REGION, ip);
    const vol = await ex.ensureVolume(ctx('create_volume'), REGION, nic.zone, 20);
    const spec = { instanceId: 'inst1', zone: nic.zone, nicId: nic.nicId, volumeId: vol.volumeId, bootstrapToken: 't', gatewayUrl: 'wss://g' };
    const first = await ex.ensureVm(ctx('create_vm'), REGION, spec).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(LaunchFailed);
    // What EC2 reports when an SCP denies the KMS calls it makes for the caller: not capacity.
    expect(first).toMatchObject({ errorClass: 'forbidden', reasonCode: 'Client.InvalidKMSKey.InvalidState', zone: 'ap-northeast-1a' });
    expect(String((first as Error).message)).toContain('incorrect state');
    // The same token only ever returns the same dead VM.
    const again = await ex.ensureVm(ctx('create_vm'), REGION, spec).catch((e: LaunchFailed) => e.vmId);
    expect(again).toBe((first as LaunchFailed).vmId);
    expect(ec2.instances.size).toBe(1);

    ec2.launchFailure = () => ({ code: 'Server.InsufficientInstanceCapacity', message: 'Insufficient capacity.' });
    await expect(ex.ensureVm(ctx('create_vm', 'op1:create_vm:1:l1'), REGION, spec)).rejects.toMatchObject({ errorClass: 'capacity' });
    ec2.launchFailure = () => null;
    const vm = await ex.ensureVm(ctx('create_vm', 'op1:create_vm:1:l2'), REGION, spec);
    expect(ec2.instances.get(vm.vmId)?.state).toBe('running');
    expect(launchFailureClass('Server.InternalError')).toBe('retryable');
    expect(launchFailureClass('Client.VolumeLimitExceeded')).toBe('quota');
    expect(launchFailureClass('Client.InternalError')).toBe('forbidden');
    expect(launchFailureClass('Client.InvalidKMSKey.KeyDisabled')).toBe('forbidden');
    expect(launchFailureClass('Client.InvalidSnapshot.NotFound')).toBe('invalid');
  });

  it('fails a volume that EBS could not create instead of building on it', async () => {
    const { ex, ec2 } = setup();
    ec2.volumeFailure = () => true;
    await expect(ex.ensureVolume(ctx('create_volume'), REGION, 'ap-northeast-1a', 20)).rejects.toMatchObject({ errorClass: 'forbidden', message: expect.stringContaining('encryption key') });
  });

  it('tells AWS denying the account an action in a region from bad credentials and our own guardrails', async () => {
    const { ex, ec2 } = setup();
    ec2.fail = (a) => (a === 'AllocateAddress' ? { code: 'UnauthorizedOperation', status: 403 } : null);
    const denied = await ex.allocateIp(ctx('allocate_ip'), REGION).catch((e: unknown) => e);
    expect(denied).toMatchObject({ errorClass: 'forbidden' });
    expect(isRegionDenial(denied)).toBe(true);
    ec2.fail = (a) => (a === 'AllocateAddress' ? { code: 'AuthFailure', status: 401 } : null);
    expect(isRegionDenial(await ex.allocateIp(ctx('allocate_ip', 'op2:allocate_ip:1'), REGION).catch((e: unknown) => e))).toBe(false);
    // A guardrail of ours (here: the reaper's credentials may not create) is no AWS denial.
    const guard = await setup('reaper', ec2).ex.allocateIp(ctx('allocate_ip', 'op3:allocate_ip:1'), REGION).catch((e: unknown) => e);
    expect(guard).toMatchObject({ errorClass: 'forbidden' });
    expect(isRegionDenial(guard)).toBe(false);
  });

  it('tells a start the encryption key refused from a capacity shortage', async () => {
    const { ex, ec2 } = setup();
    const { p } = await create(ex);
    await ex.ensureStopped(ctx('stop'), p);
    ec2.startFailure = () => ({ code: 'Client.InvalidKMSKey.InvalidState', message: 'The KMS key provided is in an incorrect state' });
    const refused = await ex.ensureRunning(ctx('start'), p).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProviderFailed);
    expect(refused).toMatchObject({ errorClass: 'forbidden', reasonCode: 'Client.InvalidKMSKey.InvalidState', resourceId: p.vmId });
    ec2.startFailure = () => ({ code: 'Server.InsufficientInstanceCapacity', message: 'Insufficient capacity.' });
    await expect(ex.ensureRunning(ctx('start', 'op2:start:1'), p)).rejects.toMatchObject({ errorClass: 'capacity' });
    ec2.startFailure = () => null;
    await expect(ex.ensureRunning(ctx('start', 'op3:start:1'), p)).resolves.toBe('running');
  });

  it('launches only machine types the zone offers, and prefers zones that offer one', async () => {
    const ec2 = new FakeEc2();
    const ex = new AwsExecutor({
      mode: 'runtime', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret',
      regions: { [REGION]: {
        subnets: { 'ap-northeast-1a': 'subnet-a', 'ap-northeast-1c': 'subnet-c', 'ap-northeast-1d': 'subnet-d' }, securityGroupId: 'sg-1',
        instanceTypes: ['c7i-flex.large', 'c6i.large'],
        zoneInstanceTypes: { 'ap-northeast-1a': [], 'ap-northeast-1c': ['c6i.large'], 'ap-northeast-1d': ['c7i-flex.large', 'c6i.large'] },
      } },
      appUrl: 'https://app.example.com', agentImage: 'a', browserImage: 'b', endpoint: () => 'https://ec2.test/', fetch: ec2.fetch, sleep: async () => {}, pollMs: 1,
    });
    expect(ex.zones(REGION)).toEqual(['ap-northeast-1c', 'ap-northeast-1d']);
    const ip = await ex.allocateIp(ctx('allocate_ip'), REGION);
    const nic = await ex.ensureNetworkInterface(ctx('create_nic'), REGION, ip);
    expect(nic.zone).toBe('ap-northeast-1c');
    const vol = await ex.ensureVolume(ctx('create_volume'), REGION, nic.zone, 20);
    const vm = await ex.ensureVm(ctx('create_vm'), REGION, { instanceId: 'inst1', zone: nic.zone, nicId: nic.nicId, volumeId: vol.volumeId, bootstrapToken: 't', gatewayUrl: 'wss://g' });
    expect(vm.instanceType).toBe('c6i.large');
    expect(ec2.calls.filter((c) => c.action === 'RunInstances').map((c) => c.params.InstanceType)).toEqual(['c6i.large']);
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

  it('rejects another browser’s fixed IP, volume, snapshot and reused resource token', async () => {
    const { ex, ec2 } = setup();
    await rejectCrossBrowserReuse(ex);
    const creates = ec2.calls.filter((c) => c.action === 'CreateVolume');
    expect(creates).toHaveLength(2);
    expect(creates.every((c) => c.params.SnapshotId === undefined)).toBe(true);
    expect(ec2.calls.filter((c) => c.action === 'DetachVolume')).toHaveLength(0);
  });

  it.each([
    ['cb:managed', 'false'], ['cb:instance', 'another-browser'], ['cb:env', 'another-environment'],
  ])('refuses to rebind an address with a mismatched %s tag', async (key, value) => {
    const { ex, ec2 } = setup();
    const { ip, p } = await create(ex);
    const addr = ec2.addresses.get(ip.allocationId)!;
    addr.tags[key!] = value!;
    await expect(ex.associateIp(ctx('bind'), REGION, p.nicId, ip)).rejects.toMatchObject({ errorClass: 'forbidden' });
    expect(addr.eni).toBe(p.nicId);
    expect(ec2.calls.filter((c) => c.action === 'AssociateAddress')).toHaveLength(1);
  });

  it('lists every managed resource including root disks and deletes everything with the reaper', async () => {
    const { ex, ec2 } = setup();
    const { p } = await create(ex);
    await ex.snapshot(ctx('snapshot_volume'), REGION, p.volumeId);
    const listed = await ex.listManaged(ctx('l'), REGION);
    expect(listed.map((r) => r.kind).sort()).toEqual(['ip', 'network_interface', 'snapshot', 'vm', 'volume', 'volume']);
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

describe('confirmed provider deletion', () => {
  const shortDelete = (): OpContext => ({ ...ctx('purge'), deadline: Date.now() + 1000 });

  it('does not treat an accepted termination or shutting-down state as a deleted VM', async () => {
    const { ex, ec2 } = setup();
    const { p } = await create(ex);
    const { ex: reaper } = setup('reaper', ec2);
    ec2.deferDeletes = true;
    await expect(reaper.ensureDeleted(shortDelete(), REGION, 'vm', p.vmId)).rejects.toMatchObject({ errorClass: 'retryable' });
    expect((await ex.describe(ctx('state'), p)).vm).toBe('terminating');
    await expect(reaper.ensureDeleted(shortDelete(), REGION, 'vm', p.vmId)).rejects.toMatchObject({ errorClass: 'retryable' });
    expect(ec2.calls.filter((c) => c.action === 'TerminateInstances')).toHaveLength(1);
    // The root disk remains visible to the final purge inventory until its own deletion finishes.
    expect((await ex.listManaged(ctx('inventory'), REGION)).some((r) => r.tags['cb:kind'] === 'root_volume')).toBe(true);
    ec2.instances.get(p.vmId)!.state = 'terminated';
    await expect(reaper.ensureDeleted(shortDelete(), REGION, 'vm', p.vmId)).resolves.toBeUndefined();
  });

  it.each(['volume', 'network_interface', 'ip', 'snapshot'] as const)('requires %s disappearance after an accepted delete', async (kind) => {
    const { ex, ec2 } = setup();
    const { p } = await create(ex);
    const snapshot = await ex.snapshot(ctx('snapshot'), REGION, p.volumeId);
    const { ex: reaper } = setup('reaper', ec2);
    await reaper.ensureDeleted(ctx('terminate'), REGION, 'vm', p.vmId);
    const id = { volume: p.volumeId, network_interface: p.nicId, ip: p.ipAllocationId, snapshot: snapshot.snapshotId }[kind];
    ec2.deferDeletes = true;
    await expect(reaper.ensureDeleted(shortDelete(), REGION, kind, id)).rejects.toMatchObject({ errorClass: 'retryable' });
    expect((await ex.listManaged(ctx('inventory'), REGION)).some((r) => r.providerId === id)).toBe(true);
    // Simulate the provider completing its asynchronous deletion.
    const remove = {
      volume: () => ec2.volumes.delete(id), network_interface: () => ec2.enis.delete(id),
      ip: () => ec2.addresses.delete(id), snapshot: () => ec2.snapshots.delete(id),
    };
    remove[kind]();
    await expect(reaper.ensureDeleted(shortDelete(), REGION, kind, id)).resolves.toBeUndefined();
  });

  it.each(['vm', 'volume', 'network_interface', 'ip', 'snapshot'] as ResourceKind[])('does not accept a malformed %s id as proof of deletion', async (kind) => {
    const { ex, ec2 } = setup('reaper');
    ec2.fail = () => ({ code: 'InvalidResource.Malformed', status: 400 });
    await expect(ex.ensureDeleted(ctx('purge'), REGION, kind, 'bad-id')).rejects.toMatchObject({ errorClass: 'invalid' });
  });

  it('does not mistake a missing IP association for a released fixed IP allocation', async () => {
    const { ex, ec2 } = setup();
    const { ip } = await create(ex);
    const { ex: reaper } = setup('reaper', ec2);
    ec2.fail = (action) => action === 'DisassociateAddress' ? { code: 'InvalidAssociationID.NotFound', status: 400 } : null;
    await expect(reaper.ensureDeleted(ctx('purge'), REGION, 'ip', ip.allocationId)).rejects.toMatchObject({ errorClass: 'retryable' });
    expect(ec2.addresses.has(ip.allocationId)).toBe(true);
  });

  it('cannot delete resources belonging to a different browser or environment', async () => {
    const { ex, ec2 } = setup();
    const { p } = await create(ex);
    const { ex: reaper } = setup('reaper', ec2);
    for (const tags of [
      { ...ctx('purge').tags, 'cb:instance': 'another-browser' },
      { ...ctx('purge').tags, 'cb:env': 'another-environment' },
    ]) {
      await expect(reaper.ensureDeleted({ ...ctx('purge'), tags }, REGION, 'vm', p.vmId)).rejects.toMatchObject({ errorClass: 'forbidden' });
    }
    expect(ec2.instances.get(p.vmId)?.state).toBe('running');
    expect(ec2.instances.get(p.vmId)?.protected).toBe(true);
    expect(ec2.calls.filter((call) => call.action === 'TerminateInstances')).toHaveLength(0);
  });
});

describe('fake provider isolation and deletion', () => {
  it('enforces the same fixed IP and browser data ownership as AWS', async () => {
    const store = new MemoryFakeStore();
    await rejectCrossBrowserReuse(new FakeExecutor({ store, mode: 'runtime' }));
  });

  it('does not confirm a delete when the fake provider failed to remove the resource', async () => {
    const store = new MemoryFakeStore();
    const runtime = new FakeExecutor({ store, mode: 'runtime' });
    const vol = await runtime.ensureVolume(ctx('volume'), REGION, `${REGION}a`, 20);
    const reaper = new FakeExecutor({ store, mode: 'reaper' });
    await expect(reaper.ensureDeleted({ ...ctx('purge'), tags: { ...ctx('purge').tags, 'cb:instance': 'another-browser' } }, REGION, 'volume', vol.volumeId)).rejects.toMatchObject({ errorClass: 'forbidden' });
    const failDelete = vi.spyOn(store, 'update').mockResolvedValueOnce(undefined);
    await expect(reaper.ensureDeleted(ctx('purge'), REGION, 'volume', vol.volumeId)).rejects.toMatchObject({ errorClass: 'retryable' });
    expect((await store.get(vol.volumeId))?.state).toBe('available');
    failDelete.mockRestore();
    await reaper.ensureDeleted(ctx('purge'), REGION, 'volume', vol.volumeId);
    expect(await store.get(vol.volumeId)).toMatchObject({ state: 'deleted', attrs: {} });
    await expect(runtime.ensureVolume(ctx('volume'), REGION, `${REGION}a`, 20)).rejects.toMatchObject({ errorClass: 'invalid' });
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

  it('gives the browser the region timezone, and only a plain zone name', () => {
    const input = { instanceId: 'i', gatewayUrl: 'wss://g', bootstrapToken: 't', appUrl: 'https://a', agentImage: 'a', browserImage: 'b' };
    expect(bootstrapScript({ ...input, timezone: 'Asia/Tokyo' })).toContain('\nBROWSER_TZ=Asia/Tokyo\n');
    expect(bootstrapScript({ ...input, timezone: 'America/Argentina/Buenos_Aires' })).toContain('\nBROWSER_TZ=America/Argentina/Buenos_Aires\n');
    expect(bootstrapScript({ ...input, timezone: 'Asia/Tokyo\nAGENT_IMAGE=evil' })).toContain('\nBROWSER_TZ=UTC\n');
    expect(bootstrapScript(input)).toContain('\nBROWSER_TZ=UTC\n');
    // The browser container receives it as TZ, which Chrome uses for its clock.
    const env = readFileSync(new URL('../../../images/vm/files/bin/cloudbrowser-browser-env', import.meta.url), 'utf8');
    expect(env).toContain('TZ=${BROWSER_TZ:-UTC}');
  });

  it.each(['legacy', 'current'])('starts supervisor as root with the %s browser unit while Chrome remains unprivileged', (version) => {
    const script = bootstrapScript({
      instanceId: 'inst1', gatewayUrl: 'wss://connect.example.com', bootstrapToken: 'tok',
      appUrl: 'https://app.example.com', agentImage: 'ghcr.io/x/agent:main', browserImage: 'ghcr.io/x/browser:main',
    });
    const patch = script.split('\n').find((line) => line.startsWith('sed -i ') && line.endsWith('/cloudbrowser-browser.service'))!;
    expect(patch).toBeDefined();
    expect(script.indexOf(patch)).toBeGreaterThan(script.indexOf('install -m 0644 /tmp/cbvm/systemd/*.service'));
    expect(script.indexOf(patch)).toBeLessThan(script.indexOf('systemctl daemon-reload'));

    const currentUnit = readFileSync(new URL('../../../images/vm/files/systemd/cloudbrowser-browser.service', import.meta.url), 'utf8');
    const sourceUnit = version === 'legacy' ? currentUnit.replace(' --user root', '') : currentUnit;
    const dir = mkdtempSync(join(tmpdir(), 'cloudbrowser-bootstrap-'));
    const unitPath = join(dir, 'cloudbrowser-browser.service');
    try {
      writeFileSync(unitPath, sourceUnit);
      const apply = () => execFileSync('bash', ['-c', patch.replace('/etc/systemd/system/cloudbrowser-browser.service', '"$1"'), 'unit-test', unitPath]);
      apply();
      expect(readFileSync(unitPath, 'utf8')).toBe(currentUnit);
      apply();
      expect(readFileSync(unitPath, 'utf8')).toBe(currentUnit);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const chromeConfig = readFileSync(new URL('../../../images/browser/google-chrome.conf', import.meta.url), 'utf8');
    expect(chromeConfig).toMatch(/^user=neko$/m);
  });
});

describe('browser image policies', () => {
  it('replaces neko\'s kiosk policies with a local-Chrome set that still allows CDP and isolated IP checks', () => {
    const dockerfile = readFileSync(new URL('../../../images/browser/Dockerfile', import.meta.url), 'utf8');
    const removal = dockerfile.indexOf('RUN rm -f /etc/opt/chrome/policies/managed/policies.json');
    expect(removal).toBeGreaterThan(0);
    expect(removal).toBeLessThan(dockerfile.indexOf('COPY policies.json'));
    const managed = JSON.parse(readFileSync(new URL('../../../images/browser/policies.json', import.meta.url), 'utf8'));
    expect(managed).toMatchObject({
      DeveloperToolsAvailability: 1,
      IncognitoModeAvailability: 0,
      ProxySettings: { ProxyMode: 'direct' },
      WebRtcIPHandlingPolicy: 'default_public_interface_only',
      DnsOverHttpsMode: 'off',
      DefaultGeolocationSetting: 2,
    });
    // What makes a browser feel unlike the user's own Chrome stays unset.
    for (const key of ['DownloadRestrictions', 'AllowFileSelectionDialogs', 'PasswordManagerEnabled', 'EditBookmarksEnabled', 'BookmarkBarEnabled', 'ExtensionInstallBlocklist', 'ExtensionInstallForcelist', 'DefaultNotificationsSetting', 'DefaultPopupsSetting', 'BrowserSignin', 'SyncDisabled']) {
      expect(managed).not.toHaveProperty(key);
    }
  });
});

/** A Price List item in the API's format (the shapes are copied from AWS's published price list). */
function priceItem(serviceCode: string, attributes: Record<string, string>, dims: { usd: string; unit: string; begin?: string }[]) {
  const sku = `SKU${Math.random().toString(36).slice(2, 10)}`;
  return {
    product: { productFamily: attributes.productFamily ?? null, attributes: { servicecode: serviceCode, ...attributes }, sku },
    serviceCode,
    terms: {
      OnDemand: {
        [`${sku}.JRTCKXETXF`]: {
          offerTermCode: 'JRTCKXETXF',
          sku,
          effectiveDate: '2026-10-01T00:00:00Z',
          priceDimensions: Object.fromEntries(
            dims.map((d, i) => [`${sku}.JRTCKXETXF.${i}`, { unit: d.unit, beginRange: d.begin ?? '0', endRange: 'Inf', description: '', pricePerUnit: { USD: d.usd } }]),
          ),
        },
      },
    },
    version: '20261001',
    publicationDate: '2026-10-01T00:00:00Z',
  };
}

const linux = { regionCode: REGION, operatingSystem: 'Linux', tenancy: 'Shared', preInstalledSw: 'NA', capacitystatus: 'Used', licenseModel: 'No License required', operation: 'RunInstances' };

function tokyoPriceList(ec2: FakeEc2) {
  ec2.priceList = {
    AmazonEC2: [
      priceItem('AmazonEC2', { ...linux, instanceType: 'c7i-flex.large', vcpu: '2', memory: '4 GiB', usagetype: 'APN1-BoxUsage:c7i-flex.large' }, [{ usd: '0.1065000000', unit: 'Hrs' }]),
      priceItem('AmazonEC2', { ...linux, instanceType: 'c6i.large', vcpu: '2', memory: '4 GiB', usagetype: 'APN1-BoxUsage:c6i.large' }, [{ usd: '0.1070000000', unit: 'Hrs' }]),
      priceItem('AmazonEC2', { ...linux, instanceType: 'c5.large', vcpu: '2', memory: '4 GiB', usagetype: 'APN1-BoxUsage:c5.large' }, [{ usd: '0.1070000000', unit: 'Hrs' }]),
      // Not ours: Windows, and a dedicated host.
      priceItem('AmazonEC2', { ...linux, operatingSystem: 'Windows', instanceType: 'c7i-flex.large', usagetype: 'APN1-BoxUsage:c7i-flex.large' }, [{ usd: '0.1990000000', unit: 'Hrs' }]),
      priceItem('AmazonEC2', { regionCode: REGION, productFamily: 'Storage', volumeApiName: 'gp3', usagetype: 'APN1-EBS:VolumeUsage.gp3' }, [{ usd: '0.0960000000', unit: 'GB-Mo' }]),
      priceItem('AmazonEC2', { regionCode: REGION, productFamily: 'Storage Snapshot', storageMedia: 'Amazon S3', locationType: 'AWS Region', usagetype: 'APN1-EBS:SnapshotArchiveStorage' }, [{ usd: '0.0137500000', unit: 'GB-Mo' }]),
      priceItem('AmazonEC2', { regionCode: REGION, productFamily: 'Storage Snapshot', storageMedia: 'Amazon S3', locationType: 'AWS Region', usagetype: 'APN1-EBS:SnapshotUsage' }, [{ usd: '0.0500000000', unit: 'GB-Mo' }]),
    ],
    AmazonVPC: [
      priceItem('AmazonVPC', { regionCode: REGION, group: 'VPCPublicIPv4Address', usagetype: 'APN1-PublicIPv4:IdleAddress' }, [{ usd: '0.0050000000', unit: 'Hrs' }]),
      priceItem('AmazonVPC', { regionCode: REGION, group: 'VPCPublicIPv4Address', usagetype: 'APN1-PublicIPv4:InUseAddress' }, [{ usd: '0.0050000000', unit: 'Hrs' }]),
    ],
    AWSDataTransfer: [
      priceItem('AWSDataTransfer', { fromRegionCode: REGION, transferType: 'AWS Outbound', toLocation: 'External', usagetype: 'APN1-DataTransfer-Out-Bytes' }, [
        { usd: '0.0980000000', unit: 'GB', begin: '10240' },
        { usd: '0.1140000000', unit: 'GB', begin: '0' },
      ]),
    ],
  };
}

describe('aws-ec2 prices', () => {
  it('reads every price of the region from the AWS Price List API, signed, with read-only credentials', async () => {
    const { ex, ec2 } = setup('readonly');
    tokyoPriceList(ec2);
    const sheet = await ex.prices(ctx('prices'), REGION);
    expect(sheet).toEqual({
      source: 'aws-price-list',
      instanceType: 'c7i-flex.large',
      vmHour: 0.1065,
      instanceTypes: { 'c7i-flex.large': 0.1065, 'c6i.large': 0.107, 'c5.large': 0.107 },
      machine: { vcpu: 2, memoryGb: 4 },
      volumeGbMonth: 0.096,
      snapshotGbMonth: 0.05,
      ipHour: 0.005,
      transferOutGb: 0.114,
      rootVolumeGb: 16,
      effectiveDate: '2026-10-01T00:00:00Z',
    });
    expect(ec2.pricingCalls.find((c) => c.ServiceCode === 'AmazonEC2' && c.Filters.some((f) => f.Field === 'instanceType'))?.Filters).toContainEqual({
      Type: 'TERM_MATCH',
      Field: 'regionCode',
      Value: REGION,
    });
  });

  it('refuses a sheet with a missing price instead of guessing one', async () => {
    const { ex, ec2 } = setup('readonly');
    tokyoPriceList(ec2);
    ec2.priceList.AmazonVPC = [];
    await expect(ex.prices(ctx('prices'), REGION)).rejects.toThrow(/public IPv4/);
  });

  it('requires a price for every capacity fallback that it may launch', async () => {
    const { ex, ec2 } = setup('readonly');
    tokyoPriceList(ec2);
    ec2.priceList.AmazonEC2 = ec2.priceList.AmazonEC2!.filter((p) => (p.product as { attributes: Record<string, string> }).attributes.instanceType !== 'c6i.large');
    await expect(ex.prices(ctx('prices'), REGION)).rejects.toThrow(/c6i.large instance/);
  });

  it('prices existing machine types without making them launch candidates', async () => {
    const { ex, ec2 } = setup('readonly');
    tokyoPriceList(ec2);
    ec2.priceList.AmazonEC2!.push(priceItem('AmazonEC2', {
      ...linux, instanceType: 'm7i-flex.large', vcpu: '2', memory: '8 GiB', usagetype: 'APN1-BoxUsage:m7i-flex.large',
    }, [{ usd: '0.1197000000', unit: 'Hrs' }]));
    const key = ex.pricingConfigKey(REGION);
    const sheet = await ex.prices(ctx('prices'), REGION, ['m7i-flex.large']);
    expect(sheet.instanceTypes['m7i-flex.large']).toBe(0.1197);
    expect(sheet.instanceType).toBe('c7i-flex.large');
    expect(sheet.vmHour).toBe(0.1065);
    expect(sheet.machine).toEqual({ vcpu: 2, memoryGb: 4 });
    expect(ex.pricingConfigKey(REGION)).toBe(key);
  });

  it('reads every page so unrelated snapshot archive products cannot hide the standard price', async () => {
    const { ex, ec2 } = setup('readonly');
    tokyoPriceList(ec2);
    ec2.pricingPageSize = 1;
    expect((await ex.prices(ctx('prices'), REGION)).snapshotGbMonth).toBe(0.05);
    expect(ec2.pricingCalls.some((call) => call.NextToken === '1')).toBe(true);
  });

  it('does not start another price request after the deadline', async () => {
    const { ex, ec2 } = setup('readonly');
    await expect(ex.prices({ ...ctx('prices'), deadline: Date.now() - 1 }, REGION)).rejects.toMatchObject({ errorClass: 'retryable' });
    expect(ec2.pricingCalls).toHaveLength(0);
  });
});

describe('aws-ec2 storage growth', () => {
  it('grows a volume once and reports progress until the new size is usable', async () => {
    const { ex, ec2 } = setup();
    const { vol } = await create(ex);
    expect(await ex.resizeVolume(ctx('resize'), REGION, vol.volumeId, 40)).toEqual({ state: 'pending', sizeGb: 40 });
    expect(await ex.resizeVolume(ctx('resize'), REGION, vol.volumeId, 40)).toEqual({ state: 'pending', sizeGb: 40 });
    expect(await ex.resizeVolume(ctx('resize'), REGION, vol.volumeId, 40)).toEqual({ state: 'ready', sizeGb: 40 });
    expect(ec2.calls.filter((c) => c.action === 'ModifyVolume')).toHaveLength(1);
    expect(ec2.volumes.get(vol.volumeId)?.size).toBe(40);
    // Never shrinks.
    expect(await ex.resizeVolume(ctx('resize'), REGION, vol.volumeId, 30)).toEqual({ state: 'ready', sizeGb: 40 });
    expect(ec2.calls.filter((c) => c.action === 'ModifyVolume')).toHaveLength(1);
  });

  it('waits for the prior modification to complete before submitting a different target', async () => {
    const { ex, ec2 } = setup();
    const { vol } = await create(ex);
    await ex.resizeVolume(ctx('resize'), REGION, vol.volumeId, 40);
    ec2.modifications[0]!.state = 'optimizing';
    expect(await ex.resizeVolume(ctx('same'), REGION, vol.volumeId, 40)).toEqual({ state: 'ready', sizeGb: 40 });
    expect(await ex.resizeVolume(ctx('next'), REGION, vol.volumeId, 50)).toEqual({ state: 'pending', sizeGb: 50 });
    expect(ec2.calls.filter((c) => c.action === 'ModifyVolume')).toHaveLength(1);
    ec2.modifications[0]!.state = 'completed';
    expect(await ex.resizeVolume(ctx('next'), REGION, vol.volumeId, 50)).toEqual({ state: 'pending', sizeGb: 50 });
    expect(ec2.calls.filter((c) => c.action === 'ModifyVolume')).toHaveLength(2);
    expect(ec2.calls.some((c) => ['StopInstances', 'StartInstances', 'DetachVolume', 'CreateSnapshot'].includes(c.action))).toBe(false);
  });

  it('checks volume ownership even when an accepted modification already has the requested size', async () => {
    const { ex, ec2 } = setup();
    const { vol } = await create(ex);
    await ex.resizeVolume(ctx('resize'), REGION, vol.volumeId, 40);
    ec2.modifications[0]!.state = 'optimizing';
    const other = { ...ctx('foreign'), tags: { ...ctx('foreign').tags, 'cb:instance': 'other-user-browser' } };
    await expect(ex.resizeVolume(other, REGION, vol.volumeId, 40)).rejects.toMatchObject({ errorClass: 'forbidden' });
    expect(ec2.calls.filter((c) => c.action === 'ModifyVolume')).toHaveLength(1);
  });

  it('does not treat an unknown modification state as usable capacity', async () => {
    const { ex, ec2 } = setup();
    const { vol } = await create(ex);
    await ex.resizeVolume(ctx('resize'), REGION, vol.volumeId, 40);
    ec2.modifications[0]!.state = 'unknown';
    await expect(ex.resizeVolume(ctx('resize'), REGION, vol.volumeId, 40)).rejects.toMatchObject({ errorClass: 'retryable' });
    expect(ec2.calls.filter((c) => c.action === 'ModifyVolume')).toHaveLength(1);
  });
});

describe('stuck stops', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19);

  it('forces a stop EC2 has left hanging for over ten minutes, and only then', async () => {
    const { ex, ec2 } = setup();
    const { vm, p } = await create(ex);
    const inst = ec2.instances.get(vm.vmId)!;
    Object.assign(inst, { state: 'stopping', stuck: true, reason: `User initiated (${minutesAgo(3)} GMT)` });
    await expect(ex.ensureStopped({ ...ctx('stop'), deadline: Date.now() + 1000 }, p)).rejects.toMatchObject({ errorClass: 'retryable' });
    expect(ec2.calls.filter((c) => c.action === 'StopInstances')).toHaveLength(0);
    inst.reason = `User initiated (${minutesAgo(11)} GMT)`;
    expect(await ex.ensureStopped(ctx('stop'), p)).toBe('stopped');
    expect(ec2.calls.filter((c) => c.action === 'StopInstances').map((c) => c.params.Force)).toEqual(['true']);
  });
});
