import type { Instance } from '@cloudbrowser/contracts';
import { StatusBadge } from '@cloudbrowser/ui';
import { Gift } from 'lucide-react';
import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';

type Trial = NonNullable<Instance['trial']>;

const minutesLeft = (trial: Trial) => Math.max(0, Math.ceil(trial.secondsLeft / 60));

/** Marks the free trial browser, with the minutes left or the date it is deleted (page 6). */
export function TrialBadge({ trial, className }: { trial: Instance['trial']; className?: string }) {
  const { t, locale } = useI18n();
  if (!trial || trial.state === 'converted') return null;
  const label =
    trial.state === 'active'
      ? t('trial.badgeActive', { minutes: minutesLeft(trial) })
      : t('trial.badgeEnded', { date: trial.reclaimAt ? new Date(trial.reclaimAt).toLocaleDateString(locale) : '…' });
  return <StatusBadge className={className} tone={trial.state === 'active' ? 'running' : 'waiting'} icon={Gift} label={label} />;
}

/** What happens to the trial browser and how to keep it, on its management pages. */
export function TrialNotice({ trial }: { trial: Instance['trial'] }) {
  const { t, locale } = useI18n();
  if (!trial || trial.state === 'converted') return null;
  const body =
    trial.state === 'active'
      ? t('trial.activeBody', { minutes: minutesLeft(trial) })
      : t('trial.endedBody', { date: trial.reclaimAt ? new Date(trial.reclaimAt).toLocaleDateString(locale) : '…' });
  return (
    <p role="status" className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-control)] border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
      <Gift className="size-4 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1">{body}</span>
      <Link to="/billing" className="font-medium text-accent hover:underline">
        {t('create.addCredit')}
      </Link>
    </p>
  );
}
