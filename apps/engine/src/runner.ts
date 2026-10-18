import { OPERATION_STEPS, type OperationKind } from '@cloudbrowser/contracts';
import { eventRow, operationRow, raiseAlert, schema } from '@cloudbrowser/db';
import { ExecutorError, type ErrorClass, type ResourceKind } from '@cloudbrowser/executors';
import { and, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import {
  RestartFrom,
  StepFailed,
  type EngineDeps,
  type OperationRow,
  type StepEnv,
  type StepOutcome,
  type StepWait,
} from './context.js';
import { compensateChangeIp, HANDLERS } from './steps.js';

const { operations, operationSteps, browserInstances, regions, placements, events, auditLog } = schema;

const LEASE_MS = 60_000;
const MAX_RETRYABLE_ATTEMPTS = 8;
const CAPACITY_RETRY_MS = 60_000;

/** Status shown while an operation of each kind runs (page 2, "Instance lifecycle"). */
const TRANSITIONAL_STATUS: Partial<Record<OperationKind, string>> = {
  create: 'creating',
  start: 'starting',
  stop: 'stopping',
  delete: 'deleting',
  recover: 'starting',
};

/** A start that waited this long for capacity hands over to `recover` in another zone (page 10). */
const RECOVER_AFTER_MS = 30 * 60_000;

export type RunResult =
  | { state: 'succeeded' }
  | { state: 'failed'; reason: string }
  | { state: 'deferred'; notBefore: Date }
  | { state: 'busy' };

function backoffMs(attempt: number): number {
  const base = Math.min(2_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

function classify(e: unknown): ErrorClass | 'step_failed' {
  if (e instanceof StepFailed) return 'step_failed';
  if (e instanceof ExecutorError) return e.errorClass;
  // Our own infrastructure (e.g. a D1 hiccup) is retried like a provider 5xx.
  return 'retryable';
}

/**
 * Claims the operation with a lease and runs its remaining steps (page 10, "Journal, leases and
 * retries"). Safe to call concurrently and repeatedly: only one caller gets the lease, and steps
 * that already succeeded are skipped.
 */
export async function runOperation(deps: EngineDeps, operationId: string): Promise<RunResult> {
  const { db } = deps;
  const now = deps.now();

  const claimed = await db
    .update(operations)
    .set({
      leaseOwner: deps.workerId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      status: 'running',
      updatedAt: now,
    })
    .where(
      and(
        eq(operations.id, operationId),
        isNull(operations.finishedAt),
        or(isNull(operations.leaseExpiresAt), lt(operations.leaseExpiresAt, now)),
        or(isNull(operations.notBefore), lte(operations.notBefore, now)),
        // Only the reaper (with delete rights) runs purges, and it runs nothing else.
        deps.mode === 'reaper' ? eq(operations.kind, 'purge') : inArray(operations.kind, workerKinds()),
      ),
    )
    .returning();
  const op = claimed[0];
  if (!op) return { state: 'busy' };

  const env = await buildEnv(deps, op);
  if (!env) return fail(deps, op, null, 'invalid', 'Instance or region not found.');
  // A retried admin job or a stale queue delivery must never resurrect a permanently deleted
  // profile. The API checks the same boundary, but operation execution is a separate trust edge.
  if ((env.instance.status === 'purged' && op.kind !== 'purge') ||
      (env.instance.desiredState === 'deleted' && !['delete', 'purge', 'undelete'].includes(op.kind))) {
    return fail(deps, op, null, 'invalid_state', 'This browser has been deleted.');
  }

  if (now > op.deadlineAt) {
    // A start that ran out of time waiting for capacity moves the browser to another zone instead of failing.
    if (op.kind === 'start' && env.instance.status === 'waiting_capacity') return handOverToRecover(deps, op, env);
    return fail(deps, op, env, 'deadline', deadlineReason(op.kind as OperationKind));
  }

  const transitional = TRANSITIONAL_STATUS[op.kind as OperationKind];
  if (transitional && env.instance.status !== transitional && op.attempt === 0) {
    await setInstanceStatus(deps, env, transitional, null);
  }

  const steps = OPERATION_STEPS[op.kind as OperationKind] as readonly string[];
  const handlers = HANDLERS[op.kind];
  if (!handlers || steps.length === 0) return fail(deps, op, env, 'invalid', `Operation ${op.kind} is not supported yet.`);

  const journal = await db.select().from(operationSteps).where(eq(operationSteps.operationId, op.id));
  const done = new Map(journal.map((j) => [j.step, j]));

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const entry = done.get(step);
    if (entry?.status === 'succeeded') {
      env.results[step] = entry.result ?? {};
      continue;
    }

    const token = env.ctx(step).token;
    const at = deps.now();
    await db.batch([
      db
        .insert(operationSteps)
        .values({ operationId: op.id, step, status: 'started', requestToken: token, attempts: 1, updatedAt: at })
        .onConflictDoUpdate({
          target: [operationSteps.operationId, operationSteps.step],
          set: { status: 'started', attempts: (entry?.attempts ?? 0) + 1, updatedAt: at },
        }),
      db
        .update(operations)
        .set({ step, updatedAt: at, leaseExpiresAt: new Date(at.getTime() + LEASE_MS) })
        .where(eq(operations.id, op.id)),
      db.insert(events).values(eventRow(env.instance.userId, 'operation.updated', { operationId: op.id, instanceId: op.instanceId }, at)),
    ]);
    deps.notify(env.instance.userId);
    op.step = step;

    let outcome: StepOutcome;
    try {
      outcome = await handlers[step]!(env);
    } catch (e) {
      if (e instanceof RestartFrom) {
        const from = steps.indexOf(e.step);
        const reset = steps.slice(from, i + 1);
        await db
          .delete(operationSteps)
          .where(and(eq(operationSteps.operationId, op.id), inArray(operationSteps.step, reset)));
        for (const s of reset) {
          delete env.results[s];
          done.delete(s);
        }
        env.round += 1;
        op.params = { ...(op.params ?? {}), round: env.round };
        await db.update(operations).set({ params: op.params }).where(eq(operations.id, op.id));
        i = from - 1;
        continue;
      }
      return handleError(deps, op, env, step, e);
    }

    if ('wait' in outcome) return defer(deps, op, (outcome as StepWait).wait, op.attempt);

    const stepResult = outcome.result ?? {};
    env.results[step] = stepResult;
    await db
      .update(operationSteps)
      .set({ status: 'succeeded', result: stepResult, updatedAt: deps.now() })
      .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.step, step)));
  }

  const at = deps.now();
  await db.batch([
    db
      .update(operations)
      .set({ status: 'succeeded', finishedAt: at, updatedAt: at, leaseOwner: null, leaseExpiresAt: null, error: null, errorClass: null })
      .where(eq(operations.id, op.id)),
    db.insert(events).values(eventRow(env.instance.userId, 'operation.updated', { operationId: op.id, instanceId: op.instanceId }, at)),
    db.insert(auditLog).values({
      actor: deps.mode === 'reaper' ? 'reaper' : 'engine',
      action: `operation.${op.kind}.succeeded`,
      target: `instance:${op.instanceId}`,
      detail: { operationId: op.id },
      createdAt: at,
    }),
  ]);
  deps.notify(env.instance.userId);
  return { state: 'succeeded' };
}

