import { schema, type Db } from '@cloudbrowser/db';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

const { operations } = schema;

/** EBS permits four modifications per rolling 24 hours, after the previous one completes. */
export const RESIZE_WINDOW_MS = 24 * 3_600_000;
const RESIZE_WINDOW_LIMIT = 4;

// A cancelled/failed call can still have been accepted by AWS. Count every admitted attempt,
// through its last activity, so losing a response or cancelling cannot reset the AWS quota.
const resizeActivity = sql<number>`max(${operations.createdAt}, coalesce(${operations.finishedAt}, ${operations.updatedAt}))`;
const recentResizes = (instanceId: string, now: Date) => and(
  eq(operations.instanceId, instanceId), eq(operations.kind, 'resize_volume'),
  gte(resizeActivity, now.getTime() - RESIZE_WINDOW_MS),
);

/** Used inside operation admission's transaction as well as the public preflight check. */
export function resizeAdmission(instanceId: string, now: Date) {
  return sql`(select count(*) from ${operations} where ${recentResizes(instanceId, now)}) < ${RESIZE_WINDOW_LIMIT}`;
}

export async function resizeQuota(db: Db, instanceId: string, now = new Date()) {
  const attempts = await db.select({ at: resizeActivity }).from(operations)
    .where(recentResizes(instanceId, now)).orderBy(desc(resizeActivity)).limit(RESIZE_WINDOW_LIMIT);
  return attempts.length < RESIZE_WINDOW_LIMIT ? null : new Date(attempts[RESIZE_WINDOW_LIMIT - 1]!.at + RESIZE_WINDOW_MS + 1);
}
