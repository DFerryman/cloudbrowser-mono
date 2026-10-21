import type { BillingState, Instance } from '@cloudbrowser/contracts';
import type { Translate } from '../../lib/i18n.js';

export const minimumSpendBalance = (billing: BillingState) => Math.max(1, billing.minBalanceMicros);
export const canSpend = (billing: BillingState | undefined, additionalReserve = 0) => !!billing && !billing.frozen && billing.availableMicros >= minimumSpendBalance(billing) + additionalReserve;
export function canUseBrowser(billing: BillingState | undefined, instance: Instance) {
  if (!billing || billing.frozen) return false;
  return billing.availableMicros >= (instance.status === 'running' ? 1 : minimumSpendBalance(billing));
}
/**
 * Hours of available credit left at the account's combined spending rate (the same projection as
 * the 24, 6 and 1 hour warnings); null when nothing is being charged.
 */
export const fundedHours = (billing: BillingState, now = Date.now()) =>
  billing.fundedUntil ? Math.max(0, (Date.parse(billing.fundedUntil) - now) / 3_600_000) : null;
/** "45 minutes", "14 hours" or "3 days": how long remaining credit lasts. */
export const runwayLabel = (t: Translate, hours: number) =>
  hours < 1 ? t('billing.runway.minutes', { n: Math.max(1, Math.floor(hours * 60)) })
    : hours < 48 ? t('billing.runway.hours', { n: Math.floor(hours) })
      : t('billing.runway.days', { n: Math.floor(hours / 24) });
/** One rule for every low-credit warning: only where usage is paid, after available credit crosses the configured threshold. */
export const isLowBalance = (billing: BillingState) => billing.mode === 'prepaid' && billing.availableMicros <= billing.lowBalanceMicros;
