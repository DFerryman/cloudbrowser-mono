import { Button, Dialog, Input, Select, useToast } from '@cloudbrowser/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { post, useAdmin, useAdminAction, when, type AlertRow, type OperationRow, type Row, type UserRow } from './data.js';
import { Json, Mono, PageTitle, Pill, ReasonDialog, statusTone, Table } from './ui.js';

export function AlertsPage() {
  const [open, setOpen] = useState(true);
  const alerts = useAdmin<AlertRow[]>(`/alerts?open=${open ? 1 : 0}`, { refetchInterval: 30_000 });
  const ack = useAdminAction((id: number) => post(`/alerts/${id}/ack`));
  return (
    <div>
      <PageTitle title="Alerts">
        <Select value={open ? 'open' : 'all'} onChange={(e) => setOpen(e.target.value === 'open')} className="w-40">
          <option value="open">Open</option>
          <option value="all">All</option>
        </Select>
      </PageTitle>
      <p className="mb-3 text-xs text-muted">New alerts are sent to the alert emails and the chat webhook every 5 minutes. Acknowledge once handled (runbooks: page 7).</p>
      <Table
        rows={alerts.data}
        rowKey={(a) => a.id}
        columns={['When', 'Severity', 'Source', 'Alert', 'Detail', 'Sent', '']}
        empty="No open alerts."
        cells={(a) => [
          when(a.createdAt),
          <Pill tone={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'muted'}>{a.severity}</Pill>,
          a.source,
          a.title,
          <Json value={a.detail} />,
          a.sentAt ? when(a.sentAt) : <span className="text-muted">pending</span>,
          a.acknowledgedAt ? (
            <span className="text-xs text-muted">
              ack {when(a.acknowledgedAt)}
              <br />
              {a.acknowledgedBy}
            </span>
          ) : (
            <Button size="sm" disabled={ack.isPending} onClick={() => ack.mutate(a.id)}>
              Acknowledge
            </Button>
          ),
        ]}
      />
    </div>
  );
}

