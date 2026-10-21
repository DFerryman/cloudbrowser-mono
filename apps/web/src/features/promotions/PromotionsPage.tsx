import { PROMOTION_UNIT, type PromotionTask } from '@cloudbrowser/contracts';
import { Button, Card, cn, Eyebrow, Section, Skeleton } from '@cloudbrowser/ui';
import { ArrowRight, Check, Gift } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '../../app/AppShell.js';
import { useI18n, type Translate } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { usePromotions } from './hooks.js';

/**
 * Promotions: tasks that show users around the product and pay credit into their balance. The
 * operator configures them in the console; completion is detected automatically.
 */
export function PromotionsPage() {
  const { t, locale } = useI18n();
  const tasks = usePromotions();
  const pending = tasks.data?.filter((x) => x.status === 'pending') ?? [];
  const completed = tasks.data?.filter((x) => x.status === 'completed') ?? [];
  const toEarn = pending.reduce((sum, x) => sum + x.rewardMicros, 0);
  const earned = completed.reduce((sum, x) => sum + x.rewardMicros, 0);
  return (
    <>
      <PageHeader title={t('promotions.title')} description={t('promotions.description')} />
      {tasks.isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      ) : tasks.isError ? (
        <p className="text-sm text-error">{t('promotions.error')}</p>
      ) : (
        <div className="space-y-4">
          <Card className="grid grid-cols-2 divide-x divide-border">
            <div className="p-5 md:p-6">
              <Eyebrow>{t('promotions.toEarn')}</Eyebrow>
              <p className="mt-2.5 text-[28px] leading-none font-semibold tracking-[-0.02em] tabular-nums">{money(toEarn, locale)}</p>
            </div>
            <div className="p-5 md:p-6">
              <Eyebrow>{t('promotions.earned')}</Eyebrow>
              <p className="mt-2.5 text-[28px] leading-none font-semibold tracking-[-0.02em] tabular-nums">{money(earned, locale)}</p>
            </div>
          </Card>

          <Section title={t('promotions.pending')} description={t('promotions.autoNote')}>
            {pending.length ? (
              <ul className="divide-y divide-border">
                {pending.map((task) => <PendingTask key={task.id} task={task} />)}
              </ul>
            ) : (
              <p className="py-2 text-sm text-muted" data-testid="promotions-empty">{completed.length ? t('promotions.allDone') : t('promotions.empty')}</p>
            )}
          </Section>

          {completed.length ? (
            <Section title={t('promotions.completed')}>
              <ul className="divide-y divide-border">
                {completed.map((task) => (
                  <li key={task.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center bg-running/15 text-running" aria-hidden>
                      <Check className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{task.title[locale]}</p>
                      <p className="mt-0.5 text-xs text-subtle">
                        {t('promotions.credited', { amount: money(task.rewardMicros, locale), date: task.completedAt ? new Date(task.completedAt).toLocaleDateString(locale) : '' })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      )}
    </>
  );
}

function PendingTask({ task }: { task: PromotionTask }) {
  const { t, locale } = useI18n();
  const pct = task.target ? Math.min(100, Math.round((task.progress / task.target) * 100)) : 0;
  return (
    <li className="flex flex-col gap-4 py-5 first:pt-1 last:pb-1 sm:flex-row sm:items-start" data-testid={`promotion-${task.id}`}>
      <span className="hidden size-9 shrink-0 place-items-center bg-fg/[0.06] text-fg sm:grid" aria-hidden>
        <Gift className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[15px] font-semibold tracking-tight">{task.title[locale]}</h3>
          <span className="bg-running/15 px-1.5 py-0.5 text-xs font-semibold text-running tabular-nums">{t('promotions.reward', { amount: money(task.rewardMicros, locale) })}</span>
        </div>
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted">{task.description[locale]}</p>
        <div className="mt-4 max-w-md">
          <div className="flex items-center justify-between text-xs text-subtle tabular-nums">
            <span>{progressLabel(t, task)}</span>
            <span>{pct}%</span>
          </div>
          <div className="mt-1.5 h-1 bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={task.target} aria-valuenow={task.progress} aria-label={task.title[locale]}>
            <div className={cn('h-full bg-fg transition-[width] duration-300')} style={{ width: `${pct}%` }} />
          </div>
        </div>
        {task.needsTopup ? <p className="mt-3 text-xs text-starting">{t('promotions.needsTopup')}</p> : null}
        {task.topupToUnlockMicros > 0 ? (
          <p className="mt-3 text-xs text-starting">{t('promotions.topupToUnlock', { amount: money(task.topupToUnlockMicros, locale) })}</p>
        ) : null}
        {task.endsAt ? <p className="mt-2 text-xs text-subtle">{t('promotions.endsAt', { date: new Date(task.endsAt).toLocaleString(locale) })}</p> : null}
      </div>
      {task.needsTopup || (task.topupToUnlockMicros > 0 && task.progress >= task.target) ? (
        <Link to="/billing#top-up" className="shrink-0">
          <Button>{t('nav.addCredit')}</Button>
        </Link>
      ) : task.actionUrl ? (
        <Link to={task.actionUrl} className="shrink-0">
          <Button variant="primary">
            {t('promotions.start')} <ArrowRight />
          </Button>
        </Link>
      ) : null}
    </li>
  );
}

function progressLabel(t: Translate, task: PromotionTask) {
  const vars = { progress: task.progress, target: task.target };
  switch (PROMOTION_UNIT[task.criterion]) {
    case 'minutes':
      return t('promotions.progress.minutes', vars);
    case 'browsers':
      return t('promotions.progress.browsers', vars);
    case 'usd':
      return t('promotions.progress.usd', vars);
    case 'passkeys':
      return t('promotions.progress.passkeys', vars);
    case 'days':
      return t('promotions.progress.days', vars);
    case 'regions':
      return t('promotions.progress.regions', vars);
    case 'times':
      return t('promotions.progress.times', vars);
    case 'topups':
      return t('promotions.progress.topups', vars);
    case 'step':
      return t(task.progress >= task.target ? 'promotions.progress.done' : 'promotions.progress.notYet');
  }
}
