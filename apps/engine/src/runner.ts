import { NEVER_SLEEP_TIMEOUT_S, OPERATION_STEPS, type OperationKind } from '@cloudbrowser/contracts';
import { eventRow, operationRow, raiseAlert, schema } from '@cloudbrowser/db';
import { ExecutorError, isRegionDenial, ProviderFailed, type ErrorClass, type ResourceKind } from '@cloudbrowser/executors';
import { and, eq, inArray, isNull, lt, lte, or, sql, type SQLWrapper } from 'drizzle-orm';
import {
  RestartFrom,
  OperationSuperseded,
  StepFailed,
  type EngineDeps,
  type OperationRow,
  type StepEnv,
  type StepOutcome,
  type StepWait,
} from './context.js';
import { abandonRecover, discoverInstanceResources, HANDLERS, saveParams } from './steps.js';
import { operationFence } from './fencing.js';
import { assertOperationFunded } from './prepaid.js';

const { operations, operationSteps, browserInstances, regions, placements, events, auditLog, instanceHealth, userNotices } = schema;

/** Stops the user did not ask for and auto-sleep did not decide: the user is emailed (page 6). */
const NOTIFIED_STOP_REASONS = new Set(['operator', 'suspended', 'frozen']);
const IDLE_STOP_CANCELED = 'The browser is no longer idle under its current sleep setting.';

/**
 * A browser that needs attention cannot be used, so it sleeps after its idle timeout like a
 * running one, and even with Never sleep after this long: its VM would otherwise keep running,
 * unused, until someone noticed.
 */
export const NEEDS_ATTENTION_IDLE_S = 3600;

/**
 * SQL over `browser_instances b`: the browser sleeps when idle, the idle timeout in seconds that
 * applies to it now, and when it began to need attention (0 otherwise). Its idle time counts from
 * then at the earliest, so the user has the whole timeout to see why and act on it.
 */
export const sleepsWhenIdle = sql`(b.status = 'needs_attention' OR (b.status = 'running' AND b.idle_timeout_s <> ${NEVER_SLEEP_TIMEOUT_S}))`;
export const idleTimeoutS = sql`(CASE WHEN b.status = 'needs_attention' AND b.idle_timeout_s = ${NEVER_SLEEP_TIMEOUT_S} THEN ${NEEDS_ATTENTION_IDLE_S} ELSE b.idle_timeout_s END)`;
export const attentionSince = sql`(CASE WHEN b.status = 'needs_attention' THEN ${attentionStarted(sql`b.id`)} ELSE 0 END)`;

/** When a browser last failed in a way that leaves it needing attention: an operation, or an IP check. */
export function attentionStarted(instanceId: SQLWrapper) {
  return sql<number>`coalesce((SELECT max(a.created_at) FROM audit_log a WHERE a.target = 'instance:' || ${instanceId}
    AND (a.action = 'ip.check_failed' OR a.action LIKE 'operation.%.failed')), 0)`;
}

// Provider calls can last two minutes. A shorter lease lets a second worker overlap them.
const LEASE_MS = 3 * 60_000;
/** Provider errors in a row before an operation fails; waits for capacity or an outage do not count. */
const MAX_RETRYABLE_ATTEMPTS = 8;
const CAPACITY_RETRY_MS = 60_000;
/** Parameters the engine writes while it runs one operation (see steps.ts); never a request's. */
const RUN_STATE = ['retries', 'ipCheckTry', 'bootStartedAt', 'restartStoppedAt', 'resumedVm', 'previousAgent'];

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
  | { state: 'busy' }
  | { state: 'canceled' };

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
  try { return await runOwnedOperation(deps, operationId); }
  catch (e) { if (e instanceof OperationSuperseded) return { state: 'canceled' }; throw e; }
}

