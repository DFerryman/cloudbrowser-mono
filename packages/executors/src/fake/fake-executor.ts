import {
  ExecutorError,
  type BindingCheck,
  type Capabilities,
  type CredentialMode,
  type ErrorClass,
  type Executor,
  type IpAllocation,
  type NetworkInterfaceRef,
  type ObservedResource,
  type ObservedState,
  type OpContext,
  type Placement,
  type ProviderPriceSheet,
  type QuotaSnapshot,
  type ResizeState,
  type ResourceKind,
  type RunState,
  type SnapshotRef,
  type VmRef,
  type VmSpec,
  type VolumeRef,
} from '../executor.js';
import type { FakeRecord, FakeStore } from './store.js';

/**
 * A fault to inject into one call. `timeout_after_success` performs the change and then reports an
 * unknown outcome, the case the step journal must resolve by lookup.
 */
export type Fault = ErrorClass | 'timeout_after_success';

/** A specific provider error (e.g. a `LaunchFailed`) may be returned to be thrown as is. */
export type FaultPlan = (method: keyof Executor, ctx: OpContext) => Fault | ExecutorError | null;

export interface FakeExecutorOptions {
  store: FakeStore;
  mode: CredentialMode;
  faults?: FaultPlan;
  /** Simulated provider latency per mutating call, in ms. */
  delayMs?: number;
  /** Address pools per provider region (documentation ranges by default). */
  ipPrefix?: Record<string, string>;
  random?: () => number;
  quotaLimits?: Partial<Record<QuotaSnapshot['metric'], number>>;
  /** What `prices` reports (simulated; there is no price list behind the fake). */
  priceSheet?: Partial<FakePriceSheet>;
}

type FakePriceSheet = Pick<ProviderPriceSheet, 'vmHour' | 'volumeGbMonth' | 'snapshotGbMonth' | 'ipHour' | 'transferOutGb' | 'rootVolumeGb'>;

const SIMULATED_PRICES: FakePriceSheet = { vmHour: 0.1, volumeGbMonth: 0.08, snapshotGbMonth: 0.05, ipHour: 0.005, transferOutGb: 0.09, rootVolumeGb: 16 };

/** Documentation address ranges, keyed by provider region. */
const DEFAULT_IP_PREFIX: Record<string, string> = {
  'ap-northeast-1': '203.0.113.',
  'us-west-2': '198.51.100.',
};

const MUTATING: ReadonlySet<keyof Executor> = new Set([
  'snapshot',
  'ensureVolumeFromSnapshot',
  'swapVolume',
  'resizeVolume',
  'allocateIp',
  'ensureNetworkInterface',
  'ensureVolume',
  'ensureVm',
  'associateIp',
  'ensureRunning',
  'ensureStopped',
  'ensureDeleted',
]);

/**
 * In-memory (or D1-backed) provider with the same semantics as the real executors: client tokens
 * de-duplicate creates, stop never deletes, and the runtime credentials cannot delete anything.
 */
export class FakeExecutor implements Executor {
  readonly kind = 'fake' as const;
  readonly capabilities: Capabilities = {
    zonalVolumes: true,
    nativeIdempotency: true,
    movableIp: true,
  };

  private readonly store: FakeStore;
  private readonly mode: CredentialMode;
  private readonly faults: FaultPlan;
  private readonly delayMs: number;
  private readonly ipPrefix: Record<string, string>;
  private readonly random: () => number;
  private readonly quotaLimits: Record<QuotaSnapshot['metric'], number>;
  private readonly priceSheet: FakePriceSheet;

  constructor(opts: FakeExecutorOptions) {
    this.store = opts.store;
    this.mode = opts.mode;
    this.faults = opts.faults ?? (() => null);
    this.delayMs = opts.delayMs ?? 0;
    this.ipPrefix = opts.ipPrefix ?? DEFAULT_IP_PREFIX;
    this.random = opts.random ?? Math.random;
    this.quotaLimits = { static_ips: 20, vcpus: 32, volumes: 50, ...opts.quotaLimits };
    this.priceSheet = { ...SIMULATED_PRICES, ...opts.priceSheet };
  }

  // --- helpers -------------------------------------------------------------------------------

