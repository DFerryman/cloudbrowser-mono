/**
 * Provider adapters behind one interface (page 10, "Executor interface").
 *
 * Pure library: no access to our database, no business rules, no knowledge of users or plans.
 * The calling process passes in its own credential mode (runtime, reaper or read-only).
 *
 * Compared with the plan's sketch, `ensureCreated` is split into the per-resource methods the
 * create step journal calls one by one (allocate IP, network interface, volume, VM), so each step
 * has its own idempotency token and lookup.
 */
import type { ProviderPriceSheet } from '@cloudbrowser/contracts';

export type { ProviderPriceSheet };

/** AWS EC2 is the only provider; `fake` is the in-memory simulator for local runs and tests. */
export type ExecutorKind = 'aws-ec2' | 'fake';

/** Which credentials the process holds (page 10, "Credentials and guardrails"). */
export type CredentialMode = 'runtime' | 'reaper' | 'readonly';

export type ErrorClass =
  | 'retryable' // throttling, 5xx, connection reset before the request was sent
  | 'unknown_outcome' // timeout after the request was sent: look up before retrying
  | 'capacity' // no capacity for this shape or zone
  | 'quota' // provider limit reached
  | 'outage' // provider API or region impaired
  | 'forbidden' // permission denied: guardrail or misconfiguration
  | 'invalid'; // our bug: bad request

/** Every provider error is classified before it leaves the executor. */
export class ExecutorError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutorError';
  }
}

/**
 * The provider accepted a launch, but the VM ended before it ran (AWS: terminated while pending,
 * with a state reason). Retrying with the same idempotency token would only return the same
 * dead VM, so the caller must use a new token for the next launch.
 */
export class LaunchFailed extends ExecutorError {
  constructor(
    errorClass: ErrorClass,
    readonly vmId: string,
    readonly zone: string | null,
    /** Provider reason code, e.g. `Server.InsufficientInstanceCapacity`. */
    readonly reasonCode: string | null,
    message: string,
  ) {
    super(errorClass, message);
    this.name = 'LaunchFailed';
  }
}

export interface OpContext {
  operationId: string;
  step: string;
  /** Deterministic idempotency token: `op_id:step:generation[:attempt]`. */
  token: string;
  /** Applied in the create call itself, so an untagged resource cannot exist. */
  tags: ResourceTags;
  /** Epoch ms after which the call should give up. */
  deadline: number;
  /**
   * Confirms the calling operation still owns its lease and the browser's current intent.
   * Called again at provider request boundaries, including after waits. A rejection must pass
   * through unchanged so cancellation is never retried as a provider failure.
   */
  assertActive?: () => Promise<void>;
}

export type ResourceKind = 'vm' | 'volume' | 'network_interface' | 'ip' | 'snapshot';

export type ResourceTags = {
  'cb:managed': 'true';
  'cb:env': string;
  'cb:instance': string;
  'cb:op': string;
  'cb:gen': string;
  'cb:kind'?: ResourceKind;
} & Record<string, string>;

export interface Capabilities {
  zonalVolumes: boolean;
  nativeIdempotency: boolean;
  /** Whether a static IP can move to a replacement VM (needed by `recover`). */
  movableIp: boolean;
}

export interface IpAllocation {
  allocationId: string;
  address: string;
}

export interface NetworkInterfaceRef {
  nicId: string;
  zone: string;
}

export interface VolumeRef {
  volumeId: string;
  zone: string;
  sizeGb: number;
}

export interface VmSpec {
  /** Our instance id, written to user data with the gateway URL and the bootstrap token. */
  instanceId: string;
  zone: string;
  nicId: string;
  volumeId: string;
  /** Single-use agent bootstrap token; the only secret in user data. */
  bootstrapToken: string;
  gatewayUrl: string;
  /** IANA timezone of the region; the browser's clock uses it. */
  timezone?: string;
  /** Maximum VM price in USD/hour confirmed for this operation; applies only to a new launch. */
  maxVmHour?: number;
  /** Current provider prices for all configured launch candidates, never an estimated fallback. */
  instanceTypePrices?: Record<string, number>;
}

/** Where a volume size change stands: `ready` once the new size can be used (AWS: optimizing or completed). */
export interface ResizeState {
  state: 'pending' | 'ready';
  sizeGb: number;
}

export interface SnapshotRef {
  snapshotId: string;
  sizeGb: number;
}

export interface VmRef {
  vmId: string;
  zone: string;
  /** Actual type selected by the provider, including capacity fallbacks. */
  instanceType?: string;
  /** Actual system disk size; separate from the browser's data volume. */
  rootVolumeGb?: number;
}

