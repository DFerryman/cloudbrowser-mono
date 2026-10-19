import { Button, Input, Label, useToast } from '@cloudbrowser/ui';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { del, put, useAdmin, useAdminAction, type Overview } from './data.js';
import { Switches } from './Overview.js';
import { Mono, PageTitle, ReasonDialog, Table } from './ui.js';

type Cap = { scope: string; metric: string; limit: number };

/** Caps (page 10, "Limits") and operator switches. Every change is audited. */
export function LimitsPage() {
  const toast = useToast();
  const caps = useAdmin<Cap[]>('/caps');
  const overview = useAdmin<Overview>('/overview');
  const [draft, setDraft] = useState<Cap>({ scope: '', metric: '', limit: 0 });
  const [removing, setRemoving] = useState<Cap | null>(null);
  const save = useAdminAction((c: Cap) => put('/caps', c));
  const remove = useAdminAction((c: Cap) => del('/caps', { scope: c.scope, metric: c.metric }));
  const edit = (c: Cap) => setDraft({ ...c });
  const defaultInstances = caps.data?.find((c) => c.scope === 'user:default' && c.metric === 'instances');

  return (
    <div className="space-y-6">
      <PageTitle title="Limits & switches" />
      {overview.data ? <Switches flags={overview.data.flags} /> : null}

      {defaultInstances ? <DefaultBrowserLimit key={defaultInstances.limit} currentLimit={defaultInstances.limit} /> : null}

      <section>
        <h2 className="mb-2 text-sm font-medium">Caps</h2>
        <p className="mb-3 text-xs text-muted">
          Scopes: <Mono>global</Mono>, <Mono>region:&lt;id&gt;</Mono>, <Mono>user:default</Mono> (account defaults) and <Mono>user:&lt;id&gt;</Mono> (per-account override, wins over the
          defaults). Use <Mono>instances</Mono> for the browser count and <Mono>running</Mono> for simultaneous running browsers.
        </p>
        <form
          className="mb-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(draft, { onSuccess: () => toast('Saved'), onError: (err) => toast((err as Error).message, 'error') });
          }}
        >
          <div>
            <Label htmlFor="scope">Scope</Label>
            <Input id="scope" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })} placeholder="user:default" className="w-56" />
          </div>
          <div>
            <Label htmlFor="metric">Metric</Label>
            <Input id="metric" value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value })} placeholder="instances" className="w-48" />
          </div>
          <div>
            <Label htmlFor="limit">Limit</Label>
            <Input id="limit" type="number" min={0} value={draft.limit} onChange={(e) => setDraft({ ...draft, limit: Number(e.target.value) })} className="w-28" />
          </div>
          <Button type="submit" variant="primary" disabled={!draft.scope || !draft.metric || save.isPending}>
            Save cap
          </Button>
        </form>
        <Table
          rows={caps.data}
          rowKey={(c) => `${c.scope}/${c.metric}`}
          columns={['Scope', 'Metric', 'Limit', '']}
          cells={(c) => [
            <Mono>{c.scope}</Mono>,
            c.metric,
            <span className="tabular-nums">{c.limit}</span>,
            c.scope.startsWith('billing:') ? (
              <span className="text-xs text-muted">from Creem</span>
            ) : (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => edit(c)}>
                  Edit
                </Button>
                <Button size="icon" variant="ghost" aria-label="Delete cap" onClick={() => setRemoving(c)}>
                  <Trash2 />
                </Button>
              </span>
            ),
          ]}
        />
      </section>
      <ReasonDialog
        open={removing !== null}
        title={removing ? `Delete ${removing.scope} / ${removing.metric}` : ''}
        description="Removing a per-account override restores the user:default value."
        confirm="Delete"
        danger
        busy={remove.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing, { onSuccess: () => setRemoving(null), onError: (e) => toast((e as Error).message, 'error') })}
      />
    </div>
  );
}

function DefaultBrowserLimit({ currentLimit }: { currentLimit: number }) {
  const toast = useToast();
  const [value, setValue] = useState(String(currentLimit));
  const save = useAdminAction((limit: number) => put('/caps', { scope: 'user:default', metric: 'instances', limit }));
  const limit = Number(value);
  const valid = value !== '' && Number.isInteger(limit) && limit >= 0;
  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">Default browsers per account</h2>
      <p className="mt-1 text-xs text-muted">
        Counts running and sleeping browsers. Per-account overrides take priority. Running limits and regional capacity apply separately; there is no daily creation quota.
      </p>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate(limit, { onSuccess: () => toast('Default browser limit saved'), onError: (err) => toast((err as Error).message, 'error') });
      }}>
        <div>
          <Label htmlFor="default-browser-limit">Browser instance limit</Label>
          <Input id="default-browser-limit" type="number" min={0} step={1} required value={value} onChange={(e) => setValue(e.target.value)} className="w-28" />
        </div>
        <Button type="submit" variant="primary" disabled={!valid || limit === currentLimit || save.isPending}>Save default browser limit</Button>
      </form>
    </section>
  );
}