  private async call<T>(method: keyof Executor, ctx: OpContext, fn: () => Promise<T>): Promise<T> {
    this.authorize(method);
    await ctx.assertActive?.();
    if (Date.now() > ctx.deadline) throw new ExecutorError('unknown_outcome', `${method}: deadline passed`);
    if (this.delayMs > 0 && MUTATING.has(method)) await new Promise((r) => setTimeout(r, this.delayMs));
    await ctx.assertActive?.();
    const fault = this.faults(method, ctx);
    if (fault instanceof ExecutorError) throw fault;
    if (fault && fault !== 'timeout_after_success') {
      throw new ExecutorError(fault, `${method}: injected ${fault}`);
    }
    const result = await fn();
    await ctx.assertActive?.();
    if (fault === 'timeout_after_success') {
      throw new ExecutorError('unknown_outcome', `${method}: injected timeout after success`);
    }
    return result;
  }

  private async update(ctx: OpContext, id: string, changes: Parameters<FakeStore['update']>[1]) {
    await ctx.assertActive?.();
    return this.store.update(id, changes);
  }

  private authorize(method: keyof Executor) {
    const readOnly: ReadonlySet<keyof Executor> = new Set(['describe', 'verifyEgress', 'listManaged', 'quotas', 'prices']);
    if (this.mode === 'readonly' && !readOnly.has(method)) {
      throw new ExecutorError('forbidden', `${method} is not allowed with read-only credentials`);
    }
    if (this.mode === 'runtime' && method === 'ensureDeleted') {
      throw new ExecutorError('forbidden', 'ensureDeleted requires the reaper credentials');
    }
    if (this.mode === 'reaper' && MUTATING.has(method) && method !== 'ensureDeleted' && method !== 'ensureStopped') {
      throw new ExecutorError('forbidden', `${method} is not allowed with the reaper credentials`);
    }
  }

