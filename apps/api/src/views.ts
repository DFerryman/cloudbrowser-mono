import { TRIAL, type Instance, type Operation } from '@cloudbrowser/contracts';
import { schema, type Db } from '@cloudbrowser/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

const { browserInstances, placements, ipAddresses, instanceHealth, operations } = schema;

type InstanceRow = typeof browserInstances.$inferSelect;
type OperationRow = typeof operations.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toOperation(op: OperationRow): Operation {
  return {
    id: op.id,
    instanceId: op.instanceId,
    kind: op.kind as Operation['kind'],
    status: op.status as Operation['status'],
    step: op.step,
    attempt: op.attempt,
    errorClass: op.errorClass,
    error: op.error,
    createdAt: op.createdAt.toISOString(),
    finishedAt: iso(op.finishedAt),
  };
}

/** Joins each instance with its current placement, IP history, health and running operation. */
export async function toInstances(db: Db, rows: InstanceRow[]): Promise<Instance[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [pls, health, ops] = await Promise.all([
    db
      .select()
      .from(placements)
      .where(and(inArray(placements.instanceId, ids), eq(placements.status, 'current'))),
    db.select().from(instanceHealth).where(inArray(instanceHealth.instanceId, ids)),
    db
      .select()
      .from(operations)
      .where(and(inArray(operations.instanceId, ids), isNull(operations.finishedAt))),
  ]);
  const addresses = pls.map((p) => p.ipAddress).filter((a): a is string => !!a);
  const ips = addresses.length ? await db.select().from(ipAddresses).where(inArray(ipAddresses.address, addresses)) : [];

  return rows.map((r) => {
    const p = pls.find((x) => x.instanceId === r.id);
    const ip = ips.find((x) => x.address === p?.ipAddress);
    const h = health.find((x) => x.instanceId === r.id);
    const op = ops.find((x) => x.instanceId === r.id);
    return {
      id: r.id,
      name: r.name,
      regionId: r.regionId as Instance['regionId'],
      status: r.status as Instance['status'],
      statusReason: r.statusReason,
      desiredState: r.desiredState as Instance['desiredState'],
      idleTimeoutS: r.idleTimeoutS,
      locale: r.locale as Instance['locale'],
      screen: r.screen as Instance['screen'],
      ipAddress: p?.ipAddress ?? null,
      dedicatedSince: iso(ip?.assignedAt),
      lastIpCheck: h?.lastIpCheck ?? null,
      lastActiveAt: iso(r.lastActiveAt),
      createdAt: r.createdAt.toISOString(),
      deletedAt: iso(r.deletedAt),
      purgeAfter: iso(r.purgeAfter),
      currentOperation: op
        ? { id: op.id, kind: op.kind as Operation['kind'], status: op.status as Operation['status'], step: op.step }
        : null,
      storageGb: r.storageGb,
      trial: r.trialState
        ? {
            state: r.trialState as NonNullable<Instance['trial']>['state'],
            secondsLeft: r.trialState === 'active' ? Math.ceil(Math.max(0, TRIAL.runningSeconds * 1000 - Math.max(r.trialUsedMs, r.trialUsedS * 1000)) / 1000) : 0,
            reclaimAt: r.trialState === 'converted' ? null : iso(r.trialReclaimAt),
          }
        : null,
    };
  });
}
