import type { OperationKind } from '@cloudbrowser/contracts';
import { eventRow, operationRow, schema, type Db } from '@cloudbrowser/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Context } from 'hono';
import type { AppEnv } from './env.js';
import { problem } from './problem.js';
import { resizeAdmission, resizeQuota } from './storage.js';

const { operations, idempotencyKeys, events, browserInstances, agentCommands, auditLog } = schema;

export function requireIdempotencyKey(c: Context<AppEnv>): string {
  const key = c.req.header('idempotency-key')?.trim();
  if (!key || key.length > 200) throw problem(400, 'idempotency_key_required');
  return key;
}

/** Returns the earlier result for a repeated Idempotency-Key, or null if the key is new. */
export async function replayed(db: Db, userId: string, key: string, route: string) {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
  if (!row) return null;
  if (row.route !== route) throw problem(422, 'idempotency_key_reused');
  return { operationId: row.operationId, instanceId: row.instanceId };
}

async function unfinishedOperation(db: Db, instanceId: string) {
  const [op] = await db
    .select()
    .from(operations)
    .where(and(eq(operations.instanceId, instanceId), isNull(operations.finishedAt)));
  return op ?? null;
}

/**
 * Records the operation, the idempotency key, any extra writes and the change event in one
 * atomic batch (stands in for "operation row and pg-boss job in one transaction", page 2), then
 * asks the engine to start on it.
 */
export async function enqueueOperation(
  c: Context<AppEnv>,
  input: {
    instanceId: string;
    kind: OperationKind;
    key: string | null;
    route: string;
    params?: Record<string, unknown>;
    /** Stop and permanent delete supersede work whose outcome the user no longer wants. */
    priority?: 'delete' | 'stop';
    before?: BatchItem<'sqlite'>[];
    after?: BatchItem<'sqlite'>[];
  },
) {
  const db = c.get('db');
  const user = c.get('user');
  if (input.priority) return enqueuePriorityOperation(c, input);
  const now = new Date();
  const op = operationRow({ instanceId: input.instanceId, userId: user.id, kind: input.kind, params: input.params, now });
  const stmts: BatchItem<'sqlite'>[] = [
    db.insert(auditLog).values({
      // Admission can race a deletion after the route read its instance. Make a stale start,
      // restore or recovery fail in the same transaction as its desired-state writes.
      actor: sql`CASE WHEN ((${input.kind === 'create' ? 1 : 0} = 1 AND NOT EXISTS (SELECT 1 FROM browser_instances WHERE id = ${input.instanceId})) OR EXISTS (SELECT 1 FROM browser_instances WHERE id = ${input.instanceId} AND user_id = ${user.id} AND status != 'purged' AND (desired_state != 'deleted' OR (${input.kind === 'undelete' ? 1 : 0} = 1 AND purge_after > ${now.getTime()})))) AND ${input.kind === 'resize_volume' ? resizeAdmission(input.instanceId, now) : sql`1`} THEN ${`user:${user.id}`} ELSE NULL END`,
      action: 'operation.requested', target: `instance:${input.instanceId}`, detail: { operationId: op.id, kind: input.kind }, createdAt: now,
    }),
    ...(input.before ?? []),
    db.insert(operations).values(op),
    ...(input.after ?? []),
    db.insert(events).values(eventRow(user.id, 'instance.updated', { instanceId: input.instanceId, operationId: op.id }, now)),
  ];
  if (input.key) {
    stmts.push(
      db.insert(idempotencyKeys).values({
        userId: user.id,
        key: input.key,
        route: input.route,
        operationId: op.id,
        instanceId: input.instanceId,
        createdAt: now,
      }),
    );
  }
  try {
    await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  } catch (e) {
    // A concurrent request with the same key won the race: answer like it did.
    if (input.key) {
      const again = await replayed(db, user.id, input.key, input.route);
      if (again) return again;
    }
    const running = await unfinishedOperation(db, input.instanceId);
    if (running) throw problem(409, 'operation_in_progress', undefined, { operationId: running.id });
    const [live] = await db.select({ desiredState: browserInstances.desiredState, status: browserInstances.status, purgeAfter: browserInstances.purgeAfter }).from(browserInstances).where(eq(browserInstances.id, input.instanceId));
    if (live && (live.status === 'purged' || (live.desiredState === 'deleted' && !(input.kind === 'undelete' && live.purgeAfter && live.purgeAfter > new Date())))) throw problem(409, 'invalid_state', 'This browser has been deleted.');
    if (input.kind === 'resize_volume' && await resizeQuota(db, input.instanceId)) throw problem(409, 'invalid_state', 'Storage allows four resize attempts per rolling 24 hours.');
    throw e;
  }
  dispatch(c, op.id);
  notifyUser(c, user.id);
  return { operationId: op.id, instanceId: input.instanceId };
}

