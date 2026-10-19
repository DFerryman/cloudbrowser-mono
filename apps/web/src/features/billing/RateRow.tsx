import { cn } from '@cloudbrowser/ui';
import type { ReactNode } from 'react';

/** One price in a list of rates: a label with an optional hint on the left, the amount on the right. */
export function RateRow({ label, hint, value, strong, badge }: { label: string; hint?: string; value: string; strong?: boolean; badge?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <p className={cn('flex items-center gap-2 text-sm', strong ? 'font-medium' : 'text-muted')}>
          {label}
          {badge}
        </p>
        {hint ? <p className="text-xs text-subtle">{hint}</p> : null}
      </div>
      <p className={cn('shrink-0 text-right tabular-nums', strong ? 'text-base font-semibold' : 'text-sm')}>{value}</p>
    </div>
  );
}
