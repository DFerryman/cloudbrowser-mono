import { UsageItem, type BillingState, type UsageTotals } from '@cloudbrowser/contracts';
import { Button, Card, cn, Section, Select, Skeleton, useToast } from '@cloudbrowser/ui';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../../app/AppShell.js';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { regionKey } from '../instances/status.js';
import { isLowBalance } from './access.js';
import { DailyCharges } from './DailyCharges.js';
import { currentMonth, monthLabel, recentMonths, useAccountUsage, useBilling, useCheckout, usePortal, useTransactions } from './hooks.js';

const ITEM_COLOR: Record<UsageItem, string> = {
  compute: 'bg-accent',
  ip: 'bg-running',
  storage: 'bg-starting',
  snapshot: 'bg-sleeping',
  transfer: 'bg-fg/60',
};

/**
 * Account-level billing (page 6): balance and top-ups, this month's spending across every browser,
 * credit history and how billing works. One browser's own usage is on its
 * Usage tab.
 */
export function BillingPage() {
  const { t } = useI18n();
  const billing = useBilling();
  const [month, setMonth] = useState(currentMonth());
  return (
    <>
      <PageHeader title={t('billing.title')} />
      {billing.isPending ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64" />
          <Skeleton className="h-64 lg:col-span-2" />
        </div>
      ) : billing.data ? (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <BalanceCard state={billing.data} />
            <MonthCard totals={billing.data.month} month={billing.data.month.month} className="lg:col-span-2" />
          </div>
          <UsageByBrowser month={month} setMonth={setMonth} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Transactions />
            <HowItWorks />
          </div>
        </div>
      ) : null}
    </>
  );
}

function runway(state: BillingState) {
  if (state.burnHourMicros <= 0 || state.availableMicros <= 0) return null;
  return state.availableMicros / state.burnHourMicros;
}

