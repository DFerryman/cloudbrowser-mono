import type { PaginationLabels } from '@cloudbrowser/ui';
import { useI18n } from './i18n.js';

/** Page sizes per list: small enough to scan, large enough that most people never page. */
export const PAGE_SIZE = {
  browsers: 12,
  transactions: 10,
  usageByBrowser: 10,
  dailyCharges: 10,
  usageByDay: 10,
  sessions: 10,
  passkeys: 10,
} as const;

/** Labels for <Pagination>; `known` when the total number of pages is known. */
export function usePagerLabels(known = true): PaginationLabels {
  const { t } = useI18n();
  return { previous: t('pager.previous'), next: t('pager.next'), page: t(known ? 'pager.pageOf' : 'pager.page') };
}
