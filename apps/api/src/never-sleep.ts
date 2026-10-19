import { browserEstimate, HOURS_PER_MONTH, MICROS_PER_USD, type NeverSleepQuote } from '@cloudbrowser/contracts';
import { accountRunway, billingRequired, schema, type Db } from '@cloudbrowser/db';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { entitlementsFor, isTrial } from './limits.js';
import { instancePrice } from './pricing.js';
import { problem } from './problem.js';

const { balanceTransactions } = schema;
type InstanceRow = typeof schema.browserInstances.$inferSelect;

const usd = (micros: number) => `$${(micros / MICROS_PER_USD).toFixed(2)}`;

/**
 * Never sleep (page 6) is offered where the operator allows it (`never_sleep` cap), never to a free
 * trial browser, and on a paid deployment only after a top-up and with available credit for 24
 * hours of the account's spending with this browser always on. The quote is what the user confirms.
 */
export async function neverSleepQuote(db: Db, userId: string, inst: InstanceRow, now = new Date()): Promise<NeverSleepQuote> {
  const [entitlements, price, paid, runway] = await Promise.all([
    entitlementsFor(db, userId),
    instancePrice(db, inst.id, inst.regionId),
    billingRequired(db),
    accountRunway(db, userId, now),
  ]);
  const estimate = price ? browserEstimate(price.rates, { storageGb: inst.storageGb, rootVolumeGb: price.sheet.rootVolumeGb, backups: false }) : null;
  const computeMicros = (estimate?.runningHour ?? 0) * 24;
  const ipMicros = (price?.rates.ip ?? 0) * 24;
  const storageMicros = estimate ? Math.round(estimate.storageMonth * 24 / HOURS_PER_MONTH) : 0;
  // Everything the account spends now, plus this browser's compute if it is not already running.
  const hourWithBrowser = runway.burnHourMicros + (inst.status === 'running' ? 0 : estimate?.runningHour ?? 0);
  const requiredMicros = Math.ceil(hourWithBrowser * 24) + (runway.availableMicros - runway.remainingMicros);
  const quote = (reason: NeverSleepQuote['reason']): NeverSleepQuote => ({
    allowed: reason === null,
    reason,
    regionId: inst.regionId as NeverSleepQuote['regionId'],
    priceVersion: price?.version ?? null,
    day: { computeMicros, ipMicros, storageMicros, totalMicros: computeMicros + ipMicros + storageMicros },
    availableMicros: runway.availableMicros,
    requiredMicros,
  });
  if (!entitlements.neverSleep) return quote('disabled');
  if (isTrial(inst)) return quote('trial');
  if (!price) return quote('price_unavailable');
  // The free pilot charges nothing, so there is no credit to check.
  if (!paid) return quote(null);
  const [topUp] = await db.select({ id: balanceTransactions.id }).from(balanceTransactions)
    .where(and(eq(balanceTransactions.userId, userId), eq(balanceTransactions.kind, 'topup'), gt(balanceTransactions.amountMicros, 0), isNotNull(balanceTransactions.appliedAt)))
    .limit(1);
  if (!topUp) return quote('no_topup');
  return quote(runway.availableMicros >= requiredMicros ? null : 'insufficient_credit');
}

/** The refusal for a quote that does not allow Never sleep. */
export function neverSleepRefused(q: NeverSleepQuote) {
  switch (q.reason) {
    case 'disabled':
      return problem(403, 'plan_limit', 'Never sleep is not available on this account.', { limit: 'never_sleep' });
    case 'trial':
      return problem(403, 'plan_limit', 'A free trial browser always goes to sleep when idle. Add credit to convert it, then turn on Never sleep.', { limit: 'never_sleep_trial' });
    case 'no_topup':
      return problem(402, 'insufficient_balance', 'Never sleep is available after your first top-up.', { limit: 'never_sleep_topup' });
    case 'insufficient_credit':
      return problem(402, 'insufficient_balance',
        `Never sleep needs ${usd(q.requiredMicros)} of available credit, enough for 24 hours of your browsers with this one always on. You have ${usd(q.availableMicros)}.`,
        { limit: 'never_sleep_credit' });
    default:
      return problem(503, 'price_unavailable', 'Prices for this region are being updated. Try again in a few minutes.');
  }
}