function workerKinds(): string[] {
  return Object.keys(OPERATION_STEPS).filter((k) => k !== 'purge');
}

async function buildEnv(deps: EngineDeps, op: OperationRow): Promise<StepEnv | null> {
  const { db } = deps;
  const [instance] = await db.select().from(browserInstances).where(eq(browserInstances.id, op.instanceId));
  if (!instance) return null;
  const [region] = await db.select().from(regions).where(eq(regions.id, instance.regionId));
  if (!region) return null;
  const [placement] = await db
    .select()
    .from(placements)
    .where(and(eq(placements.instanceId, instance.id), eq(placements.status, 'current')));
  const executorKind = (placement?.executor ?? region.executor) as Parameters<EngineDeps['executor']>[0];
  const executor = deps.executor(executorKind);
  const round = Number((op.params as { round?: number } | null)?.round ?? 0);

  const env: StepEnv = {
    deps,
    op,
    instance,
    region,
    executor,
    agent: deps.agent(executorKind),
    placement: placement ?? null,
    results: {},
    round,
    ctx(step, extra) {
      const generation = env.placement?.generation ?? 1;
      return {
        operationId: op.id,
        step,
        token: `${op.id}:${step}:${generation}${extra ? `:${extra}` : ''}`,
        tags: env.tags('vm', generation),
        // Wall-clock deadline for the provider call: at most 2 minutes, never past the operation's.
        deadline: Date.now() + Math.max(0, Math.min(120_000, op.deadlineAt.getTime() - deps.now().getTime())),
      };
    },
    tags(kind: ResourceKind, generation: number) {
      return {
        'cb:managed': 'true',
        'cb:env': deps.envName,
        'cb:instance': instance.id,
        'cb:op': op.id,
        'cb:gen': String(generation),
        'cb:kind': kind,
      };
    },
  };
  return env;
}