type EnqueueInput = Parameters<typeof enqueueOperation>[1];
const PROVIDER_DRAIN_MS = 125_000;

/**
 * Stop/delete are user intent, rather than another job behind an indefinitely waiting create.
 * Cancelling the old operation and recording the new one is one D1 transaction; the partial
 * unique index resolves competing requests. Workers fence against the cancelled row before
 * every provider call, while drainUntil covers a request AWS had already accepted.
 */
async function enqueuePriorityOperation(c: Context<AppEnv>, input: EnqueueInput) {
  const db = c.get('db');
  const user = c.get('user');
  if (input.kind !== input.priority) throw problem(400, 'validation_failed');
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [owner] = await db.select({ userId: browserInstances.userId, desiredState: browserInstances.desiredState, status: browserInstances.status }).from(browserInstances).where(eq(browserInstances.id, input.instanceId));
    if (!owner || owner.userId !== user.id) throw problem(404, 'not_found');
    if (input.key) {
      const earlier = await replayed(db, user.id, input.key, input.route);
      if (earlier) return earlier;
    }
    let old = await unfinishedOperation(db, input.instanceId);
    const deletedIntent = owner.desiredState === 'deleted' || ['deleting', 'purged'].includes(owner.status);
    // The worker's delete may already be finished while the reaper has yet to release resources.
    // Such a browser remains deleted; a late stop is only an acknowledgment of that stronger intent.
    if (input.priority === 'stop' && deletedIntent && !['delete', 'purge'].includes(old?.kind ?? '')) {
      const [deletion] = await db.select().from(operations).where(and(eq(operations.instanceId, input.instanceId), inArray(operations.kind, ['delete', 'purge']))).orderBy(desc(operations.createdAt)).limit(1);
      if (!deletion) throw problem(409, 'invalid_state', 'This browser has been deleted.');
      old = deletion;
    }
    const now = new Date();
    const deleting = old?.kind === 'delete' || old?.kind === 'purge';
    const sameTarget = old?.kind === input.kind && old.deadlineAt > now && !['failed', 'canceled'].includes(old.status);
    // A permanent delete upgrades a legacy soft delete; a stop may never replace any deletion.
    const mergeFinishedDelete = input.priority === 'stop' && deletedIntent && deleting;
    const merge = old && (old.kind === 'purge' || (input.priority === 'stop' && deleting) ||
      (sameTarget && (input.priority !== 'delete' || old.params?.purgeNow === true)));
    if (merge && old) {
      const current = old;
      try {
        const stmts: BatchItem<'sqlite'>[] = [
          // If the old row finished or was superseded since the read, this NOT NULL check fails
          // and rolls the whole batch back. In particular, stale stop requests cannot undo delete.
          db.insert(auditLog).values({
            actor: sql`CASE WHEN EXISTS (SELECT 1 FROM operations WHERE id = ${current.id} AND (finished_at IS NULL OR ${mergeFinishedDelete ? 1 : 0} = 1)) AND EXISTS (SELECT 1 FROM browser_instances WHERE id = ${input.instanceId} AND user_id = ${user.id} ${!deleting ? sql`AND desired_state != 'deleted' AND status NOT IN ('deleting', 'purged')` : sql``}) THEN ${`user:${user.id}`} ELSE NULL END`,
            action: 'operation.request_coalesced', target: `instance:${input.instanceId}`,
            detail: { operationId: current.id, requested: input.kind }, createdAt: now,
          }),
          ...(!deleting || input.priority === 'delete' ? input.before ?? [] : []),
          ...(!deleting || input.priority === 'delete' ? input.after ?? [] : []),
          db.insert(events).values(eventRow(user.id, 'instance.updated', { instanceId: input.instanceId, operationId: current.id }, now)),
        ];
        if (input.key) stmts.push(db.insert(idempotencyKeys).values({ userId: user.id, key: input.key, route: input.route, operationId: current.id, instanceId: input.instanceId, createdAt: now }));
        await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
        dispatch(c, current.id);
        notifyUser(c, user.id);
        return { operationId: current.id, instanceId: input.instanceId };
      } catch (e) {
        lastError = e;
        continue;
      }
    }
    const params = { ...(input.params ?? {}) };
    if (old) {
      params.preemptedOperationId = old.id;
      const priorDrain = typeof old.params?.drainUntil === 'number' ? old.params.drainUntil : 0;
      const drainUntil = Math.max(priorDrain, old.leaseOwner ? old.updatedAt.getTime() + PROVIDER_DRAIN_MS : 0);
      if (drainUntil > now.getTime()) params.drainUntil = drainUntil;
      const resume = old.params?.resumeCreateFrom ?? (old.kind === 'create' ? old.id : undefined);
      if (typeof resume === 'string' && resume) params.resumeCreateFrom = resume;
    }
    const op = operationRow({ instanceId: input.instanceId, userId: user.id, kind: input.kind, params, now });
    const stmts: BatchItem<'sqlite'>[] = [];
    if (input.priority === 'stop') stmts.push(db.insert(auditLog).values({
      // Stop's earlier read may race all the way through a complete delete. Fence the acceptance
      // transaction itself, not just the uniqueness of unfinished operation rows.
      actor: sql`CASE WHEN EXISTS (SELECT 1 FROM browser_instances WHERE id = ${input.instanceId} AND user_id = ${user.id} AND desired_state != 'deleted' AND status NOT IN ('deleting', 'purged')) THEN ${`user:${user.id}`} ELSE NULL END`,
      action: 'operation.priority_requested', target: `instance:${input.instanceId}`, detail: { operationId: op.id, kind: input.kind }, createdAt: now,
    }));
    if (old) stmts.push(
      db.update(operations).set({
        status: 'canceled', finishedAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null, errorClass: 'superseded', error: `Cancelled by a newer ${input.kind} request.`,
        // Read the actual lease inside the cancellation transaction. The worker can acquire its
        // lease after our initial read, and any request it just submitted still needs to drain.
        params: sql`json_set(COALESCE(${operations.params}, '{}'), '$.preemptionDrainUntil', max(COALESCE(json_extract(${operations.params}, '$.drainUntil'), 0), CASE WHEN ${operations.leaseOwner} IS NOT NULL THEN max(${operations.updatedAt} + ${PROVIDER_DRAIN_MS}, ${now.getTime()}) ELSE 0 END))`,
      }).where(and(eq(operations.id, old.id), isNull(operations.finishedAt))),
      db.update(agentCommands).set({ status: 'failed', completedAt: now, reply: { error: 'Operation cancelled by a newer browser action.' } }).where(and(eq(agentCommands.instanceId, input.instanceId), isNull(agentCommands.completedAt), sql`substr(${agentCommands.id}, 1, ${old.id.length + 1}) = ${`${old.id}:`}`)),
    );
    stmts.push(
      ...(input.before ?? []),
      db.insert(operations).values({ ...op, ...(old ? { params: sql`json_set(${JSON.stringify(params)}, '$.drainUntil', max(COALESCE((SELECT json_extract(params, '$.preemptionDrainUntil') FROM operations WHERE id = ${old.id}), 0), ${typeof params.drainUntil === 'number' ? params.drainUntil : 0}))` } : {}) }),
      ...(input.after ?? []),
      db.insert(events).values(eventRow(user.id, 'instance.updated', { instanceId: input.instanceId, operationId: op.id }, now)),
    );
    if (input.key) stmts.push(db.insert(idempotencyKeys).values({ userId: user.id, key: input.key, route: input.route, operationId: op.id, instanceId: input.instanceId, createdAt: now }));
    try {
      await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
      dispatch(c, op.id);
      notifyUser(c, user.id);
      return { operationId: op.id, instanceId: input.instanceId };
    } catch (e) {
      lastError = e;
    }
  }
  if (input.key) {
    const earlier = await replayed(db, user.id, input.key, input.route);
    if (earlier) return earlier;
  }
  const running = await unfinishedOperation(db, input.instanceId);
  if (running) throw problem(409, 'operation_in_progress', undefined, { operationId: running.id });
  throw lastError;
}

