import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { useBilling } from './hooks.js';

/** One line above every page when the balance needs attention (page 6). */
export function BillingBanner() {
  const { t, locale } = useI18n();
  const billing = useBilling();
  const b = billing.data;
  if (!b) return null;
  let message: string | null = null;
  let urgent = true;
  if (b.frozen) message = t('banner.frozen');
  else if (b.dataKeptUntil) message = t('banner.kept', { date: new Date(b.dataKeptUntil).toLocaleDateString(locale) });
  else if (b.exhaustedAt) message = t('banner.exhausted');
  else if ((b.availableMicros ?? 0) <= b.lowBalanceMicros) {
    message = t('banner.low', { amount: money(b.availableMicros ?? 0, locale) });
    urgent = false;
  }
  if (!message) return null;
  return (
    <div
      role="status"
      className={
        urgent
          ? 'mb-4 rounded-[var(--radius-control)] border border-error/40 bg-error/10 px-3 py-2 text-sm'
          : 'mb-4 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-sm'
      }
    >
      {message}{' '}
      {b.frozen ? null : (
        <Link to="/billing" className="font-medium text-accent hover:underline">
          {t('banner.manage')}
        </Link>
      )}
    </div>
  );
}
