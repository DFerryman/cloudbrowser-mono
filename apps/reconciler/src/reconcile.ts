import { newId, priceSheets, raiseAlert, schema, type Db } from '@cloudbrowser/db';
import type { Executor, ExecutorKind, OpContext } from '@cloudbrowser/executors';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';

const { regions, resources, operations, driftFindings, quotaSnapshots, spendSnapshots, controlFlags, caps, browserInstances, auditLog } =
  schema;

export interface ReconcilerDeps {
  db: Db;
  /** Read-only credentials: the reconciler never changes provider resources. */
  executor(kind: ExecutorKind): Executor;
  envName: string;
  now(): Date;
}

/** Assumed active hours per running browser per day, for the month projection (page 12). */
// The operator policy is read at run time (24 hours/day initially).

function ctx(deps: ReconcilerDeps, purpose: string): OpContext {
  return {
    operationId: `reconciler:${purpose}`,
    step: purpose,
    token: purpose,
    tags: { 'cb:managed': 'true', 'cb:env': deps.envName, 'cb:instance': '-', 'cb:op': 'reconciler', 'cb:gen': '0' },
    deadline: Date.now() + 30_000,
  };
}

async function openFinding(
  deps: ReconcilerDeps,
  f: { kind: string; executor: string; region: string; providerId: string; resourceKind?: string; instanceId?: string | null; detail: string },
) {
  const { db } = deps;
  const [existing] = await db
    .select({ id: driftFindings.id })
    .from(driftFindings)
    .where(and(eq(driftFindings.providerId, f.providerId), eq(driftFindings.kind, f.kind), eq(driftFindings.status, 'open')));
  if (existing) return false;
  await db.insert(driftFindings).values({
    id: newId(),
    kind: f.kind,
    executor: f.executor,
    region: f.region,
    providerId: f.providerId,
    resourceKind: f.resourceKind ?? null,
    instanceId: f.instanceId ?? null,
    status: 'open',
    detail: f.detail,
    createdAt: deps.now(),
  });
  await raiseAlert(
    db,
    {
      source: 'reconciler',
      severity: f.kind === 'missing' ? 'critical' : 'warning',
      title: `Drift: ${f.kind} ${f.resourceKind ?? 'resource'} ${f.providerId} in ${f.executor}/${f.region}`,
      detail: { ...f },
      dedupeKey: `finding:${f.kind}:${f.providerId}`,
    },
    deps.now(),
  );
  return true;
}

async function freezeCreates(deps: ReconcilerDeps, reason: string) {
  const at = deps.now();
  await deps.db.batch([
    deps.db
      .insert(controlFlags)
      .values({ key: 'creation_freeze', value: 'true', reason, updatedAt: at })
      .onConflictDoUpdate({ target: controlFlags.key, set: { value: 'true', reason, updatedAt: at } }),
    deps.db.insert(auditLog).values({ actor: 'reconciler', action: 'circuit_breaker.tripped', target: 'global', detail: { reason }, createdAt: at }),
  ]);
  await raiseAlert(
    deps.db,
    { source: 'reconciler', severity: 'critical', title: `Circuit breaker: new browsers frozen (${reason})`, detail: { reason }, dedupeKey: 'circuit_breaker' },
    at,
  );
}

/**
 * Ledger vs provider, every 5 minutes (page 10, "Ledger and reconciler"). Findings and the circuit
 * breaker are recorded here; corrective changes are left to the engine and the reaper.
 */
