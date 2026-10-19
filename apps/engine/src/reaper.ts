import { operationRow, schema, userCaps } from '@cloudbrowser/db';
import type { ExecutorKind } from '@cloudbrowser/executors';
import { and, eq, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { readContext, type EngineDeps } from './context.js';
import { runPending } from './scheduler.js';
import { deleteLedgerResources, discoverInstanceResources } from './steps.js';

const { browserInstances, operations, resources, driftFindings, events, idempotencyKeys, auditLog, viewerTokens, backups } = schema;

const ORPHAN_GRACE_MS = 24 * 3_600_000;

/**
 * The only deleter (page 2, "reaper mode"). Runs on its own schedule with the reaper credentials,
 * and deletes only what the ledger marks as eligible.
 */
export async function reaperTick(deps: EngineDeps) {
  if (deps.mode !== 'reaper') throw new Error('reaperTick needs the reaper credentials');
  const { db } = deps;
  const now = deps.now();
  const summary = { purgesQueued: 0, purgesRun: 0, failedCleanups: 0, released: 0, orphans: 0, backupsExpired: 0 };

  // A delayed provider response or reconciler adoption can expose an owned resource after a
  // previous purge. Reopen cleanup instead of leaving it behind under a tombstoned browser.
  await db.update(browserInstances).set({ status: 'deleting', purgeAfter: now, updatedAt: now }).where(and(
    eq(browserInstances.status, 'purged'),
    sql`exists(select 1 from resources where instance_id = ${browserInstances.id} and state <> 'deleted')`,
  ));
  // 1. Permanent user deletions are eligible immediately; system recovery windows keep their deadline.
  const expired = await db
    .select({ id: browserInstances.id, userId: browserInstances.userId })
    .from(browserInstances)
    .where(and(ne(browserInstances.status, 'purged'), or(eq(browserInstances.status, 'deleting'), eq(browserInstances.desiredState, 'deleted')), lte(browserInstances.purgeAfter, now)));
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

  // 2. Failed creates: no user data ever existed, so everything they allocated goes. Once the
  //    provider confirmed the release, a failed browser is only revisited if a resource of it
  //    reappears in the ledger: every pass lists the whole region, and EC2 throttles the account.
  const failed = await db
    .select({ id: browserInstances.id, regionId: browserInstances.regionId })
    .from(browserInstances)
    .where(and(eq(browserInstances.status, 'failed'), or(
      isNull(browserInstances.providerReleasedAt),
      sql`exists(select 1 from resources where instance_id = ${browserInstances.id} and state <> 'deleted')`,
    )));
  for (const inst of failed) {
    await db.update(schema.browserReservations).set({ reservedMicros: 0, updatedAt: now }).where(eq(schema.browserReservations.instanceId, inst.id));
    const kinds = await db
      .selectDistinct({ executor: resources.executor })
      .from(resources)
      .where(and(eq(resources.instanceId, inst.id), ne(resources.state, 'deleted')));
    const [region]=await db.select().from(schema.regions).where(eq(schema.regions.id,inst.regionId));
    if (region && !kinds.some((k)=>k.executor===region.executor)) kinds.push({executor:region.executor});
    let confirmed=true;
    for (const { executor } of kinds) {
      const cleanup = env(executor as ExecutorKind);
      try {
        await discoverInstanceResources(cleanup, inst.id);
        summary.failedCleanups += await deleteLedgerResources(cleanup, inst.id, (r) => r.executor === executor);
      } catch (e) {
        confirmed=false;
        // Provider deletion and unknown-outcome creates may take multiple passes. Preserve every
        // unconfirmed ledger row and let the next reaper tick retry without skipping other users.
        console.error('failed browser cleanup pending', inst.id, e);
      }
    }
    if (confirmed) await db.update(browserInstances).set({providerReleasedAt:now}).where(and(eq(browserInstances.id,inst.id),eq(browserInstances.status,'failed')));
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
    const observed = (await ex.listManaged(readContext('reaper:orphan-ownership', deps.envName), o.region))
      .find((r) => r.providerId === o.providerId && r.kind === (o.resourceKind ?? 'vm'));
    const ownerId = observed?.tags['cb:instance'];
    if (!observed || !ownerId || ownerId === '-' || observed.tags['cb:env'] !== deps.envName) continue;
    const [owner] = await db.select({ status: browserInstances.status }).from(browserInstances).where(eq(browserInstances.id, ownerId));
    // An orphan finding can be stale: never delete a resource of a live browser just because the
    // reconciler saw it before its ledger write. Its own purge handles a deleted browser.
    if (owner && owner.status !== 'purged') continue;
    const ctx = readContext('reaper:orphan', deps.envName);
    await ex.ensureDeleted({ ...ctx, tags: { ...ctx.tags, 'cb:instance': ownerId, 'cb:kind': observed.kind } }, o.region, observed.kind, o.providerId);
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

  // 5. Backups past their retention (page 4): snapshots after 7 days (the newest is always kept),
  //    archives beyond the last 10 unless they are the newest of a day in the last 14 days.
  summary.backupsExpired = await expireBackups(deps, env);

  // 6. Housekeeping: the SSE change feed, idempotency keys and viewer tokens live for 24 h.
  const dayAgo = new Date(now.getTime() - 86_400_000);
  await db.batch([
    db.delete(events).where(lt(events.createdAt, dayAgo)),
    db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, dayAgo)),
    // Redeemed viewer tokens only need to outlive their 60 s validity.
    db.delete(viewerTokens).where(lt(viewerTokens.redeemedAt, dayAgo)),
  ]);
  return summary;
}

