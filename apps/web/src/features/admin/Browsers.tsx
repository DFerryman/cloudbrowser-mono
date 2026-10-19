import { Button, Input, useToast } from '@cloudbrowser/ui';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ADMIN_PAGE, post, useAdmin, useAdminAction, useAdminPage, when, type InstanceDetail, type InstanceRow } from './data.js';
import { OperationDialog } from './Lists.js';
import { Json, Mono, PageTitle, Pill, ReasonDialog, statusTone, Table } from './ui.js';

export function BrowsersPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [q, setQ] = useState(query);
  const navigate = useNavigate();
  const rows = useAdminPage<InstanceRow>(`/instances?q=${encodeURIComponent(query)}`, ADMIN_PAGE.browsers);
  return (
    <div>
      <PageTitle title="Browsers">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setParams(q.trim() ? { q: q.trim() } : {});
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Id, name, owner email or IP" className="w-72" />
          <Button type="submit">Search</Button>
        </form>
      </PageTitle>
      <Table
        rows={rows.rows}
        pager={rows.pager}
        rowKey={(r) => r.id}
        onRow={(r) => navigate(`/browsers/${r.id}`)}
        columns={['Browser', 'Status', 'Region', 'IP', 'Owner', 'Updated']}
        cells={(r) => [
          <span>
            {r.name}
            <br />
            <Mono>{r.id}</Mono>
          </span>,
          <span>
            <Pill tone={statusTone(r.status)}>{r.status}</Pill> {r.suspendedAt ? <Pill tone="bad">suspended</Pill> : null}
          </span>,
          r.regionId,
          r.ipAddress ? <Mono>{r.ipAddress}</Mono> : '—',
          r.userEmail ?? '—',
          when(r.updatedAt),
        ]}
      />
    </div>
  );
}

type Action = 'retry' | 'recover' | 'stop' | 'suspend' | 'unsuspend';
const ACTIONS: Record<Action, { label: string; help: string; danger?: boolean }> = {
  retry: { label: 'Retry last failed operation', help: 'Runs the latest failed start, stop, recover, restore, delete or undelete again with the same parameters.' },
  recover: { label: 'Recover', help: 'New VM in another zone of the same region, with the same IP and data (page 10).' },
  stop: { label: 'Put to sleep', help: 'Gracefully stops the browser while keeping its saved data and IP.' },
  suspend: { label: 'Suspend', help: 'Kill switch: the browser sleeps within a minute and cannot start. Data and IP are kept.', danger: true },
  unsuspend: { label: 'Release suspension', help: 'The owner can start the browser again.' },
};

