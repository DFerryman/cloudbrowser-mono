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

export type ExecutorKind = 'aws-ec2' | 'oci-compute' | 'fly-machines' | 'fake';

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

export interface OpContext {
  operationId: string;
  step: string;
  /** Deterministic idempotency token: `op_id:step:generation[:attempt]`. */
  token: string;
  /** Applied in the create call itself, so an untagged resource cannot exist. */
  tags: ResourceTags;
  /** Epoch ms after which the call should give up. */
  deadline: number;
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
  /** Ledger estimates in US cents per month for resources that bill while they exist. */
  monthlyCostCents: Partial<Record<ResourceKind, number>>;
  /** Estimated cost of one running VM hour, in US cents. */
  vmHourCents: number;
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
  zone: string;
  nicId: string;
  volumeId: string;
  /** Single-use agent bootstrap token; the only secret in user data. */
  bootstrapToken: string;
  gatewayUrl: string;
}

export interface VmRef {
  vmId: string;
  zone: string;
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

export type RunState = 'pending' | 'running' | 'stopping' | 'stopped' | 'terminated' | 'missing';

export interface ObservedState {
  vm: RunState;
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
  /** Creates the interface in an outbound-only subnet and associates the static IP with it. */
  ensureNetworkInterface(ctx: OpContext, region: string, ip: IpAllocation): Promise<NetworkInterfaceRef>;
  ensureVolume(ctx: OpContext, region: string, zone: string, sizeGb: number): Promise<VolumeRef>;
  ensureVm(ctx: OpContext, region: string, spec: VmSpec): Promise<VmRef>;
  /** Associates `allocationId` with the interface in place of whatever address it had. */
  associateIp(ctx: OpContext, region: string, nicId: string, ip: IpAllocation): Promise<void>;
  ensureRunning(ctx: OpContext, p: Placement): Promise<RunState>;
  /** Stop, never terminate. */
  ensureStopped(ctx: OpContext, p: Placement): Promise<RunState>;
  describe(ctx: OpContext, p: Placement): Promise<ObservedState>;
  /** Provider side: the static IP is the VM's only public address. */
  verifyEgress(ctx: OpContext, p: Placement): Promise<BindingCheck>;
  /** Reaper credentials only. Deleting something already gone succeeds. */
  ensureDeleted(ctx: OpContext, region: string, kind: ResourceKind, providerId: string): Promise<void>;

  // Used by the reconciler and the checks before create/start.
  listManaged(ctx: OpContext, region: string): Promise<ObservedResource[]>;
  quotas(ctx: OpContext, region: string): Promise<QuotaSnapshot[]>;
}
