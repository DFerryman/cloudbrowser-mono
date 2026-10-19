import { Button, Input, useToast } from '@cloudbrowser/ui';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ADMIN_PAGE, post, useAdmin, useAdminAction, useAdminPage, when, type InstanceDetail, type InstanceRow } from './data.js';
import { useT, type AdminKey } from './i18n.js';
import { OperationDialog } from './Lists.js';
import { Mono, PageTitle, Pill, ReasonDialog, StatusPill, Table } from './ui.js';

export function BrowsersPage() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [q, setQ] = useState(query);
  const navigate = useNavigate();
  const rows = useAdminPage<InstanceRow>(`/instances?q=${encodeURIComponent(query)}`, ADMIN_PAGE.browsers);
  return (
    <div>
      <PageTitle title={t('nav.browsers')}>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setParams(q.trim() ? { q: q.trim() } : {});
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('browsers.searchPlaceholder')} className="w-72" />
          <Button type="submit">{t('common.search')}</Button>
        </form>
      </PageTitle>
      <Table
        rows={rows.rows}
        pager={rows.pager}
        rowKey={(r) => r.id}
        onRow={(r) => navigate(`/browsers/${r.id}`)}
        columns={[t('col.browser'), t('col.status'), t('col.region'), t('col.ip'), t('col.owner'), t('col.updated')]}
        cells={(r) => [
          <span>
            {r.name}
            <br />
            <Mono>{r.id}</Mono>
          </span>,
          <span>
            <StatusPill value={r.status} /> {r.suspendedAt ? <Pill tone="bad">{t('browsers.suspended')}</Pill> : null}
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
const ACTIONS: Record<Action, { label: AdminKey; help: AdminKey; danger?: boolean }> = {
  retry: { label: 'action.retry', help: 'action.retryHelp' },
  recover: { label: 'action.recover', help: 'action.recoverHelp' },
  stop: { label: 'action.stop', help: 'action.stopHelp' },
  suspend: { label: 'action.suspend', help: 'action.suspendHelp', danger: true },
  unsuspend: { label: 'action.unsuspend', help: 'action.unsuspendHelp' },
};

export function BrowserDetailPage() {
  const { t, term, errorText } = useT();
  const { id = '' } = useParams();
  const toast = useToast();
  const d = useAdmin<InstanceDetail>(`/instances/${id}`, { refetchInterval: 10_000 });
  const [action, setAction] = useState<Action | null>(null);
  const [op, setOp] = useState<string | null>(null);
  const act = useAdminAction((v: { action: Action; reason: string }) => post(`/instances/${id}/actions`, v));
  if (d.isError) return <p className="text-sm text-error">{t('browsers.notFound')}</p>;
  if (!d.data) return <p className="text-sm text-muted">{t('common.loading')}</p>;
  const { instance: i } = d.data;
  const current = d.data.placements.find((p) => p.status === 'current');
  const health = d.data.health as { lastHeartbeatAt?: string; agentReadyAt?: string; viewers?: number } | null;

  return (
    <div className="space-y-6">
      <PageTitle title={i.name}>
        <div className="flex flex-wrap gap-2">
          {(['retry', 'recover', 'stop'] as const).map((a) => (
            <Button key={a} size="sm" onClick={() => setAction(a)}>
              {t(ACTIONS[a].label)}
            </Button>
          ))}
          {i.suspendedAt ? (
            <Button size="sm" onClick={() => setAction('unsuspend')}>
              {t(ACTIONS.unsuspend.label)}
            </Button>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setAction('suspend')}>
              {t(ACTIONS.suspend.label)}
            </Button>
          )}
        </div>
      </PageTitle>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[160px_1fr]">
        <dt className="text-muted">{t('browsers.id')}</dt>
        <dd>
          <Mono>{i.id}</Mono>
        </dd>
        <dt className="text-muted">{t('browsers.status')}</dt>
        <dd>
          <StatusPill value={i.status} /> {i.statusReason ? <span className="text-muted">{i.statusReason}</span> : null}
          {i.suspendedAt ? (
            <span className="ml-2">
              <Pill tone="bad">{t('browsers.suspended')}</Pill> {String(i.suspendedReason ?? '')} · {when(i.suspendedAt)}
            </span>
          ) : null}
        </dd>
        <dt className="text-muted">{t('browsers.owner')}</dt>
        <dd>
          {d.data.owner ? (
            <Link to={`/browsers?q=${encodeURIComponent(d.data.owner.email)}`} className="text-accent hover:underline">
              {d.data.owner.email}
            </Link>
          ) : (
            '—'
          )}
        </dd>
        <dt className="text-muted">{t('browsers.where')}</dt>
        <dd>{t('browsers.whereValue', { region: i.regionId, ip: String(current?.ipAddress ?? '—'), zone: String(current?.zone ?? '—'), gen: String(current?.generation ?? '—') })}</dd>
        <dt className="text-muted">{t('browsers.agent')}</dt>
        <dd>{t('browsers.agentValue', { ready: when(health?.agentReadyAt), heartbeat: when(health?.lastHeartbeatAt), viewers: health?.viewers ?? 0 })}</dd>
      </dl>

      <Section title={t('browsers.operations')}>
        <Table
          rows={d.data.operations}
          rowKey={(o) => o.id}
          onRow={(o) => setOp(o.id)}
          columns={[t('col.created'), t('col.kind'), t('col.status'), t('col.step'), t('col.error')]}
          cells={(o) => [when(o.createdAt), term(o.kind), <StatusPill value={o.status} tone={o.status === 'running' ? 'warn' : undefined} />, String(o.step ?? '—'), String(o.error ?? '')]}
        />
      </Section>
      <Section title={t('browsers.placements')}>
        <Table
          rows={d.data.placements}
          rowKey={(p) => String(p.generation)}
          columns={[t('col.gen'), t('col.status'), t('col.zone'), t('col.vm'), t('col.volume'), t('col.ip')]}
          cells={(p) => [
            String(p.generation),
            <StatusPill value={String(p.status)} />,
            String(p.zone ?? '—'),
            <Mono>{String(p.vmId ?? '—')}</Mono>,
            <Mono>{String(p.volumeId ?? '—')}</Mono>,
            <Mono>{String(p.ipAddress ?? '—')}</Mono>,
          ]}
        />
      </Section>
      <Section title={t('browsers.ipHistory')}>
        <Table
          rows={d.data.ipAddresses}
          rowKey={(r) => String(r.address)}
          columns={[t('col.address'), t('col.assigned'), t('col.released')]}
          cells={(r) => [<Mono>{String(r.address)}</Mono>, when(r.assignedAt), when(r.releasedAt)]}
        />
      </Section>
      <Link to={`/audit?target=${encodeURIComponent(`instance:${i.id}`)}`} className="block text-sm text-accent hover:underline">
        {t('browsers.auditLink')}
      </Link>

      <OperationDialog id={op} onClose={() => setOp(null)} />
      <ReasonDialog
        open={action !== null}
        title={action ? `${t(ACTIONS[action].label)} · ${i.name}` : ''}
        description={action ? t(ACTIONS[action].help) : undefined}
        confirm={action ? t(ACTIONS[action].label) : ''}
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
                toast(t('common.done'));
              },
              onError: (e) => toast(errorText(e), 'error'),
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
