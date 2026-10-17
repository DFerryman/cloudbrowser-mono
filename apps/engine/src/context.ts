import type { Db } from '@cloudbrowser/db';
import { schema } from '@cloudbrowser/db';
import type { Executor, ExecutorKind, OpContext, Placement, ResourceKind, ResourceTags } from '@cloudbrowser/executors';
import type { AgentBridge } from './agent.js';

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
  /** Sleeps between in-process retries; replaced in tests. */
  sleep(ms: number): Promise<void>;
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
