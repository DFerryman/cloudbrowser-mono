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
  type QuotaSnapshot,
  type ResourceKind,
  type RunState,
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

export type FaultPlan = (method: keyof Executor, ctx: OpContext) => Fault | null;

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
}

/** Documentation address ranges, keyed by provider region. */
const DEFAULT_IP_PREFIX: Record<string, string> = {
  'ap-northeast-1': '203.0.113.',
  'us-west-2': '198.51.100.',
};

const MUTATING: ReadonlySet<keyof Executor> = new Set([
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
    monthlyCostCents: { ip: 365, volume: 160, snapshot: 50 },
    vmHourCents: 10,
  };

  private readonly store: FakeStore;
  private readonly mode: CredentialMode;
  private readonly faults: FaultPlan;
  private readonly delayMs: number;
  private readonly ipPrefix: Record<string, string>;
  private readonly random: () => number;
  private readonly quotaLimits: Record<QuotaSnapshot['metric'], number>;

  constructor(opts: FakeExecutorOptions) {
    this.store = opts.store;
    this.mode = opts.mode;
    this.faults = opts.faults ?? (() => null);
    this.delayMs = opts.delayMs ?? 0;
    this.ipPrefix = opts.ipPrefix ?? DEFAULT_IP_PREFIX;
    this.random = opts.random ?? Math.random;
    this.quotaLimits = { static_ips: 20, vcpus: 32, volumes: 50, ...opts.quotaLimits };
  }

  // --- helpers -------------------------------------------------------------------------------

  private async call<T>(method: keyof Executor, ctx: OpContext, fn: () => Promise<T>): Promise<T> {
    this.authorize(method);
    if (Date.now() > ctx.deadline) throw new ExecutorError('unknown_outcome', `${method}: deadline passed`);
    if (this.delayMs > 0 && MUTATING.has(method)) await new Promise((r) => setTimeout(r, this.delayMs));
    const fault = this.faults(method, ctx);
    if (fault && fault !== 'timeout_after_success') {
      throw new ExecutorError(fault, `${method}: injected ${fault}`);
    }
    const result = await fn();
    if (fault === 'timeout_after_success') {
      throw new ExecutorError('unknown_outcome', `${method}: injected timeout after success`);
    }
    return result;
  }

  private authorize(method: keyof Executor) {
    const readOnly: ReadonlySet<keyof Executor> = new Set(['describe', 'verifyEgress', 'listManaged', 'quotas']);
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
    return { ...ctx.tags, 'cb:kind': kind };
  }

  private async mustGet(id: string, kind: ResourceKind): Promise<FakeRecord> {
    const r = await this.store.get(id);
    if (!r || r.kind !== kind || r.state === 'deleted') {
      throw new ExecutorError('invalid', `${kind} ${id} does not exist`);
    }
    return r;
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
    if (existing) return existing;
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

  ensureNetworkInterface(ctx: OpContext, region: string, ip: IpAllocation): Promise<NetworkInterfaceRef> {
    return this.call('ensureNetworkInterface', ctx, async () => {
      await this.mustGet(ip.allocationId, 'ip');
      const rec = await this.createOnce(
        ctx,
        'network_interface',
        region,
        `${region}a`,
        'available',
        { ipAllocationId: ip.allocationId, extraPublicAddresses: [] },
        'eni',
      );
      await this.store.update(ip.allocationId, { state: 'associated' });
      return { nicId: rec.id, zone: rec.zone! };
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
      await this.mustGet(spec.nicId, 'network_interface');
      await this.mustGet(spec.volumeId, 'volume');
      const rec = await this.createOnce(
        ctx,
        'vm',
        region,
        spec.zone,
        'running',
        { nicId: spec.nicId, volumeId: spec.volumeId, terminationProtection: true },
        'i',
      );
      await this.store.update(spec.volumeId, { state: 'in-use' });
      await this.store.update(spec.nicId, { state: 'in-use' });
      return { vmId: rec.id, zone: rec.zone! };
    });
  }

  associateIp(ctx: OpContext, _region: string, nicId: string, ip: IpAllocation): Promise<void> {
    return this.call('associateIp', ctx, async () => {
      const nic = await this.mustGet(nicId, 'network_interface');
      await this.mustGet(ip.allocationId, 'ip');
      const previous = nic.attrs.ipAllocationId as string | undefined;
      if (previous && previous !== ip.allocationId) await this.store.update(previous, { state: 'allocated' });
      await this.store.update(nicId, { attrs: { ...nic.attrs, ipAllocationId: ip.allocationId } });
      await this.store.update(ip.allocationId, { state: 'associated' });
    });
  }

  ensureRunning(ctx: OpContext, p: Placement): Promise<RunState> {
    return this.call('ensureRunning', ctx, async () => {
      const vm = await this.mustGet(p.vmId, 'vm');
      if (vm.state !== 'running') await this.store.update(vm.id, { state: 'running' });
      return 'running' as const;
    });
  }

  ensureStopped(ctx: OpContext, p: Placement): Promise<RunState> {
    return this.call('ensureStopped', ctx, async () => {
      const vm = await this.store.get(p.vmId);
      if (!vm || vm.state === 'deleted') return 'missing' as const;
      if (vm.state !== 'stopped') await this.store.update(vm.id, { state: 'stopped' });
      return 'stopped' as const;
    });
  }

  describe(ctx: OpContext, p: Placement): Promise<ObservedState> {
    return this.call('describe', ctx, async () => {
      const vm = await this.store.get(p.vmId);
      const vol = await this.store.get(p.volumeId);
      return {
        vm: !vm || vm.state === 'deleted' ? 'missing' : (vm.state as RunState),
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
      if (!r || r.state === 'deleted') return;
      if (r.kind !== kind) throw new ExecutorError('invalid', `${providerId} is a ${r.kind}, not a ${kind}`);
      if (r.tags['cb:managed'] !== 'true') throw new ExecutorError('forbidden', `${providerId} is not managed by us`);
      await this.store.update(providerId, { state: 'deleted' });
    });
  }

  listManaged(ctx: OpContext, region: string): Promise<ObservedResource[]> {
    return this.call('listManaged', ctx, async () => {
      const all = await this.store.list(region);
      return all
        .filter((r) => r.state !== 'deleted' && r.tags['cb:managed'] === 'true')
        .map((r) => ({ providerId: r.id, kind: r.kind, region: r.region, zone: r.zone, state: r.state, tags: r.tags }));
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

  // --- test hooks --------------------------------------------------------------------------------

  /** Simulates drift: a second public address attached to an interface outside our control. */
  async injectExtraPublicAddress(nicId: string, address: string) {
    const nic = await this.mustGet(nicId, 'network_interface');
    const extra = [...((nic.attrs.extraPublicAddresses as string[] | undefined) ?? []), address];
    await this.store.update(nicId, { attrs: { ...nic.attrs, extraPublicAddresses: extra } });
  }
}
