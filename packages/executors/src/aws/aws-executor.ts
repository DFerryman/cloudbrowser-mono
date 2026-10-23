/**
 * `aws-ec2` executor (page 10, "Provider mapping"): Elastic IP on the VM's primary network
 * interface, encrypted gp3 data volume attached as a second disk, VM stopped (never terminated)
 * while the browser sleeps.
 *
 * Idempotency: every create carries a ClientToken where EC2 has one and is tagged `cb:token`, so a
 * repeated call (or a call whose response was lost) finds the resource by lookup instead of
 * creating a second one. AllocateAddress and CreateSnapshot have no ClientToken: lookup only.
 */
import { FALLBACK_PRICE_TOLERANCE, type BrowserTier } from '@cloudbrowser/contracts';
import {
  ExecutorError,
  LaunchFailed,
  NoLaunchCandidate,
  ProviderFailed,
  type BindingCheck,
  type ErrorClass,
  type Capabilities,
  type CredentialMode,
  type Executor,
  type IpAllocation,
  type NetworkInterfaceRef,
  type ObservedResource,
  type ObservedState,
  type OpContext,
  type Placement,
  type ProviderPriceSheet,
  type ResizeState,
  type QuotaSnapshot,
  type ResourceKind,
  type RunState,
  type SnapshotRef,
  type VmRef,
  type VmSpec,
  type VolumeRef,
} from '../executor.js';
import { Ec2Client, Ec2Error, isNotFound, type ClientOptions, type Params, type PriceListProduct } from './client.js';
import { bootstrapScript } from './user-data.js';
import { items, tags as tagsOf, text, type XmlNode } from './xml.js';

/** One tier's machines in a region. */
export interface AwsTierMachines {
  /** Tried in order on a capacity error (see DEFAULT_TIER_INSTANCE_TYPES). */
  instanceTypes?: string[];
  /**
   * Which of `instanceTypes` each zone offers (DescribeInstanceTypeOfferings). Without it every
   * zone is assumed to offer every type.
   */
  zoneInstanceTypes?: Record<string, string[]>;
}

/** Network created by infra/aws/cloudbrowser.yaml, per provider region (Worker var AWS_REGIONS). */
export interface AwsRegionConfig extends AwsTierMachines {
  /** Availability zone → outbound-only subnet. The first zone is the default for new browsers. */
  subnets: Record<string, string>;
  securityGroupId: string;
  /** `instanceTypes` and `zoneInstanceTypes` above are Basic's; Premium's are here. Absent: its defaults in every zone. */
  premium?: AwsTierMachines;
  /** Pin an AMI; by default the latest Canonical Ubuntu 24.04 LTS (amd64) image. */
  ami?: string;
}

export interface AwsExecutorOptions extends ClientOptions {
  regionConfigResolver?: (region: string) => Promise<AwsRegionConfig | null>;
  mode: CredentialMode;
  regions: Record<string, AwsRegionConfig>;
  appUrl: string;
  agentImage: string;
  browserImage: string;
  /** Root disk (OS, Docker images); user data lives on the separate data volume. Billed as storage. */
  rootVolumeGb?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval while waiting for state changes. */
  pollMs?: number;
}

/**
 * One VM per browser, and every launch candidate of a tier has the same vCPUs and memory
 * (contracts TIERS). No burstable `t3`: once its CPU credits run out it either throttles the
 * video or bills surplus credits that the price list does not show. Chrome for Linux is x86-64
 * only, so no Graviton.
 *
 * Basic, 2 vCPU / 4 GB: Chrome plus neko's VP8 encoding at 1080p25 (about 2.5 GB in use with a
 * handful of tabs; while the screen moves the encoder takes most of a vCPU and the VM is about
 * 85% busy). `c7i-flex` has the same CPU as the `m7i-flex` the first real browsers ran on, with
 * half the memory; the fallbacks are 2 vCPU / 4 GB at about the same price (a fraction of a
 * percent more in most regions).
 *
 * Premium, 4 vCPU / 8 GB: the same live view, with twice the CPU and memory for heavier pages and
 * more tabs. Full-performance `c7i` rather than `c7i-flex`, whose 40% baseline is not sized for a
 * VM busy the whole session; `c6i` and `c5` are the same shape at or below its price.
 */
export const DEFAULT_TIER_INSTANCE_TYPES: Record<BrowserTier, string[]> = {
  basic: ['c7i-flex.large', 'c6i.large', 'c5.large'],
  premium: ['c7i.xlarge', 'c6i.xlarge', 'c5.xlarge'],
};
export const DEFAULT_INSTANCE_TYPES = DEFAULT_TIER_INSTANCE_TYPES.basic;

/**
 * A tier's launch candidates and zone offerings in a region. Basic without a list, or a config
 * without `premium` (a hand-written AWS_REGIONS entry), gets the defaults. The reconciler lists
 * the Premium machines the region's zones offer: an empty list means Premium is not offered.
 */
export function tierMachines(cfg: AwsRegionConfig, tier: BrowserTier = 'basic'): { instanceTypes: string[]; zoneInstanceTypes?: Record<string, string[]> } {
  const machines = tier === 'basic' ? cfg : cfg.premium;
  const listed = tier === 'basic' ? !!machines?.instanceTypes?.length : !!machines?.instanceTypes;
  return {
    instanceTypes: listed ? machines!.instanceTypes! : DEFAULT_TIER_INSTANCE_TYPES[tier],
    ...(machines?.zoneInstanceTypes ? { zoneInstanceTypes: machines.zoneInstanceTypes } : {}),
  };
}
/** Ubuntu, Docker and the browser image take about 8 GB; the rest leaves room for an image update. */
export const DEFAULT_ROOT_VOLUME_GB = 16;
const DATA_DEVICE = '/dev/sdf';
const UBUNTU_OWNER = '099720109477'; // Canonical
const UBUNTU_NAME = 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*';

const MUTATING: ReadonlySet<keyof Executor> = new Set([
  'allocateIp',
  'ensureNetworkInterface',
  'ensureVolume',
  'ensureVm',
  'associateIp',
  'ensureRunning',
  'ensureStopped',
  'snapshot',
  'ensureVolumeFromSnapshot',
  'swapVolume',
  'resizeVolume',
  'ensureDeleted',
]);

/** EC2 ClientToken: at most 64 ASCII characters, so long tokens are hashed. */
async function clientToken(token: string, suffix = '') {
  const raw = `${token}${suffix}`;
  if (raw.length <= 64 && /^[\x20-\x7e]+$/.test(raw)) return raw;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  return `cb-${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 56)}`;
}

