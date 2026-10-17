import { operationRow, schema } from '@cloudbrowser/db';
import type { ExecutorKind } from '@cloudbrowser/executors';
import { and, eq, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { readContext, type EngineDeps } from './context.js';
import { runPending } from './scheduler.js';
import { deleteLedgerResources } from './steps.js';

const { browserInstances, operations, resources, driftFindings, events, idempotencyKeys, auditLog, viewerTokens } = schema;

const ORPHAN_GRACE_MS = 24 * 3_600_000;

/**
 * The only deleter (page 2, "reaper mode"). Runs on its own schedule with the reaper credentials,
 * and deletes only what the ledger marks as eligible.
 */
export async function reaperTick(deps: EngineDeps) {
  if (deps.mode !== 'reaper') throw new Error('reaperTick needs the reaper credentials');
  const { db } = deps;
  const now = deps.now();
  const summary = { purgesQueued: 0, purgesRun: 0, failedCleanups: 0, released: 0, orphans: 0 };

  // 1. Purge soft-deleted instances after 7 days.
  const expired = await db
    .select({ id: browserInstances.id, userId: browserInstances.userId })
    .from(browserInstances)
    .where(and(eq(browserInstances.status, 'deleting'), lte(browserInstances.purgeAfter, now)));
  for (const inst of expired) {
    try {
      await db.insert(operations).values(operationRow({ instanceId: inst.id, userId: null, kind: 'purge', now }));
      summary.purgesQueued++;
    } catch {
      // An unfinished operation exists (e.g. a purge already queued, or an undelete).
    }
  }
  summary.purgesRun = await runPending(deps);

  const env = (kind: ExecutorKind) => ({
    deps,
    executor: deps.executor(kind),
    ctx: (step: string, extra?: string) => readContext(`reaper:${step}:${extra ?? ''}`, deps.envName),
  });

  // 2. Failed creates: no user data ever existed, so everything they allocated goes.
  const failed = await db
    .select({ id: browserInstances.id, regionId: browserInstances.regionId })
    .from(browserInstances)
    .where(eq(browserInstances.status, 'failed'));
  for (const inst of failed) {
    const kinds = await db
      .selectDistinct({ executor: resources.executor })
      .from(resources)
      .where(and(eq(resources.instanceId, inst.id), ne(resources.state, 'deleted')));
    for (const { executor } of kinds) {
      summary.failedCleanups += await deleteLedgerResources(env(executor as ExecutorKind), inst.id);
    }
  }

  // 3. IPs rejected by screening, and superseded resources past their keep period
  //    (old IPs 30 days after change_ip).
  const eligible = await db
    .select()
    .from(resources)
    .where(
      sql`${resources.state} = 'rejected' OR (${resources.state} = 'superseded' AND ${resources.releaseAfter} <= ${now.getTime()})`,
    );
  for (const r of eligible) {
    if (!r.instanceId) continue;
    summary.released += await deleteLedgerResources(env(r.executor as ExecutorKind), r.instanceId, (x) => x.id === r.id);
  }

  // 4. Orphans the reconciler found more than 24 h ago that were never attached to an instance.
  const orphans = await db
    .select()
    .from(driftFindings)
    .where(
      and(
        eq(driftFindings.kind, 'orphan'),
        eq(driftFindings.status, 'open'),
        isNull(driftFindings.instanceId),
        lt(driftFindings.createdAt, new Date(now.getTime() - ORPHAN_GRACE_MS)),
      ),
    );
  for (const o of orphans) {
    const ex = deps.executor(o.executor as ExecutorKind);
    await ex.ensureDeleted(readContext('reaper:orphan', deps.envName), o.region, (o.resourceKind ?? 'vm') as never, o.providerId);
    await db.batch([
      db.update(driftFindings).set({ status: 'resolved', resolvedAt: now }).where(eq(driftFindings.id, o.id)),
      db.insert(auditLog).values({
        actor: 'reaper',
        action: 'orphan.deleted',
        target: `provider:${o.providerId}`,
        detail: { executor: o.executor, region: o.region },
        createdAt: now,
      }),
    ]);
    summary.orphans++;
  }

  // 5. Housekeeping: the SSE change feed, idempotency keys and viewer tokens live for 24 h.
  const dayAgo = new Date(now.getTime() - 86_400_000);
  await db.batch([
    db.delete(events).where(lt(events.createdAt, dayAgo)),
    db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, dayAgo)),
    // Redeemed viewer tokens only need to outlive their 60 s validity.
    db.delete(viewerTokens).where(lt(viewerTokens.redeemedAt, dayAgo)),
  ]);
  return summary;
}