const SNAPSHOT_KEEP_DAYS = 7;
const ARCHIVE_KEEP_LAST = 10;
const ARCHIVE_DAILY_DAYS = 14;

/** Which of one instance's complete backups are past retention. Pure, so it is unit-tested. */
export function expiredBackups(
  list: { id: string; kind: string; reason?: string; createdAt: Date }[],
  now: Date,
  snapshotDays = SNAPSHOT_KEEP_DAYS,
  snapshotsEnabled = true,
): string[] {
  const out: string[] = [];
  if (!snapshotsEnabled) {
    // Snapshots were turned off: every daily or manual one goes, so they stop being billed.
    // Snapshots taken by `recover` are ours and follow the normal rule.
    out.push(...list.filter((b) => b.kind === 'snapshot' && b.reason !== 'recover').map((b) => b.id));
    list = list.filter((b) => !out.includes(b.id));
  }
  const byNewest = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const snaps = byNewest.filter((b) => b.kind === 'snapshot');
  for (const s of snaps.slice(1)) {
    if (now.getTime() - s.createdAt.getTime() > snapshotDays * 86_400_000) out.push(s.id);
  }
  const archives = byNewest.filter((b) => b.kind === 'archive');
  const dailyKept = new Set<string>();
  archives.forEach((a, i) => {
    if (i < ARCHIVE_KEEP_LAST) return;
    const day = a.createdAt.toISOString().slice(0, 10);
    const recent = now.getTime() - a.createdAt.getTime() <= ARCHIVE_DAILY_DAYS * 86_400_000;
    const newerSameDay = archives.slice(0, i).some((x) => x.createdAt.toISOString().slice(0, 10) === day);
    if (recent && !newerSameDay && !dailyKept.has(day)) {
      dailyKept.add(day);
      return;
    }
    out.push(a.id);
  });
  return out;
}

async function expireBackups(deps: EngineDeps, env: (kind: ExecutorKind) => Parameters<typeof deleteLedgerResources>[0]) {
  const { db } = deps;
  const now = deps.now();
  const all = await db.select().from(backups).where(eq(backups.status, 'complete'));
  const byInstance = new Map<string, typeof all>();
  for (const b of all) byInstance.set(b.instanceId, [...(byInstance.get(b.instanceId) ?? []), b]);
  let expired = 0;
  for (const [instanceId, list] of byInstance) {
    // Retention: the `snapshot_retention_days` cap (7 days by default). Turning snapshots off deletes them.
    const [owner] = await db
      .select({ userId: browserInstances.userId, backupsEnabled: browserInstances.backupsEnabled })
      .from(browserInstances)
      .where(eq(browserInstances.id, instanceId));
    const days = owner ? ((await userCaps(db, owner.userId)).get('snapshot_retention_days') ?? SNAPSHOT_KEEP_DAYS) : SNAPSHOT_KEEP_DAYS;
    for (const id of expiredBackups(list, now, days, owner?.backupsEnabled ?? true)) {
      const b = list.find((x) => x.id === id)!;
      if (b.kind === 'snapshot') {
        const [r] = await db.select().from(resources).where(and(eq(resources.instanceId, instanceId), eq(resources.providerId, b.location ?? '')));
        if (r) await deleteLedgerResources(env(r.executor as ExecutorKind), instanceId, (x) => x.id === r.id);
      } else if (b.kind === 'archive' && b.location) {
        if (!deps.deleteArchive) continue;
        await deps.deleteArchive(b.location);
      }
      await db.update(backups).set({ status: 'deleted', deletedAt: now }).where(eq(backups.id, id));
      expired++;
    }
  }
  return expired;
}
