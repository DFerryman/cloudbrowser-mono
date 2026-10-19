import { Pagination, usePaged } from '@cloudbrowser/ui';
import { useId } from 'react';
import { useI18n } from '../../lib/i18n.js';
import { PAGE_SIZE, usePagerLabels } from '../../lib/paging.js';
import { money } from '../../lib/money.js';

/** Recorded debits, rather than a price estimate. Dates remain UTC on every device. */
export function DailyCharges({ days }: { days: { day: string; totalMicros: number }[] }) {
  const { t, locale } = useI18n();
  const id = useId();
  const sorted = [...days].sort((a, b) => b.day.localeCompare(a.day));
  // The bars compare against the whole month, not just the page.
  const max = Math.max(0, ...sorted.map((day) => day.totalMicros));
  const { rows, page, pages, setPage } = usePaged(sorted, PAGE_SIZE.dailyCharges);
  const pagerLabels = usePagerLabels();
  return (
    <section className="mt-5 min-w-0" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="text-sm font-medium">{t('billing.dailyCharges')}</h3>
      <p id={`${id}-order`} className="mt-1 text-xs text-subtle">{t('billing.dailyChargesHint')}</p>
      {sorted.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t('billing.dailyEmpty')}</p>
      ) : (
        <table className="mt-3 w-full table-fixed text-sm" aria-describedby={`${id}-order`}>
          <thead className="text-xs text-muted">
            <tr className="border-b border-border">
              <th scope="col" className="w-1/2 pb-2 pr-3 text-left font-medium">{t('billing.dailyDate')}</th>
              <th scope="col" className="pb-2 text-right font-medium">{t('billing.dailyCharged')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((day) => (
              <tr key={day.day}>
                <th scope="row" className="py-3 pr-3 text-left font-normal tabular-nums">
                  <time dateTime={day.day}>{day.day}</time>
                </th>
                <td className="py-3 text-right tabular-nums">
                  <span className="block [overflow-wrap:anywhere]">{money(day.totalMicros, locale)}</span>
                  {sorted.length > 1 && max > 0 ? (
                    <div className="mt-1 ml-auto h-1 w-20 max-w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
                      <div className="h-full rounded-full bg-accent/50" style={{ width: `${Math.max(0, day.totalMicros / max * 100)}%` }} />
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pagination page={page} pages={pages} onPage={setPage} labels={pagerLabels} />
    </section>
  );
}
