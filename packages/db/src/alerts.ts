import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema.js';

type Db = DrizzleD1Database<typeof schema>;

export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * Raises an operator alert (page 10: "alerts go to email and a chat webhook"). Rows are delivered
 * by the api's cron and shown in /admin. With a `dedupeKey`, an alert that is still open is not
 * raised again. Also logs, so Workers Logs keep a copy.
 */
export async function raiseAlert(
  db: Db,
  input: { source: string; severity: AlertSeverity; title: string; detail?: Record<string, unknown>; dedupeKey?: string },
  now = new Date(),
): Promise<void> {
  console.error(`ALERT [${input.severity}] ${input.source}: ${input.title}`, JSON.stringify(input.detail ?? {}));
  if (input.dedupeKey) {
    const [open] = await db
      .select({ id: schema.alerts.id })
      .from(schema.alerts)
      .where(and(eq(schema.alerts.dedupeKey, input.dedupeKey), isNull(schema.alerts.acknowledgedAt)));
    if (open) return;
  }
  await db.insert(schema.alerts).values({ ...input, detail: input.detail ?? null, dedupeKey: input.dedupeKey ?? null, createdAt: now });
}