async function setInstanceStatus(deps: EngineDeps, env: StepEnv, status: string, reason: string | null) {
  const { db } = deps;
  const at = deps.now();
  await db.batch([
    db
      .update(browserInstances)
      .set({ status, statusReason: reason, updatedAt: at })
      .where(eq(browserInstances.id, env.instance.id)),
    db.insert(events).values(eventRow(env.instance.userId, 'instance.updated', { instanceId: env.instance.id }, at)),
  ]);
  deps.notify(env.instance.userId);
  env.instance.status = status;
}

async function defer(deps: EngineDeps, op: OperationRow, waitMs: number, attempt: number): Promise<RunResult> {
  const at = deps.now();
  const notBefore = new Date(at.getTime() + waitMs);
  await deps.db
    .update(operations)
    .set({ status: 'waiting', notBefore, attempt, leaseOwner: null, leaseExpiresAt: null, updatedAt: at })
    .where(eq(operations.id, op.id));
  return { state: 'deferred', notBefore };
}

async function handleError(deps: EngineDeps, op: OperationRow, env: StepEnv, step: string, e: unknown): Promise<RunResult> {
  const cls = classify(e);
  const message = e instanceof Error ? e.message : String(e);
  const { db } = deps;
  await db
    .update(operationSteps)
    .set({ status: 'failed', result: { error: message, errorClass: cls }, updatedAt: deps.now() })
    .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.step, step)));
  await db.update(operations).set({ error: message, errorClass: cls }).where(eq(operations.id, op.id));

  switch (cls) {
    case 'retryable':
    case 'unknown_outcome': {
      // An unknown outcome is resolved by lookup: the retried step calls an idempotent ensure*
      // method with the same token, which finds the resource instead of creating another.
      const attempt = op.attempt + 1;
      if (attempt > MAX_RETRYABLE_ATTEMPTS) return fail(deps, op, env, cls, 'Too many provider errors. We have been alerted.');
      return defer(deps, op, backoffMs(attempt), attempt);
    }
    case 'capacity': {
      // Honest state, never "Running" (page 10, rule 6). After 30 minutes the start ends and
      // `recover` brings the browser up in another zone of the same region, with the same IP.
      if (op.kind === 'start' && deps.now().getTime() - op.createdAt.getTime() > RECOVER_AFTER_MS) {
        return handOverToRecover(deps, op, env);
      }
      if (env.instance.status !== 'waiting_capacity') {
        await setInstanceStatus(deps, env, 'waiting_capacity', `${env.region.name} is short of capacity right now.`);
      }
      return defer(deps, op, CAPACITY_RETRY_MS, op.attempt + 1);
    }
    case 'outage': {
      if (env.instance.status !== 'provider_issue') {
        await setInstanceStatus(deps, env, 'provider_issue', `Our cloud provider in ${env.region.name} is having problems.`);
      }
      return defer(deps, op, CAPACITY_RETRY_MS, op.attempt + 1);
    }
    case 'step_failed':
      return fail(deps, op, env, cls, message);
    case 'quota':
    case 'forbidden':
    case 'invalid':
      // These stop at once and alert (page 10, "Retries").
      await raiseAlert(
        deps.db,
        {
          source: deps.mode,
          severity: 'critical',
          title: `${cls} error in ${op.kind} (${env.region.id})`,
          detail: { operationId: op.id, instanceId: op.instanceId, message },
          dedupeKey: `op:${cls}:${op.kind}:${env.region.id}`,
        },
        deps.now(),
      );
      return fail(
        deps,
        op,
        env,
        cls,
        cls === 'quota' ? `New browsers are temporarily unavailable in ${env.region.name}.` : 'Something went wrong on our side. We have been alerted.',
      );
  }
}

