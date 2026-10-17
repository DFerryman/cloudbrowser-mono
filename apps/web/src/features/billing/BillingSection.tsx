import { PLAN_PRICES, PRO_MAX_BROWSERS, PRO_MIN_BROWSERS, planFamily, type BillingState, type PlanKey } from '@cloudbrowser/contracts';
import { Button, cn, Input, Label, Section, Skeleton, useToast } from '@cloudbrowser/ui';
import { useEffect, useState } from 'react';
import { useI18n } from '../../lib/i18n.js';
import { useMe } from '../instances/hooks.js';
import { useBilling, useChangeBrowsers, useChangePlan, useCheckout, usePortal } from './hooks.js';

const money = (cents: number, locale: string) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

/** Plan and billing (page 6): plan choice, browsers, active hours, and the Creem customer portal. */
export function BillingSection() {
  const { t } = useI18n();
  const billing = useBilling();
  const me = useMe();
  if (billing.isPending || me.isPending) {
    return (
      <Section title={t('billing.title')}>
        <Skeleton className="h-24" />
      </Section>
    );
  }
  if (!billing.data || !me.data) return null;
  const b = billing.data;
  const hasPlan = b.subscription && b.subscription.access !== 'none';
  return (
    <Section title={t('billing.title')} description={hasPlan ? undefined : t('billing.intro')}>
      <Hours state={b} />
      {hasPlan ? <CurrentPlan state={b} /> : b.enabled ? <PlanPicker state={b} /> : <p className="text-sm text-muted">{t('billing.pilot')}</p>}
    </Section>
  );
}