  private id(prefix: string) {
    return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 17)}`;
  }

  private requireTags(ctx: OpContext, kind: ResourceKind) {
    if (ctx.tags['cb:managed'] !== 'true' || !ctx.tags['cb:instance'] || !ctx.tags['cb:op']) {
      // Mirrors the account guardrail that refuses creates without our tags.
      throw new ExecutorError('forbidden', `refusing to create an untagged ${kind}`);
    }
    return { ...ctx.tags, 'cb:kind': kind, 'cb:token': ctx.token };
  }

  private async mustGet(id: string, kind: ResourceKind): Promise<FakeRecord> {
    const r = await this.store.get(id);
    if (!r || r.kind !== kind || r.state === 'deleted') {
      throw new ExecutorError('invalid', `${kind} ${id} does not exist`);
    }
    return r;
  }

  private requireOwner(ctx: OpContext, resource: FakeRecord) {
    if (resource.tags['cb:managed'] !== 'true' || resource.tags['cb:instance'] !== ctx.tags['cb:instance'] || resource.tags['cb:env'] !== ctx.tags['cb:env']) {
      throw new ExecutorError('forbidden', `${resource.id} does not belong to this browser`);
    }
  }

  private async createOnce(
    ctx: OpContext,
    kind: ResourceKind,
    region: string,
    zone: string | null,
    state: string,
    attrs: Record<string, unknown>,
    prefix: string,
  ): Promise<FakeRecord> {
    const existing = await this.store.findByToken(kind, ctx.token);
    if (existing) {
      this.requireOwner(ctx, existing);
      if (existing.state === 'deleted') throw new ExecutorError('invalid', 'A deleted resource cannot be reused');
      return existing;
    }
    const rec: FakeRecord = {
      id: this.id(prefix),
      kind,
      region,
      zone,
      clientToken: ctx.token,
      state,
      attrs,
      tags: this.requireTags(ctx, kind),
      createdAt: Date.now(),
    };
    await ctx.assertActive?.();
    await this.store.insert(rec);
    return rec;
  }

  private async publicAddressesOf(nicId: string): Promise<string[]> {
    const nic = await this.store.get(nicId);
    if (!nic || nic.state === 'deleted') return [];
    const addresses: string[] = [];
    const ipId = nic.attrs.ipAllocationId as string | undefined;
    if (ipId) {
      const ip = await this.store.get(ipId);
      if (ip && ip.state !== 'deleted') addresses.push(ip.attrs.address as string);
    }
    for (const extra of (nic.attrs.extraPublicAddresses as string[] | undefined) ?? []) addresses.push(extra);
    return addresses;
  }

  // --- Executor --------------------------------------------------------------------------------

  allocateIp(ctx: OpContext, region: string): Promise<IpAllocation> {
    return this.call('allocateIp', ctx, async () => {
      const prefix = this.ipPrefix[region] ?? '192.0.2.';
      // A real provider may hand back an address it gave us before; screening must catch that.
      const address = `${prefix}${1 + Math.floor(this.random() * 254)}`;
      const rec = await this.createOnce(ctx, 'ip', region, null, 'allocated', { address }, 'eipalloc');
      return { allocationId: rec.id, address: rec.attrs.address as string };
    });
  }

  zones(region: string): string[] {
    return [`${region}a`, `${region}c`, `${region}d`];
  }

  ensureNetworkInterface(ctx: OpContext, region: string, ip: IpAllocation, zone?: string): Promise<NetworkInterfaceRef> {
    return this.call('ensureNetworkInterface', ctx, async () => {
      const addr = await this.mustGet(ip.allocationId, 'ip');
      this.requireOwner(ctx, addr);
      const rec = await this.createOnce(
        ctx,
        'network_interface',
        region,
        zone ?? this.zones(region)[0]!,
        'available',
        { ipAllocationId: ip.allocationId, extraPublicAddresses: [] },
        'eni',
      );
      // An address has one association: moving it here detaches it from its previous interface.
      const previous = addr.attrs.nicId as string | undefined;
      if (previous && previous !== rec.id) {
        const old = await this.store.get(previous);
        if (old) await this.update(ctx, previous, { attrs: { ...old.attrs, ipAllocationId: undefined } });
      }
      await this.update(ctx, ip.allocationId, { state: 'associated', attrs: { ...addr.attrs, nicId: rec.id } });
      return { nicId: rec.id, zone: rec.zone! };
    });
  }

  snapshot(ctx: OpContext, region: string, volumeId: string): Promise<SnapshotRef> {
    return this.call('snapshot', ctx, async () => {
      const vol = await this.mustGet(volumeId, 'volume');
      this.requireOwner(ctx, vol);
      const rec = await this.createOnce(ctx, 'snapshot', region, null, 'completed', { volumeId, sizeGb: vol.attrs.sizeGb }, 'snap');
      return { snapshotId: rec.id, sizeGb: rec.attrs.sizeGb as number };
    });
  }

  ensureVolumeFromSnapshot(ctx: OpContext, region: string, zone: string, snapshotId: string, sizeGb: number): Promise<VolumeRef> {
    return this.call('ensureVolumeFromSnapshot', ctx, async () => {
      this.requireOwner(ctx, await this.mustGet(snapshotId, 'snapshot'));
      const rec = await this.createOnce(ctx, 'volume', region, zone, 'available', { sizeGb, encrypted: true, fromSnapshot: snapshotId }, 'vol');
      return { volumeId: rec.id, zone: rec.zone!, sizeGb };
    });
  }

  resizeVolume(ctx: OpContext, _region: string, volumeId: string, sizeGb: number): Promise<ResizeState> {
    return this.call('resizeVolume', ctx, async () => {
      const vol = await this.mustGet(volumeId, 'volume');
      this.requireOwner(ctx, vol);
      const size = Number(vol.attrs.sizeGb ?? 0);
      if (size < sizeGb) await this.update(ctx, volumeId, { attrs: { ...vol.attrs, sizeGb } });
      return { state: 'ready' as const, sizeGb: Math.max(size, sizeGb) };
    });
  }

  swapVolume(ctx: OpContext, p: Placement, volumeId: string): Promise<void> {
    return this.call('swapVolume', ctx, async () => {
      const vm = await this.mustGet(p.vmId, 'vm');
      this.requireOwner(ctx, vm);
      if (vm.state !== 'stopped') throw new ExecutorError('invalid', 'swapVolume needs a stopped VM');
      const next = await this.mustGet(volumeId, 'volume');
      this.requireOwner(ctx, next);
      if (next.zone !== vm.zone) throw new ExecutorError('invalid', 'volume and VM are in different zones');
      const current = vm.attrs.volumeId as string;
      if (current === volumeId) return;
      await this.update(ctx, current, { state: 'available' });
      await this.update(ctx, volumeId, { state: 'in-use' });
      await this.update(ctx, vm.id, { attrs: { ...vm.attrs, volumeId } });
    });
  }

  ensureVolume(ctx: OpContext, region: string, zone: string, sizeGb: number): Promise<VolumeRef> {
    return this.call('ensureVolume', ctx, async () => {
      const rec = await this.createOnce(ctx, 'volume', region, zone, 'available', { sizeGb, encrypted: true }, 'vol');
      return { volumeId: rec.id, zone: rec.zone!, sizeGb: rec.attrs.sizeGb as number };
    });
  }

  ensureVm(ctx: OpContext, region: string, spec: VmSpec): Promise<VmRef> {
    return this.call('ensureVm', ctx, async () => {
      this.requireOwner(ctx, await this.mustGet(spec.nicId, 'network_interface'));
      this.requireOwner(ctx, await this.mustGet(spec.volumeId, 'volume'));
      if (!(await this.store.findByToken('vm', ctx.token)) && (spec.maxVmHour !== undefined || spec.instanceTypePrices !== undefined)) {
        const price = spec.instanceTypePrices?.['fake.large'];
        if (typeof spec.maxVmHour !== 'number' || !Number.isFinite(spec.maxVmHour) || spec.maxVmHour < 0 ||
            typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
          throw new ExecutorError('invalid', 'A valid confirmed VM hourly price and current provider price are required.');
        }
        if (price > spec.maxVmHour) throw new ExecutorError('capacity', 'No launch candidate fits the confirmed VM hourly price.');
      }
      const rec = await this.createOnce(
        ctx,
        'vm',
        region,
        spec.zone,
        'running',
        {
          nicId: spec.nicId,
          volumeId: spec.volumeId,
          rootVolumeGb: this.priceSheet.rootVolumeGb,
          terminationProtection: true,
          // What a real VM receives as user data; `scripts/dev-agent.sh` reads it to start a local agent.
          userData: { instanceId: spec.instanceId, gatewayUrl: spec.gatewayUrl, bootstrapToken: spec.bootstrapToken },
        },
        'i',
      );
      await this.update(ctx, spec.volumeId, { state: 'in-use' });
      await this.update(ctx, spec.nicId, { state: 'in-use' });
      return { vmId: rec.id, zone: rec.zone!, instanceType: 'fake.large', rootVolumeGb: Number(rec.attrs.rootVolumeGb ?? 16) };
    });
  }

  associateIp(ctx: OpContext, _region: string, nicId: string, ip: IpAllocation): Promise<void> {
    return this.call('associateIp', ctx, async () => {
      const nic = await this.mustGet(nicId, 'network_interface');
      this.requireOwner(ctx, nic);
      this.requireOwner(ctx, await this.mustGet(ip.allocationId, 'ip'));
      const previous = nic.attrs.ipAllocationId as string | undefined;
      if (previous && previous !== ip.allocationId) await this.update(ctx, previous, { state: 'allocated' });
      await this.update(ctx, nicId, { attrs: { ...nic.attrs, ipAllocationId: ip.allocationId } });
      const addr = await this.mustGet(ip.allocationId, 'ip');
      await this.update(ctx, ip.allocationId, { state: 'associated', attrs: { ...addr.attrs, nicId } });
    });
  }

  ensureRunning(ctx: OpContext, p: Placement): Promise<RunState> {
    return this.call('ensureRunning', ctx, async () => {
      const vm = await this.mustGet(p.vmId, 'vm');
      this.requireOwner(ctx, vm);
      if (vm.state !== 'running') await this.update(ctx, vm.id, { state: 'running' });
      return 'running' as const;
    });
  }

  ensureStopped(ctx: OpContext, p: Placement): Promise<RunState> {
    return this.call('ensureStopped', ctx, async () => {
      const vm = await this.store.get(p.vmId);
      if (!vm || vm.state === 'deleted') return 'missing' as const;
      this.requireOwner(ctx, vm);
      if (vm.state !== 'stopped') await this.update(ctx, vm.id, { state: 'stopped' });
      return 'stopped' as const;
    });
  }

  describe(ctx: OpContext, p: Placement): Promise<ObservedState> {
    return this.call('describe', ctx, async () => {
      const vm = await this.store.get(p.vmId);
      const vol = await this.store.get(p.volumeId);
      return {
        vm: !vm || vm.state === 'deleted' ? 'missing' : (vm.state as RunState),
        ...(!vm || vm.state === 'deleted' ? {} : { instanceType: 'fake.large' }),
        ...(!vm || vm.state === 'deleted' ? {} : { rootVolumeGb: Number(vm.attrs.rootVolumeGb ?? 16) }),
        publicAddresses: await this.publicAddressesOf(p.nicId),
        volumeAttached: !!vol && vol.state === 'in-use',
      };
    });
  }

  verifyEgress(ctx: OpContext, p: Placement): Promise<BindingCheck> {
    return this.call('verifyEgress', ctx, async () => {
      const publicAddresses = await this.publicAddressesOf(p.nicId);
      const ok = publicAddresses.length === 1 && publicAddresses[0] === p.ipAddress;
      return {
        ok,
        expected: p.ipAddress,
        publicAddresses,
        ...(ok ? {} : { detail: `expected only ${p.ipAddress}, found [${publicAddresses.join(', ')}]` }),
      };
    });
  }

  ensureDeleted(ctx: OpContext, _region: string, kind: ResourceKind, providerId: string): Promise<void> {
    return this.call('ensureDeleted', ctx, async () => {
      const r = await this.store.get(providerId);
      if (!r) return;
      if (r.kind !== kind) throw new ExecutorError('invalid', `${providerId} is a ${r.kind}, not a ${kind}`);
      this.requireOwner(ctx, r);
      if (r.state === 'deleted') return;
      await this.update(ctx, providerId, { state: 'deleted', attrs: {} });
      const confirmed = await this.store.get(providerId);
      if (confirmed && confirmed.state !== 'deleted') throw new ExecutorError('retryable', `still waiting for ${providerId} to be deleted`);
    });
  }

  listManaged(ctx: OpContext, region: string): Promise<ObservedResource[]> {
    return this.call('listManaged', ctx, async () => {
      const all = await this.store.list(region);
      return all
        .filter((r) => r.state !== 'deleted' && r.tags['cb:managed'] === 'true')
        .map((r) => ({ providerId: r.id, kind: r.kind, region: r.region, zone: r.zone, state: r.state, tags: r.tags,
          ...(r.kind === 'volume' && typeof r.attrs.sizeGb === 'number' ? { sizeGb: r.attrs.sizeGb } : {}),
        }));
    });
  }

  quotas(ctx: OpContext, region: string): Promise<QuotaSnapshot[]> {
    return this.call('quotas', ctx, async () => {
      const live = (await this.store.list(region)).filter((r) => r.state !== 'deleted');
      const count = (k: ResourceKind) => live.filter((r) => r.kind === k).length;
      return [
        { metric: 'static_ips', limit: this.quotaLimits.static_ips, used: count('ip') },
        { metric: 'vcpus', limit: this.quotaLimits.vcpus, used: 2 * live.filter((r) => r.kind === 'vm' && r.state === 'running').length },
        { metric: 'volumes', limit: this.quotaLimits.volumes, used: count('volume') },
      ];
    });
  }

  /**
   * The simulator has no price list; it reports a plausible sheet, marked `simulated`, so the
   * pricing, metering and billing paths run end to end in local development and tests.
   */
  pricingConfigKey(_region: string): string {
    return JSON.stringify({ instanceTypes: ['fake.large'], rootVolumeGb: this.priceSheet.rootVolumeGb });
  }

  prices(ctx: OpContext, _region: string, additionalInstanceTypes: string[] = []): Promise<ProviderPriceSheet> {
    return this.call('prices', ctx, async () => ({
      source: 'simulated' as const,
      instanceType: 'fake.large',
      vmHour: this.priceSheet.vmHour,
      instanceTypes: Object.fromEntries(['fake.large', ...additionalInstanceTypes].map((type) => [type, this.priceSheet.vmHour])),
      machine: { vcpu: 2, memoryGb: 4 },
      volumeGbMonth: this.priceSheet.volumeGbMonth,
      snapshotGbMonth: this.priceSheet.snapshotGbMonth,
      ipHour: this.priceSheet.ipHour,
      transferOutGb: this.priceSheet.transferOutGb,
      rootVolumeGb: this.priceSheet.rootVolumeGb,
      effectiveDate: null,
    }));
  }

  // --- test hooks --------------------------------------------------------------------------------

  /** Simulates drift: a second public address attached to an interface outside our control. */
  async injectExtraPublicAddress(nicId: string, address: string) {
    const nic = await this.mustGet(nicId, 'network_interface');
    const extra = [...((nic.attrs.extraPublicAddresses as string[] | undefined) ?? []), address];
    await this.store.update(nicId, { attrs: { ...nic.attrs, extraPublicAddresses: extra } });
  }
}