export async function reconcileLedger(deps: ReconcilerDeps) {
  const { db } = deps;
  const summary = { adopted: 0, orphans: 0, missing: 0, frozen: false };
  const targets = await db
    .selectDistinct({ executor: regions.executor, providerRegion: regions.providerRegion })
    .from(regions)
    .where(and(eq(regions.enabled, true),sql`NOT EXISTS (SELECT 1 FROM aws_provider_regions a WHERE a.region_id=${regions.id} AND a.status!='ready')`));

  for (const t of targets) {
    const executor = deps.executor(t.executor as ExecutorKind);
    const observed = (await executor.listManaged(ctx(deps, 'list'), t.providerRegion)).filter(
      // Root disks are accounted for by their VM ledger row. The complete inventory still
      // exposes them to permanent deletion, including an orphaned disk after termination.
      (r) => r.tags['cb:env'] === deps.envName && r.tags['cb:kind'] !== 'root_volume',
    );
    const ledger = await db
      .select()
      .from(resources)
      .where(and(eq(resources.executor, t.executor), eq(resources.region, t.providerRegion), ne(resources.state, 'deleted')));
    const byProviderId = new Map(ledger.filter((r) => r.providerId).map((r) => [r.providerId!, r]));
    const seen = new Set<string>();

    for (const r of observed) {
      seen.add(r.providerId);
      if (byProviderId.has(r.providerId)) continue;
      const opId = r.tags['cb:op'];
      const [op] = opId ? await db.select().from(operations).where(eq(operations.id, opId)) : [];
      // Created by a known operation (e.g. after a database restore): adopt it.
      const pending = op
        ? ledger.find((l) => !l.providerId && l.createdByOp === op.id && l.kind === r.kind && l.state === 'pending')
        : undefined;
      if (op && pending) {
        await db
          .update(resources)
          .set({ providerId: r.providerId, state: 'active', lastSeenAt: deps.now() })
          .where(eq(resources.id, pending.id));
        summary.adopted++;
        continue;
      }
      if (op) {
        await db.insert(resources).values({
          id: newId(),
          instanceId: op.instanceId,
          kind: r.kind,
          executor: t.executor,
          providerId: r.providerId,
          region: t.providerRegion,
          zone: r.zone,
          createdByOp: op.id,
          requestToken: `adopted:${r.providerId}`,
          state: 'active',
          tags: r.tags,
          firstSeenAt: deps.now(),
          lastSeenAt: deps.now(),
        });
        summary.adopted++;
        continue;
      }
      if (
        await openFinding(deps, {
          kind: 'orphan',
          executor: t.executor,
          region: t.providerRegion,
          providerId: r.providerId,
          resourceKind: r.kind,
          detail: `unknown ${r.kind} tagged cb:op=${opId ?? '-'}`,
        })
      ) {
        summary.orphans++;
      }
    }

    for (const l of ledger) {
      if (l.state !== 'active' || !l.providerId || seen.has(l.providerId)) continue;
      if (
        await openFinding(deps, {
          kind: 'missing',
          executor: t.executor,
          region: t.providerRegion,
          providerId: l.providerId,
          resourceKind: l.kind,
          instanceId: l.instanceId,
          detail: `ledger says active, provider has no ${l.kind}`,
        })
      ) {
        summary.missing++;
      }
    }

    if (observed.length > ledger.filter((l) => l.providerId).length + 2) {
      await freezeCreates(deps, `${t.executor}/${t.providerRegion}: ${observed.length} managed resources, ledger has ${ledger.length}`);
      summary.frozen = true;
    }
  }

  // Too many creates in 10 minutes also trips the breaker.
  const [limit] = await db
    .select()
    .from(caps)
    .where(and(eq(caps.scope, 'global'), eq(caps.metric, 'creates_per_10_min')));
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(operations)
    .where(and(eq(operations.kind, 'create'), gte(operations.createdAt, new Date(deps.now().getTime() - 600_000))));
  if (limit && n > limit.limit) {
    await freezeCreates(deps, `${n} creates in 10 minutes (cap ${limit.limit})`);
    summary.frozen = true;
  }
  return summary;
}

/** Hourly: provider quotas and the month's spend projection for the spend guard (page 10). */
export async function snapshotQuotasAndSpend(deps: ReconcilerDeps) {
  const { db } = deps;
  const at = deps.now();
  const targets = await db
    .selectDistinct({ executor: regions.executor, providerRegion: regions.providerRegion })
    .from(regions)
    .where(and(eq(regions.enabled, true),sql`NOT EXISTS (SELECT 1 FROM aws_provider_regions a WHERE a.region_id=${regions.id} AND a.status!='ready')`));
  // The hourly VM price comes from the providers' price lists (refreshed by the engine), never a constant.
  let vmHourCents = 0;
  for (const s of (await priceSheets(db)).values()) vmHourCents = Math.max(vmHourCents, s.sheet.vmHour * 100);
  for (const t of targets) {
    const executor = deps.executor(t.executor as ExecutorKind);
    const qs = await executor.quotas(ctx(deps, 'quotas'), t.providerRegion);
    if (qs.length) {
      await db.insert(quotaSnapshots).values(
        qs.map((q) => ({ executor: t.executor, region: t.providerRegion, metric: q.metric, limit: q.limit, used: q.used, takenAt: at })),
      );
    }
  }

  const [{ cents } = { cents: 0 }] = await db
    .select({ cents: sql<number>`coalesce(sum(${resources.monthlyCostEstimate}), 0)` })
    .from(resources)
    .where(inArray(resources.state, ['active', 'superseded', 'pending']));
  const [{ running } = { running: 0 }] = await db
    .select({ running: sql<number>`count(*)` })
    .from(browserInstances)
    .where(inArray(browserInstances.status, ['running', 'starting', 'creating']));
  const daysInMonth = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
  const [policy]=await db.select().from(schema.awsProviderSettings);
  const runningHoursCents = Math.round(running * (policy?.estimatedHoursPerDay ?? 24) * daysInMonth * vmHourCents);
  const month = at.toISOString().slice(0, 7);
  const projectedCents = Number(cents) + runningHoursCents;
  await db.insert(spendSnapshots).values({ month, activeMonthlyCents: Number(cents), runningHoursCents, projectedCents, takenAt: at });

  // Spend guard thresholds (page 10): alert at 80% of the budget; at 100% creates are refused.
  const [budget] = await db.select().from(caps).where(and(eq(caps.scope, 'global'), eq(caps.metric, 'spend_budget_cents')));
  if (budget && budget.limit > 0) {
    const pct = Math.round((projectedCents / budget.limit) * 100);
    if (pct >= 100) {
      await raiseAlert(db, { source: 'reconciler', severity: 'critical', title: `Spend guard active: projected ${pct}% of the monthly budget`, detail: { projectedCents, budgetCents: budget.limit }, dedupeKey: `spend100:${month}` }, at);
    } else if (pct >= 80) {
      await raiseAlert(db, { source: 'reconciler', severity: 'warning', title: `Projected spend at ${pct}% of the monthly budget`, detail: { projectedCents, budgetCents: budget.limit }, dedupeKey: `spend80:${month}` }, at);
    }
  }
}