export function OperationsPage() {
  const [status, setStatus] = useState('unfinished');
  const [kind, setKind] = useState('');
  const ops = useAdmin<OperationRow[]>(`/operations?status=${status}${kind ? `&kind=${kind}` : ''}`, { refetchInterval: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <PageTitle title="Operations">
        <div className="flex gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
            <option value="unfinished">Unfinished</option>
            <option value="failed">Failed</option>
            <option value="all">All</option>
          </Select>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-36">
            <option value="">Any kind</option>
            {['create', 'start', 'stop', 'recover', 'restore', 'change_ip', 'delete', 'undelete', 'purge'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
        </div>
      </PageTitle>
      <Table
        rows={ops.data}
        rowKey={(o) => o.id}
        onRow={(o) => setOpen(o.id)}
        columns={['Created', 'Kind', 'Status', 'Step', 'Attempt', 'Browser', 'User', 'Error']}
        cells={(o) => [
          when(o.createdAt),
          o.kind,
          <Pill tone={statusTone(o.status === 'running' ? 'running_op' : o.status)}>{o.status}</Pill>,
          o.step ?? '—',
          o.attempt,
          <Link to={`/browsers/${o.instanceId}`} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">
            {o.instanceName ?? o.instanceId}
          </Link>,
          o.userEmail ?? '—',
          o.error ? (
            <span className="text-error">
              {o.errorClass}: {o.error}
            </span>
          ) : o.notBefore && !o.finishedAt ? (
            <span className="text-muted">next try {when(o.notBefore)}</span>
          ) : (
            '—'
          ),
        ]}
      />
      <OperationDialog id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/** One operation with its write-ahead step journal (page 10). */
export function OperationDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useAdmin<{ operation: Row; steps: Row[] }>(`/operations/${id ?? ''}`, { enabled: id !== null });
  const op = id ? detail.data?.operation : undefined;
  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()} title={op ? `${String(op.kind)} · ${String(op.status)}` : 'Operation'}>
      {op ? (
        <div className="space-y-3 text-sm">
          <p>
            <Mono>{String(op.id)}</Mono>
          </p>
          <Json value={{ params: op.params, attempt: op.attempt, error: op.error, errorClass: op.errorClass, lease: op.leaseOwner, deadline: op.deadlineAt }} />
          <h3 className="font-medium">Step journal</h3>
          <Table
            rows={detail.data!.steps}
            rowKey={(s) => String(s.step)}
            columns={['Step', 'Status', 'Attempts', 'Result']}
            cells={(s) => [String(s.step), <Pill tone={statusTone(String(s.status))}>{String(s.status)}</Pill>, String(s.attempts ?? ''), <Json value={s.result} />]}
          />
        </div>
      ) : (
        <p className="text-sm text-muted">Loading…</p>
      )}
    </Dialog>
  );
}

export function LedgerPage() {
  const [state, setState] = useState('active');
  const [kind, setKind] = useState('');
  const rows = useAdmin<Row[]>(`/ledger?state=${state}${kind ? `&kind=${kind}` : ''}`);
  return (
    <div>
      <PageTitle title="Ledger">
        <div className="flex gap-2">
          <Select value={state} onChange={(e) => setState(e.target.value)} className="w-36">
            {['active', 'pending', 'superseded', 'rejected', 'deleting', 'deleted'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-40">
            <option value="">Any kind</option>
            {['vm', 'volume', 'network_interface', 'ip', 'snapshot'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
        </div>
      </PageTitle>
      <p className="mb-3 text-xs text-muted">Every billable provider resource (page 10). The reconciler compares this with the provider every 5 minutes.</p>
      <Table
        rows={rows.data}
        rowKey={(r) => String(r.id)}
        columns={['Kind', 'Provider id', 'Region / zone', 'State', 'Browser', 'Cost / month', 'First seen', 'Release after']}
        cells={(r) => [
          String(r.kind),
          <Mono>{String(r.providerId ?? '—')}{r.address ? ` (${String(r.address)})` : ''}</Mono>,
          `${String(r.region)}${r.zone ? ` / ${String(r.zone)}` : ''}`,
          <Pill tone={statusTone(String(r.state))}>{String(r.state)}</Pill>,
          r.instanceId ? (
            <Link to={`/browsers/${String(r.instanceId)}`} className="text-accent hover:underline">
              <Mono>{String(r.instanceId)}</Mono>
            </Link>
          ) : (
            '—'
          ),
          `$${(Number(r.monthlyCostEstimate) / 100).toFixed(2)}`,
          when(r.firstSeenAt),
          when(r.releaseAfter),
        ]}
      />
    </div>
  );
}

export function FindingsPage() {
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const rows = useAdmin<Row[]>(`/findings?status=${status}`);
  const [resolving, setResolving] = useState<string | null>(null);
  const resolve = useAdminAction((v: { id: string; note: string }) => post(`/findings/${v.id}/resolve`, { note: v.note }));
  return (
    <div>
      <PageTitle title="Findings">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </Select>
      </PageTitle>
      <p className="mb-3 text-xs text-muted">
        Drift between the ledger and the provider. Orphans are stopped and tagged; the reaper removes them after 24 h only if they never served a user. Missing resources need
        a decision.
      </p>
      <Table
        rows={rows.data}
        rowKey={(r) => String(r.id)}
        columns={['When', 'Kind', 'Resource', 'Where', 'Browser', 'Detail', '']}
        empty="No findings."
        cells={(r) => [
          when(r.createdAt),
          <Pill tone={statusTone(String(r.kind))}>{String(r.kind)}</Pill>,
          <Mono>
            {String(r.resourceKind ?? '')} {String(r.providerId)}
          </Mono>,
          `${String(r.executor)}/${String(r.region)}`,
          r.instanceId ? (
            <Link to={`/browsers/${String(r.instanceId)}`} className="text-accent hover:underline">
              <Mono>{String(r.instanceId)}</Mono>
            </Link>
          ) : (
            '—'
          ),
          String(r.detail ?? ''),
          r.status === 'open' ? (
            <Button size="sm" onClick={() => setResolving(String(r.id))}>
              Resolve
            </Button>
          ) : (
            <span className="text-xs text-muted">resolved {when(r.resolvedAt)}</span>
          ),
        ]}
      />
      <ReasonDialog
        open={resolving !== null}
        title="Resolve finding"
        description="Say what was done, e.g. removed by the reaper or adopted."
        confirm="Resolve"
        busy={resolve.isPending}
        onClose={() => setResolving(null)}
        onConfirm={(note) =>
          resolving && resolve.mutate({ id: resolving, note }, { onSuccess: () => setResolving(null), onError: (e) => toast((e as Error).message, 'error') })
        }
      />
    </div>
  );
}

export function UsersPage() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const users = useAdmin<UserRow[]>(`/users?q=${encodeURIComponent(query)}`);
  const [pending, setPending] = useState<{ user: UserRow; action: 'suspend' | 'unsuspend' } | null>(null);
  const act = useAdminAction((v: { id: string; action: string; reason: string }) => post(`/users/${v.id}/actions`, { action: v.action, reason: v.reason }));
  return (
    <div>
      <PageTitle title="Users">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email or user id" className="w-64" />
          <Button type="submit">Search</Button>
        </form>
      </PageTitle>
      <Table
        rows={users.data}
        rowKey={(u) => u.id}
        columns={['Email', 'Joined', 'Plan', 'Browsers', 'Kill switch']}
        cells={(u) => [
          <span>
            {u.email} {u.admin ? <Pill>staff</Pill> : null}
            <br />
            <Mono>{u.id}</Mono>
          </span>,
          when(u.createdAt),
          u.subscription ? (
            <span>
              {u.subscription.plan} · {u.subscription.status}
              {u.subscription.plan.startsWith('pro') ? ` · ${u.subscription.units}` : ''}
              {u.subscription.revoked ? <Pill tone="bad">revoked</Pill> : null}
            </span>
          ) : (
            <span className="text-muted">pilot / none</span>
          ),
          <Link to={`/browsers?q=${encodeURIComponent(u.email)}`} className="text-accent hover:underline">
            {u.browsers}
            {u.suspended ? ` (${u.suspended} suspended)` : ''}
          </Link>,
          u.suspended ? (
            <Button size="sm" onClick={() => setPending({ user: u, action: 'unsuspend' })}>
              Release all
            </Button>
          ) : (
            <Button size="sm" variant="danger" disabled={!u.browsers} onClick={() => setPending({ user: u, action: 'suspend' })}>
              Suspend all
            </Button>
          ),
        ]}
      />
      <ReasonDialog
        open={pending !== null}
        title={pending ? `${pending.action === 'suspend' ? 'Suspend' : 'Release'} every browser of ${pending.user.email}` : ''}
        description={pending?.action === 'suspend' ? 'They go to sleep within a minute and cannot start. Data and IPs are kept.' : undefined}
        confirm={pending?.action === 'suspend' ? 'Suspend all' : 'Release all'}
        danger={pending?.action === 'suspend'}
        busy={act.isPending}
        onClose={() => setPending(null)}
        onConfirm={(reason) =>
          pending &&
          act.mutate(
            { id: pending.user.id, action: pending.action, reason },
            { onSuccess: () => setPending(null), onError: (e) => toast((e as Error).message, 'error') },
          )
        }
      />
    </div>
  );
}

export function AuditPage() {
  const [target, setTarget] = useState('');
  const [actor, setActor] = useState('');
  const [filters, setFilters] = useState({ target: '', actor: '' });
  const rows = useAdmin<Row[]>(`/audit?target=${encodeURIComponent(filters.target)}&actor=${encodeURIComponent(filters.actor)}`);
  return (
    <div>
      <PageTitle title="Audit log">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ target: target.trim(), actor: actor.trim() });
          }}
        >
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target, e.g. instance:01J…" className="w-56" />
          <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Actor prefix, e.g. admin:" className="w-44" />
          <Button type="submit">Filter</Button>
        </form>
      </PageTitle>
      <Table
        rows={rows.data}
        rowKey={(r) => String(r.id)}
        columns={['When', 'Actor', 'Action', 'Target', 'Detail']}
        cells={(r) => [when(r.createdAt), <Mono>{String(r.actor)}</Mono>, String(r.action), <Mono>{String(r.target)}</Mono>, <Json value={r.detail} />]}
      />
    </div>
  );
}
