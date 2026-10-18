import { Button, cn, Dialog, Input, Label } from '@cloudbrowser/ui';
import { useState, type ReactNode } from 'react';

/** Compact table for the console. `cells` returns one node per column. */
export function Table<T>({
  rows,
  columns,
  cells,
  empty = 'Nothing here.',
  onRow,
  rowKey,
}: {
  rows: T[] | undefined;
  columns: string[];
  cells: (r: T) => ReactNode[];
  empty?: string;
  onRow?: (r: T) => void;
  rowKey: (r: T) => string | number;
}) {
  if (!rows) return <p className="py-6 text-sm text-muted">Loading…</p>;
  if (!rows.length) return <p className="py-6 text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface text-xs text-muted">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3 py-2 font-medium whitespace-nowrap">
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
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums', tone === 'bad' && 'text-error', tone === 'warn' && 'text-starting')}>{value}</div>
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
        <Label htmlFor="reason">Reason (kept in the audit log)</Label>
        <Input id="reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. abuse report #123, incident 7" />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
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
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-lg font-semibold">{title}</h1>
      {children}
    </div>
  );
}
