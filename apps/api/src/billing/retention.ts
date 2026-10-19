import { pricingSettings, schema, type Db } from '@cloudbrowser/db';
import { and, asc, eq, isNotNull, ne, notInArray, sql } from 'drizzle-orm';

const { browserInstances, browserReservations, billingAccounts } = schema;

export interface RetentionState {
  /** Browsers kept after credit ran out, earliest deletion first. */
  retained: { id: string; name: string; regionId: string; deletesAt: Date }[];
  /** Sum of the seven-day deposits of every browser the account keeps. */
  depositsMicros: number;
  minBalanceMicros: number;
  /** The least top-up that ends retention (applyBalance's condition); null when nothing is retained. */
  restoreNeededMicros: number | null;
}

/**
 * What a user must know after credit runs out: which browsers will be deleted and when, and the
 * least top-up that keeps all of them. A top-up ends retention only when the balance covers every
 * kept browser's seven-day deposit plus the minimum balance (see applyBalance); browsers stay
 * asleep afterwards until the user resumes them.
 */
export async function retentionState(db: Db, userId: string): Promise<RetentionState> {
  const live = and(eq(browserInstances.userId, userId), ne(browserInstances.desiredState, 'deleted'), notInArray(browserInstances.status, ['deleting', 'purged', 'failed']));
  const [retained, [deposits], [account], settings] = await Promise.all([
    db.select({ id: browserInstances.id, name: browserInstances.name, regionId: browserInstances.regionId, deletesAt: browserReservations.retentionEndsAt })
      .from(browserReservations).innerJoin(browserInstances, eq(browserInstances.id, browserReservations.instanceId))
      .where(and(live, isNotNull(browserReservations.retentionStartedAt))).orderBy(asc(browserReservations.retentionEndsAt)),
    db.select({ micros: sql<number>`coalesce(sum(${browserReservations.requiredMicros}), 0)` })
      .from(browserReservations).innerJoin(browserInstances, eq(browserInstances.id, browserReservations.instanceId)).where(live),
    db.select({ balanceMicros: billingAccounts.balanceMicros }).from(billingAccounts).where(eq(billingAccounts.userId, userId)),
    pricingSettings(db),
  ]);
  const depositsMicros = Number(deposits?.micros ?? 0);
  const minBalanceMicros = Math.max(1, settings.minBalanceMicros);
  const kept = retained.filter((r): r is typeof r & { deletesAt: Date } => r.deletesAt !== null);
  return {
    retained: kept,
    depositsMicros,
    minBalanceMicros,
    restoreNeededMicros: kept.length ? Math.max(1, depositsMicros + minBalanceMicros - (account?.balanceMicros ?? 0)) : null,
  };
}
