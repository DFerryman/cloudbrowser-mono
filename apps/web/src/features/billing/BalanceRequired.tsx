import type { Instance } from '@cloudbrowser/contracts';
import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { canSpend, canUseBrowser, minimumSpendBalance } from './access.js';
import { useBilling } from './hooks.js';

export function BalanceRequired({ instance, additionalReserve = 0 }: { instance?: Instance; additionalReserve?: number }) {
  const { t, locale } = useI18n();
  const { data: billing } = useBilling();
  if (!billing || (instance ? canUseBrowser(billing, instance) : canSpend(billing, additionalReserve))) return null;
  return (
    <p role="status" className="my-2 text-sm text-error">
      {billing.frozen ? t('billing.frozen') : <>
        {t(instance ? 'billing.useNeedsCredit' : 'billing.actionNeedsCredit', { amount: money(minimumSpendBalance(billing) + additionalReserve, locale) })}{' '}
        <Link to="/billing" className="font-medium text-accent hover:underline">{t('create.addCredit')}</Link>
      </>}
    </p>
  );
}
