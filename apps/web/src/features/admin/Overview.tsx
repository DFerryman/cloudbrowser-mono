import { Button, useToast } from '@cloudbrowser/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { put, useAdmin, useAdminAction, when, type Overview } from './data.js';
import { useT, type AdminKey } from './i18n.js';
import { PageTitle, ReasonDialog, Tile } from './ui.js';

const STATUS_ORDER = ['running', 'creating', 'starting', 'stopping', 'sleeping', 'waiting_capacity', 'provider_issue', 'needs_attention', 'failed', 'deleting'];

export function OverviewPage() {
  const { t, term } = useT();
  const o = useAdmin<Overview>('/overview', { refetchInterval: 30_000 });
  if (!o.data) return <p className="text-sm text-muted">{t('common.loading')}</p>;
  const d = o.data;
  return (
    <div className="space-y-6">
      <PageTitle title={t('nav.overview')} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label={t('overview.alerts')} value={<Link to="/alerts">{d.alertsOpen}</Link>} tone={d.alertsOpen ? 'bad' : undefined} />
        <Tile label={t('overview.findings')} value={<Link to="/findings">{d.findingsOpen}</Link>} tone={d.findingsOpen ? 'warn' : undefined} />
        <Tile label={t('overview.unfinished')} value={<Link to="/operations">{d.operations.unfinished}</Link>} />
        <Tile label={t('overview.failed24h')} value={d.operations.failed24h} tone={d.operations.failed24h ? 'warn' : undefined} />
        <Tile label={t('overview.webhooks')} value={d.webhooksPending} tone={d.webhooksPending ? 'warn' : undefined} />
        <Tile label={t('overview.users')} value={d.users} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium">{t('overview.byStatus')}</h2>
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.filter((s) => d.instances[s]).map((s) => (
            <span key={s} className="rounded-[var(--radius-control)] border border-border px-2.5 py-1 text-sm">
              {term(s)} <b className="tabular-nums">{d.instances[s]}</b>
            </span>
          ))}
          {STATUS_ORDER.every((s) => !d.instances[s]) ? <span className="text-sm text-muted">{t('overview.noBrowsers')}</span> : null}
        </div>
      </section>

      <Switches flags={d.flags} />
    </div>
  );
}

const SWITCHES: { key: string; label: AdminKey; help: AdminKey }[] = [
  { key: 'creation_freeze', label: 'switches.freeze', help: 'switches.freezeHelp' },
  { key: 'billing_required', label: 'switches.billing', help: 'switches.billingHelp' },
  { key: 'invite_only', label: 'switches.inviteOnly', help: 'switches.inviteOnlyHelp' },
];

function Switches({ flags }: { flags: Overview['flags'] }) {
  const { t, errorText } = useT();
  const toast = useToast();
  const [pending, setPending] = useState<{ key: string; value: 'true' | 'false'; label: string } | null>(null);
  const set = useAdminAction((v: { key: string; value: string; reason: string }) => put(`/flags/${v.key}`, { value: v.value, reason: v.reason }));
  return (
    <section className="max-w-3xl">
      <h2 className="mb-2 text-sm font-medium">{t('switches.title')}</h2>
      <div className="divide-y divide-border rounded-[var(--radius-card)] border border-border">
        {SWITCHES.map((s) => {
          const on = flags[s.key]?.value === 'true';
          return (
            <div key={s.key} className="flex items-start justify-between gap-3 p-3 text-sm">
              <div>
                <p className="font-medium">
                  {t(s.label)} <span className={on ? 'text-error' : 'text-muted'}>· {t(on ? 'common.on' : 'common.off')}</span>
                </p>
                <p className="text-xs text-muted">{t(s.help)}</p>
                {flags[s.key]?.reason ? <p className="mt-1 text-xs text-muted">{t('switches.lastChange', { reason: flags[s.key]!.reason!, when: when(flags[s.key]!.updatedAt) })}</p> : null}
              </div>
              <Button size="sm" variant={on ? 'secondary' : 'danger'} onClick={() => setPending({ key: s.key, value: on ? 'false' : 'true', label: t(s.label) })}>
                {t(on ? 'common.turnOff' : 'common.turnOn')}
              </Button>
            </div>
          );
        })}
      </div>
      <ReasonDialog
        open={pending !== null}
        title={pending ? `${t(pending.value === 'true' ? 'common.turnOn' : 'common.turnOff')} · ${pending.label}` : ''}
        confirm={t(pending?.value === 'true' ? 'common.turnOn' : 'common.turnOff')}
        danger={pending?.value === 'true'}
        busy={set.isPending}
        onClose={() => setPending(null)}
        onConfirm={(reason) =>
          pending &&
          set.mutate(
            { key: pending.key, value: pending.value, reason },
            { onSuccess: () => setPending(null), onError: (e) => toast(errorText(e), 'error') },
          )
        }
      />
    </section>
  );
}
