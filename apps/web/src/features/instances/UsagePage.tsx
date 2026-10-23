import { HOURS_PER_MONTH, USAGE_UNITS, UsageItem } from '@cloudbrowser/contracts';
import { Card, Eyebrow, Hint, Pagination, Section, Select, Skeleton, usePaged } from '@cloudbrowser/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { PAGE_SIZE, usePagerLabels } from '../../lib/paging.js';
import { money, quantity } from '../../lib/money.js';
import { currentMonth, monthLabel, recentMonths, usePricing } from '../billing/hooks.js';
import { RateRow } from '../billing/RateRow.js';
import { useManagedInstance } from './BrowserLayout.js';
import { useInstanceUsage } from './hooks.js';
import { LoadError } from '../../app/LoadError.js';

/** The Usage tab: what this one browser used and cost in a month, and what it costs right now. */
export function UsagePage() {
  const i = useManagedInstance();
  const { t, locale } = useI18n();
  const [month, setMonth] = useState(currentMonth());
  const usage = useInstanceUsage(i.id, month);
  const u = usage.data;
  const items = UsageItem.options.filter((item) => item !== 'snapshot' || u?.byDay.some((day) => day.byItem.snapshot !== 0));
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
        <Card className="p-5 md:p-6">
          <Eyebrow as="h2">{monthLabel(month, locale)}</Eyebrow>
          <p className="mt-4 text-[36px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{u ? m(u.totalMicros) : '…'}</p>
          <div className="mt-6 w-48"><Select aria-label={t('usage.monthLabel')} value={month} onChange={(e) => setMonth(e.target.value)}>
            {recentMonths().map((mo) => (
              <option key={mo} value={mo}>
                {monthLabel(mo, locale)}
              </option>
            ))}
          </Select></div>
        </Card>
        <Card className="p-5 md:p-6 lg:col-span-2">
          <Eyebrow as="h2">{t('usage.ratesTitle')}</Eyebrow>
          {!u && usage.isError ? (
            <LoadError className="mt-3" error={usage.error} onRetry={() => void usage.refetch()} />
          ) : !u ? (
            <Skeleton className="mt-3 h-20" />

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
        ) : !u ? (
          <LoadError error={usage.error} onRetry={() => void usage.refetch()} />
        ) : !u.items.some((row) => row.quantity > 0) ? (
          <p className="text-sm text-muted">{t('usage.none')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] tracking-[0.1em] text-subtle uppercase">
              <tr className="border-b border-border">
                <th className="py-2.5 pr-3 font-semibold">{t('usage.col.item')}</th>
                <th className="py-2.5 pr-3 text-right font-semibold">{t('usage.col.quantity')}</th>
                <th className="py-2.5 text-right font-semibold">{t('usage.col.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {u.items.filter((row) => row.quantity > 0 || row.amountMicros !== 0).map((row) => (
                <tr key={row.item}>
                  <td className="py-3 pr-3">{t(`billing.item.${row.item}`)}</td>
                  <td className="py-3 pr-3 text-right tabular-nums text-muted">{t(`usage.unit.${USAGE_UNITS[row.item]}`, { n: quantity(row.quantity, locale) })}</td>
                  <td className="py-3 text-right tabular-nums">{m(row.amountMicros)}</td>
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
              <thead className="text-left text-[11px] tracking-[0.1em] text-subtle uppercase">
                <tr className="border-b border-border">
                  <th className="py-2.5 pr-3 font-semibold">{t('usage.col.day')}</th>
                  {items.map((item) => (
                    <th key={item} className="hidden py-2.5 pr-3 text-right font-semibold sm:table-cell">
                      {t(`billing.item.${item}`)}
                    </th>
                  ))}
                  <th className="py-2.5 text-right font-semibold">{t('usage.col.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {days.rows.map((d) => (
                  <tr key={d.day}>
                    <td className="py-3 pr-3 whitespace-nowrap">{new Date(`${d.day}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' })}</td>
                    {items.map((item) => (
                      <td key={item} className="hidden py-3 pr-3 text-right tabular-nums text-muted sm:table-cell">
                        {m(d.byItem[item])}
                      </td>
                    ))}
                    <td className="py-3 text-right tabular-nums">{m(d.totalMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={days.page} pages={days.pages} onPage={days.setPage} labels={pagerLabels} />
          </div>
        </Section>
      ) : null}

      <p className="text-sm">
        <Link to="/billing" className="text-accent underline-offset-4 hover:underline">
          {t('usage.accountLink')}
        </Link>
      </p>
    </div>
  );
}

function NowBadge() {
  const { t } = useI18n();
  return <span className="border border-fg px-1.5 py-px text-[10px] font-semibold tracking-wider uppercase">{t('usage.now')}</span>;
}