function Hours({ state }: { state: BillingState }) {
  const { t } = useI18n();
  const { used, included } = state.hours;
  if (included === null) return <p className="mb-4 text-sm text-muted">{t('billing.hoursUnlimited', { used })}</p>;
  const pct = included > 0 ? Math.min(100, (used / included) * 100) : 100;
  return (
    <div className="mb-4">
      <div className="mb-1 flex justify-between text-sm">
        <span>{t('billing.hours')}</span>
        <span className={cn(pct >= 100 ? 'text-error' : pct >= 80 ? 'text-starting' : 'text-muted')}>{t('billing.hoursUsed', { used, included })}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-error' : pct >= 80 ? 'bg-starting' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function PlanPicker({ state }: { state: BillingState }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const checkout = useCheckout();
  const [yearly, setYearly] = useState(false);
  const [browsers, setBrowsers] = useState(PRO_MIN_BROWSERS);
  const personal: PlanKey = yearly ? 'personal_yearly' : 'personal_monthly';
  const pro: PlanKey = yearly ? 'pro_yearly' : 'pro_monthly';
  const per = yearly ? t('billing.perYear') : t('billing.perMonth');
  const go = (plan: PlanKey) => checkout.mutate({ plan, browsers: planFamily(plan) === 'pro' ? browsers : 1 }, { onError: (e) => toast(errorMessage(e), 'error') });

  return (
    <div>
      {state.dataKeptUntil ? <p className="mb-3 text-sm text-error">{t('billing.endedKept', { date: new Date(state.dataKeptUntil).toLocaleDateString(locale) })}</p> : null}
      <div className="mb-3 inline-flex rounded-[var(--radius-control)] border border-border p-0.5 text-sm" role="group">
        {[false, true].map((y) => (
          <button
            key={String(y)}
            type="button"
            aria-pressed={yearly === y}
            onClick={() => setYearly(y)}
            className={cn('rounded-[calc(var(--radius-control)-2px)] px-3 py-1', yearly === y ? 'bg-surface-2 font-medium' : 'text-muted')}
          >
            {y ? t('billing.yearly') : t('billing.monthly')}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col rounded-[var(--radius-card)] border border-border p-4">
          <h3 className="font-medium">{t('billing.personal')}</h3>
          <p className="mt-1 text-2xl font-semibold">
            {money(PLAN_PRICES[personal].cents, locale)}
            <span className="text-sm font-normal text-muted"> {per}</span>
          </p>
          <ul className="mt-3 flex-1 space-y-1 text-sm text-muted">
            <li>{t('billing.feature.browsers', { n: 1 })}</li>
            <li>{t('billing.feature.hours', { n: 60 })}</li>
            <li>{t('billing.feature.sleep', { n: 30 })}</li>
            <li>{t('billing.feature.storage', { n: 20 })}</li>
            <li>{t('billing.feature.backups', { n: 7 })}</li>
          </ul>
          <Button className="mt-4" variant="primary" disabled={checkout.isPending} onClick={() => go(personal)}>
            {t('billing.choose', { plan: t('billing.personal') })}
          </Button>
        </div>
        <div className="flex flex-col rounded-[var(--radius-card)] border border-border p-4">
          <h3 className="font-medium">{t('billing.pro')}</h3>
          <p className="mt-1 text-2xl font-semibold">
            {money(PLAN_PRICES[pro].cents, locale)}
            <span className="text-sm font-normal text-muted"> {t('billing.perBrowser')} {per}</span>
          </p>
          <ul className="mt-3 flex-1 space-y-1 text-sm text-muted">
            <li>{t('billing.feature.proBrowsers', { min: PRO_MIN_BROWSERS })}</li>
            <li>{t('billing.feature.proHours', { n: 60 })}</li>
            <li>{t('billing.feature.sleep', { n: 60 })}</li>
            <li>{t('billing.feature.storage', { n: 30 })}</li>
            <li>{t('billing.feature.backups', { n: 14 })}</li>
          </ul>
          <div className="mt-4 flex items-end gap-2">
            <div className="w-24">
              <Label htmlFor="pro-browsers">{t('billing.browsers')}</Label>
              <Input
                id="pro-browsers"
                type="number"
                min={PRO_MIN_BROWSERS}
                max={PRO_MAX_BROWSERS}
                value={browsers}
                onChange={(e) => setBrowsers(Math.min(PRO_MAX_BROWSERS, Math.max(PRO_MIN_BROWSERS, Number(e.target.value) || PRO_MIN_BROWSERS)))}
              />
            </div>
            <Button className="flex-1" variant="primary" disabled={checkout.isPending} onClick={() => go(pro)}>
              {t('billing.choose', { plan: t('billing.pro') })} · {money(PLAN_PRICES[pro].cents * browsers, locale)}
            </Button>
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">{t('billing.guarantee')}</p>
    </div>
  );
}

function CurrentPlan({ state }: { state: BillingState }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const me = useMe();
  const portal = usePortal();
  const changeBrowsers = useChangeBrowsers();
  const changePlan = useChangePlan();
  const s = state.subscription!;
  const pro = planFamily(s.plan) === 'pro';
  const [browsers, setBrowsers] = useState(s.browsers);
  useEffect(() => setBrowsers(s.browsers), [s.browsers]);
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale) : '—');
  const inUse = me.data?.usage.browsers ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          <span className="font-medium">{t(`billing.plan.${s.plan}`)}</span>
          {pro ? <span className="text-muted"> · {t('billing.browsersCount', { n: s.browsers })}</span> : null}
        </p>
        <p className={cn('text-sm', s.access === 'active' ? 'text-muted' : 'text-error')}>
          {s.access === 'grace'
            ? t('billing.status.grace')
            : s.access === 'ending'
              ? t('billing.status.ending', { date: date(s.currentPeriodEnd) })
              : t('billing.status.renews', { date: date(s.currentPeriodEnd) })}
        </p>
      </div>

      {pro ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-28">
            <Label htmlFor="browsers">{t('billing.browsers')}</Label>
            <Input
              id="browsers"
              type="number"
              min={Math.max(PRO_MIN_BROWSERS, inUse)}
              max={PRO_MAX_BROWSERS}
              value={browsers}
              onChange={(e) => setBrowsers(Math.min(PRO_MAX_BROWSERS, Math.max(PRO_MIN_BROWSERS, Number(e.target.value) || PRO_MIN_BROWSERS)))}
            />
          </div>
          <Button
            disabled={browsers === s.browsers || changeBrowsers.isPending}
            onClick={() =>
              changeBrowsers.mutate(browsers, {
                onSuccess: () => toast(t('billing.browsersSaved')),
                onError: (e) => toast(errorMessage(e), 'error'),
              })
            }
          >
            {browsers > s.browsers
              ? t('billing.addBrowsers', { n: browsers - s.browsers })
              : browsers < s.browsers
                ? t('billing.removeBrowsers', { n: s.browsers - browsers })
                : t('billing.changeBrowsers')}
          </Button>
          <p className="basis-full text-xs text-muted">{browsers < inUse ? t('billing.deleteFirst', { n: inUse }) : t('billing.proration')}</p>
        </div>
      ) : (
        <Button
          disabled={changePlan.isPending}
          onClick={() =>
            changePlan.mutate(
              { plan: s.plan.endsWith('yearly') ? 'pro_yearly' : 'pro_monthly', browsers: PRO_MIN_BROWSERS },
              { onSuccess: () => toast(t('billing.upgraded')), onError: (e) => toast(errorMessage(e), 'error') },
            )
          }
        >
          {t('billing.upgrade', { n: PRO_MIN_BROWSERS })}
        </Button>
      )}

      <div>
        <Button variant="ghost" disabled={portal.isPending} onClick={() => portal.mutate(undefined, { onError: (e) => toast(errorMessage(e), 'error') })}>
          {t('billing.manage')}
        </Button>
        <p className="mt-1 text-xs text-muted">{t('billing.manageBody')}</p>
      </div>
    </div>
  );
}