export interface Placement {
  providerRegion: string;
  zone: string;
  vmId: string;
  volumeId: string;
  nicId: string;
  ipAllocationId: string;
  ipAddress: string;
}

export type RunState = 'pending' | 'running' | 'stopping' | 'stopped' | 'terminating' | 'terminated' | 'missing';

export interface ObservedState {
  vm: RunState;
  /** Present for an existing VM; lets older placements recover their actual type. */
  instanceType?: string;
  rootVolumeGb?: number;
  publicAddresses: string[];
  volumeAttached: boolean;
}

export interface BindingCheck {
  ok: boolean;
  expected: string;
  publicAddresses: string[];
  detail?: string;
}

export interface ObservedResource {
  providerId: string;
  kind: ResourceKind;
  region: string;
  zone: string | null;
  state: string;
  tags: Record<string, string>;
  /** Actual provisioned size from the provider inventory, when this is a volume. */
  sizeGb?: number;
}

export interface QuotaSnapshot {
  metric: 'static_ips' | 'vcpus' | 'volumes';
  limit: number;
  used: number;
}

export interface Executor {
  readonly kind: ExecutorKind;
  readonly capabilities: Capabilities;

  // Every method converges to the requested state and is safe to call again with the same token.
  allocateIp(ctx: OpContext, region: string): Promise<IpAllocation>;
  /** Availability zones a placement may use in a region (recover moves to another one). */
  zones(region: string): string[];
  /** Load dynamically discovered network and machine configuration before planning/pricing. */
  prepareRegion?(region: string): Promise<void>;
  /**
   * Creates the interface in an outbound-only subnet of `zone` (default: the first zone) and
   * associates the static IP with it. If the IP was associated elsewhere, it moves here: this is
   * how `recover` keeps the same IP on a new VM (page 10).
   */
  ensureNetworkInterface(ctx: OpContext, region: string, ip: IpAllocation, zone?: string): Promise<NetworkInterfaceRef>;
  ensureVolume(ctx: OpContext, region: string, zone: string, sizeGb: number): Promise<VolumeRef>;
  ensureVm(ctx: OpContext, region: string, spec: VmSpec): Promise<VmRef>;
  /** Associates `allocationId` with the interface in place of whatever address it had. */
  associateIp(ctx: OpContext, region: string, nicId: string, ip: IpAllocation): Promise<void>;
  ensureRunning(ctx: OpContext, p: Placement): Promise<RunState>;
  /** Stop, never terminate. */
  ensureStopped(ctx: OpContext, p: Placement): Promise<RunState>;
  /** Provider snapshot of a data volume (page 4: daily, and before a Chrome major upgrade). */
  snapshot(ctx: OpContext, region: string, volumeId: string): Promise<SnapshotRef>;
  /** A new encrypted volume from a snapshot, in `zone`. */
  ensureVolumeFromSnapshot(ctx: OpContext, region: string, zone: string, snapshotId: string, sizeGb: number): Promise<VolumeRef>;
  /**
   * Grows a volume to `sizeGb` (never shrinks). Safe to call repeatedly: it starts the change once
   * and then reports its progress.
   */
  resizeVolume(ctx: OpContext, region: string, volumeId: string, sizeGb: number): Promise<ResizeState>;
  /** Detaches the current data volume of a stopped VM and attaches `volumeId` instead. */
  swapVolume(ctx: OpContext, p: Placement, volumeId: string): Promise<void>;
  describe(ctx: OpContext, p: Placement): Promise<ObservedState>;
  /** Provider side: the static IP is the VM's only public address. */
  verifyEgress(ctx: OpContext, p: Placement): Promise<BindingCheck>;
  /** Reaper credentials only. Deleting something already gone succeeds. */
  ensureDeleted(ctx: OpContext, region: string, kind: ResourceKind, providerId: string): Promise<void>;

  // Used by the reconciler and the checks before create/start.
  listManaged(ctx: OpContext, region: string): Promise<ObservedResource[]>;
  quotas(ctx: OpContext, region: string): Promise<QuotaSnapshot[]>;
  /** Stable identity for settings that affect the default machine and its provider price sheet. */
  pricingConfigKey(region: string): string;
  /**
   * What this region costs, from the provider's price list (never a built-in number). Additional
   * types price existing VMs; they do not become launch candidates.
   */
  prices(ctx: OpContext, region: string, additionalInstanceTypes?: string[]): Promise<ProviderPriceSheet>;
}
