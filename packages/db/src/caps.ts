import { eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema.js';

type Db = DrizzleD1Database<typeof schema>;

/**
 * A user's limits come from three scopes, later ones winning: the pilot defaults (`user:default`),
 * what their subscription buys (`billing:<id>`, written by the api from Creem state, page 6) and
 * operator overrides (`user:<id>`). Shared by the api (admission) and the engine (enforcement).
 */
export async function userCaps(db: Db, userId: string): Promise<Map<string, number>> {
  const scopes = ['user:default', `billing:${userId}`, `user:${userId}`];
  const rows = await db.select().from(schema.caps).where(inArray(schema.caps.scope, scopes));
  const out = new Map<string, number>();
  for (const scope of scopes) for (const r of rows) if (r.scope === scope) out.set(r.metric, r.limit);
  const hasBilling = rows.some((r) => r.scope === `billing:${userId}`);
  if (!hasBilling && (await billingRequired(db))) {
    // Without a subscription, a paid deployment allows nothing (no free tier, page 6).
    out.set('instances', 0);
    out.set('running', 0);
  }
  return out;
}

/** Control flag `billing_required`: off for the invite-only pilot, on once plans are sold. */
export async function billingRequired(db: Db): Promise<boolean> {
  const [flag] = await db
    .select()
    .from(schema.controlFlags)
    .where(eq(schema.controlFlags.key, 'billing_required'));
  return flag?.value === 'true';
}

/** Calendar month (UTC) used for active hours. */
export const usageMonth = (d: Date) => d.toISOString().slice(0, 7);
