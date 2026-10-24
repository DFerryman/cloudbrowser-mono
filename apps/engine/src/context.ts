import type { Db } from '@cloudbrowser/db';
import { schema } from '@cloudbrowser/db';
import type { Executor, ExecutorKind, OpContext, Placement, ResourceKind, ResourceTags } from '@cloudbrowser/executors';
import type { AgentBridge } from './agent.js';
import type { ArchiveStore } from './archives.js';

export type OperationRow = typeof schema.operations.$inferSelect;
export type InstanceRow = typeof schema.browserInstances.$inferSelect;
export type RegionRow = typeof schema.regions.$inferSelect;
export type PlacementRow = typeof schema.placements.$inferSelect;

/** Which credentials this process holds: the long-running worker never holds delete rights. */
export type EngineMode = 'worker' | 'reaper';

export interface EngineDeps {
  db: Db;
  mode: EngineMode;
  /** Executors built with this process's credentials (runtime for worker, reaper for reaper). */
  executor(kind: ExecutorKind): Executor;
  agent(kind: ExecutorKind): AgentBridge;
  /** Value of the `cb:env` tag (prod, staging, trial, dev). */
  envName: string;
  gatewayUrl: string;
  workerId: string;
  now(): Date;
  /** Tells the user's EventHub (Durable Object) that new rows are in the `events` feed. */
  notify(userId: string): void;
  /** Derives single-use agent bootstrap tokens (Worker secret BOOTSTRAP_SECRET). */
  bootstrapSecret: string;
  /** Waits between polls in synchronous calls such as an on-demand IP check. */
  sleep(ms: number): Promise<void>;
  /** Archive backups in S3 (the browser's region) or R2; null when neither is configured (archives are skipped). */
  archives: ArchiveStore | null;
  /** Wraps per-instance archive keys (Worker secret ARCHIVE_MASTER_KEY); null disables archives. */
  archiveMasterKey: string | null;
  /** Deletes an archive object by its location: in S3 with the AWS credentials, in R2 through the binding (reaper). */
  deleteArchive?: (location: string) => Promise<void>;
}

/** The step asks to be called again later without counting as a failure (e.g. waiting for the agent). */
export interface StepWait {
  wait: number;
  reason?: string;
}

export type StepOutcome = { result?: Record<string, unknown> } | StepWait;

/** Re-run the operation from an earlier step, e.g. allocate another IP after screening rejected one. */
export class RestartFrom extends Error {
  constructor(
    readonly step: string,
    readonly reason: string,
  ) {
    super(`restart from ${step}: ${reason}`);
  }
}

/** An obsolete worker must stop without compensation or changing the replacement job. */
export class OperationSuperseded extends Error {
  constructor() { super('This operation was superseded by a newer browser action.'); }
}

/** A permanent failure with a reason that is safe to show to the user. */
export class StepFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface StepEnv {
  deps: EngineDeps;
  op: OperationRow;
  instance: InstanceRow;
  region: RegionRow;
  executor: Executor;
  agent: AgentBridge;
  /** The current placement generation, if one exists. */
  placement: PlacementRow | null;
  /** Results of the steps that already succeeded, by step name. */
  results: Record<string, Record<string, unknown>>;
  /** Increments each time the operation restarts from an earlier step. */
  round: number;
  assertActive(): Promise<void>;
  ctx(step: string, extra?: string): OpContext;
  tags(kind: ResourceKind, generation: number): ResourceTags;
}

export function placementRef(p: PlacementRow): Placement {
  return {
    providerRegion: p.providerRegion,
    zone: p.zone ?? '',
    vmId: p.vmId ?? '',
    volumeId: p.volumeId ?? '',
    nicId: p.networkId ?? '',
    ipAllocationId: p.ipAllocationId ?? '',
    ipAddress: p.ipAddress ?? '',
  };
}

/** A context for read-only provider calls outside an operation (IP checks, reconciler). */
export function readContext(purpose: string, envName: string): OpContext {
  return {
    operationId: purpose,
    step: purpose,
    token: purpose,
    tags: { 'cb:managed': 'true', 'cb:env': envName, 'cb:instance': '-', 'cb:op': purpose, 'cb:gen': '0' },
    deadline: Date.now() + 30_000,
  };
}
