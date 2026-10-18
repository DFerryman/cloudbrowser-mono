import type { BillingState, Instance } from '@cloudbrowser/contracts';

/** Only the explicit remaining free-trial minutes waive the prepaid balance requirement. */
export const hasTrialTime = (instance: Instance) => instance.trial?.state === 'active' && instance.trial.secondsLeft > 0;
export const minimumSpendBalance = (billing: BillingState) => Math.max(1, billing.minBalanceMicros);
export const canSpend = (billing: BillingState | undefined, additionalReserve = 0) => !!billing && !billing.frozen && billing.availableMicros >= minimumSpendBalance(billing) + additionalReserve;
export function canUseBrowser(billing: BillingState | undefined, instance: Instance) {
  if (!billing || billing.frozen) return false;
  return hasTrialTime(instance) || billing.availableMicros >= (instance.status === 'running' ? 1 : minimumSpendBalance(billing));
}
