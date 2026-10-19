import { Button, Input, Label, useToast } from '@cloudbrowser/ui';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { del, put, useAdmin, useAdminAction } from './data.js';
import { useT } from './i18n.js';
import { Mono, PageTitle, ReasonDialog, Table } from './ui.js';

type Cap = { scope: string; metric: string; limit: number };

/** Caps per scope. Every change is audited; switches are on the overview. */
export function LimitsPage() {
  const { t, errorText } = useT();
  const toast = useToast();
  const caps = useAdmin<Cap[]>('/caps');
  const [draft, setDraft] = useState<Cap>({ scope: '', metric: '', limit: 0 });
  const [removing, setRemoving] = useState<Cap | null>(null);
  const save = useAdminAction((c: Cap) => put('/caps', c));
  const remove = useAdminAction((c: Cap) => del('/caps', { scope: c.scope, metric: c.metric }));
  const perUser = caps.data?.find((c) => c.scope === 'user:default' && c.metric === 'instances')?.limit;
  const [perUserDraft, setPerUserDraft] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <PageTitle title={t('nav.limits')} />
      <section className="max-w-3xl rounded-[var(--radius-card)] border border-border p-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const limit = Number(perUserDraft);
            if (!Number.isInteger(limit) || limit < 0) return;
            save.mutate({ scope: 'user:default', metric: 'instances', limit }, { onSuccess: () => { setPerUserDraft(null); toast(t('common.saved')); }, onError: (err) => toast(errorText(err), 'error') });
          }}
        >
          <div>
            <Label htmlFor="per-user">{t('limits.perUser')}</Label>
            <Input id="per-user" type="number" min={0} step={1} value={perUserDraft ?? (perUser ?? '')} onChange={(e) => setPerUserDraft(e.target.value)} className="w-28" />
          </div>
          <Button type="submit" variant="primary" disabled={perUserDraft === null || perUserDraft === '' || Number(perUserDraft) === perUser || save.isPending}>
            {t('common.save')}
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted">{t('limits.perUserHelp')}</p>
      </section>
      <p className="text-xs text-muted">{t('limits.note')}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(draft, { onSuccess: () => toast(t('common.saved')), onError: (err) => toast(errorText(err), 'error') });
        }}
      >
        <div>
          <Label htmlFor="scope">{t('col.scope')}</Label>
          <Input id="scope" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })} placeholder="user:default" className="w-56" />
        </div>
        <div>
          <Label htmlFor="metric">{t('col.metric')}</Label>
          <Input id="metric" value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value })} placeholder="instances" className="w-48" />
        </div>
        <div>
          <Label htmlFor="limit">{t('col.limit')}</Label>
          <Input id="limit" type="number" min={0} value={draft.limit} onChange={(e) => setDraft({ ...draft, limit: Number(e.target.value) })} className="w-28" />
        </div>
        <Button type="submit" variant="primary" disabled={!draft.scope || !draft.metric || save.isPending}>
          {t('limits.saveCap')}
        </Button>
      </form>
      <Table
        rows={caps.data}
        rowKey={(c) => `${c.scope}/${c.metric}`}
        columns={[t('col.scope'), t('col.metric'), t('col.limit'), '']}
        cells={(c) => [
          <Mono>{c.scope}</Mono>,
          c.metric,
          <span className="tabular-nums">{c.limit}</span>,
          c.scope.startsWith('billing:') ? (
            <span className="text-xs text-muted">{t('limits.fromCreem')}</span>
          ) : (
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setDraft({ ...c })}>
                {t('common.edit')}
              </Button>
              <Button size="icon" variant="ghost" aria-label={t('limits.deleteCap')} onClick={() => setRemoving(c)}>
                <Trash2 />
              </Button>
            </span>
          ),
        ]}
      />
      <ReasonDialog
        open={removing !== null}
        title={removing ? t('limits.deleteTitle', { scope: removing.scope, metric: removing.metric }) : ''}
        description={t('limits.deleteHelp')}
        confirm={t('common.delete')}
        danger
        busy={remove.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing, { onSuccess: () => setRemoving(null), onError: (e) => toast(errorText(e), 'error') })}
      />
    </div>
  );
}
