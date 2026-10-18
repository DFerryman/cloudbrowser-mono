/**
 * Plan enforcement on running browsers (page 6, page 10), every minute from the engine's cron:
 *  - meters active (running) time per user and month into `active_usage`;
 *  - when the month's hours run out, records it (the session view shows a 10-minute warning) and
 *    puts the user's running browsers to sleep 10 minutes later;
 *  - puts suspended browsers to sleep (operator kill switch);
 *  - when a user may run no browsers at all (the subscription ended and the caps went to zero),
 *    puts every running browser to sleep within a minute.
 * Data and IPs are never touched here.
 */
import { eventRow, schema, usageMonth, userCaps } from '@cloudbrowser/db';
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { EngineDeps } from './context.js';
import { requestStop } from './scheduler.js';

const { browserInstances, instanceHealth, activeUsage, operations, events } = schema;

/** Running browsers sleep this long after the month's active hours run out. */
export const HOURS_GRACE_MS = 10 * 60_000;
/** A missed cron run is not billed beyond this. */
const MAX_METER_STEP_MS = 5 * 60_000;
const RUNNING = ['creating', 'starting', 'running', 'waiting_capacity'];

export async function meterAndEnforce(deps: EngineDeps) {
  const { db } = deps;
  const now = deps.now();
  const month = usageMonth(now);
  const summary = { metered: 0, stopped: 0 };

  const running = await db
    .select({
      id: browserInstances.id,
      userId: browserInstances.userId,
      status: browserInstances.status,
      suspendedAt: browserInstances.suspendedAt,
      meteredAt: instanceHealth.meteredAt,
    })
    .from(browserInstances)
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, browserInstances.id))
    .where(inArray(browserInstances.status, RUNNING));

  // Meter only `running` (the VM is up and the user can use it); creating/starting are not billed.
  const secondsByUser = new Map<string, number>();
  for (const r of running.filter((x) => x.status === 'running')) {
    const from = r.meteredAt ? r.meteredAt.getTime() : now.getTime();
    const step = Math.max(0, Math.min(MAX_METER_STEP_MS, now.getTime() - from));
    secondsByUser.set(r.userId, (secondsByUser.get(r.userId) ?? 0) + step / 1000);
    await db
      .insert(instanceHealth)
      .values({ instanceId: r.id, meteredAt: now })
      .onConflictDoUpdate({ target: instanceHealth.instanceId, set: { meteredAt: now } });
    summary.metered++;
  }
  // Browsers that are no longer running start a fresh metering window next time.
  await db
    .update(instanceHealth)
    .set({ meteredAt: null })
    .where(
      and(
        isNotNull(instanceHealth.meteredAt),
        notInArray(
          instanceHealth.instanceId,
          running.filter((x) => x.status === 'running').map((x) => x.id),
        ),
      ),
    );
  for (const [userId, secs] of secondsByUser) {
    const add = Math.round(secs);
    if (add <= 0) continue;
    await db
      .insert(activeUsage)
      .values({ userId, month, seconds: add })
      .onConflictDoUpdate({ target: [activeUsage.userId, activeUsage.month], set: { seconds: sql`${activeUsage.seconds} + ${add}` } });
  }

  const busy = new Set(
    (await db.select({ id: operations.instanceId }).from(operations).where(sql`${operations.finishedAt} IS NULL`)).map((r) => r.id),
  );
  const users = [...new Set(running.map((r) => r.userId))];
  for (const userId of users) {
    const caps = await userCaps(db, userId);
    const mine = running.filter((r) => r.userId === userId);
    const stoppable = mine.filter((r) => r.status === 'running' && !busy.has(r.id));

    // Suspended by an operator (abuse kill switch, page 10): sleep now.
    for (const r of stoppable.filter((x) => x.suspendedAt)) if (await requestStop(deps, r, 'suspended')) summary.stopped++;

    // Active hours (page 6): warn, then sleep 10 minutes later.
    const hours = caps.get('hours_per_month');
    if (hours !== undefined) {
      const [u] = await db.select().from(activeUsage).where(and(eq(activeUsage.userId, userId), eq(activeUsage.month, month)));
      if ((u?.seconds ?? 0) >= hours * 3600) {
        if (!u?.exhaustedAt) {
          await db.batch([
            db
              .insert(activeUsage)
              .values({ userId, month, seconds: u?.seconds ?? 0, exhaustedAt: now })
              .onConflictDoUpdate({ target: [activeUsage.userId, activeUsage.month], set: { exhaustedAt: now } }),
            db.insert(events).values(eventRow(userId, 'entitlements.updated', { hoursExhausted: true }, now)),
          ]);
          deps.notify(userId);
        } else if (now.getTime() - u.exhaustedAt.getTime() >= HOURS_GRACE_MS) {
          for (const r of stoppable) if (await requestStop(deps, r, 'hours')) summary.stopped++;
          continue;
        }
      }
    }

    // No running browsers allowed (the subscription ended or was revoked): all of them sleep now.
    // Lower non-zero caps are enforced at start, not here: a Pro plan can never drop below the
    // browsers in use, and a create may briefly run alongside another browser.
    if ((caps.get('running') ?? 0) === 0) {
      for (const r of stoppable) if (await requestStop(deps, r, 'plan')) summary.stopped++;
    }
  }
  return summary;
}