function b64(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** `TagSpecification.N.*` parameters. */
function tagSpec(n: number, resourceType: string, tags: Record<string, string>): Params {
  const out: Params = { [`TagSpecification.${n}.ResourceType`]: resourceType };
  Object.entries(tags).forEach(([k, v], i) => {
    out[`TagSpecification.${n}.Tag.${i + 1}.Key`] = k;
    out[`TagSpecification.${n}.Tag.${i + 1}.Value`] = v;
  });
  return out;
}

function filters(f: Record<string, string | string[]>): Params {
  const out: Params = {};
  Object.entries(f).forEach(([name, values], i) => {
    out[`Filter.${i + 1}.Name`] = name;
    (Array.isArray(values) ? values : [values]).forEach((v, j) => (out[`Filter.${i + 1}.Value.${j + 1}`] = v));
  });
  return out;
}

/** How long a just-launched VM or volume may be invisible to Describe calls (eventual consistency). */
const VISIBILITY_GRACE_MS = 90_000;

/**
 * What a VM that ended during launch means, from its EC2 state reason. Only a capacity shortage
 * is worth retrying elsewhere; the `Client.*` reasons repeat on every launch until an operator
 * fixes them. EC2 reports a KMS call it was not allowed to make for the caller (IAM, an
 * organization SCP or the key policy) as `Client.InvalidKMSKey.InvalidState` ("the KMS key is in
 * an incorrect state") with transition reason `Client.InternalError`, the same as a disabled key:
 * either way the account may not use the key here, so it is `forbidden`, not a capacity problem.
 */
export function launchFailureClass(code: string | null): ErrorClass {
  if (!code) return 'retryable';
  if (code === 'Server.InsufficientInstanceCapacity') return 'capacity';
  if (code === 'Server.InternalError') return 'retryable';
  if (code === 'Client.VolumeLimitExceeded') return 'quota';
  if (code.startsWith('Client.InvalidKMSKey.') || code === 'Client.InternalError') return 'forbidden';
  return 'invalid';
}

const RUN_STATES: Record<string, RunState> = {
  pending: 'pending',
  running: 'running',
  stopping: 'stopping',
  stopped: 'stopped',
  'shutting-down': 'terminating',
  terminated: 'terminated',
};

/** A stop still pending after this long is forced (EC2: "Troubleshoot an instance stuck in stopping"). */
const FORCE_STOP_AFTER_MS = 10 * 60_000;

/** When the current stop was requested, from EC2's `reason`: "User initiated (2026-10-20 03:00:00 GMT)". */
function stopRequestedAt(inst: XmlNode | null): number | null {
  const at = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)/.exec(text(inst ?? undefined, 'reason') ?? '');
  return at ? Date.parse(`${at[1]}T${at[2]}Z`) : null;
}

export class AwsExecutor implements Executor {
  readonly kind = 'aws-ec2' as const;
  readonly capabilities: Capabilities = {
    zonalVolumes: true,
    nativeIdempotency: true,
    movableIp: true,
  };

  private readonly ec2: Ec2Client;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly amiCache = new Map<string, string>();

  constructor(private readonly opts: AwsExecutorOptions) {
    this.ec2 = new Ec2Client(opts);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = opts.pollMs ?? 3000;
  }

  // --- helpers -------------------------------------------------------------------------------

  private authorize(method: keyof Executor) {
    const readOnly: ReadonlySet<keyof Executor> = new Set(['describe', 'verifyEgress', 'listManaged', 'quotas', 'zones', 'prices']);
    if (this.opts.mode === 'readonly' && !readOnly.has(method)) throw new ExecutorError('forbidden', `${method} needs more than read-only credentials`);
    if (this.opts.mode === 'runtime' && method === 'ensureDeleted') throw new ExecutorError('forbidden', 'ensureDeleted requires the reaper credentials');
    if (this.opts.mode === 'reaper' && MUTATING.has(method) && method !== 'ensureDeleted' && method !== 'ensureStopped') {
      throw new ExecutorError('forbidden', `${method} is not allowed with the reaper credentials`);
    }
  }

  private region(region: string): AwsRegionConfig {
    const cfg = this.opts.regions[region];
    if (!cfg || !Object.keys(cfg.subnets).length) throw new ExecutorError('invalid', `AWS region ${region} is not configured (AWS_REGIONS)`);
    return cfg;
  }

  async prepareRegion(region: string): Promise<void> {
    const config = await this.opts.regionConfigResolver?.(region);
    if (config) this.opts.regions[region] = config;
  }

  private call(ctx: OpContext, region: string, action: string, params: Params, mutating = true) {
    return this.ec2.call(region, action, params, ctx.deadline, mutating, ctx.assertActive);
  }

  private read(ctx: OpContext, region: string, action: string, params: Params) {
    return this.ec2.call(region, action, params, ctx.deadline, false, ctx.assertActive);
  }

  /** All pages of a Describe call. */
  private async readAll(ctx: OpContext, region: string, action: string, setName: string, params: Params): Promise<XmlNode[]> {
    const out: XmlNode[] = [];
    let next: string | undefined;
    do {
      const res = await this.read(ctx, region, action, { ...params, ...(next ? { NextToken: next } : {}) });
      out.push(...items(res, setName));
      next = text(res, 'nextToken') || undefined;
    } while (next);
    return out;
  }

  private requireTags(ctx: OpContext, kind: ResourceKind | 'root_volume'): Record<string, string> {
    if (ctx.tags['cb:managed'] !== 'true' || !ctx.tags['cb:instance'] || !ctx.tags['cb:op']) {
      throw new ExecutorError('forbidden', `refusing to create an untagged ${kind}`);
    }
    return { ...ctx.tags, 'cb:kind': kind, 'cb:token': ctx.token, Name: `cloudbrowser-${ctx.tags['cb:instance']}` };
  }

  private requireOwner(ctx: OpContext, node: XmlNode | null | undefined, providerId: string) {
    if (!node) throw new ExecutorError('invalid', `${providerId} does not exist`);
    const tags = tagsOf(node);
    if (tags['cb:managed'] !== 'true' || tags['cb:instance'] !== ctx.tags['cb:instance'] || tags['cb:env'] !== ctx.tags['cb:env']) {
      throw new ExecutorError('forbidden', `${providerId} does not belong to this browser`);
    }
  }

  /** Polls `check` until it returns a value or the deadline is near. */
  private async waitFor<T>(ctx: OpContext, what: string, check: () => Promise<T | null>): Promise<T> {
    for (;;) {
      const v = await check();
      if (v !== null) return v;
      if (Date.now() + this.pollMs + 2000 > ctx.deadline) throw new ExecutorError('retryable', `still waiting for ${what}`);
      await this.sleep(this.pollMs);
    }
  }