async function runOwnedOperation(deps: EngineDeps, operationId: string): Promise<RunResult> {
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
    // The reason tells the user we have been alerted (a failed purge alerts on its own).
    if (op.kind !== 'create' && op.kind !== 'purge') await raiseAlert(deps.db, {
      source: deps.mode, severity: 'critical', title: `${op.kind} ran out of time (${env.region.id})`,
      detail: { operationId: op.id, instanceId: op.instanceId, step: op.step }, dedupeKey: `op:deadline:${op.kind}:${env.region.id}`,
    }, now);
    return fail(deps, op, env, 'deadline', deadlineReason(op.kind as OperationKind));
  }

  const steps = OPERATION_STEPS[op.kind as OperationKind] as readonly string[];
  const handlers = HANDLERS[op.kind];
  // A retired kind (e.g. change_ip) queued by an older API ends before any step and leaves the browser as it is.
  if (!handlers || steps.length === 0) return fail(deps, op, null, 'invalid', 'This action is no longer available.');

  await env.assertActive();
  // An operator's retry copies the failed operation's parameters, with what the engine kept while
  // running it: the retry starts with its own error count, boot clock and restart state.
  if (op.step === null && op.attempt === 0 && RUN_STATE.some((k) => op.params?.[k] !== undefined)) {
    op.params = Object.fromEntries(Object.entries(op.params ?? {}).filter(([k]) => !RUN_STATE.includes(k)));
    await db.update(operations).set({ params: op.params }).where(and(eq(operations.id, op.id), operationFence(env)));
  }
  const transitional = TRANSITIONAL_STATUS[op.kind as OperationKind];
  if (op.kind === 'stop' && op.params?.reason === 'idle' && op.attempt === 0 && ['running', 'needs_attention'].includes(env.instance.status)) {
    if (!(await beginIdleStop(deps, env))) return { state: 'canceled' };
  } else if (transitional && env.instance.status !== transitional && op.attempt === 0) {
    // A start from Needs attention is a restart, also when an operator retries one: its VM may
    // still run, with an agent that will not report ready again (see ensure_running).
    if (op.kind === 'start' && env.instance.status === 'needs_attention' && op.params?.restart !== true) await saveParams(env, { restart: true });
    await setInstanceStatus(deps, env, transitional, null);
  }

  const journal = await db.select().from(operationSteps).where(eq(operationSteps.operationId, op.id));
  if (op.kind === 'create' && typeof op.params?.resumeCreateFrom === 'string') {
    const resumeFrom = op.params.resumeCreateFrom;
    const [source] = await db.select({ instanceId: operations.instanceId, kind: operations.kind, params: operations.params }).from(operations).where(eq(operations.id, resumeFrom));
    if (!source || source.instanceId !== op.instanceId || source.kind !== 'create') return fail(deps, op, env, 'invalid', 'The saved creation does not belong to this browser.');
    // Resumed steps use the saved creation's tokens, including its zone move and relaunch count.
    for (const key of ['zoneAttempt', 'launch', 'avoidZones']) {
      if (op.params?.[key] === undefined && source.params?.[key] !== undefined) op.params = { ...op.params, [key]: source.params[key] };
    }
    const saved = await db.select().from(operationSteps).where(and(eq(operationSteps.operationId, resumeFrom), eq(operationSteps.status, 'succeeded')));
    // Once this resumed create moved zones or relaunched, the saved creation's interface, disk
    // and VM belong to the old attempt: never bring them back in place of the new one.
    const attempt = (p: Record<string, unknown> | null | undefined, key: string) => Number(p?.[key] ?? 0);
    const moved = attempt(op.params, 'zoneAttempt') !== attempt(source.params, 'zoneAttempt');
    const relaunched = moved || attempt(op.params, 'launch') !== attempt(source.params, 'launch');
    const stale = (step: string) => (moved && ['create_nic', 'create_volume'].includes(step)) || (relaunched && step === 'create_vm');
    // Refresh bootstrap validity and agent verification; the resumed VM must authenticate after this wake.
    for (const row of saved) if (['allocate_ip', 'screen_ip', 'create_nic', 'create_volume', 'create_vm'].includes(row.step) && !stale(row.step) && !journal.some((j) => j.step === row.step)) journal.push(row);
  }
  const done = new Map(journal.map((j) => [j.step, j]));

  for (let i = 0; i < steps.length; i++) {
    await env.assertActive();
    const step = steps[i]!;
    const entry = done.get(step);
    if (entry?.status === 'succeeded') {
      env.results[step] = entry.result ?? {};
      continue;
    }

    // A step that asked to be called again (waiting for the agent, a reply, a volume) is already
    // journaled as started: polling it again changes nothing the user or the journal shows, so it
    // writes nothing (assertActive above keeps the lease).
    if (entry?.status !== 'started' || op.step !== step) {
      const token = env.ctx(step).token;
      const at = deps.now();
      try { await db.batch([
        db
          .insert(operationSteps)
          .values({ operationId: op.id, step, status: 'started', requestToken: token, attempts: 1, updatedAt: at })
          .onConflictDoUpdate({
            target: [operationSteps.operationId, operationSteps.step],
            set: { status: 'started', attempts: (entry?.attempts ?? 0) + 1, updatedAt: at },
          }),
        db
          .update(operations)
          .set({ step, updatedAt: at, leaseExpiresAt: new Date(at.getTime() + LEASE_MS), kind: sql`case when ${operationFence(env)} then ${op.kind} else null end` })
          .where(eq(operations.id, op.id)),
        db.insert(events).values(eventRow(env.instance.userId, 'operation.updated', { operationId: op.id, instanceId: op.instanceId }, at)),
      ]); } catch (e) { await env.assertActive(); throw e; }
      deps.notify(env.instance.userId);
      op.step = step;
    }

    let outcome: StepOutcome;
    try {
      await env.assertActive();
      await assertOperationFunded(env);
      outcome = await handlers[step]!(env);
      await env.assertActive();
    } catch (e) {
      if (e instanceof OperationSuperseded) throw e;
      await env.assertActive();
      if (e instanceof RestartFrom) {
        const from = steps.indexOf(e.step);
        const reset = steps.slice(from, i + 1);
        await db
          .delete(operationSteps)
          .where(and(eq(operationSteps.operationId, op.id), inArray(operationSteps.step, reset), operationFence(env)));
        for (const s of reset) {
          delete env.results[s];
          done.delete(s);
        }
        env.round += 1;
        op.params = { ...(op.params ?? {}), round: env.round };
        await db.update(operations).set({ params: op.params }).where(and(eq(operations.id, op.id), operationFence(env)));
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
      .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.step, step), operationFence(env)));
    // The step got through: provider errors count from zero again, and after a wait for capacity
    // or a provider the browser shows what the operation is doing (the last step sets the final status).
    if (Number(op.params?.retries ?? 0) > 0) await saveParams(env, { retries: 0 });
    if (transitional && i < steps.length - 1 && ['waiting_capacity', 'provider_issue'].includes(env.instance.status)) {
      await setInstanceStatus(deps, env, transitional, null);
    }
  }

  await env.assertActive();
  const at = deps.now();
  const finished = await db.update(operations)
    .set({ status: 'succeeded', finishedAt: at, updatedAt: at, leaseOwner: null, leaseExpiresAt: null, error: null, errorClass: null })
    .where(and(eq(operations.id, op.id), operationFence(env))).returning({ id: operations.id });
  if (!finished.length) throw new OperationSuperseded();
  await db.batch([
    db.insert(events).values(eventRow(env.instance.userId, 'operation.updated', { operationId: op.id, instanceId: op.instanceId }, at)),
    db.insert(auditLog).values({
      actor: deps.mode === 'reaper' ? 'reaper' : 'engine',
      action: `operation.${op.kind}.succeeded`,
      target: `instance:${op.instanceId}`,
      detail: { operationId: op.id },
      createdAt: at,
    }),
    ...(op.kind === 'stop' && NOTIFIED_STOP_REASONS.has(String(op.params?.reason))
      ? [db.insert(userNotices).values({ id: `stop:${op.id}`, userId: env.instance.userId, kind: 'stopped', instanceId: op.instanceId,
        data: { name: env.instance.name, reason: op.params?.reason }, createdAt: at }).onConflictDoNothing()]
      : []),
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
  await executor.prepareRegion?.(placement?.providerRegion ?? region.providerRegion);
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
    async assertActive() {
      const owned = await db.update(operations).set({ leaseExpiresAt: new Date(deps.now().getTime() + LEASE_MS), updatedAt: deps.now() })
        .where(and(eq(operations.id, op.id), operationFence(env))).returning({ id: operations.id });
      if (!owned.length) throw new OperationSuperseded();
      const [current] = await db.select({ desiredState: browserInstances.desiredState, status: browserInstances.status }).from(browserInstances).where(eq(browserInstances.id, instance.id));
      if (!current || (current.status === 'purged' && op.kind !== 'purge') ||
          (current.desiredState === 'deleted' && !['delete', 'purge', 'undelete'].includes(op.kind)) ||
          (current.desiredState === 'stopped' && ['create', 'start', 'recover'].includes(op.kind))) {
        await db.update(operations).set({ status: 'canceled', finishedAt: deps.now(), updatedAt: deps.now(), leaseOwner: null, leaseExpiresAt: null, errorClass: 'superseded', error: 'A newer browser intent superseded this operation.' })
          .where(and(eq(operations.id, op.id), operationFence(env)));
        throw new OperationSuperseded();
      }
    },
    ctx(step, extra) {
      const generation = env.placement?.generation ?? 1;
      return {
        operationId: op.id,
        step,
        token: `${op.kind === 'create' && typeof op.params?.resumeCreateFrom === 'string' ? op.params.resumeCreateFrom : op.id}:${step}:${generation}${extra ? `:${extra}` : ''}`,
        assertActive: async () => { await env.assertActive(); await assertOperationFunded(env); },
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
  // Agents also perform asynchronous IO. Their durable command writes are independently fenced.
  const bridge = env.agent;
  env.agent = new Proxy(bridge, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => { await env.assertActive(); if (key === 'send') await assertOperationFunded(env); const result = await value.apply(target, args); await env.assertActive(); return result; };
  } });
  return env;
}

/**
 * An idle stop is decided by the scheduler and runs later, so the user may use the browser or
 * change the timeout in between. The full current idle deadline is checked in the transaction that starts the
 * stop: either the browser shows stopping and the stop runs, or the stop is canceled and the
 * browser keeps running with its intent restored. A change saved after that applies to the next run.
 */
async function beginIdleStop(deps: EngineDeps, env: StepEnv): Promise<boolean> {
  const { db } = deps;
  const at = deps.now();
  const { op, instance } = env;
  const baseline = op.params?.idleLastActiveAt;
  const captured = Object.prototype.hasOwnProperty.call(op.params ?? {}, 'idleLastActiveAt')
    && (baseline === null || (typeof baseline === 'number' && Number.isSafeInteger(baseline)));
  // requestStop settles billing at createdAt, which also writes last_active_at. Only substitute
  // the captured baseline while that exact accounting stamp remains current; honor any later
  // activity normally. Old queued jobs lack this proof, so cancel them and let a fresh cron decide.
  const lastActive = sql`CASE WHEN b.last_active_at = ${op.createdAt.getTime()} THEN ${captured ? baseline ?? 0 : 0} ELSE coalesce(b.last_active_at, 0) END`;
  const stillIdle = sql`EXISTS (SELECT 1 FROM browser_instances b LEFT JOIN instance_health h ON h.instance_id = b.id
    WHERE b.id = ${instance.id} AND b.desired_state = 'stopped' AND ${sleepsWhenIdle}
    AND ${captured ? 1 : 0} = 1
    AND max(${lastActive}, coalesce(h.last_input_at, 0), ${attentionSince}) + ${idleTimeoutS} * 1000 <= ${at.getTime()})`;
  const canceledHere = sql`EXISTS (SELECT 1 FROM operations WHERE id = ${op.id} AND status = 'canceled' AND finished_at = ${at.getTime()} AND error = ${IDLE_STOP_CANCELED})`;
  const [, started] = await db.batch([
    db.update(operations).set({ status: 'canceled', finishedAt: at, updatedAt: at, leaseOwner: null, leaseExpiresAt: null, errorClass: 'superseded', error: IDLE_STOP_CANCELED })
      .where(and(eq(operations.id, op.id), operationFence(env), sql`NOT ${stillIdle}`)),
    db.update(browserInstances).set({ status: 'stopping', statusReason: null, updatedAt: at })
      .where(and(eq(browserInstances.id, instance.id), operationFence(env), stillIdle)).returning({ id: browserInstances.id }),
    db.update(browserInstances).set({ desiredState: 'running', updatedAt: at })
      .where(and(eq(browserInstances.id, instance.id), eq(browserInstances.desiredState, 'stopped'), canceledHere)),
    db.insert(events).values(eventRow(instance.userId, 'instance.updated', { instanceId: instance.id, operationId: op.id }, at)),
  ]);
  deps.notify(instance.userId);
  if (!started.length) return false;
  env.instance.status = 'stopping';
  return true;
}

async function setInstanceStatus(deps: EngineDeps, env: StepEnv, status: string, reason: string | null) {
  const { db } = deps;
  const at = deps.now();
  await db.batch([
    db
      .update(browserInstances)
      .set({ status, statusReason: reason, updatedAt: at })
      .where(and(eq(browserInstances.id, env.instance.id), operationFence(env))),
    db.insert(events).values(eventRow(env.instance.userId, 'instance.updated', { instanceId: env.instance.id }, at)),
  ]);
  deps.notify(env.instance.userId);
  env.instance.status = status;
}

async function defer(deps: EngineDeps, op: OperationRow, waitMs: number, attempt: number, params?: Record<string, unknown>): Promise<RunResult> {
  const at = deps.now();
  const notBefore = new Date(at.getTime() + waitMs);
  if (params) op.params = { ...(op.params ?? {}), ...params };
  await deps.db
    .update(operations)
    .set({ status: 'waiting', notBefore, attempt, ...(params ? { params: op.params } : {}), leaseOwner: null, leaseExpiresAt: null, updatedAt: at })
    .where(and(eq(operations.id, op.id), operationFence({ deps, op }))).returning({ id: operations.id });
  const [current] = await deps.db.select({ finishedAt: operations.finishedAt }).from(operations).where(eq(operations.id, op.id));
  if (!current || current.finishedAt) return { state: 'canceled' };
  return { state: 'deferred', notBefore };
}

async function handleError(deps: EngineDeps, op: OperationRow, env: StepEnv, step: string, e: unknown): Promise<RunResult> {
  await env.assertActive();
  const cls = classify(e);
  const message = e instanceof Error ? e.message : String(e);
  const { db } = deps;
  await db
    .update(operationSteps)
    .set({ status: 'failed', result: { error: message, errorClass: cls }, updatedAt: deps.now() })
    .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.step, step), operationFence(env)));
  await db.update(operations).set({ error: message, errorClass: cls }).where(and(eq(operations.id, op.id), operationFence(env)));

  switch (cls) {
    case 'retryable':
    case 'unknown_outcome': {
      // An unknown outcome is resolved by lookup: the retried step calls an idempotent ensure*
      // method with the same token, which finds the resource instead of creating another.
      // Only errors in a row count: a step that gets through starts the count again.
      const retries = Number(op.params?.retries ?? 0) + 1;
      if (retries > MAX_RETRYABLE_ATTEMPTS) {
        await raiseAlert(deps.db, {
          source: deps.mode, severity: 'critical', title: `Repeated provider errors in ${op.kind} (${env.region.id})`,
          detail: { operationId: op.id, instanceId: op.instanceId, step, message }, dedupeKey: `op:retries:${op.kind}:${env.region.id}`,
        }, deps.now());
        return fail(deps, op, env, cls, 'Too many provider errors. We have been alerted.');
      }
      return defer(deps, op, backoffMs(retries), op.attempt + 1, { retries });
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
        cls === 'quota'
          ? `New browsers are temporarily unavailable in ${env.region.name}.`
          : cls === 'forbidden' && (e instanceof ProviderFailed || isRegionDenial(e))
            ? `${env.region.name} is unavailable while we fix a provider configuration problem. We have been alerted.`
            : 'Something went wrong on our side. We have been alerted.',
      );
  }
}

