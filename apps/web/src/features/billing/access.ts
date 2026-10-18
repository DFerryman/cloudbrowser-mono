import type { BillingState, Instance } from '@cloudbrowser/contracts';

/** Only the explicit remaining free-trial minutes waive the prepaid balance requirement. */
export const hasTrialTime = (instance: Instance) => instance.trial?.state === 'active' && instance.trial.secondsLeft > 0;
export const minimumSpendBalance = (billing: BillingState) => Math.max(1, billing.minBalanceMicros);
export const canSpend = (billing: BillingState | undefined, additionalReserve = 0) => !!billing && !billing.frozen && billing.availableMicros >= minimumSpendBalance(billing) + additionalReserve;
export function canUseBrowser(billing: BillingState | undefined, instance: Instance) {
  if (!billing || billing.frozen) return false;
  return hasTrialTime(instance) || billing.availableMicros >= (instance.status === 'running' ? 1 : minimumSpendBalance(billing));
}
/** One rule for every low-credit warning: only where usage is paid, and not before a new user's free trial. */
export const isLowBalance = (billing: BillingState) => billing.mode === 'prepaid' && !billing.trial.eligible && billing.availableMicros <= billing.lowBalanceMicros;
