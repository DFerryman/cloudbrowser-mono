import { UsageItem, type BillingState, type UsageTotals } from '@cloudbrowser/contracts';
import { Button, Card, cn, Eyebrow, Hint, Pagination, Section, Select, Skeleton, usePaged, useToast } from '@cloudbrowser/ui';
import { AlertTriangle, ExternalLink, Gift } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../../app/AppShell.js';
import { DocsLink } from '../../app/DocsLink.js';
import { useI18n } from '../../lib/i18n.js';
import { PAGE_SIZE, usePagerLabels } from '../../lib/paging.js';
import { cents, money } from '../../lib/money.js';
import { useRegionInfo } from '../instances/hooks.js';
import { fundedHours, isLowBalance, runwayLabel } from './access.js';
import { DailyCharges } from './DailyCharges.js';
import { currentMonth, monthLabel, recentMonths, useAccountUsage, useBilling, useCheckout, usePortal, useTransactions } from './hooks.js';
import { LoadError } from '../../app/LoadError.js';

/** One ramp of the accent, strongest for the largest item, so the breakdown reads as one family. */
const ITEM_COLOR: Record<UsageItem, string> = {
  compute: 'bg-chart-1',
  ip: 'bg-chart-2',
  storage: 'bg-chart-3',
  snapshot: 'bg-border-strong',
  transfer: 'bg-chart-4',
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
      <PageHeader title={t('billing.title')} action={<DocsLink to="billing" label={t('billing.howLink')} />} />
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
          <Transactions />
        </div>
      ) : (
        <LoadError error={billing.error} onRetry={() => void billing.refetch()} />
      )}
    </>
  );
}

/**
 * After credit runs out: each stopped browser with its deletion time, and the exact top-up that
 * keeps all of them. Browsers stay asleep after topping up; the user resumes each one.
 */
function RetainedBrowsers({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  return (
    <div className="mt-4 border-l-2 border-error bg-error/5 px-3 py-2.5 text-sm" data-testid="retained-browsers">
      <p className="font-medium">{t('billing.retainedTitle')}</p>
      <ul className="mt-1.5 space-y-1">
        {state.retained.map((b) => (
          <li key={b.id} className="flex flex-wrap justify-between gap-x-3">
            <span className="truncate">{b.name}</span>
            <span className="tabular-nums text-error">{t('billing.retainedDeletes', { date: new Date(b.deletesAt).toLocaleString(locale) })}</span>
          </li>
        ))}
      </ul>
      {state.restoreNeededMicros !== null ? (
        <p className="mt-2">{t('billing.restoreNeeded', { amount: money(state.restoreNeededMicros, locale) })}</p>
      ) : null}
      <Hint className="mt-1">{t('billing.restoreResume')}</Hint>
    </div>
  );
}

function BalanceCard({ state }: { state: BillingState }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const checkout = useCheckout();
  const portal = usePortal();
  const hours = fundedHours(state);
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
  const topUp = (productId: string) => checkout.mutate(productId, { onError: (e) => toast(errorMessage(e), 'error') });

  return (
    <Card id="top-up" className="flex scroll-mt-6 flex-col p-5 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <Eyebrow as="h2">{t('billing.balance')}</Eyebrow>
        {state.enabled ? (
          <Button variant="ghost" size="sm" className="-mt-1 -mr-2 text-muted" disabled={portal.isPending} onClick={() => portal.mutate(undefined, { onError: (e) => toast(errorMessage(e), 'error') })}>
            <ExternalLink /> {t('billing.receipts')}
          </Button>
        ) : null}
      </div>
      <p className={cn('mt-4 text-[44px] leading-none font-semibold tracking-[-0.03em] tabular-nums', state.balanceMicros < 0 && 'text-error')}>{m(state.balanceMicros)}</p>
      <dl className="mt-6 grid grid-cols-2 border-t border-border text-sm">
        <div className="border-r border-border py-3 pr-3">
          <dt className="text-xs text-subtle">{t('billing.availableBalance')}</dt>
          <dd className={cn('mt-0.5 text-base font-semibold tabular-nums', state.availableMicros <= 0 && state.mode === 'prepaid' && 'text-error')}>{m(state.availableMicros)}</dd>
        </div>
        <div className="py-3 pl-4">
          <dt className="text-xs text-subtle">{t('billing.reservedBalance')}</dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums">{m(state.reservedMicros)}</dd>
        </div>
      </dl>
      <Hint className="border-t border-border pt-3">
        {t('billing.reserveHint')} <DocsLink to="billing#held" />
      </Hint>

      <div className="mt-6 mb-6">
        {!state.enabled ? (
          <p className="text-sm text-muted">{t('billing.unavailable')}</p>
        ) : state.topUps.length === 0 ? (
          <p className="text-sm text-muted">{t('billing.noTopUps')}</p>
        ) : state.topUps.length === 1 ? (
          <Button variant="primary" className="w-full justify-center" disabled={checkout.isPending || state.frozen} onClick={() => topUp(state.topUps[0]!.productId)}>
            {t('billing.topUp')}
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {state.topUps.map((p) => (
              <Button key={p.productId} variant="secondary" className="justify-center tabular-nums" disabled={checkout.isPending || state.frozen} onClick={() => topUp(p.productId)}>
                {money(cents(p.amountCents), locale)}
              </Button>
            ))}
          </div>
        )}
        {state.enabled && state.topUps.length ? <Hint className="mt-2">{t('billing.topUpHint')}</Hint> : null}
      </div>

      {alert ? (
        <p role="status" className="mt-4 flex gap-2 border-l-2 border-error bg-error/5 px-3 py-2.5 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-error" aria-hidden /> {alert}
        </p>
      ) : null}
      {state.retained.length ? <RetainedBrowsers state={state} /> : null}
      <div className="mt-auto space-y-1 border-t border-border pt-4 text-sm">
        <p>{state.burnHourMicros > 0 ? t('billing.burnShort', { amount: m(state.burnHourMicros) }) : t('billing.burnNone')}</p>
        {hours !== null ? (
          <p className="text-muted">
            {t('billing.runway', { time: runwayLabel(t, hours) })}
          </p>
        ) : null}
        <Hint>{t('billing.minBalance', { amount: m(state.minBalanceMicros) })}</Hint>
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
        <div className="flex h-2 gap-px overflow-hidden bg-surface-2" aria-hidden>
          {items.map((i) => (
            <div key={i} className={cn('transition-[width] duration-500 ease-out', ITEM_COLOR[i])} style={{ width: `${(totals.byItem[i] / totals.totalMicros) * 100}%` }} />
          ))}
        </div>
      ) : null}
      <dl className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i} className="flex items-center justify-between gap-3 text-sm">
            <dt className="flex items-center gap-2 text-muted">
              <span className={cn('size-2', ITEM_COLOR[i])} aria-hidden />
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
    <Card className={cn('p-5 md:p-6', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow as="h2">{t('billing.thisMonth')}</Eyebrow>
        <p className="text-xs text-subtle">{monthLabel(month, locale)}</p>
      </div>
      <p className="mt-4 text-[44px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{money(totals.totalMicros, locale)}</p>
      <div className="mt-8">
        <ItemBreakdown totals={totals} />
      </div>
      <DailyCharges days={days} />
    </Card>
  );
}

