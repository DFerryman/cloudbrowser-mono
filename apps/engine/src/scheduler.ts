import { eventRow, operationRow, schema } from '@cloudbrowser/db';
import type { ExecutorKind } from '@cloudbrowser/executors';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { placementRef, readContext, type EngineDeps } from './context.js';
import { runOperation } from './runner.js';

const { operations, browserInstances, instanceHealth, viewerSessions, placements, events, auditLog } = schema;

/** Runs every operation that is due and not leased by another worker. */
export async function runPending(deps: EngineDeps, limit = 20): Promise<number> {
  const now = deps.now();
  const due = await deps.db
    .select({ id: operations.id })
    .from(operations)
    .where(
      and(
        isNull(operations.finishedAt),
        or(isNull(operations.notBefore), lte(operations.notBefore, now)),
        or(isNull(operations.leaseExpiresAt), lt(operations.leaseExpiresAt, now)),
        deps.mode === 'reaper' ? eq(operations.kind, 'purge') : sql`${operations.kind} <> 'purge'`,
      ),
    )
    .orderBy(asc(operations.createdAt))
    .limit(limit);
  let ran = 0;
  for (const { id } of due) {
    const r = await runOperation(deps, id);
    if (r.state !== 'busy') ran++;
  }
  return ran;
}

/**
 * Puts running browsers to sleep after `idle_timeout` without input (page 2, flow C). Viewer
 * heartbeats carry whether there was input since the last one.
 */
export async function idleStops(deps: EngineDeps): Promise<string[]> {
  const { db } = deps;
  const now = deps.now();
  const running = await db
    .select({
      id: browserInstances.id,
      userId: browserInstances.userId,
      idleTimeoutS: browserInstances.idleTimeoutS,
      lastActiveAt: browserInstances.lastActiveAt,
      lastInputAt: instanceHealth.lastInputAt,
    })
    .from(browserInstances)
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
    .where(eq(browserInstances.status, 'running'));

  const busy = new Set(
    (
      await db
        .select({ instanceId: operations.instanceId })
        .from(operations)
        .where(isNull(operations.finishedAt))
    ).map((r) => r.instanceId),
  );

  const stopped: string[] = [];
  for (const inst of running) {
    if (busy.has(inst.id)) continue;
    const last = Math.max(inst.lastActiveAt?.getTime() ?? 0, inst.lastInputAt?.getTime() ?? 0);
    if (now.getTime() - last < inst.idleTimeoutS * 1000) continue;
    const row = operationRow({ instanceId: inst.id, userId: null, kind: 'stop', params: { reason: 'idle' }, now });
    try {
      await db.batch([
        db.insert(operations).values(row),
        db
          .update(browserInstances)
          .set({ desiredState: 'stopped', updatedAt: now })
          .where(eq(browserInstances.id, inst.id)),
        db.insert(events).values(eventRow(inst.userId, 'operation.updated', { operationId: row.id, instanceId: inst.id }, now)),
      ]);
      deps.notify(inst.userId);
      stopped.push(inst.id);
    } catch {
      // Another operation was admitted at the same moment (unique index); skip this round.
    }
  }
  // End viewer sessions that stopped sending heartbeats.
  await db
    .update(viewerSessions)
    .set({ endedAt: now })
    .where(and(isNull(viewerSessions.endedAt), lt(viewerSessions.lastSeenAt, new Date(now.getTime() - 90_000))));
  return stopped;
}

/**
 * IP check for one running instance: provider binding plus the address Chrome sees (page 3).
 * On failure the instance shows Needs attention; it is never given a different IP.
 */
export async function checkInstanceIp(deps: EngineDeps, instanceId: string) {
  const { db } = deps;
  const [p] = await db
    .select()
    .from(placements)
    .where(and(eq(placements.instanceId, instanceId), eq(placements.status, 'current')));
  const [inst] = await db.select().from(browserInstances).where(eq(browserInstances.id, instanceId));
  if (!p || !inst) return null;
  const kind = p.executor as ExecutorKind;
  const executor = deps.executor(kind);
  const ref = placementRef(p);
  const binding = await executor.verifyEgress(readContext('ip-check', deps.envName), ref);
  const { observed } = await deps.agent(kind).checkIpFromChrome(instanceId, ref);
  const ok = binding.ok && observed.length > 0 && observed.every((a) => a === p.ipAddress);
  const at = deps.now();
  const lastIpCheck = {
    ok,
    expected: p.ipAddress,
    observed,
    checkedAt: at.toISOString(),
    ...(binding.ok ? {} : { detail: binding.detail ?? 'binding check failed' }),
  };
  const stmts = [
    db
      .insert(instanceHealth)
      .values({ instanceId, lastIpCheck })
      .onConflictDoUpdate({ target: instanceHealth.instanceId, set: { lastIpCheck } }),
    db.insert(events).values(eventRow(inst.userId, 'instance.updated', { instanceId }, at)),
  ] as const;
  if (!ok && inst.status === 'running') {
    await db.batch([
      ...stmts,
      db
        .update(browserInstances)
        .set({ status: 'needs_attention', statusReason: 'Network paused while we check your dedicated IP.', updatedAt: at })
        .where(eq(browserInstances.id, instanceId)),
      db.insert(auditLog).values({
        actor: 'engine',
        action: 'ip.check_failed',
        target: `instance:${instanceId}`,
        detail: lastIpCheck,
        createdAt: at,
      }),
    ]);
  } else {
    await db.batch(stmts);
  }
  deps.notify(inst.userId);
  return lastIpCheck;
}

/** Every 5 minutes while running (page 3, "Verification"). */
export async function periodicIpChecks(deps: EngineDeps) {
  const running = await deps.db
    .select({ id: browserInstances.id })
    .from(browserInstances)
    .where(inArray(browserInstances.status, ['running']));
  for (const { id } of running) await checkInstanceIp(deps, id);
}