export function BrowserDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const d = useAdmin<InstanceDetail>(`/instances/${id}`, { refetchInterval: 10_000 });
  const [action, setAction] = useState<Action | null>(null);
  const [op, setOp] = useState<string | null>(null);
  const act = useAdminAction((v: { action: Action; reason: string }) => post(`/instances/${id}/actions`, v));
  if (d.isError) return <p className="text-sm text-error">Not found.</p>;
  if (!d.data) return <p className="text-sm text-muted">Loading…</p>;
  const { instance: i } = d.data;
  const current = d.data.placements.find((p) => p.status === 'current');
  const health = d.data.health as { lastHeartbeatAt?: string; lastIpCheck?: unknown; agentReadyAt?: string; viewers?: number } | null;

  return (
    <div className="space-y-6">
      <PageTitle title={i.name}>
        <div className="flex flex-wrap gap-2">
          {(['retry', 'recover', 'stop'] as const).map((a) => (
            <Button key={a} size="sm" onClick={() => setAction(a)}>
              {ACTIONS[a].label}
            </Button>
          ))}
          {i.suspendedAt ? (
            <Button size="sm" onClick={() => setAction('unsuspend')}>
              {ACTIONS.unsuspend.label}
            </Button>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setAction('suspend')}>
              {ACTIONS.suspend.label}
            </Button>
          )}
        </div>
      </PageTitle>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[160px_1fr]">
        <dt className="text-muted">Id</dt>
        <dd>
          <Mono>{i.id}</Mono>
        </dd>
        <dt className="text-muted">Status</dt>
        <dd>
          <Pill tone={statusTone(i.status)}>{i.status}</Pill> {i.statusReason ? <span className="text-muted">{i.statusReason}</span> : null}
          {i.suspendedAt ? (
            <span className="ml-2">
              <Pill tone="bad">suspended</Pill> {String(i.suspendedReason ?? '')} · {when(i.suspendedAt)}
            </span>
          ) : null}
        </dd>
        <dt className="text-muted">Owner</dt>
        <dd>
          {d.data.owner ? (
            <Link to={`/browsers?q=${encodeURIComponent(d.data.owner.email)}`} className="text-accent hover:underline">
              {d.data.owner.email}
            </Link>
          ) : (
            '—'
          )}
        </dd>
        <dt className="text-muted">Region · IP</dt>
        <dd>
          {i.regionId} · <Mono>{String(current?.ipAddress ?? '—')}</Mono> · zone {String(current?.zone ?? '—')} · generation {String(current?.generation ?? '—')}
        </dd>
        <dt className="text-muted">Agent</dt>
        <dd>
          ready {when(health?.agentReadyAt)} · heartbeat {when(health?.lastHeartbeatAt)} · viewers {health?.viewers ?? 0}
        </dd>
        <dt className="text-muted">Last IP check</dt>
        <dd>
          <Json value={health?.lastIpCheck ?? null} />
        </dd>
      </dl>

      <Section title="Operations">
        <Table
          rows={d.data.operations}
          rowKey={(o) => o.id}
          onRow={(o) => setOp(o.id)}
          columns={['Created', 'Kind', 'Status', 'Step', 'Error']}
          cells={(o) => [when(o.createdAt), o.kind, <Pill tone={statusTone(o.status === 'running' ? 'running_op' : o.status)}>{o.status}</Pill>, String(o.step ?? '—'), String(o.error ?? '')]}
        />
      </Section>
      <Section title="Placements">
        <Table
          rows={d.data.placements}
          rowKey={(p) => String(p.generation)}
          columns={['Gen', 'Status', 'Zone', 'VM', 'Volume', 'Interface', 'IP']}
          cells={(p) => [
            String(p.generation),
            <Pill tone={statusTone(String(p.status))}>{String(p.status)}</Pill>,
            String(p.zone ?? '—'),
            <Mono>{String(p.vmId ?? '—')}</Mono>,
            <Mono>{String(p.volumeId ?? '—')}</Mono>,
            <Mono>{String(p.networkId ?? '—')}</Mono>,
            <Mono>{String(p.ipAddress ?? '—')}</Mono>,
          ]}
        />
      </Section>
      <Section title="Ledger">
        <Table
          rows={d.data.resources}
          rowKey={(r) => String(r.id)}
          columns={['Kind', 'Provider id', 'State', 'Zone', 'Created by', 'Release after']}
          cells={(r) => [
            String(r.kind),
            <Mono>{String(r.providerId ?? '—')}</Mono>,
            <Pill tone={statusTone(String(r.state))}>{String(r.state)}</Pill>,
            String(r.zone ?? '—'),
            <Mono>{String(r.createdByOp ?? '—')}</Mono>,
            when(r.releaseAfter),
          ]}
        />
      </Section>
      <Section title="IP history">
        <Table
          rows={d.data.ipAddresses}
          rowKey={(r) => String(r.address)}
          columns={['Address', 'Assigned', 'Released']}
          cells={(r) => [<Mono>{String(r.address)}</Mono>, when(r.assignedAt), when(r.releasedAt)]}
        />
      </Section>
      <Section title="Audit">
        <Table
          rows={d.data.audit}
          rowKey={(r) => r.id}
          columns={['When', 'Actor', 'Action', 'Detail']}
          cells={(r) => [when(r.createdAt), <Mono>{r.actor}</Mono>, r.action, <Json value={r.detail} />]}
        />
      </Section>

      <OperationDialog id={op} onClose={() => setOp(null)} />
      <ReasonDialog
        open={action !== null}
        title={action ? `${ACTIONS[action].label}: ${i.name}` : ''}
        description={action ? ACTIONS[action].help : undefined}
        confirm={action ? ACTIONS[action].label : ''}
        danger={action ? ACTIONS[action].danger : false}
        busy={act.isPending}
        onClose={() => setAction(null)}
        onConfirm={(reason) =>
          action &&
          act.mutate(
            { action, reason },
            {
              onSuccess: () => {
                setAction(null);
                toast('Done');
              },
              onError: (e) => toast((e as Error).message, 'error'),
            },
          )
        }
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}
