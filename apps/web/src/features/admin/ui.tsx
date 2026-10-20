import { Button, cn, Dialog, Input, Label, Pagination, usePaged } from '@cloudbrowser/ui';
import { useState, type ReactNode } from 'react';
import { useT } from './i18n.js';

/**
 * Compact table for the console. `cells` returns one node per column. Rows already in memory are
 * paged here (`pageSize`); a server-paged list passes its `pager` instead and is shown as is.
 */
export function Table<T>({
  rows: all,
  columns,
  cells,
  empty,
  onRow,
  rowKey,
  pageSize = 25,
  pager,
}: {
  rows: T[] | undefined;
  columns: string[];
  cells: (r: T) => ReactNode[];
  empty?: string;
  onRow?: (r: T) => void;
  rowKey: (r: T) => string | number;
  pageSize?: number;
  pager?: { page: number; hasMore: boolean; onPage: (page: number) => void };
}) {
  const { t } = useT();
  const local = usePaged(pager ? undefined : all, pageSize);
  const rows = pager ? all : all && local.rows;
  if (!rows) return <p className="py-6 text-sm text-muted">{t('common.loading')}</p>;
  if (!rows.length && !(pager && pager.page > 0)) return <p className="py-6 text-sm text-muted">{empty ?? t('common.empty')}</p>;
  return (
    <div>
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface text-[11px] tracking-wider text-subtle uppercase">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3 py-2.5 font-semibold whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={rowKey(r)} className={cn(onRow && 'cursor-pointer hover:bg-surface-2')} onClick={onRow ? () => onRow(r) : undefined}>
              {cells(r).map((c, i) => (
                <td key={i} className="px-3 py-2 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {pager ? (
      <Pagination page={pager.page} hasMore={pager.hasMore} onPage={pager.onPage} labels={{ previous: t('common.previous'), next: t('common.next'), page: t('common.page') }} />
    ) : (
      <Pagination page={local.page} pages={local.pages} onPage={local.setPage} labels={{ previous: t('common.previous'), next: t('common.next'), page: t('common.pageOf', { rows: all!.length }) }} />
    )}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

export function Pill({ tone = 'muted', children }: { tone?: 'ok' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  const tones = {
    ok: 'bg-running/15 text-running',
    warn: 'bg-starting/15 text-starting',
    bad: 'bg-error/15 text-error',
    muted: 'bg-surface-2 text-muted',
  };
  return <span className={cn('inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone])}>{children}</span>;
}

export const statusTone = (s: string): 'ok' | 'warn' | 'bad' | 'muted' =>
  ['running', 'succeeded', 'active', 'complete', 'current'].includes(s)
    ? 'ok'
    : ['failed', 'needs_attention', 'provider_issue', 'missing', 'orphan', 'critical'].includes(s)
      ? 'bad'
      : ['waiting_capacity', 'starting', 'stopping', 'creating', 'running_op', 'queued', 'waiting', 'pending', 'warning', 'superseded'].includes(s)
        ? 'warn'
        : 'muted';

export function Tile({ label, value, tone }: { label: string; value: ReactNode; tone?: 'bad' | 'warn' }) {
  return (
    <div className="border border-border bg-bg p-5">
      <div className="text-[11px] font-semibold tracking-[0.12em] text-subtle uppercase">{label}</div>
      <div className={cn('mt-3 text-[28px] leading-none font-semibold tracking-tight tabular-nums', tone === 'bad' && 'text-error', tone === 'warn' && 'text-starting')}>{value}</div>
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  return <pre className="max-h-48 max-w-[480px] overflow-auto rounded bg-surface-2 p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

/**
 * Every operator change asks for a reason, which goes into the audit log (page 10). `danger`
 * styles the confirm button for destructive actions.
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirm,
  danger,
  busy,
  onClose,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  /** Extra fields shown above the reason. */
  children?: ReactNode;
}) {
  const { t } = useT();
  const [reason, setReason] = useState('');
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={title} description={description}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(reason.trim());
        }}
      >
        {children}
        <Label htmlFor="reason">{t('common.reason')}</Label>
        <Input id="reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('common.reasonPlaceholder')} />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={reason.trim().length < 3 || busy}>
            {confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}

/** A status, kind or severity as a translated, coloured pill. */
export function StatusPill({ value, tone }: { value: string; tone?: 'ok' | 'warn' | 'bad' | 'muted' }) {
  const { term } = useT();
  return <Pill tone={tone ?? statusTone(value)}>{term(value)}</Pill>;
}
