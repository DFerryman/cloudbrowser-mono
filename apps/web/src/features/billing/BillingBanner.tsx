import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { useMe } from '../instances/hooks.js';
import { useBilling } from './hooks.js';

/** One line above every page when billing needs attention (page 6: past due, ending, ended, hours). */
export function BillingBanner() {
  const { t, locale } = useI18n();
  const me = useMe();
  const billing = useBilling();
  const b = billing.data;
  const e = me.data?.entitlements;
  if (!b || !e) return null;
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale) : '—');
  const s = b.subscription;

  let message: string | null = null;
  let urgent = false;
  if (s?.access === 'grace') {
    message = t('banner.pastDue');
    urgent = true;
  } else if (s?.access === 'none' && b.dataKeptUntil) {
    message = t('banner.ended', { date: date(b.dataKeptUntil) });
    urgent = true;
  } else if (s?.access === 'ending' && s.status === 'scheduled_cancel') {
    message = t('banner.ending', { date: date(s.currentPeriodEnd) });
  } else if (b.hours.included !== null && b.hours.included > 0 && b.hours.used >= b.hours.included) {
    message = t('banner.hoursOut');
    urgent = true;
  } else if (b.hours.included !== null && b.hours.included > 0 && b.hours.used >= 0.8 * b.hours.included) {
    message = t('banner.hours80', { used: b.hours.used, included: b.hours.included });
  }
  if (!message) return null;
  return (
    <div role="status" className={urgent ? 'mb-4 rounded-[var(--radius-control)] border border-error/40 bg-error/10 px-3 py-2 text-sm' : 'mb-4 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-sm'}>
      {message}{' '}
      <Link to="/settings" className="font-medium text-accent hover:underline">
        {t('banner.manage')}
      </Link>
    </div>
  );
}