async function handOverToRecover(deps: EngineDeps, op: OperationRow, env: StepEnv): Promise<RunResult> {
  const { db } = deps;
  const at = deps.now();
  const recover = operationRow({ instanceId: op.instanceId, userId: op.userId, kind: 'recover', params: { reason: 'capacity', after: op.id }, now: at });
  await db.batch([
    db
      .update(operations)
      .set({ status: 'failed', finishedAt: at, updatedAt: at, leaseOwner: null, leaseExpiresAt: null, errorClass: 'capacity', error: 'Handed over to recover.' })
      .where(eq(operations.id, op.id)),
    db.insert(operations).values(recover),
    db.insert(auditLog).values({
      actor: 'engine',
      action: 'operation.start.recover',
      target: `instance:${op.instanceId}`,
      detail: { operationId: op.id, recoverId: recover.id },
      createdAt: at,
    }),
    db.insert(events).values(eventRow(env.instance.userId, 'operation.updated', { operationId: recover.id, instanceId: op.instanceId }, at)),
  ]);
  deps.notify(env.instance.userId);
  return { state: 'failed', reason: 'Handed over to recover.' };
}

function deadlineReason(kind: OperationKind): string {
  return kind === 'create' ? 'Creating this browser took too long.' : 'This took too long. We have been alerted.';
}

/**
 * Ends an operation for good. A failed create becomes Failed (the reaper cleans up, since no user
 * data exists yet). An existing instance is never set to Failed: it shows Needs attention and its
 * data is never deleted automatically (page 10, "States shown to users").
 */
async function fail(
  deps: EngineDeps,
  op: OperationRow,
  env: StepEnv | null,
  errorClass: string,
  reason: string,
): Promise<RunResult> {
  const { db } = deps;
  if (env && op.kind === 'purge') await raiseAlert(db, {
    source: 'reaper', severity: 'critical', title: `Browser cleanup incomplete: ${op.instanceId}`,
    detail: { instanceId: op.instanceId, operationId: op.id, errorClass, reason }, dedupeKey: `cleanup:${op.instanceId}`,
  }, deps.now());
  if (env && op.kind === 'change_ip') {
    try {
      await compensateChangeIp(env);
    } catch (e) {
      reason = `${reason} Restoring the previous IP also failed.`;
      void e;
    }
  }
  const at = deps.now();
  let instanceStatus: string | null = null;
  if (env) {
    if (op.kind === 'create') instanceStatus = 'failed';
    // A failed resize leaves the browser as it was (the volume keeps its size); it is reported, not shown as a problem.
    else if (op.kind === 'delete') instanceStatus = 'deleting';
    else if (op.kind === 'change_ip' || op.kind === 'purge' || op.kind === 'resize_volume') instanceStatus = null;
    else instanceStatus = 'needs_attention';
  }
  const stmts = [
    db
      .update(operations)
      .set({ status: 'failed', finishedAt: at, updatedAt: at, leaseOwner: null, leaseExpiresAt: null, error: reason, errorClass })
      .where(eq(operations.id, op.id)),
    db.insert(auditLog).values({
      actor: deps.mode === 'reaper' ? 'reaper' : 'engine',
      action: `operation.${op.kind}.failed`,
      target: `instance:${op.instanceId}`,
      detail: { operationId: op.id, errorClass, reason, step: op.step },
      createdAt: at,
    }),
  ] as const;
  if (env) {
    const extra = [
      db.insert(events).values(eventRow(env.instance.userId, 'operation.updated', { operationId: op.id, instanceId: op.instanceId }, at)),
      ...(instanceStatus
        ? [
            db
              .update(browserInstances)
              .set({ status: instanceStatus, statusReason: reason, updatedAt: at })
              .where(eq(browserInstances.id, op.instanceId)),
            db.insert(events).values(eventRow(env.instance.userId, 'instance.updated', { instanceId: op.instanceId }, at)),
          ]
        : []),
    ];
    await db.batch([...stmts, ...extra]);
    deps.notify(env.instance.userId);
  } else {
    await db.batch(stmts);
  }
  return { state: 'failed', reason };
}