async function handOverToRecover(deps: EngineDeps, op: OperationRow, env: StepEnv): Promise<RunResult> {
  const { db } = deps;
  await env.assertActive();
  const at = deps.now();
  const recover = operationRow({ instanceId: op.instanceId, userId: op.userId, kind: 'recover', params: { reason: 'capacity', after: op.id }, now: at });
  try {
    await db.batch([
      // NOT NULL is a transactional assertion: if another intent won, do not insert its recovery.
      db.insert(auditLog).values({
        actor: sql`case when ${operationFence(env)} and exists(select 1 from browser_instances where id = ${op.instanceId} and desired_state = 'running') then 'engine' else null end`,
        action: 'operation.start.recover', target: `instance:${op.instanceId}`, detail: { operationId: op.id, recoverId: recover.id }, createdAt: at,
      }),
      db.update(operations)
        .set({ status: 'failed', finishedAt: at, updatedAt: at, leaseOwner: null, leaseExpiresAt: null, errorClass: 'capacity', error: 'Handed over to recover.' })
        .where(and(eq(operations.id, op.id), operationFence(env))),
      db.insert(operations).values(recover),
      db.insert(events).values(eventRow(env.instance.userId, 'operation.updated', { operationId: recover.id, instanceId: op.instanceId }, at)),
    ]);
  } catch (e) { await env.assertActive(); throw e; }
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
  if (env) await env.assertActive();
  if (env && op.kind === 'purge') await raiseAlert(db, {
    source: 'reaper', severity: 'critical', title: `Browser cleanup incomplete: ${op.instanceId}`,
    detail: { instanceId: op.instanceId, operationId: op.id, errorClass, reason }, dedupeKey: `cleanup:${op.instanceId}`,
  }, deps.now());
  const at = deps.now();
  let instanceStatus: string | null = null;
  if (env) {
    if (op.kind === 'create') instanceStatus = 'failed';
    // A failed resize leaves the browser as it was (the volume keeps its size); it is reported, not shown as a problem.
    else if (op.kind === 'delete') instanceStatus = 'deleting';
    else if (op.kind === 'purge' || op.kind === 'resize_volume') instanceStatus = null;
    else instanceStatus = 'needs_attention';
  }
  const stmts = [
    db
      .update(operations)
      .set({ status: 'failed', finishedAt: at, updatedAt: at, leaseOwner: null, leaseExpiresAt: null, error: reason, errorClass })
      .where(and(eq(operations.id, op.id), operationFence({ deps, op }))),
    db.insert(auditLog).values({
      actor: deps.mode === 'reaper' ? 'reaper' : 'engine',
      action: `operation.${op.kind}.failed`,
      target: `instance:${op.instanceId}`,
      detail: { operationId: op.id, errorClass, reason, step: op.step },
      createdAt: at,
    }),
  ] as const;
  if (env) {
    if (op.kind === 'recover') {
      // A lost create response would leave its resource out of the cleanup; the listing is best
      // effort, since the operation must end even while the provider is failing.
      await discoverInstanceResources(env, op.instanceId).catch((e: unknown) => console.error('recover cleanup could not list provider resources', op.id, e));
    }
    const extra = [
      ...(op.kind === 'create' ? [db.update(schema.browserReservations).set({ reservedMicros: 0, updatedAt: at }).where(and(eq(schema.browserReservations.instanceId, op.instanceId), operationFence(env)))] : []),
      ...(op.kind === 'recover' ? await abandonRecover(env, op, at) : []),
      db.insert(events).values(eventRow(env.instance.userId, 'operation.updated', { operationId: op.id, instanceId: op.instanceId }, at)),
      ...(instanceStatus
        ? [
            db
              .update(browserInstances)
              .set({ status: instanceStatus, statusReason: reason, updatedAt: at })
              .where(and(eq(browserInstances.id, op.instanceId), operationFence(env))),
            db.insert(events).values(eventRow(env.instance.userId, 'instance.updated', { instanceId: op.instanceId }, at)),
          ]
        : []),
    ];
    await db.batch([extra[0]!, ...extra.slice(1), ...stmts]);
    deps.notify(env.instance.userId);
  } else {
    await db.batch(stmts);
  }
  return { state: 'failed', reason };
}
