import { BrowserTier, StopReason, type Instance, type Operation } from '@cloudbrowser/contracts';
import { schema, type Db } from '@cloudbrowser/db';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

const { browserInstances, placements, ipAddresses, instanceHealth, operations, browserReservations } = schema;

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
  const sleeping = rows.filter((r) => r.status === 'sleeping').map((r) => r.id);
  const [ips, retained, stops] = await Promise.all([
    addresses.length ? db.select().from(ipAddresses).where(inArray(ipAddresses.address, addresses)) : [],
    db.select({ instanceId: browserReservations.instanceId, endsAt: browserReservations.retentionEndsAt }).from(browserReservations)
      .where(and(inArray(browserReservations.instanceId, ids), isNotNull(browserReservations.retentionStartedAt))),
    // Why each sleeping browser last stopped: only stops the user did not ask for are shown.
    sleeping.length ? db.select({ instanceId: operations.instanceId, reason: sql<string | null>`json_extract(${operations.params}, '$.reason')` }).from(operations)
      .where(and(inArray(operations.instanceId, sleeping), eq(operations.kind, 'stop'), eq(operations.status, 'succeeded'),
        sql`${operations.finishedAt} = (SELECT max(o2.finished_at) FROM operations o2 WHERE o2.instance_id = ${operations.instanceId} AND o2.kind = 'stop' AND o2.status = 'succeeded')`)) : [],
  ]);

  return rows.map((r) => {
    const p = pls.find((x) => x.instanceId === r.id);
    const ip = ips.find((x) => x.address === p?.ipAddress);
    const h = health.find((x) => x.instanceId === r.id);
    const op = ops.find((x) => x.instanceId === r.id);
    const stop = StopReason.safeParse(stops.find((x) => x.instanceId === r.id)?.reason);
    return {
      id: r.id,
      name: r.name,
      regionId: r.regionId as Instance['regionId'],
      tier: BrowserTier.catch('basic').parse(r.tier),
      status: r.status as Instance['status'],
      statusReason: r.statusReason,
      desiredState: r.desiredState as Instance['desiredState'],
      idleTimeoutS: r.idleTimeoutS,
      screen: r.screen as Instance['screen'],
      videoQuality: 'full',
      videoAuto: true,
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
      stopReason: r.status === 'sleeping' && stop.success ? stop.data : null,
      deletesAt: iso(retained.find((x) => x.instanceId === r.id)?.endsAt),
    };
  });
}
