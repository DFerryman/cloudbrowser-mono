import { NEVER_SLEEP_TIMEOUT_S } from '@cloudbrowser/contracts';
import { settleRunningStatements, eventRow, operationRow, raiseAlert, reservedTotalSql, schema } from '@cloudbrowser/db';
import type { ExecutorKind } from '@cloudbrowser/executors';
import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { placementRef, readContext, type EngineDeps } from './context.js';
import { attentionSince, attentionStarted, idleTimeoutS, NEEDS_ATTENTION_IDLE_S, runOperation, sleepsWhenIdle } from './runner.js';

const { operations, browserInstances, instanceHealth, viewerSessions, placements, events, auditLog, billingAccounts, browserReservations, userNotices } = schema;

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
 * Asks the engine to put a browser to sleep (a `stop` operation with the given reason). Returns
 * false if another operation was admitted at the same moment (unique index); the caller retries
 * on its next round.
 */
export async function requestStop(deps: EngineDeps, inst: { id: string; userId: string }, reason: string): Promise<boolean> {
  const { db } = deps;
  const now = deps.now();
  const row = operationRow({ instanceId: inst.id, userId: null, kind: 'stop', params: { reason }, now });
  // Recheck the reason with the stop admission: inventory or billing reads can race a wake,
  // top-up. Aborting the batch also prevents a stray unfinished operation.
  const reasonStillApplies = reason === 'intent_reconcile' ? sql`${browserInstances.desiredState} = 'stopped'`
    : reason === 'idle' ? sql`EXISTS (SELECT 1 FROM browser_instances b LEFT JOIN instance_health h ON h.instance_id = b.id
      WHERE b.id = ${inst.id} AND b.desired_state = 'running' AND ${sleepsWhenIdle}
      AND max(coalesce(b.last_active_at, 0), coalesce(h.last_input_at, 0), ${attentionSince}) + ${idleTimeoutS} * 1000 <= ${now.getTime()})`
    : reason === 'frozen' ? sql`EXISTS (SELECT 1 FROM ${billingAccounts} WHERE ${billingAccounts.userId} = ${inst.userId} AND ${billingAccounts.frozenAt} IS NOT NULL)`
    : reason === 'balance' ? sql`(
      NOT EXISTS (SELECT 1 FROM ${billingAccounts} WHERE ${billingAccounts.userId} = ${inst.userId} AND ${billingAccounts.balanceMicros} - ${reservedTotalSql(inst.userId)} > 0)
      OR NOT EXISTS (SELECT 1 FROM ${browserReservations} WHERE ${browserReservations.instanceId} = ${inst.id} AND ${browserReservations.retentionStartedAt} IS NULL AND ${browserReservations.reservedMicros} >= ${browserReservations.requiredMicros}))`
    : sql`1`;

  try {
    // Billing settlement advances last_active_at. Preserve the actual pre-settlement activity
    // atomically with admission so execution can recheck the full idle deadline without treating
    // this stop's own accounting write as new user activity.
    const insertStop = db.insert(operations).values(reason === 'idle' ? {
      ...row,
      params: sql`json_object(
        'reason', 'idle',
        'idleLastActiveAt', (SELECT last_active_at FROM browser_instances WHERE id = ${inst.id}),
        'idleLastInputAt', (SELECT last_input_at FROM instance_health WHERE instance_id = ${inst.id}),
        'idleTimeoutS', (SELECT idle_timeout_s FROM browser_instances WHERE id = ${inst.id}),
        'idleViewerPresence', json((SELECT json_object('sessionId', id, 'sequence', presence_seq,
          'viewing', viewing, 'presenceAt', presence_at, 'endedAt', ended_at)
          FROM viewer_sessions WHERE instance_id = ${inst.id} ORDER BY rowid DESC LIMIT 1)))`,
    } : row);
    const settlement = settleRunningStatements(db, inst.id, now);
    await db.batch([
      db.insert(auditLog).values({ actor: 'engine', action: 'operation.stop.guard', target: `instance:${inst.id}`,
        createdAt: sql`CASE WHEN EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.id} = ${inst.id} AND ${browserInstances.desiredState} <> 'deleted' AND ${browserInstances.status} <> 'purged' AND (${reasonStillApplies})) THEN ${now.getTime()} ELSE NULL END`,
      }),
      ...(reason === 'idle' ? [insertStop, ...settlement] : [...settlement, insertStop]),
      db.update(browserInstances).set({ desiredState: 'stopped', updatedAt: now }).where(eq(browserInstances.id, inst.id)),
      db.insert(events).values(eventRow(inst.userId, 'operation.updated', { operationId: row.id, instanceId: inst.id }, now)),
    ]);
    deps.notify(inst.userId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts running browsers to sleep after `idle_timeout` without input (page 2, flow C). Viewer
 * heartbeats carry whether there was input since the last one. Browsers that need attention
 * sleep too, counting from when they began to, Never sleep ones after an hour; one with an
 * operation under way is left to it.
 */
export async function idleStops(deps: EngineDeps): Promise<string[]> {
  const { db } = deps;
  const now = deps.now();
  const running = await db
    .select({
      id: browserInstances.id,
      userId: browserInstances.userId,
      status: browserInstances.status,
      idleTimeoutS: browserInstances.idleTimeoutS,
      lastActiveAt: browserInstances.lastActiveAt,
      lastInputAt: instanceHealth.lastInputAt,
      attentionSince: sql<number>`CASE WHEN ${browserInstances.status} = 'needs_attention' THEN ${attentionStarted(browserInstances.id)} ELSE 0 END`,
    })
    .from(browserInstances)
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
    .where(or(
      and(eq(browserInstances.status, 'running'), ne(browserInstances.idleTimeoutS, NEVER_SLEEP_TIMEOUT_S)),
      eq(browserInstances.status, 'needs_attention'),
    ));

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
    const last = Math.max(inst.lastActiveAt?.getTime() ?? 0, inst.lastInputAt?.getTime() ?? 0, Number(inst.attentionSince));
    const timeoutS = inst.status === 'needs_attention' && inst.idleTimeoutS === NEVER_SLEEP_TIMEOUT_S ? NEEDS_ATTENTION_IDLE_S : inst.idleTimeoutS;
    if (now.getTime() - last < timeoutS * 1000) continue;
    if (await requestStop(deps, inst, 'idle')) stopped.push(inst.id);
  }
  // End viewer sessions that stopped sending heartbeats.
  await db
    .update(viewerSessions)
    .set({ endedAt: now })
    .where(and(isNull(viewerSessions.endedAt), lt(viewerSessions.lastSeenAt, new Date(now.getTime() - 90_000))));
  return stopped;
}

/** okAt: the last check that passed, kept on a failed one; a passing check is its own. */
type IpCheckRecord = { ok: boolean; expected: string | null; observed: string[]; checkedAt: string; detail?: string; okAt?: string };

/** No successful check for this long while running pauses the network (page 3, "Fail-closed"). */
const IP_CHECK_STALE_MS = 15 * 60_000;
const ON_DEMAND_TIMEOUT_MS = 15_000;

/**
 * Chrome saw an address, and not (only) the expected one: an IP incident, which pauses at once.
 * A check that saw nothing (Chrome or the echo did not answer) says nothing about the address; it
 * pauses only once no check has passed for IP_CHECK_STALE_MS, about when the agent closes the VM
 * firewall after its third such check in a row.
 */
function sawOtherAddress(check: IpCheckRecord | null | undefined) {
  return !!check && !check.ok && check.observed.length > 0;
}

/** When a check last passed, or when the agent last became ready, whichever is later. */
function lastPassAt(check: IpCheckRecord | null | undefined, agentReadyAt: Date | null | undefined) {
  const ok = check?.ok ? check.checkedAt : check?.okAt;
  return Math.max(ok ? Date.parse(ok) : 0, agentReadyAt?.getTime() ?? 0);
}

/**
 * Stores a check and, if it failed on a running browser, shows Needs attention: at once for an
 * incident (the binding failed, or Chrome saw another address), else once no check has passed for
 * IP_CHECK_STALE_MS. A different IP is never assigned automatically.
 */
async function recordIpCheck(deps: EngineDeps, inst: { id: string; userId: string; status: string }, check: IpCheckRecord, incident: boolean, stale: boolean) {
  const { db } = deps;
  const at = deps.now();
  const stmts = [
    db
      .insert(instanceHealth)
      .values({ instanceId: inst.id, lastIpCheck: check })
      .onConflictDoUpdate({ target: instanceHealth.instanceId, set: { lastIpCheck: check } }),
    db.insert(events).values(eventRow(inst.userId, 'instance.updated', { instanceId: inst.id }, at)),
  ] as const;
  if (!check.ok && (incident || stale) && inst.status === 'running') {
    await db.batch([...stmts, ...pauseNetwork(deps, inst.id, check, at)]);
    await ipAlert(deps, inst.id, { ...check }, at, incident);
  } else {
    await db.batch(stmts);
  }
  deps.notify(inst.userId);
}

/**
 * A failed IP check is an IP-integrity incident until an operator looks at it (page 3). One that
 * could not run (Chrome did not answer, nothing was seen) is a browser that stopped responding:
 * still paused, but not reported as a wrong address.
 */
function ipAlert(deps: EngineDeps, instanceId: string, detail: Record<string, unknown>, at: Date, incident: boolean) {
  return raiseAlert(
    deps.db,
    incident
      ? { source: 'engine', severity: 'critical', title: `IP check failed for ${instanceId}: network paused`, detail, dedupeKey: `ip:${instanceId}` }
      : { source: 'engine', severity: 'warning', title: `No IP check passed for ${instanceId} in 15 minutes (Chrome or its agent is not answering): network paused`, detail, dedupeKey: `ip:${instanceId}` },
    at,
  );
}

/** The reason a browser paused by an IP check shows; only this pause ends with a passing check. */
const NETWORK_PAUSED = 'Network paused while we check your dedicated IP.';

function pauseNetwork(deps: EngineDeps, instanceId: string, detail: Record<string, unknown>, at: Date) {
  const { db } = deps;
  return [
    db
      .update(browserInstances)
      .set({ status: 'needs_attention', statusReason: NETWORK_PAUSED, updatedAt: at })
      .where(and(eq(browserInstances.id, instanceId), eq(browserInstances.desiredState, 'running'), eq(browserInstances.status, 'running'))),
    db.insert(auditLog).values({ actor: 'engine', action: 'ip.check_failed', target: `instance:${instanceId}`, detail, createdAt: at }),
    // Only when this batch paused it: the user is emailed, and it stays paused until they check again.
    db.insert(userNotices).select(sql`SELECT ${`ip:${instanceId}:${at.getTime()}`}, user_id, 'network_paused', id, json_object('name', name), ${at.getTime()}, NULL
      FROM browser_instances WHERE id = ${instanceId} AND status = 'needs_attention' AND updated_at = ${at.getTime()}`).onConflictDoNothing(),
  ] as const;
}

/**
 * On-demand IP check for one running instance: provider binding plus the address Chrome sees
 * (page 3). Waits up to 15 s for the agent's answer. Only a check the user asked for (Check
 * again) can end a pause; a passing check never resumes the network by itself.
 */
export async function checkInstanceIp(deps: EngineDeps, instanceId: string, opts: { requestedByUser?: boolean } = {}): Promise<IpCheckRecord | null> {
  const { db } = deps;
  const [p] = await db
    .select()
    .from(placements)
    .where(and(eq(placements.instanceId, instanceId), eq(placements.status, 'current')));
  const [inst] = await db.select().from(browserInstances).where(eq(browserInstances.id, instanceId));
  if (!p || !inst) return null;
  const [health] = await db.select().from(instanceHealth).where(eq(instanceHealth.instanceId, instanceId));
  const kind = p.executor as ExecutorKind;
  const ref = placementRef(p);
  const binding = await deps.executor(kind).verifyEgress(readContext('ip-check', deps.envName), ref);

  const agent = deps.agent(kind);
  const commandId = `ipcheck:${instanceId}:${deps.now().getTime()}`;
  await agent.send({ id: commandId, instanceId, kind: 'ip_check', payload: { expected: p.ipAddress } });
  const started = Date.now();
  let reply = await agent.reply(commandId);
  while (reply.status === 'pending' && Date.now() - started < ON_DEMAND_TIMEOUT_MS) {
    await deps.sleep(500);
    reply = await agent.reply(commandId);
  }
  const observed = Array.isArray(reply.result?.observed) ? (reply.result.observed as string[]) : [];
  const ok = binding.ok && reply.status === 'succeeded' && observed.length > 0 && observed.every((a) => a === p.ipAddress);
  const detail = !binding.ok
    ? (binding.detail ?? 'binding check failed')
    : reply.status === 'pending'
      ? 'the IP check inside Chrome did not answer'
      : undefined;
  const prev = health?.lastIpCheck;
  const okAt = ok ? undefined : prev?.ok ? prev.checkedAt : prev?.okAt;
  const check: IpCheckRecord = { ok, expected: p.ipAddress, observed, checkedAt: deps.now().toISOString(), ...(detail ? { detail } : {}), ...(okAt ? { okAt } : {}) };
  const stale = deps.now().getTime() - lastPassAt(check, health?.agentReadyAt) > IP_CHECK_STALE_MS;
  await recordIpCheck(deps, inst, check, !binding.ok || sawOtherAddress(check), stale);
  if (ok && opts.requestedByUser && inst.status === 'needs_attention' && inst.statusReason === NETWORK_PAUSED) await resumeNetwork(deps, inst, kind);
  return check;
}

/**
 * A passing check (the user's Check again) ends the pause an IP check caused: the agent opens
 * the VM firewall again, which it closes itself when one of its own checks fails, and the
 * browser shows Running. Without the agent's confirmation the browser stays paused, and Restart
 * reboots the VM, which resets the firewall too. Never while an operation is under way.
 */
async function resumeNetwork(deps: EngineDeps, inst: { id: string; userId: string }, kind: ExecutorKind) {
  const { db } = deps;
  const agent = deps.agent(kind);
  // The `ipcheck:` prefix keeps this command independent of any operation, like the check itself.
  const commandId = `ipcheck:${inst.id}:${deps.now().getTime()}:firewall`;
  await agent.send({ id: commandId, instanceId: inst.id, kind: 'set_firewall', payload: { mode: 'normal' } });
  const started = Date.now();
  let reply = await agent.reply(commandId);
  while (reply.status === 'pending' && Date.now() - started < ON_DEMAND_TIMEOUT_MS) {
    await deps.sleep(500);
    reply = await agent.reply(commandId);
  }
  if (reply.status !== 'succeeded') return;
  const at = deps.now();
  const paused = sql`EXISTS (SELECT 1 FROM browser_instances WHERE id = ${inst.id} AND status = 'needs_attention'
    AND status_reason = ${NETWORK_PAUSED} AND desired_state = 'running')
    AND NOT EXISTS (SELECT 1 FROM operations WHERE instance_id = ${inst.id} AND finished_at IS NULL)`;
  const [, resumed] = await db.batch([
    // Running time is metered from now, as after a wake.
    db.insert(instanceHealth).values({ instanceId: inst.id, meteredAt: sql`CASE WHEN ${paused} THEN ${at.getTime()} ELSE NULL END` })
      .onConflictDoUpdate({ target: instanceHealth.instanceId, set: { meteredAt: at }, setWhere: paused }),
    db.update(browserInstances).set({ status: 'running', statusReason: null, lastActiveAt: at, updatedAt: at })
      .where(and(eq(browserInstances.id, inst.id), paused)).returning({ id: browserInstances.id }),
  ]);
  if (!resumed.length) return;
  await db.batch([
    db.insert(auditLog).values({ actor: 'engine', action: 'ip.network_resumed', target: `instance:${inst.id}`, detail: { commandId }, createdAt: at }),
    db.insert(events).values(eventRow(inst.userId, 'instance.updated', { instanceId: inst.id }, at)),
  ]);
  deps.notify(inst.userId);
}

/**
 * Every 5 minutes while running (page 3, "Verification"). Real agents check from inside Chrome on
 * their own and report; here the engine checks the provider-side binding and pauses the network if
 * the agent's last report saw another address, or no report has passed for 15 minutes. The fake
 * agent cannot report, so the engine runs the whole check for it.
 */
export async function periodicIpChecks(deps: EngineDeps) {
  const { db } = deps;
  const running = await db
    .select({ inst: browserInstances, placement: placements, health: instanceHealth })
    .from(browserInstances)
    .innerJoin(placements, and(eq(placements.instanceId, browserInstances.id), eq(placements.status, 'current')))
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
    .where(eq(browserInstances.status, 'running'));
  // One browser's provider or agent error must not skip the fail-closed check of the others.
  const failures: unknown[] = [];
  for (const { inst, placement, health } of running) {
    try {
      await checkOne(inst, placement, health);
    } catch (e) {
      failures.push(e);
    }
  }
  if (failures.length) throw new AggregateError(failures, `IP checks failed for ${failures.length} of ${running.length} browsers`);

  async function checkOne(inst: (typeof running)[number]['inst'], placement: (typeof running)[number]['placement'], health: (typeof running)[number]['health']) {
    const kind = placement.executor as ExecutorKind;
    if (!deps.agent(kind).selfReportsIpChecks) {
      await checkInstanceIp(deps, inst.id);
      return;
    }
    const binding = await deps.executor(kind).verifyEgress(readContext('ip-check', deps.envName), placementRef(placement));
    const last = health?.lastIpCheck;
    // A failed check that saw nothing does not count as a recent check: Chrome stopped answering.
    const stale = deps.now().getTime() - lastPassAt(last, health?.agentReadyAt) > IP_CHECK_STALE_MS;
    const incident = !binding.ok || sawOtherAddress(last);
    if (incident || stale) {
      const at = deps.now();
      await db.batch([
        ...pauseNetwork(deps, inst.id, { binding: binding.ok, lastCheck: last ?? null, stale }, at),
        db.insert(events).values(eventRow(inst.userId, 'instance.updated', { instanceId: inst.id }, at)),
      ]);
      await ipAlert(deps, inst.id, { binding: binding.ok, lastCheck: last ?? null, stale }, at, incident);
      deps.notify(inst.userId);
    }
  }
}


/** Kept for internal callers upgrading from older engine builds. Public daily snapshots are removed. */
export async function dailySnapshots(_deps: EngineDeps): Promise<number> {
  return 0;
}
