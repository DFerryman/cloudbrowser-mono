import { Button, useToast } from '@cloudbrowser/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { money, put, useAdmin, useAdminAction, when, type Overview } from './data.js';
import { PageTitle, ReasonDialog, Table, Tile } from './ui.js';

const STATUS_ORDER = ['running', 'creating', 'starting', 'stopping', 'sleeping', 'waiting_capacity', 'provider_issue', 'needs_attention', 'failed', 'deleting', 'purged'];

export function OverviewPage() {
  const o = useAdmin<Overview>('/overview', { refetchInterval: 30_000 });
  if (!o.data) return <p className="text-sm text-muted">Loading…</p>;
  const d = o.data;
  const spendPct = d.spend?.budgetCents ? Math.round((d.spend.projectedCents / d.spend.budgetCents) * 100) : null;
  return (
    <div className="space-y-6">
      <PageTitle title="Overview" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Open alerts" value={<Link to="/alerts">{d.alertsOpen}</Link>} tone={d.alertsOpen ? 'bad' : undefined} />
        <Tile label="Open findings" value={<Link to="/findings">{d.findingsOpen}</Link>} tone={d.findingsOpen ? 'warn' : undefined} />
        <Tile label="Unfinished operations" value={<Link to="/operations">{d.operations.unfinished}</Link>} />
        <Tile label="Failed in 24 h" value={d.operations.failed24h} tone={d.operations.failed24h ? 'warn' : undefined} />
        <Tile label="Webhooks pending" value={d.webhooksPending} tone={d.webhooksPending ? 'warn' : undefined} />
        <Tile label="Users" value={d.users} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium">Browsers by status</h2>
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.filter((s) => d.instances[s]).map((s) => (
            <span key={s} className="rounded-[var(--radius-control)] border border-border px-2.5 py-1 text-sm">
              {s.replace('_', ' ')} <b className="tabular-nums">{d.instances[s]}</b>
            </span>
          ))}
          {Object.keys(d.instances).length === 0 ? <span className="text-sm text-muted">No browsers yet.</span> : null}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Switches flags={d.flags} />
        <div>
          <h2 className="mb-2 text-sm font-medium">Spend guard</h2>
          {d.spend ? (
            <div className="rounded-[var(--radius-card)] border border-border p-4 text-sm">
              <p>
                Projected this month: <b>{money(d.spend.projectedCents)}</b>
                {d.spend.budgetCents ? ` of ${money(d.spend.budgetCents)} (${spendPct}%)` : ''}
              </p>
              {spendPct !== null ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className={spendPct >= 100 ? 'h-full bg-error' : spendPct >= 80 ? 'h-full bg-starting' : 'h-full bg-accent'} style={{ width: `${Math.min(100, spendPct)}%` }} />
                </div>
              ) : null}
              <p className="mt-2 text-xs text-muted">At 80% an alert is raised; at 100% new browsers are refused. Snapshot {when(d.spend.takenAt)}.</p>
            </div>
          ) : (
            <p className="text-sm text-muted">No spend snapshot yet (the reconciler takes one every hour).</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Provider quotas</h2>
        <Table
          rows={d.quotas}
          rowKey={(q) => `${q.executor}/${q.region}/${q.metric}`}
          columns={['Executor', 'Region', 'Metric', 'Used', 'Limit', 'Headroom']}
          empty="No quota snapshot yet."
          cells={(q) => [q.executor, q.region, q.metric, q.used, q.limit, <span className={q.used / q.limit >= 0.7 ? 'text-starting' : ''}>{q.limit - q.used}</span>]}
        />
      </section>
    </div>
  );
}

const SWITCHES = [
  { key: 'creation_freeze', label: 'Freeze new browsers', help: 'Creates are refused. The circuit breaker sets this on its own.' },
  { key: 'billing_required', label: 'Require a paid plan', help: 'Users without a subscription get no browsers. Off during the invite-only pilot.' },
] as const;

export function Switches({ flags }: { flags: Overview['flags'] }) {
  const toast = useToast();
  const [pending, setPending] = useState<{ key: string; value: 'true' | 'false'; label: string } | null>(null);
  const set = useAdminAction((v: { key: string; value: string; reason: string }) => put(`/flags/${v.key}`, { value: v.value, reason: v.reason }));
  return (
    <div>
      <h2 className="mb-2 text-sm font-medium">Switches</h2>
      <div className="divide-y divide-border rounded-[var(--radius-card)] border border-border">
        {SWITCHES.map((s) => {
          const on = flags[s.key]?.value === 'true';
          return (
            <div key={s.key} className="flex items-start justify-between gap-3 p-3 text-sm">
              <div>
                <p className="font-medium">
                  {s.label} <span className={on ? 'text-error' : 'text-muted'}>· {on ? 'on' : 'off'}</span>
                </p>
                <p className="text-xs text-muted">{s.help}</p>
                {flags[s.key]?.reason ? <p className="mt-1 text-xs text-muted">Last change: {flags[s.key]!.reason} · {when(flags[s.key]!.updatedAt)}</p> : null}
              </div>
              <Button size="sm" variant={on ? 'secondary' : 'danger'} onClick={() => setPending({ key: s.key, value: on ? 'false' : 'true', label: s.label })}>
                {on ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
          );
        })}
      </div>
      <ReasonDialog
        open={pending !== null}
        title={pending ? `${pending.value === 'true' ? 'Turn on' : 'Turn off'}: ${pending.label}` : ''}
        confirm={pending?.value === 'true' ? 'Turn on' : 'Turn off'}
        danger={pending?.value === 'true'}
        busy={set.isPending}
        onClose={() => setPending(null)}
        onConfirm={(reason) =>
          pending &&
          set.mutate(
            { key: pending.key, value: pending.value, reason },
            { onSuccess: () => setPending(null), onError: (e) => toast((e as Error).message, 'error') },
          )
        }
      />
    </div>
  );
}
