import { HOURS_PER_MONTH, USAGE_UNITS, UsageItem } from '@cloudbrowser/contracts';
import { Card, Hint, Pagination, Section, Select, Skeleton, usePaged } from '@cloudbrowser/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { PAGE_SIZE, usePagerLabels } from '../../lib/paging.js';
import { money, quantity } from '../../lib/money.js';
import { currentMonth, monthLabel, recentMonths, usePricing } from '../billing/hooks.js';
import { RateRow } from '../billing/RateRow.js';
import { useManagedInstance } from './BrowserLayout.js';
import { useInstanceUsage } from './hooks.js';

/** The Usage tab: what this one browser used and cost in a month, and what it costs right now. */
export function UsagePage() {
  const i = useManagedInstance();
  const { t, locale } = useI18n();
  const [month, setMonth] = useState(currentMonth());
  const usage = useInstanceUsage(i.id, month);
  const u = usage.data;
  const items = UsageItem.options.filter((item) => item !== 'snapshot' || u?.byDay.some((day) => day.byItem.snapshot !== 0));
  const trial = !!i.trial && i.trial.state !== 'converted';
  const m = (v: number) => money(v, locale);
  const pricing = usePricing();
  const price = pricing.data?.find((p) => p.regionId === i.regionId);
  // The same 730-hour projection as every hourly estimate of fixed resources.
  const alwaysOnHour = u ? Math.round(u.now.alwaysOnMonthMicros / HOURS_PER_MONTH) : 0;
  const days = usePaged(u ? [...u.byDay].reverse() : undefined, PAGE_SIZE.usageByDay);
  const pagerLabels = usePagerLabels();

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <h2 className="text-base font-semibold">{monthLabel(month, locale)}</h2>
          <p className="mt-2 text-3xl font-semibold tabular-nums">{u ? m(u.totalMicros) : '…'}</p>
          <div className="mt-3 w-48"><Select aria-label={t('usage.monthLabel')} value={month} onChange={(e) => setMonth(e.target.value)}>
            {recentMonths().map((mo) => (
              <option key={mo} value={mo}>
                {monthLabel(mo, locale)}
              </option>
            ))}
          </Select></div>
        </Card>
        <Card className="p-5 lg:col-span-2">
          <h2 className="text-base font-semibold">{t('usage.ratesTitle')}</h2>
          {!u ? (
            <Skeleton className="mt-3 h-20" />
          ) : trial ? (
            <p className="mt-2 text-sm font-medium text-running">{t('usage.trialFree')}</p>
          ) : u.now.hourMicros === 0 && u.now.alwaysOnMonthMicros === 0 ? (
            <p className="mt-2 text-sm text-muted">{t('usage.nowNothing')}</p>
          ) : (
            <>
              <div className="mt-2 divide-y divide-border">
                <RateRow strong={i.status === 'running'} label={t('usage.running')} hint={t('usage.runningHint', { gb: i.storageGb + (price?.rootVolumeGb ?? 0) })}
                  value={t('price.perHour', { amount: m(u.now.runningHourMicros + alwaysOnHour) })} badge={i.status === 'running' ? <NowBadge /> : null} />
                <RateRow strong={i.status !== 'running'} label={t('usage.asleep')} hint={t('usage.asleepHint', { gb: i.storageGb + (price?.rootVolumeGb ?? 0) })}
                  value={t('price.perHour', { amount: m(alwaysOnHour) })} badge={i.status !== 'running' ? <NowBadge /> : null} />
                {price?.rates ? <RateRow label={t('price.transfer')} value={t('price.perGb', { amount: m(price.rates.transfer) })} /> : null}
              </div>
              <Hint className="mt-2">{t('usage.ratesNote')}</Hint>
            </>
          )}
        </Card>
      </div>

      <Section title={t('usage.title')}>
        {usage.isPending ? (
          <Skeleton className="h-32" />
        ) : !u || !u.items.some((row) => row.quantity > 0) ? (
          <p className="text-sm text-muted">{t('usage.none')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-border">
                <th className="py-2 pr-3 font-medium">{t('usage.col.item')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('usage.col.quantity')}</th>
                <th className="py-2 text-right font-medium">{t('usage.col.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {u.items.filter((row) => row.quantity > 0 || row.amountMicros !== 0).map((row) => (
                <tr key={row.item}>
                  <td className="py-2 pr-3">{t(`billing.item.${row.item}`)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted">{t(`usage.unit.${USAGE_UNITS[row.item]}`, { n: quantity(row.quantity, locale) })}</td>
                  <td className="py-2 text-right tabular-nums">{m(row.amountMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {u && u.byDay.length ? (
        <Section title={t('usage.byDay')}>
          <div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-medium">{t('usage.col.day')}</th>
                  {items.map((item) => (
                    <th key={item} className="hidden py-2 pr-3 text-right font-medium sm:table-cell">
                      {t(`billing.item.${item}`)}
                    </th>
                  ))}
                  <th className="py-2 text-right font-medium">{t('usage.col.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {days.rows.map((d) => (
                  <tr key={d.day}>
                    <td className="py-2 pr-3 whitespace-nowrap">{new Date(`${d.day}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' })}</td>
                    {items.map((item) => (
                      <td key={item} className="hidden py-2 pr-3 text-right tabular-nums text-muted sm:table-cell">
                        {m(d.byItem[item])}
                      </td>
                    ))}
                    <td className="py-2 text-right tabular-nums">{m(d.totalMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={days.page} pages={days.pages} onPage={days.setPage} labels={pagerLabels} />
          </div>
        </Section>
      ) : null}

      <p className="text-sm">
        <Link to="/billing" className="text-accent hover:underline">
          {t('usage.accountLink')}
        </Link>
      </p>
    </div>
  );
}

function NowBadge() {
  const { t } = useI18n();
  return <span className="rounded-full bg-accent/10 px-1.5 py-px text-[11px] font-medium text-accent">{t('usage.now')}</span>;
}
