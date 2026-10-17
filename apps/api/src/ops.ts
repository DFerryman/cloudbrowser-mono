import type { OperationKind } from '@cloudbrowser/contracts';
import { eventRow, operationRow, schema, type Db } from '@cloudbrowser/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Context } from 'hono';
import type { AppEnv } from './env.js';
import { problem } from './problem.js';

const { operations, idempotencyKeys, events } = schema;

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
    .select({ id: operations.id })
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
    before?: BatchItem<'sqlite'>[];
    after?: BatchItem<'sqlite'>[];
  },
) {
  const db = c.get('db');
  const user = c.get('user');
  const now = new Date();
  const op = operationRow({ instanceId: input.instanceId, userId: user.id, kind: input.kind, params: input.params, now });
  const stmts: BatchItem<'sqlite'>[] = [
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
    throw e;
  }
  dispatch(c, op.id);
  notifyUser(c, user.id);
  return { operationId: op.id, instanceId: input.instanceId };
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