/**
 * Hands the operation to the engine through Cloudflare Queues. The send happens after the D1 batch
 * commits; if it is lost, the engine's 1-minute cron sweep runs the operation anyway.
 */
function dispatch(c: Context<AppEnv>, operationId: string) {
  c.executionCtx.waitUntil(c.env.OPERATIONS.send({ operationId }).catch((e) => console.error('enqueue failed', operationId, e)));
}

/** Wakes the user's EventHub so open SSE streams read the new `events` rows now. */
export function notifyUser(c: Context<AppEnv>, userId: string) {
  const stub = c.env.EVENT_HUB.get(c.env.EVENT_HUB.idFromName(userId));
  c.executionCtx.waitUntil(
    stub.fetch(`https://hub/notify?userId=${encodeURIComponent(userId)}`, { method: 'POST' }).catch((e) => console.error('notify failed', e)),
  );
}

/**
 * An operation started by the system or an operator rather than a user request (billing, /admin).
 * Same atomic batch as `enqueueOperation`, with an audit row naming the actor. Throws 409
 * `operation_in_progress` if the browser already has an unfinished operation.
 */
export async function systemOperation(
  env: AppEnv['Bindings'],
  db: Db,
  input: {
    instanceId: string;
    userId: string;
    kind: OperationKind;
    actor: string;
    auditDetail?: Record<string, unknown>;
    params?: Record<string, unknown>;
    before?: BatchItem<'sqlite'>[];
  },
  now = new Date(),
): Promise<string> {
  const op = operationRow({ instanceId: input.instanceId, userId: null, kind: input.kind, params: input.params, now });
  try {
    const stmts: BatchItem<'sqlite'>[] = [
      db.insert(schema.auditLog).values({
        // Operator and billing actions have the same read/acceptance race as user actions.
        // Only deletion/cleanup can run after permanent intent has been recorded.
        actor: sql`CASE WHEN EXISTS (SELECT 1 FROM browser_instances WHERE id = ${input.instanceId} AND user_id = ${input.userId} AND (${['delete', 'purge'].includes(input.kind) ? 1 : 0} = 1 OR (status != 'purged' AND (desired_state != 'deleted' OR (${input.kind === 'undelete' ? 1 : 0} = 1 AND purge_after > ${now.getTime()}))))) THEN ${input.actor} ELSE NULL END`,
        action: `operation.${input.kind}`,
        target: `instance:${input.instanceId}`,
        detail: { operationId: op.id, ...(input.params ?? {}), ...(input.auditDetail ?? {}) },
        createdAt: now,
      }),
      ...(input.before ?? []),
      db.insert(operations).values(op),
      db.insert(events).values(eventRow(input.userId, 'instance.updated', { instanceId: input.instanceId, operationId: op.id }, now)),
    ];
    await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  } catch (e) {
    const running = await unfinishedOperation(db, input.instanceId);
    if (running) throw problem(409, 'operation_in_progress', undefined, { operationId: running.id });
    const [live] = await db.select({ desiredState: browserInstances.desiredState, status: browserInstances.status, purgeAfter: browserInstances.purgeAfter }).from(browserInstances).where(eq(browserInstances.id, input.instanceId));
    if (live && !['delete', 'purge'].includes(input.kind) && (live.status === 'purged' || (live.desiredState === 'deleted' && !(input.kind === 'undelete' && live.purgeAfter && live.purgeAfter > now)))) throw problem(409, 'invalid_state', 'This browser has been deleted.');
    throw e;
  }
  await env.OPERATIONS.send({ operationId: op.id }).catch((e) => console.error('enqueue failed', op.id, e)); // the engine's sweep is the backstop
  return op.id;
}