function BalanceCard({ state }: { state: BillingState }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const checkout = useCheckout();
  const portal = usePortal();
  const hours = runway(state);
  const m = (v: number) => money(v, locale);
  const alert = state.frozen
    ? t('billing.frozen')
    : state.dataKeptUntil
      ? t('billing.keptUntil', { date: new Date(state.dataKeptUntil).toLocaleDateString(locale) })
      : state.exhaustedAt
        ? t('billing.exhausted')
        : isLowBalance(state)
          ? t('billing.low')
          : null;

  return (
    <Card className="flex flex-col p-5">
      <h2 className="text-base font-semibold">{t('billing.balance')}</h2>
      <p className={cn('mt-2 text-3xl font-semibold tabular-nums', state.balanceMicros < 0 && 'text-error')}>{m(state.balanceMicros)}</p>
      <p className="mt-1 text-sm text-muted">{t('billing.balanceHint')}</p>
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">{t('billing.availableBalance')}</dt>
          <dd className={cn('tabular-nums', state.availableMicros <= 0 && 'text-error')}>{m(state.availableMicros)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">{t('billing.reservedBalance')}</dt>
          <dd className="tabular-nums">{m(state.reservedMicros)}</dd>
        </div>
      </dl>
      <p className="mt-1 text-xs text-muted">{t('billing.reserveHint')}</p>
      <div className="mt-3 space-y-1 text-sm">
        <p>{state.burnHourMicros > 0 ? t('billing.burn', { amount: m(state.burnHourMicros) }) : t('billing.burnNone')}</p>
        {hours !== null ? (
          <p className="text-muted">
            {t('billing.runway', { time: hours < 48 ? t('billing.runway.hours', { n: Math.floor(hours) }) : t('billing.runway.days', { n: Math.floor(hours / 24) }) })}
          </p>
        ) : null}
        <p className="text-xs text-muted">{t('billing.minBalance', { amount: m(state.minBalanceMicros) })}</p>
      </div>
      {alert ? (
        <p role="status" className="mt-3 flex gap-2 rounded-[var(--radius-control)] border border-error/40 bg-error/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-error" aria-hidden /> {alert}
        </p>
      ) : null}
      {state.trial.eligible ? (
        <div className="mt-3 rounded-[var(--radius-control)] border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
          <p>{t('trial.billingCta', { minutes: state.trial.minutes, region: t(regionKey(state.trial.regionId)) })}</p>
          <Link to="/browsers/new" className="mt-1 inline-block font-medium text-accent hover:underline">
            {t('trial.start')}
          </Link>
        </div>
      ) : null}

      <div className="mt-5 border-t border-border pt-4">
        {!state.enabled ? (
          <p className="mt-1 text-sm text-muted">{t('billing.unavailable')}</p>
        ) : state.topUps.length === 0 ? (
          <p className="mt-1 text-sm text-muted">{t('billing.noTopUps')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {state.topUps.map((p) => (
              <Button
                key={p.productId}
                variant="primary"
                className="justify-center"
                disabled={checkout.isPending || state.frozen}
                onClick={() => checkout.mutate(p.productId, { onError: (e) => toast(errorMessage(e), 'error') })}
              >
                {t('billing.topUp')}
              </Button>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-muted">{t('billing.topUpHint')}</p>
        {state.enabled ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 -ml-3"
            disabled={portal.isPending}
            onClick={() => portal.mutate(undefined, { onError: (e) => toast(errorMessage(e), 'error') })}
          >
            <ExternalLink /> {t('billing.receipts')}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** Spending by item for a month, as a stacked bar and a list. */
function ItemBreakdown({ totals }: { totals: UsageTotals }) {
  const { t, locale } = useI18n();
  const items = UsageItem.options.filter((item) => item !== 'snapshot' || totals.byItem.snapshot !== 0);
  return (
    <div>
      {totals.totalMicros > 0 ? (
        <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          {items.map((i) => (
            <div key={i} className={ITEM_COLOR[i]} style={{ width: `${(totals.byItem[i] / totals.totalMicros) * 100}%` }} />
          ))}
        </div>
      ) : null}
      <dl className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i} className="flex items-center justify-between gap-3 text-sm">
            <dt className="flex items-center gap-2 text-muted">
              <span className={cn('size-2.5 rounded-sm', ITEM_COLOR[i])} aria-hidden />
              {t(`billing.item.${i}`)}
            </dt>
            <dd className="tabular-nums">{money(totals.byItem[i], locale)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function MonthCard({ totals, month, className }: { totals: UsageTotals; month: string; className?: string }) {
  const { t, locale } = useI18n();
  const usage = useAccountUsage(month);
  const days = usage.data?.byDay ?? [];
  return (
    <Card className={cn('p-5', className)}>
      <h2 className="text-base font-semibold">{t('billing.thisMonth')}</h2>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{money(totals.totalMicros, locale)}</p>
      <p className="mt-1 text-sm text-muted">{monthLabel(month, locale)}</p>
      <div className="mt-4">
        <ItemBreakdown totals={totals} />
      </div>
      <DailyCharges days={days} />
    </Card>
  );
}

function UsageByBrowser({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const { t, locale } = useI18n();
  const usage = useAccountUsage(month);
  const rows = usage.data?.byBrowser ?? [];
  const items = UsageItem.options.filter((item) => item !== 'snapshot' || rows.some((row) => row.byItem.snapshot !== 0));
  return (
    <Section title={t('billing.byBrowser')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{usage.data ? t('billing.monthTotal', { amount: money(usage.data.totalMicros, locale), month: monthLabel(month, locale) }) : ''}</p>
        <div className="w-48"><Select aria-label={t('usage.monthLabel')} value={month} onChange={(e) => setMonth(e.target.value)}>
          {recentMonths().map((mo) => (
            <option key={mo} value={mo}>
              {monthLabel(mo, locale)}
            </option>
          ))}
        </Select></div>
      </div>
      {usage.isPending ? (
        <Skeleton className="h-24" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('billing.byBrowserEmpty')}</p>
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-medium">{t('settings.name')}</th>
                  {items.map((i) => (
                    <th key={i} className="py-2 pr-3 text-right font-medium">
                      {t(`billing.item.${i}`)}
                    </th>
                  ))}
                  <th className="py-2 text-right font-medium">{t('usage.col.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.instanceId}>
                    <td className="py-2 pr-3">
                      <BrowserName {...r} />
                    </td>
                    {items.map((i) => (
                      <td key={i} className="py-2 pr-3 text-right tabular-nums text-muted">
                        {money(r.byItem[i], locale)}
                      </td>
                    ))}
                    <td className="py-2 text-right font-medium tabular-nums">{money(r.totalMicros, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border md:hidden">
            {rows.map((r) => (
              <li key={r.instanceId} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <BrowserName {...r} />
                  <span className="font-medium tabular-nums">{money(r.totalMicros, locale)}</span>
                </div>
                <ItemBreakdown totals={r} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function BrowserName({ instanceId, name, regionId, deleted }: { instanceId: string; name: string; regionId: Parameters<typeof regionKey>[0]; deleted: boolean }) {
  const { t } = useI18n();
  return (
    <span className="min-w-0">
      {deleted ? (
        <span className="font-medium">{name}</span>
      ) : (
        <Link to={`/browsers/${instanceId}/usage`} className="font-medium text-accent hover:underline">
          {name}
        </Link>
      )}
      <span className="text-xs text-muted">
        {' '}
        · {t(regionKey(regionId))}
        {deleted ? ` · ${t('billing.deletedBrowser')}` : ''}
      </span>
    </span>
  );
}

function Transactions() {
  const { t, locale } = useI18n();
  const tx = useTransactions();
  return (
    <Section title={t('billing.transactions')}>
      {tx.isPending ? (
        <Skeleton className="h-16" />
      ) : !tx.data?.length ? (
        <p className="text-sm text-muted">{t('billing.noTransactions')}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {tx.data.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                {t(`billing.tx.${x.kind}`)}
                <span className="text-muted">
                  {' '}
                  · {new Date(x.createdAt).toLocaleDateString(locale)}
                  {x.description && x.kind !== 'topup' ? ` · ${x.description}` : ''}
                </span>
              </span>
              <span className={cn('shrink-0 tabular-nums', x.amountMicros < 0 ? 'text-error' : 'text-running')}>
                {x.amountMicros > 0 ? '+' : ''}
                {money(x.amountMicros, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function HowItWorks() {
  const { t } = useI18n();
  return (
    <Section title={t('billing.how')}>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
        <li>{t('billing.how.1')}</li>
        <li>{t('billing.how.2')}</li>
        <li>{t('billing.how.3')}</li>
      </ol>
    </Section>
  );
}
