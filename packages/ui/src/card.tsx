import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border border-border bg-bg', className)} {...props} />;
}

/** A titled block of a page: the title and its action sit above a hairline, the content below. */
export function Section({ title, description, action, children, className }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('p-0', className)}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description ? <p className="mt-1 max-w-prose text-xs leading-relaxed text-subtle">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="px-5 py-4">{children}</div>
    </Card>
  );
}

/** A small uppercase label above a heading or a figure; `as="h2"` when it titles a block. */
export function Eyebrow({ className, as: Tag = 'p', ...props }: HTMLAttributes<HTMLElement> & { as?: 'p' | 'h2' | 'h3' }) {
  return <Tag className={cn('text-[11px] font-semibold uppercase tracking-[0.12em] text-subtle', className)} {...props} />;
}

/** Every app page opens the same way: eyebrow, title, one line of context, and its actions. */
export function PageHeader({ eyebrow, title, description, actions, className }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn('mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-border pb-4 md:mb-8 md:pb-6', className)}>
      <div className="min-w-0">
        {eyebrow ? <Eyebrow className="mb-2">{eyebrow}</Eyebrow> : null}
        <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-tight">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A key figure: label, value set large in tabular numerals, and an optional note. */
export function Stat({ label, value, note, tone, className }: { label: ReactNode; value: ReactNode; note?: ReactNode; tone?: 'bad' | 'warn'; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <Eyebrow>{label}</Eyebrow>
      <p className={cn('mt-2 text-[28px] font-semibold leading-none tracking-tight tabular-nums', tone === 'bad' && 'text-error', tone === 'warn' && 'text-starting')}>{value}</p>
      {note ? <p className="mt-2 text-xs leading-relaxed text-subtle">{note}</p> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('bg-surface-2 [animation:cb-pulse_1.5s_ease-in-out_infinite]', className)} />;
}
