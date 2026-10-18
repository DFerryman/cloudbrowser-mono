import { USAGE_UNITS, UsageItem } from '@cloudbrowser/contracts';
import { Card, Section, Select, Skeleton } from '@cloudbrowser/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { money, quantity } from '../../lib/money.js';
import { currentMonth, monthLabel, recentMonths } from '../billing/hooks.js';
import { useManagedInstance } from './BrowserLayout.js';
import { useInstanceUsage } from './hooks.js';

/** The Usage tab: what this one browser used and cost in a month, and what it costs right now. */
export function UsagePage() {
  const i = useManagedInstance();
  const { t, locale } = useI18n();
  const [month, setMonth] = useState(currentMonth());
  const usage = useInstanceUsage(i.id, month);
  const u = usage.data;
  const m = (v: number) => money(v, locale);

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
          {u ? (
            <div className="space-y-1 text-sm">
              <p className="font-medium">
                {u.now.hourMicros === 0
                  ? t('usage.nowNothing')
                  : i.status === 'running'
                    ? t('usage.nowRunning', { amount: m(u.now.hourMicros) })
                    : t('usage.nowAsleep', { amount: m(u.now.hourMicros) })}
              </p>
              <p className="text-muted">{t('usage.runningRate', { amount: m(u.now.runningHourMicros) })}</p>
              <p className="text-muted">{t('usage.keptRate', { amount: m(u.now.alwaysOnMonthMicros) })}</p>
              <p className="pt-2 text-xs text-muted">{t('usage.note')}</p>
            </div>
          ) : (
            <Skeleton className="h-20" />
          )}
        </Card>
      </div>

      <Section title={t('usage.title')}>
        {usage.isPending ? (
          <Skeleton className="h-32" />
        ) : !u || u.totalMicros === 0 ? (
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
              {u.items.map((row) => (
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
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg text-left text-xs text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-medium">{t('usage.col.day')}</th>
                  {UsageItem.options.map((item) => (
                    <th key={item} className="hidden py-2 pr-3 text-right font-medium sm:table-cell">
                      {t(`billing.item.${item}`)}
                    </th>
                  ))}
                  <th className="py-2 text-right font-medium">{t('usage.col.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[...u.byDay].reverse().map((d) => (
                  <tr key={d.day}>
                    <td className="py-2 pr-3 whitespace-nowrap">{new Date(`${d.day}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' })}</td>
                    {UsageItem.options.map((item) => (
                      <td key={item} className="hidden py-2 pr-3 text-right tabular-nums text-muted sm:table-cell">
                        {m(d.byItem[item])}
                      </td>
                    ))}
                    <td className="py-2 text-right tabular-nums">{m(d.totalMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
