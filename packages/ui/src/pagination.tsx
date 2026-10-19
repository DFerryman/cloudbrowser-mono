import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from './cn.js';

export type PaginationLabels = {
  previous: string;
  next: string;
  /** Shown between the buttons, with `{page}` and, when the total is known, `{pages}` (pass a label without it otherwise). */
  page: string;
};

const DEFAULT_LABELS: PaginationLabels = { previous: 'Previous', next: 'Next', page: 'Page {page} of {pages}' };

/**
 * Previous / next paging under a list. With `pages` the total is known (lists paged in the
 * browser); with `hasMore` only whether another page exists (lists paged on the server).
 * Renders nothing while everything fits on the first page.
 */
export function Pagination({
  page,
  pages,
  hasMore,
  onPage,
  labels = DEFAULT_LABELS,
  className,
}: {
  /** Zero-based. */
  page: number;
  pages?: number;
  hasMore?: boolean;
  onPage: (page: number) => void;
  labels?: PaginationLabels;
  className?: string;
}) {
  const more = pages !== undefined ? page < pages - 1 : !!hasMore;
  if (page === 0 && !more) return null;
  const text = labels.page.replace('{page}', String(page + 1)).replace('{pages}', String(pages ?? ''));
  const button =
    'inline-flex h-8 items-center gap-1 rounded-[var(--radius-control)] border border-border bg-bg px-2.5 text-sm font-medium transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4';
  return (
    <nav className={cn('mt-3 flex items-center justify-between gap-3', className)} aria-label={text}>
      <button type="button" className={button} disabled={page === 0} onClick={() => onPage(page - 1)}>
        <ChevronLeft aria-hidden /> <span className="hidden sm:inline">{labels.previous}</span>
        <span className="sr-only sm:hidden">{labels.previous}</span>
      </button>
      <span className="text-xs text-subtle tabular-nums" aria-live="polite">
        {text}
      </span>
      <button type="button" className={button} disabled={!more} onClick={() => onPage(page + 1)}>
        <span className="hidden sm:inline">{labels.next}</span>
        <span className="sr-only sm:hidden">{labels.next}</span> <ChevronRight aria-hidden />
      </button>
    </nav>
  );
}

/**
 * Pages a list held in memory. The page resets when the list shrinks below it (for example after
 * a delete), so a page is never left empty.
 */
export function usePaged<T>(items: readonly T[] | undefined, size: number) {
  const [page, setPage] = useState(0);
  const total = items?.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);
  const current = Math.min(page, pages - 1);
  const rows = useMemo(() => (items ?? []).slice(current * size, current * size + size), [items, current, size]);
  return { rows, page: current, pages, setPage, total };
}
