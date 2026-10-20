import { TRIAL } from '@cloudbrowser/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema.js';

type Db = DrizzleD1Database<typeof schema>;

/**
 * A user's limits come from two scopes, the later one winning: the defaults (`user:default`) and
 * operator overrides (`user:<id>`). Shared by the api (admission) and the engine (enforcement).
 * What a user may spend is decided by their prepaid balance, not by caps (page 6).
 */
export async function userCaps(db: Db, userId: string): Promise<Map<string, number>> {
  const scopes = ['user:default', `user:${userId}`];
  const rows = await db.select().from(schema.caps).where(inArray(schema.caps.scope, scopes));
  const out = new Map<string, number>();
  for (const scope of scopes) for (const r of rows) if (r.scope === scope) out.set(r.metric, r.limit);
  return out;
}

/** The free trial's running time in minutes (operator cap user:default / trial_minutes). */
export async function trialMinutes(db: Db): Promise<number> {
  const [row] = await db.select().from(schema.caps).where(and(eq(schema.caps.scope, 'user:default'), eq(schema.caps.metric, 'trial_minutes')));
  const minutes = row?.limit ?? TRIAL.runningSeconds / 60;
  return Math.min(TRIAL.maxMinutes, Math.max(1, minutes));
}

/**
 * Control flag `billing_required`: off for the invite-only pilot (usage is metered and shown, but
 * free); on once usage is paid from the prepaid balance.
 */
export async function billingRequired(db: Db): Promise<boolean> {
  const [flag] = await db
    .select()
    .from(schema.controlFlags)
    .where(eq(schema.controlFlags.key, 'billing_required'));
  return flag?.value !== 'false';
}

/** Calendar month (UTC) of a date, e.g. 2026-10. */
export const usageMonth = (d: Date) => d.toISOString().slice(0, 7);
/** Calendar day (UTC) of a date, e.g. 2026-10-18. */
export const usageDay = (d: Date) => d.toISOString().slice(0, 10);
