import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { fundedHours, isLowBalance, runwayLabel } from './access.js';
import { useBilling } from './hooks.js';

/** One line above every page when the balance needs attention (page 6). */
export function BillingBanner() {
  const { t, locale } = useI18n();
  const billing = useBilling();
  const b = billing.data;
  if (!b) return null;
  let message: string | null = null;
  let urgent = true;
  const hours = fundedHours(b);
  if (b.frozen) message = t('banner.frozen');
  else if (b.retained.length && b.restoreNeededMicros !== null) {
    message = t('banner.retained', { count: b.retained.length, date: new Date(b.retained[0]!.deletesAt).toLocaleString(locale), amount: money(b.restoreNeededMicros, locale) });
  } else if (b.dataKeptUntil) message = t('banner.kept', { date: new Date(b.dataKeptUntil).toLocaleDateString(locale) });
  else if (b.exhaustedAt) message = t('banner.exhausted');
  else if (b.mode === 'prepaid' && hours !== null && hours < 24) {
    message = t('banner.runway', { time: runwayLabel(t, hours), amount: money(b.availableMicros, locale) });
    urgent = hours < 6;
  } else if (isLowBalance(b)) {
    message = t('banner.low', { amount: money(b.availableMicros, locale) });
    urgent = false;
  }
  if (!message) return null;
  return (
    <div
      role="status"
      className={
        urgent
          ? 'mb-6 border-l-2 border-error bg-error/5 px-4 py-3 text-sm'
          : 'mb-6 border-l-2 border-fg bg-surface px-4 py-3 text-sm'
      }
    >
      {message}{' '}
      {b.frozen ? null : (
        <Link to="/billing" className="font-medium whitespace-nowrap text-accent underline-offset-4 hover:underline">
          {t('banner.manage')}
        </Link>
      )}
    </div>
  );
}