  private async instance(ctx: OpContext, region: string, vmId: string): Promise<XmlNode | null> {
    try {
      const res = await this.read(ctx, region, 'DescribeInstances', { 'InstanceId.1': vmId });
      return items(items(res, 'reservationSet')[0], 'instancesSet')[0] ?? null;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  private async volume(ctx: OpContext, region: string, volumeId: string): Promise<XmlNode | null> {
    try {
      const res = await this.read(ctx, region, 'DescribeVolumes', { 'VolumeId.1': volumeId });
      return items(res, 'volumeSet')[0] ?? null;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  private async rootVolumeSize(ctx: OpContext, region: string, vmId: string): Promise<number | undefined> {
    const volumes = await this.readAll(ctx, region, 'DescribeVolumes', 'volumeSet', filters({
      'attachment.instance-id': vmId,
      'tag:cb:kind': 'root_volume',
    }));
    const sizeGb = Number(text(volumes[0], 'size'));
    return Number.isInteger(sizeGb) && sizeGb > 0 ? sizeGb : undefined;
  }

  private async byToken(ctx: OpContext, region: string, action: string, setName: string, extra: Record<string, string | string[]> = {}) {
    const found = await this.readAll(ctx, region, action, setName, filters({ 'tag:cb:token': ctx.token, ...extra }));
    // A token collision or stale ledger entry must never recover another browser's data or IP.
    // Fail rather than issuing another create with that already-used provider idempotency token.
    for (const node of found) this.requireOwner(ctx, action === 'DescribeInstances' ? items(node, 'instancesSet')[0] : node, `resource for ${ctx.step}`);
    return found[0] ?? null;
  }

  private stateOf(inst: XmlNode | null): RunState {
    if (!inst) return 'missing';
    return RUN_STATES[text(inst, 'instanceState', 'name') ?? ''] ?? 'pending';
  }

  private async latestUbuntu(ctx: OpContext, region: string): Promise<string> {
    const cached = this.amiCache.get(region);
    if (cached) return cached;
    const images = await this.readAll(ctx, region, 'DescribeImages', 'imagesSet', {
      'Owner.1': UBUNTU_OWNER,
      ...filters({ name: UBUNTU_NAME, architecture: 'x86_64', state: 'available' }),
    });
    const latest = images.sort((a, b) => (text(b, 'creationDate') ?? '').localeCompare(text(a, 'creationDate') ?? ''))[0];
    const id = text(latest, 'imageId');
    if (!id) throw new ExecutorError('invalid', `no Ubuntu 24.04 image found in ${region}`);
    this.amiCache.set(region, id);
    return id;
  }

  /** Public IPv4 and any IPv6 addresses on the VM's interfaces (or on one interface without a VM). */
  private async publicAddresses(ctx: OpContext, region: string, p: Placement): Promise<string[]> {
    const enis = p.vmId
      ? await this.readAll(ctx, region, 'DescribeNetworkInterfaces', 'networkInterfaceSet', filters({ 'attachment.instance-id': p.vmId }))
      : [];
    if (!enis.length && p.nicId) {
      try {
        enis.push(...(await this.readAll(ctx, region, 'DescribeNetworkInterfaces', 'networkInterfaceSet', { 'NetworkInterfaceId.1': p.nicId })));
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    const out = new Set<string>();
    for (const eni of enis) {
      for (const ip of items(eni, 'privateIpAddressesSet')) {
        const pub = text(ip, 'association', 'publicIp');
        if (pub) out.add(pub);
      }
      const direct = text(eni, 'association', 'publicIp');
      if (direct) out.add(direct);
      for (const v6 of items(eni, 'ipv6AddressesSet')) {
        const a = text(v6, 'ipv6Address');
        if (a) out.add(a);
      }
    }
    return [...out];
  }

  private async ensureAttached(ctx: OpContext, region: string, vmId: string, volumeId: string) {
    const vol = await this.volume(ctx, region, volumeId);
    if (!vol) throw new ExecutorError('invalid', `volume ${volumeId} does not exist`);
    this.requireOwner(ctx, vol, volumeId);
    const att = items(vol, 'attachmentSet')[0];
    if (att && text(att, 'instanceId') === vmId) {
      if (text(att, 'status') === 'attached') return;
    } else if (att) {
      throw new ExecutorError('invalid', `volume ${volumeId} is attached to ${text(att, 'instanceId')}`);
    } else {
      await this.call(ctx, region, 'AttachVolume', { VolumeId: volumeId, InstanceId: vmId, Device: DATA_DEVICE });
    }
    await this.waitFor(ctx, `volume ${volumeId} to attach`, async () => {
      const v = await this.volume(ctx, region, volumeId);
      return text(items(v ?? undefined, 'attachmentSet')[0], 'status') === 'attached' ? true : null;
    });
  }

  // --- Executor --------------------------------------------------------------------------------

  pricingConfigKey(region: string): string {
    const cfg = this.region(region);
    return JSON.stringify({
      instanceTypes: tierMachines(cfg).instanceTypes,
      premiumInstanceTypes: premiumOffered(cfg) ? tierMachines(cfg, 'premium').instanceTypes : [],
      rootVolumeGb: this.opts.rootVolumeGb ?? DEFAULT_ROOT_VOLUME_GB,
    });
  }

  /** Zones that offer at least one launch candidate of the tier, in configuration order. */
  zones(region: string, tier: BrowserTier = 'basic'): string[] {
    const cfg = this.region(region);
    const all = Object.keys(cfg.subnets);
    const { instanceTypes: types, zoneInstanceTypes } = tierMachines(cfg, tier);
    const offered = zoneInstanceTypes ? all.filter((z) => zoneInstanceTypes[z]?.some((t) => types.includes(t))) : all;
    return offered.length ? offered : all;
  }

  async allocateIp(ctx: OpContext, region: string): Promise<IpAllocation> {
    this.authorize('allocateIp');
    this.region(region);
    const found = await this.byToken(ctx, region, 'DescribeAddresses', 'addressesSet');
    if (found) return { allocationId: text(found, 'allocationId')!, address: text(found, 'publicIp')! };
    const res = await this.call(ctx, region, 'AllocateAddress', { Domain: 'vpc', ...tagSpec(1, 'elastic-ip', this.requireTags(ctx, 'ip')) });
    return { allocationId: text(res, 'allocationId')!, address: text(res, 'publicIp')! };
  }

  async ensureNetworkInterface(ctx: OpContext, region: string, ip: IpAllocation, zone?: string): Promise<NetworkInterfaceRef> {
    this.authorize('ensureNetworkInterface');
    const cfg = this.region(region);
    const az = zone ?? this.zones(region)[0]!;
    const subnet = cfg.subnets[az];
    if (!subnet) throw new ExecutorError('invalid', `no subnet configured for ${az}`);
    let eni = await this.byToken(ctx, region, 'DescribeNetworkInterfaces', 'networkInterfaceSet');
    if (!eni) {
      const res = await this.call(ctx, region, 'CreateNetworkInterface', {
        SubnetId: subnet,
        'SecurityGroupId.1': cfg.securityGroupId,
        Description: `cloudbrowser ${ctx.tags['cb:instance']}`,
        ClientToken: await clientToken(ctx.token),
        ...tagSpec(1, 'network-interface', this.requireTags(ctx, 'network_interface')),
      });
      eni = res.children.find((c) => c.name === 'networkInterface') ?? null;
    }
    const nicId = text(eni ?? undefined, 'networkInterfaceId');
    if (!nicId) throw new ExecutorError('unknown_outcome', 'CreateNetworkInterface returned no id');
    // The address has one association; reassociating moves it here (recover keeps the same IP).
    await this.associateIp(ctx, region, nicId, ip);
    return { nicId, zone: text(eni ?? undefined, 'availabilityZone') ?? az };
  }

  async associateIp(ctx: OpContext, region: string, nicId: string, ip: IpAllocation): Promise<void> {
    this.authorize('associateIp');
    const res = await this.read(ctx, region, 'DescribeAddresses', { 'AllocationId.1': ip.allocationId });
    const addr = items(res, 'addressesSet')[0];
    this.requireOwner(ctx, addr, ip.allocationId);
    const interfaces = await this.read(ctx, region, 'DescribeNetworkInterfaces', { 'NetworkInterfaceId.1': nicId });
    this.requireOwner(ctx, items(interfaces, 'networkInterfaceSet')[0], nicId);
    if (text(addr, 'networkInterfaceId') === nicId) return;
    await this.call(ctx, region, 'AssociateAddress', { AllocationId: ip.allocationId, NetworkInterfaceId: nicId, AllowReassociation: true });
  }

  async ensureVolume(ctx: OpContext, region: string, zone: string, sizeGb: number): Promise<VolumeRef> {
    this.authorize('ensureVolume');
    this.region(region);
    let vol = await this.byToken(ctx, region, 'DescribeVolumes', 'volumeSet');
    if (!vol) {
      vol = await this.call(ctx, region, 'CreateVolume', {
        AvailabilityZone: zone,
        Size: sizeGb,
        VolumeType: 'gp3',
        Encrypted: true,
        ClientToken: await clientToken(ctx.token),
        ...tagSpec(1, 'volume', this.requireTags(ctx, 'volume')),
      });
    }
    const volumeId = text(vol, 'volumeId')!;
    await this.volumeCreated(ctx, region, volumeId);
    return { volumeId, zone: text(vol, 'availabilityZone') ?? zone, sizeGb: Number(text(vol, 'size') ?? sizeGb) };
  }

  /**
   * CreateVolume only starts the work. An encrypted volume whose KMS key EC2 cannot use for the
   * caller goes from `creating` to `error` and is deleted within seconds, so wait for `available`
   * before building on it. A new volume fails like this only for its key, hence `forbidden`.
   */
  private async volumeCreated(ctx: OpContext, region: string, volumeId: string) {
    const since = Date.now();
    let seen = false;
    await this.waitFor(ctx, `volume ${volumeId} to be created`, async () => {
      const v = await this.volume(ctx, region, volumeId);
      const status = text(v ?? undefined, 'status');
      if (status === 'available' || status === 'in-use') return true;
      seen ||= !!v;
      // Not visible yet right after CreateVolume is normal; gone after being seen is a failure.
      if (status === 'creating' || (!v && !seen && Date.now() - since < VISIBILITY_GRACE_MS)) return null;
      throw new ProviderFailed('forbidden', volumeId, text(v ?? undefined, 'availabilityZone') ?? null, null, `EBS could not create volume ${volumeId} in ${region} (${v ? status : 'it disappeared'}). Check that the EBS encryption key is usable there: key state, key policy and SCPs for KMS through EC2.`);
    });
  }

  async ensureVm(ctx: OpContext, region: string, spec: VmSpec): Promise<VmRef> {
    this.authorize('ensureVm');
    const cfg = this.region(region);
    let inst = await this.byToken(ctx, region, 'DescribeInstances', 'reservationSet', {
      'instance-state-name': ['pending', 'running', 'stopping', 'stopped'],
    });
    let vmId = text(items(inst ?? undefined, 'instancesSet')[0], 'instanceId');
    let launchedAt: number | null = null;
    if (!vmId) {
      const tier = spec.tier ?? 'basic';
      const machines = tierMachines(cfg, tier);
      const configuredTypes = machines.instanceTypes;
      if (!configuredTypes.length) throw new ExecutorError('invalid', `No ${tier} machine is offered in ${region}.`);
      let types = configuredTypes.map((type, index) => ({ type, index }));
      // Older callers may omit a quote. Production creation supplies both fields; a partial or
      // malformed quote never permits launch, and an existing VM is resolved before this gate.
      if (spec.maxVmHour !== undefined || spec.instanceTypePrices !== undefined) {
        if (typeof spec.maxVmHour !== 'number' || !Number.isFinite(spec.maxVmHour) || spec.maxVmHour < 0) {
          throw new ExecutorError('invalid', 'A valid confirmed VM hourly price is required before launching a machine.');
        }
        const cap = spec.maxVmHour;
        for (const type of configuredTypes) {
          const price = spec.instanceTypePrices?.[type];
          if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
            throw new ExecutorError('invalid', `A current provider price is required for launch candidate ${type}.`);
          }
        }
        // A fallback for a capacity shortage may cost up to 5% more: Basic's are priced a fraction
        // of a percent above its first machine in most regions and were otherwise never tried.
        // The user still pays the tier's price for it (contracts billedVmHour). The first machine
        // itself must fit: costing more means prices rose after the user confirmed them.
        types = types.filter(({ type, index }) => spec.instanceTypePrices![type]! <= (index === 0 ? cap : cap * (1 + FALLBACK_PRICE_TOLERANCE)));
        if (!types.length) throw new NoLaunchCandidate('price', 'No launch candidate fits the confirmed VM hourly price.');
      }
      // A type this zone does not offer fails with Unsupported; skip it instead of asking.
      const zoneTypes = machines.zoneInstanceTypes?.[spec.zone];
      if (zoneTypes) {
        types = types.filter(({ type }) => zoneTypes.includes(type));
        if (!types.length) throw new NoLaunchCandidate('zone', `No allowed machine type is offered in ${spec.zone}.`);
      }
      const ami = cfg.ami ?? (await this.latestUbuntu(ctx, region));
      const userData = bootstrapScript({
        instanceId: spec.instanceId,
        gatewayUrl: spec.gatewayUrl,
        bootstrapToken: spec.bootstrapToken,
        appUrl: this.opts.appUrl,
        agentImage: this.opts.agentImage,
        browserImage: this.opts.browserImage,
        ...(spec.timezone ? { timezone: spec.timezone } : {}),
      });
      for (const [attempt, { type, index }] of types.entries()) {
        try {
          const res = await this.call(ctx, region, 'RunInstances', {
            ImageId: ami,
            InstanceType: type,
            MinCount: 1,
            MaxCount: 1,
            // Keep each type's original token even when more expensive candidates were filtered.
            ClientToken: await clientToken(ctx.token, `:${index}`),
            'NetworkInterface.1.DeviceIndex': 0,
            'NetworkInterface.1.NetworkInterfaceId': spec.nicId,
            'BlockDeviceMapping.1.DeviceName': '/dev/sda1',
            'BlockDeviceMapping.1.Ebs.VolumeSize': this.opts.rootVolumeGb ?? DEFAULT_ROOT_VOLUME_GB,
            'BlockDeviceMapping.1.Ebs.VolumeType': 'gp3',
            'BlockDeviceMapping.1.Ebs.Encrypted': true,
            'BlockDeviceMapping.1.Ebs.DeleteOnTermination': true,
            DisableApiTermination: true,
            InstanceInitiatedShutdownBehavior: 'stop',
            // IMDSv2 only, one hop: the browser's user is blocked from it by the VM firewall too.
            'MetadataOptions.HttpTokens': 'required',
            'MetadataOptions.HttpPutResponseHopLimit': 1,
            'MetadataOptions.HttpEndpoint': 'enabled',
            UserData: b64(userData),
            ...tagSpec(1, 'instance', this.requireTags(ctx, 'vm')),
            ...tagSpec(2, 'volume', this.requireTags(ctx, 'root_volume')),
          });
          vmId = text(items(res, 'instancesSet')[0], 'instanceId');
          break;
        } catch (e) {
          // No capacity for this type (or not offered in this zone): try the next allowed type.
          if (e instanceof ExecutorError && e.errorClass === 'capacity' && attempt < types.length - 1) continue;
          throw e;
        }
      }
      if (!vmId) throw new ExecutorError('unknown_outcome', 'RunInstances returned no instance id');
      launchedAt = Date.now();
    }
    const id = vmId;
    // The data volume can only be attached once the VM is running (or stopped).
    const started = await this.waitFor(ctx, `VM ${id} to start`, async () => {
      const i = await this.instance(ctx, region, id);
      const state = this.stateOf(i);
      // DescribeInstances may not know a VM for a few seconds after RunInstances returned it.
      if (state === 'missing' && launchedAt !== null && Date.now() - launchedAt < VISIBILITY_GRACE_MS) return null;
      if (state === 'terminating' || state === 'terminated' || state === 'missing') {
        const code = text(i ?? undefined, 'stateReason', 'code') ?? null;
        const reason = text(i ?? undefined, 'stateReason', 'message') ?? (state === 'missing' ? 'it is no longer visible' : 'no reason given');
        throw new LaunchFailed(launchFailureClass(code), id, text(i ?? undefined, 'placement', 'availabilityZone') ?? spec.zone, code, `VM ${id} ended during launch: ${reason}`);
      }
      if (state !== 'running' && state !== 'stopped') return null;
      const instanceType = text(i ?? undefined, 'instanceType');
      if (!instanceType) throw new ExecutorError('retryable', `DescribeInstances returned no type for VM ${id}`);
      return { zone: text(i ?? undefined, 'placement', 'availabilityZone') ?? spec.zone, instanceType };
    });
    await this.ensureAttached(ctx, region, id, spec.volumeId);
    return { vmId: id, ...started, rootVolumeGb: await this.rootVolumeSize(ctx, region, id) };
  }

  async ensureRunning(ctx: OpContext, p: Placement): Promise<RunState> {
    this.authorize('ensureRunning');
    const region = p.providerRegion;
    let inst = await this.instance(ctx, region, p.vmId);
    if (inst) this.requireOwner(ctx, inst, p.vmId);
    let state = this.stateOf(inst);
    if (state === 'terminating' || state === 'terminated' || state === 'missing') throw new ExecutorError('invalid', `VM ${p.vmId} no longer exists`);
    if (state === 'stopping') {
      await this.waitFor(ctx, `VM ${p.vmId} to stop`, async () => (this.stateOf(await this.instance(ctx, region, p.vmId)) === 'stopped' ? true : null));
      state = 'stopped';
    }
    if (state === 'stopped') await this.call(ctx, region, 'StartInstances', { 'InstanceId.1': p.vmId });
    return this.waitFor(ctx, `VM ${p.vmId} to run`, async () => {
      inst = await this.instance(ctx, region, p.vmId);
      const s = this.stateOf(inst);
      if (s === 'stopped') {
        // Its encrypted disks need the KMS key on every start too; that is no capacity shortage.
        const code = text(inst ?? undefined, 'stateReason', 'code') ?? null;
        if (launchFailureClass(code) === 'forbidden') {
          throw new ProviderFailed('forbidden', p.vmId, p.zone, code, `VM ${p.vmId} could not start: ${text(inst ?? undefined, 'stateReason', 'message') ?? code}`);
        }
        throw new ExecutorError('capacity', `VM ${p.vmId} stopped again while starting`);
      }
      return s === 'running' ? ('running' as const) : null;
    });
  }

  async ensureStopped(ctx: OpContext, p: Placement): Promise<RunState> {
    this.authorize('ensureStopped');
    const region = p.providerRegion;
    const inst = await this.instance(ctx, region, p.vmId);
    if (inst) this.requireOwner(ctx, inst, p.vmId);
    const state = this.stateOf(inst);
    if (state === 'missing' || state === 'terminated') return 'missing';
    if (state === 'stopped') return 'stopped';
    if (state === 'running' || state === 'pending') await this.call(ctx, region, 'StopInstances', { 'InstanceId.1': p.vmId });
    // EC2 can leave a VM on failing hardware in `stopping` indefinitely, and the browser showed
    // "Going to sleep" until someone forced it from the console. Chrome was closed (or given its
    // time) before this step, so a stop that has not finished in time is forced.
    const since = stopRequestedAt(inst);
    if (state === 'stopping' && since !== null && Date.now() - since > FORCE_STOP_AFTER_MS) {
      await this.call(ctx, region, 'StopInstances', { 'InstanceId.1': p.vmId, Force: 'true' });
    }
    return this.waitFor(ctx, `VM ${p.vmId} to stop`, async () => {
      const s = this.stateOf(await this.instance(ctx, region, p.vmId));
      return s === 'stopped' ? ('stopped' as const) : s === 'missing' || s === 'terminated' ? ('missing' as const) : null;
    });
  }

  async snapshot(ctx: OpContext, region: string, volumeId: string): Promise<SnapshotRef> {
    this.authorize('snapshot');
    this.requireOwner(ctx, await this.volume(ctx, region, volumeId), volumeId);
    let snap = await this.byToken(ctx, region, 'DescribeSnapshots', 'snapshotSet', {});
    if (!snap) {
      snap = await this.call(ctx, region, 'CreateSnapshot', {
        VolumeId: volumeId,
        Description: `cloudbrowser ${ctx.tags['cb:instance']} ${ctx.step}`,
        ...tagSpec(1, 'snapshot', this.requireTags(ctx, 'snapshot')),
      });
    }
    return { snapshotId: text(snap, 'snapshotId')!, sizeGb: Number(text(snap, 'volumeSize') ?? 0) };
  }

  async ensureVolumeFromSnapshot(ctx: OpContext, region: string, zone: string, snapshotId: string, sizeGb: number): Promise<VolumeRef> {
    this.authorize('ensureVolumeFromSnapshot');
    const snapshots = await this.read(ctx, region, 'DescribeSnapshots', { 'SnapshotId.1': snapshotId });
    this.requireOwner(ctx, items(snapshots, 'snapshotSet')[0], snapshotId);
    let vol = await this.byToken(ctx, region, 'DescribeVolumes', 'volumeSet');
    if (!vol) {
      // A snapshot can only be used once it is complete (a first snapshot takes minutes).
      await this.waitFor(ctx, `snapshot ${snapshotId} to complete`, async () => {
        const res = await this.read(ctx, region, 'DescribeSnapshots', { 'SnapshotId.1': snapshotId });
        const s = text(items(res, 'snapshotSet')[0], 'status');
        if (s === 'error') throw new ExecutorError('invalid', `snapshot ${snapshotId} failed`);
        return s === 'completed' ? true : null;
      });
      vol = await this.call(ctx, region, 'CreateVolume', {
        AvailabilityZone: zone,
        SnapshotId: snapshotId,
        Size: sizeGb,
        VolumeType: 'gp3',
        Encrypted: true,
        ClientToken: await clientToken(ctx.token),
        ...tagSpec(1, 'volume', this.requireTags(ctx, 'volume')),
      });
    }
    const volumeId = text(vol, 'volumeId')!;
    await this.volumeCreated(ctx, region, volumeId);
    return { volumeId, zone: text(vol, 'availabilityZone') ?? zone, sizeGb: Number(text(vol, 'size') ?? sizeGb) };
  }

  async resizeVolume(ctx: OpContext, region: string, volumeId: string, sizeGb: number): Promise<ResizeState> {
    this.authorize('resizeVolume');
    const vol = await this.volume(ctx, region, volumeId);
    if (!vol) throw new ExecutorError('invalid', `volume ${volumeId} does not exist`);
    this.requireOwner(ctx, vol, volumeId);
    const size = Number(text(vol, 'size') ?? 0);
    let mods: XmlNode[] = [];
    try {
      mods = await this.readAll(ctx, region, 'DescribeVolumesModifications', 'volumeModificationSet', { 'VolumeId.1': volumeId });
    } catch (e) {
      if (!isNotFound(e)) throw e; // never modified
    }
    const latest = mods.sort((a, b) => (text(b, 'startTime') ?? '').localeCompare(text(a, 'startTime') ?? ''))[0];
    const target = Number(text(latest, 'targetSize') ?? 0);
    if (latest) {
      const state = text(latest, 'modificationState');
      if (state === 'failed') throw new ExecutorError('invalid', `resizing ${volumeId} failed: ${text(latest, 'statusMessage') ?? 'no reason given'}`);
      if (!['modifying', 'optimizing', 'completed'].includes(state ?? '')) throw new ExecutorError('retryable', `Unrecognized volume modification state for ${volumeId}.`);
      // The accepted size is usable (and billed) from optimizing on, but another size change
      // must wait for completed. Retrying the same target never submits ModifyVolume twice.
      if (target >= sizeGb) return { state: state === 'modifying' ? 'pending' : 'ready', sizeGb: Math.max(size, target) };
      if (state !== 'completed') return { state: 'pending', sizeGb };
    }
    if (size >= sizeGb) return { state: 'ready', sizeGb: size };
    await this.call(ctx, region, 'ModifyVolume', { VolumeId: volumeId, Size: sizeGb });
    return { state: 'pending', sizeGb };
  }

  async swapVolume(ctx: OpContext, p: Placement, volumeId: string): Promise<void> {
    this.authorize('swapVolume');
    const region = p.providerRegion;
    const inst = await this.instance(ctx, region, p.vmId);
    this.requireOwner(ctx, inst, p.vmId);
    // Validate the replacement before detaching the current volume.
    this.requireOwner(ctx, await this.volume(ctx, region, volumeId), volumeId);
    if (this.stateOf(inst) !== 'stopped') throw new ExecutorError('invalid', 'swapVolume needs a stopped VM');
    const attached = await this.readAll(
      ctx,
      region,
      'DescribeVolumes',
      'volumeSet',
      filters({ 'attachment.instance-id': p.vmId, 'attachment.device': DATA_DEVICE }),
    );
    for (const v of attached) {
      const id = text(v, 'volumeId')!;
      if (id === volumeId) return this.ensureAttached(ctx, region, p.vmId, volumeId);
      await this.call(ctx, region, 'DetachVolume', { VolumeId: id, InstanceId: p.vmId });
      await this.waitFor(ctx, `volume ${id} to detach`, async () => (text((await this.volume(ctx, region, id)) ?? undefined, 'status') === 'available' ? true : null));
    }
    await this.ensureAttached(ctx, region, p.vmId, volumeId);
  }

  async describe(ctx: OpContext, p: Placement): Promise<ObservedState> {
    this.authorize('describe');
    const region = p.providerRegion;
    const inst = await this.instance(ctx, region, p.vmId);
    const vol = p.volumeId ? await this.volume(ctx, region, p.volumeId) : null;
    return {
      vm: this.stateOf(inst),
      ...(text(inst ?? undefined, 'instanceType') ? { instanceType: text(inst ?? undefined, 'instanceType')! } : {}),
      ...(inst ? { rootVolumeGb: await this.rootVolumeSize(ctx, region, p.vmId) } : {}),
      publicAddresses: await this.publicAddresses(ctx, region, p),
      volumeAttached: !!vol && text(items(vol, 'attachmentSet')[0], 'instanceId') === p.vmId,
    };
  }

  async verifyEgress(ctx: OpContext, p: Placement): Promise<BindingCheck> {
    this.authorize('verifyEgress');
    const publicAddresses = await this.publicAddresses(ctx, p.providerRegion, p);
    const ok = publicAddresses.length === 1 && publicAddresses[0] === p.ipAddress;
    return {
      ok,
      expected: p.ipAddress,
      publicAddresses,
      ...(ok ? {} : { detail: `expected only ${p.ipAddress}, found [${publicAddresses.join(', ')}]` }),
    };
  }

  /** A missing association/dependency is not proof that the resource itself is gone. */
  private async deletionConfirmed(ctx: OpContext, region: string, kind: ResourceKind, providerId: string): Promise<boolean> {
    try {
      if (kind === 'vm') {
        const state = this.stateOf(await this.instance(ctx, region, providerId));
        return state === 'missing' || state === 'terminated';
      }
      if (kind === 'volume') {
        const volume = await this.volume(ctx, region, providerId);
        return !volume || text(volume, 'status') === 'deleted';
      }
      const describe = {
        network_interface: { action: 'DescribeNetworkInterfaces', set: 'networkInterfaceSet', params: { 'NetworkInterfaceId.1': providerId } },
        ip: { action: 'DescribeAddresses', set: 'addressesSet', params: { 'AllocationId.1': providerId } },
        snapshot: { action: 'DescribeSnapshots', set: 'snapshotSet', params: { 'SnapshotId.1': providerId } },
      }[kind];
      return !items(await this.read(ctx, region, describe.action, describe.params), describe.set).length;
    } catch (e) {
      if (isNotFound(e)) return true; // This Describe targeted the resource, not an association.
      throw e;
    }
  }

  async ensureDeleted(ctx: OpContext, region: string, kind: ResourceKind, providerId: string): Promise<void> {
    this.authorize('ensureDeleted');
    const managed = (t: Record<string, string>) => {
      if (t['cb:managed'] !== 'true' || t['cb:instance'] !== ctx.tags['cb:instance'] || t['cb:env'] !== ctx.tags['cb:env']) {
        throw new ExecutorError('forbidden', `${providerId} does not belong to this browser`);
      }
    };
    try {
      switch (kind) {
        case 'vm': {
          const inst = await this.instance(ctx, region, providerId);
          const state = this.stateOf(inst);
          if (state === 'missing') return;
          managed(tagsOf(inst!));
          if (state === 'terminated') return;
          if (state !== 'terminating') {
            await this.call(ctx, region, 'ModifyInstanceAttribute', { InstanceId: providerId, 'DisableApiTermination.Value': false });
            await this.call(ctx, region, 'TerminateInstances', { 'InstanceId.1': providerId });
          }
          await this.waitFor(ctx, `VM ${providerId} to terminate`, async () => await this.deletionConfirmed(ctx, region, kind, providerId) ? true : null);
          return;
        }
        case 'volume': {
          const vol = await this.volume(ctx, region, providerId);
          if (!vol) return;
          managed(tagsOf(vol));
          if (text(vol, 'status') === 'deleted') return;
          if (text(vol, 'status') !== 'deleting') await this.call(ctx, region, 'DeleteVolume', { VolumeId: providerId });
          await this.waitFor(ctx, `volume ${providerId} to be deleted`, async () => await this.deletionConfirmed(ctx, region, kind, providerId) ? true : null);
          return;
        }
        case 'network_interface': {
          const res = await this.read(ctx, region, 'DescribeNetworkInterfaces', { 'NetworkInterfaceId.1': providerId });
          const eni = items(res, 'networkInterfaceSet')[0];
          if (!eni) return;
          managed(tagsOf(eni));
          await this.call(ctx, region, 'DeleteNetworkInterface', { NetworkInterfaceId: providerId });
          await this.waitFor(ctx, `network interface ${providerId} to be deleted`, async () => await this.deletionConfirmed(ctx, region, kind, providerId) ? true : null);
          return;
        }
        case 'ip': {
          const res = await this.read(ctx, region, 'DescribeAddresses', { 'AllocationId.1': providerId });
          const addr = items(res, 'addressesSet')[0];
          if (!addr) return;
          managed(tagsOf(addr));
          const association = text(addr, 'associationId');
          if (association) await this.call(ctx, region, 'DisassociateAddress', { AssociationId: association });
          await this.call(ctx, region, 'ReleaseAddress', { AllocationId: providerId });
          await this.waitFor(ctx, `IP allocation ${providerId} to be released`, async () => await this.deletionConfirmed(ctx, region, kind, providerId) ? true : null);
          return;
        }
        case 'snapshot': {
          const res = await this.read(ctx, region, 'DescribeSnapshots', { 'SnapshotId.1': providerId });
          const snap = items(res, 'snapshotSet')[0];
          if (!snap) return;
          managed(tagsOf(snap));
          await this.call(ctx, region, 'DeleteSnapshot', { SnapshotId: providerId });
          await this.waitFor(ctx, `snapshot ${providerId} to be deleted`, async () => await this.deletionConfirmed(ctx, region, kind, providerId) ? true : null);
          return;
        }
      }
    } catch (e) {
      if (isNotFound(e)) {
        if (await this.deletionConfirmed(ctx, region, kind, providerId)) return;
        throw new ExecutorError('retryable', `${providerId} still exists after a missing dependency was reported`);
      }
      throw e;
    }
  }

  async listManaged(ctx: OpContext, region: string): Promise<ObservedResource[]> {
    this.authorize('listManaged');
    const f = filters({ 'tag:cb:managed': 'true', 'tag:cb:env': ctx.tags['cb:env'] });
    const out: ObservedResource[] = [];
    const add = (kind: ResourceKind, id: string | undefined, node: XmlNode, state: string, zone: string | null) => {
      if (id) {
        const sizeGb = kind === 'volume' ? Number(text(node, 'size')) : NaN;
        out.push({ providerId: id, kind, region, zone, state, tags: tagsOf(node), ...(Number.isInteger(sizeGb) && sizeGb > 0 ? { sizeGb } : {}) });
      }
    };
    // The five listings are independent: read them together rather than one after another.
    const [reservations, volumes, interfaces, addresses, snapshots] = await Promise.all([
      this.readAll(ctx, region, 'DescribeInstances', 'reservationSet', f),
      this.readAll(ctx, region, 'DescribeVolumes', 'volumeSet', f),
      this.readAll(ctx, region, 'DescribeNetworkInterfaces', 'networkInterfaceSet', f),
      this.readAll(ctx, region, 'DescribeAddresses', 'addressesSet', f),
      this.readAll(ctx, region, 'DescribeSnapshots', 'snapshotSet', { 'Owner.1': 'self', ...f }),
    ]);
    for (const r of reservations) {
      for (const i of items(r, 'instancesSet')) {
        const state = text(i, 'instanceState', 'name') ?? '';
        if (state !== 'terminated') add('vm', text(i, 'instanceId'), i, state, text(i, 'placement', 'availabilityZone') ?? null);
      }
    }
    for (const v of volumes) {
      // Include root disks: termination requests and DeleteOnTermination are asynchronous, so a
      // remaining root disk must still block confirmation that the browser's data is gone.
      add('volume', text(v, 'volumeId'), v, text(v, 'status') ?? '', text(v, 'availabilityZone') ?? null);
    }
    for (const n of interfaces) {
      add('network_interface', text(n, 'networkInterfaceId'), n, text(n, 'status') ?? '', text(n, 'availabilityZone') ?? null);
    }
    for (const a of addresses) {
      add('ip', text(a, 'allocationId'), a, text(a, 'associationId') ? 'associated' : 'allocated', null);
    }
    for (const s of snapshots) {
      add('snapshot', text(s, 'snapshotId'), s, text(s, 'status') ?? '', null);
    }
    return out;
  }

  async quotas(ctx: OpContext, region: string): Promise<QuotaSnapshot[]> {
    this.authorize('quotas');
    const out: QuotaSnapshot[] = [];
    const ipLimit = await this.ec2.serviceQuota(region, 'ec2', 'L-0263D0A3', ctx.deadline); // EC2-VPC Elastic IPs
    if (ipLimit !== null) {
      const used = (await this.readAll(ctx, region, 'DescribeAddresses', 'addressesSet', {})).length;
      out.push({ metric: 'static_ips', limit: ipLimit, used });
    }
    const cpuLimit = await this.ec2.serviceQuota(region, 'ec2', 'L-1216C47A', ctx.deadline); // Running On-Demand Standard vCPUs
    if (cpuLimit !== null) {
      let used = 0;
      for (const r of await this.readAll(ctx, region, 'DescribeInstances', 'reservationSet', filters({ 'instance-state-name': ['pending', 'running'] }))) {
        for (const i of items(r, 'instancesSet')) {
          used += Number(text(i, 'cpuOptions', 'coreCount') ?? 1) * Number(text(i, 'cpuOptions', 'threadsPerCore') ?? 2);
        }
      }
      out.push({ metric: 'vcpus', limit: cpuLimit, used });
    }
    return out;
  }

  /**
   * This region's prices from the AWS Price List API: on-demand Linux for every allowed instance
   * type, gp3 storage, EBS snapshots, an in-use public IPv4 address and data transfer out to the
   * internet (first paid tier). Throws if any of them is missing, so a partial sheet is never stored.
   * Premium is priced when the region offers it; a Premium type without a price leaves Premium
   * out of the sheet rather than making Basic unavailable.
   */
  async prices(ctx: OpContext, region: string, additionalInstanceTypes: string[] = []): Promise<ProviderPriceSheet> {
    this.authorize('prices');
    const cfg = this.region(region);
    const configuredTypes = tierMachines(cfg).instanceTypes;
    const premiumTypes = premiumOffered(cfg) ? tierMachines(cfg, 'premium').instanceTypes : [];
    const types = [...new Set([...configuredTypes, ...additionalInstanceTypes])];
    const dates: string[] = [];
    const price = (what: string, products: PriceListProduct[], match: (a: Record<string, string>) => boolean, unit: string): number => {
      for (const p of products.filter((x) => match(x.attributes))) {
        const d = p.onDemand.find((x) => x.unit === unit && Number(x.beginRange) === 0);
        if (d) {
          if (p.effectiveDate) dates.push(p.effectiveDate);
          return d.usd;
        }
      }
      throw new ExecutorError('invalid', `the AWS price list has no ${what} price for ${region}`);
    };
    const ends = (suffix: string) => (a: Record<string, string>) => (a.usagetype ?? '').endsWith(suffix);

    const instanceTypes: Record<string, number> = {};
    let machine: ProviderPriceSheet['machine'] = null;
    for (const [i, type] of types.entries()) {
      const products = await this.ec2.products(
        'AmazonEC2',
        { regionCode: region, instanceType: type, operatingSystem: 'Linux', tenancy: 'Shared', preInstalledSw: 'NA', capacitystatus: 'Used', licenseModel: 'No License required', operation: 'RunInstances' },
        ctx.deadline,
      );
      // Every configured type can be launched on a capacity fallback. A missing price for one
      // must make the sheet unavailable instead of silently allowing an unpriced VM.
      instanceTypes[type] = price(`${type} instance`, products, ends(`BoxUsage:${type}`), 'Hrs');
      if (i === 0) machine = machineOf(products.find((p) => ends(`BoxUsage:${type}`)(p.attributes))?.attributes);
    }
    let premium: ProviderPriceSheet['premium'] = null;
    try {
      for (const [i, type] of premiumTypes.entries()) {
        const products = await this.ec2.products(
          'AmazonEC2',
          { regionCode: region, instanceType: type, operatingSystem: 'Linux', tenancy: 'Shared', preInstalledSw: 'NA', capacitystatus: 'Used', licenseModel: 'No License required', operation: 'RunInstances' },
          ctx.deadline,
        );
        instanceTypes[type] = price(`${type} instance`, products, ends(`BoxUsage:${type}`), 'Hrs');
        if (i === 0) premium = { instanceType: type, vmHour: instanceTypes[type]!, machine: machineOf(products.find((p) => ends(`BoxUsage:${type}`)(p.attributes))?.attributes) ?? null };
      }
    } catch (e) {
      if (!(e instanceof ExecutorError && e.errorClass === 'invalid')) throw e;
      // Its fallbacks may also launch, so every one of them needs a price.
      for (const type of premiumTypes) if (!configuredTypes.includes(type) && !additionalInstanceTypes.includes(type)) delete instanceTypes[type];
      premium = null;
    }
    const storage = await this.ec2.products('AmazonEC2', { regionCode: region, productFamily: 'Storage', volumeApiName: 'gp3' }, ctx.deadline);
    const snapshots = await this.ec2.products('AmazonEC2', { regionCode: region, productFamily: 'Storage Snapshot', storageMedia: 'Amazon S3', locationType: 'AWS Region' }, ctx.deadline);
    const ips = await this.ec2.products('AmazonVPC', { regionCode: region, group: 'VPCPublicIPv4Address' }, ctx.deadline);
    const transfer = await this.ec2.products('AWSDataTransfer', { fromRegionCode: region, transferType: 'AWS Outbound', toLocation: 'External' }, ctx.deadline);
    const instanceType = types[0]!;
    return {
      source: 'aws-price-list',
      instanceType,
      vmHour: instanceTypes[instanceType]!,
      instanceTypes,
      machine,
      ...(premium ? { premium } : {}),
      volumeGbMonth: price('gp3 storage', storage, ends('EBS:VolumeUsage.gp3'), 'GB-Mo'),
      snapshotGbMonth: price('EBS snapshot', snapshots, ends('EBS:SnapshotUsage'), 'GB-Mo'),
      ipHour: price('public IPv4', ips, ends('PublicIPv4:InUseAddress'), 'Hrs'),
      transferOutGb: price('data transfer out', transfer, ends('DataTransfer-Out-Bytes'), 'GB'),
      rootVolumeGb: this.opts.rootVolumeGb ?? DEFAULT_ROOT_VOLUME_GB,
      effectiveDate: dates.sort().pop() ?? null,
    };
  }
}

export { Ec2Error };

/** Whether the region's configuration offers Premium (see tierMachines). */
function premiumOffered(cfg: AwsRegionConfig): boolean {
  return tierMachines(cfg, 'premium').instanceTypes.length > 0;
}

/** "2" and "4 GiB" from the price list's attributes. */
function machineOf(a: Record<string, string> | undefined): ProviderPriceSheet['machine'] {
  const vcpu = Number(a?.vcpu);
  const memoryGb = Number.parseFloat(a?.memory ?? '');
  return vcpu > 0 && memoryGb > 0 ? { vcpu, memoryGb } : null;
}