function UsageByBrowser({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const { t, locale } = useI18n();
  const usage = useAccountUsage(month);
  const all = usage.data?.byBrowser ?? [];
  const items = UsageItem.options.filter((item) => item !== 'snapshot' || all.some((row) => row.byItem.snapshot !== 0));
  const { rows, page, pages, setPage } = usePaged(all, PAGE_SIZE.usageByBrowser);
  const pagerLabels = usePagerLabels();
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
      ) : !usage.data ? (
        <LoadError error={usage.error} onRetry={() => void usage.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('billing.byBrowserEmpty')}</p>
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] tracking-[0.1em] text-subtle uppercase">
                <tr className="border-b border-border">
                  <th className="py-2.5 pr-3 font-semibold">{t('settings.name')}</th>
                  {items.map((i) => (
                    <th key={i} className="py-2.5 pr-3 text-right font-semibold">
                      {t(`billing.item.${i}`)}
                    </th>
                  ))}
                  <th className="py-2.5 text-right font-semibold">{t('usage.col.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.instanceId}>
                    <td className="py-3 pr-3">
                      <BrowserName {...r} />
                    </td>
                    {items.map((i) => (
                      <td key={i} className="py-3 pr-3 text-right tabular-nums text-muted">
                        {money(r.byItem[i], locale)}
                      </td>
                    ))}
                    <td className="py-3 text-right font-medium tabular-nums">{money(r.totalMicros, locale)}</td>
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
          <Pagination page={page} pages={pages} onPage={setPage} labels={pagerLabels} />
        </>
      )}
    </Section>
  );
}

function BrowserName({ instanceId, name, regionId, deleted }: { instanceId: string; name: string; regionId: string; deleted: boolean }) {
  const { t } = useI18n();
  const region = useRegionInfo(regionId);
  return (
    <span className="min-w-0">
      {deleted ? (
        <span className="font-medium">{name}</span>
      ) : (
        <Link to={`/browsers/${instanceId}/usage`} className="font-medium underline-offset-4 hover:underline">
          {name}
        </Link>
      )}
      <span className="text-xs text-subtle">
        {' '}
        · {region.name}
        {deleted ? ` · ${t('billing.deletedBrowser')}` : ''}
      </span>
    </span>
  );
}

function Transactions() {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(0);
  const tx = useTransactions(page, PAGE_SIZE.transactions);
  const pagerLabels = usePagerLabels(false);
  return (
    <Section title={t('billing.transactions')}>
      {tx.isPending ? (
        <Skeleton className="h-16" />
      ) : !tx.rows ? (
        <LoadError error={tx.error} onRetry={() => void tx.refetch()} />
      ) : !tx.rows.length ? (
        <p className="text-sm text-muted">{t('billing.noTransactions')}</p>
      ) : (
        <ul className={cn('divide-y divide-border text-sm transition-opacity', tx.isPlaceholderData && 'opacity-60')}>
          {tx.rows.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-3 py-3">
              <span className="min-w-0">
                {t(`billing.tx.${x.kind}`)}
                <span className="text-subtle">
                  {' '}
                  · {new Date(x.createdAt).toLocaleDateString(locale)}
                  {x.description && x.kind !== 'topup' ? ` · ${x.description}` : ''}
                </span>
              </span>
              <span className={cn('shrink-0 font-medium tabular-nums', x.amountMicros < 0 ? 'text-fg' : 'text-running')}>
                {x.amountMicros > 0 ? '+' : ''}
                {money(x.amountMicros, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={page} hasMore={tx.hasMore} onPage={setPage} labels={pagerLabels} />
    </Section>
  );
}

