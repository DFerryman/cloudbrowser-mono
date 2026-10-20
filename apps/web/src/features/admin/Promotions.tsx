import { PROMOTION_UNIT, PromotionCriterion, type PromotionTaskInput } from '@cloudbrowser/contracts';
import { Button, Dialog, Input, Label, Select, useToast } from '@cloudbrowser/ui';
import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ADMIN_PAGE, del, put, usd, useAdmin, useAdminAction, useAdminPage, when } from './data.js';
import { useT, type AdminKey } from './i18n.js';
import { Mono, PageTitle, Pill, ReasonDialog, Table } from './ui.js';

type TaskRow = Omit<PromotionTaskInput, 'startsAt' | 'endsAt'> & {
  id: string;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  completions: number;
  credited: number;
  paidMicros: number;
};
type CompletionRow = { userId: string; email: string | null; progress: number; rewardMicros: number; completedAt: string; creditedAt: string | null };

const CRITERIA = PromotionCriterion.options;
const UNIT_KEY: Record<(typeof PROMOTION_UNIT)[keyof typeof PROMOTION_UNIT], AdminKey> = {
  minutes: 'promo.unit.minutes',
  browsers: 'promo.unit.browsers',
  usd: 'promo.unit.usd',
  step: 'promo.unit.step',
  passkeys: 'promo.unit.passkeys',
};

const EMPTY: PromotionTaskInput = {
  title: { en: '', 'zh-CN': '' },
  description: { en: '', 'zh-CN': '' },
  actionUrl: '/browsers/new',
  criterion: 'browser_running_minutes',
  target: 20,
  rewardMicros: 5_000_000,
  enabled: false,
  requiresTopup: false,
  sortOrder: 0,
  startsAt: null,
  endsAt: null,
  maxCompletions: null,
};

/** `datetime-local` works in local time without a zone; the API takes ISO timestamps. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

/**
 * Promotions: tasks that pay users credit for trying the product. Each task says what the user
 * does (English and Chinese), how completion is measured (criterion and target), the reward, and
 * when and for how many accounts it runs. Every change is audited.
 */
export function PromotionsPage() {
  const { t, term } = useT();
  const tasks = useAdmin<TaskRow[]>('/promotions');
  const [editing, setEditing] = useState<{ id: string; isNew: boolean; draft: PromotionTaskInput } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const status = (r: TaskRow) => {
    const now = Date.now();
    if (!r.enabled) return <Pill>{t('promo.off')}</Pill>;
    if (r.startsAt && new Date(r.startsAt).getTime() > now) return <Pill tone="warn">{t('promo.scheduled')}</Pill>;
    if (r.endsAt && new Date(r.endsAt).getTime() <= now) return <Pill>{t('promo.ended')}</Pill>;
    if (r.maxCompletions !== null && r.completions >= r.maxCompletions) return <Pill tone="warn">{t('promo.budgetUsed')}</Pill>;
    return <Pill tone="ok">{t('promo.live')}</Pill>;
  };
  const edit = (r: TaskRow) => {
    const { id, createdAt: _c, updatedAt: _u, updatedBy: _b, completions: _n, credited: _r, paidMicros: _p, ...draft } = r;
    setEditing({ id, isNew: false, draft });
  };

  return (
    <div className="space-y-6">
      <PageTitle title={t('nav.promotions')}>
        <Button variant="primary" onClick={() => setEditing({ id: '', isNew: true, draft: EMPTY })}>
          <Plus /> {t('promo.new')}
        </Button>
      </PageTitle>
      <p className="max-w-3xl text-sm text-muted">{t('promo.intro')}</p>

      <Table
        rows={tasks.data}
        rowKey={(r) => r.id}
        empty={t('promo.empty')}
        columns={[t('promo.col.task'), t('promo.col.done'), t('col.status'), t('promo.col.reward'), t('promo.col.completions'), t('promo.col.paid'), '']}
        cells={(r) => [
          <span>
            <span className="font-medium">{r.title['zh-CN']}</span>
            <br />
            <span className="text-xs text-muted">{r.title.en}</span>
            <br />
            <Mono>{r.id}</Mono>
          </span>,
          <span className="text-xs">
            {term(r.criterion)} ≥ {r.target} {t(UNIT_KEY[PROMOTION_UNIT[r.criterion]])}
            {r.requiresTopup ? <span className="block text-muted">{t('promo.needsTopup')}</span> : null}
          </span>,
          <span className="text-xs">
            {status(r)}
            {r.startsAt || r.endsAt ? <span className="mt-1 block text-muted">{when(r.startsAt)} → {when(r.endsAt)}</span> : null}
          </span>,
          <span className="tabular-nums">{usd(r.rewardMicros)}</span>,
          <span className="tabular-nums">
            {r.completions}
            {r.maxCompletions !== null ? ` / ${r.maxCompletions}` : ''}
            {r.credited < r.completions ? <span className="block text-xs text-starting">{t('promo.uncredited', { n: r.completions - r.credited })}</span> : null}
          </span>,
          <span className="tabular-nums">{usd(r.paidMicros)}</span>,
          <span className="flex gap-2 whitespace-nowrap">
            <Button size="sm" onClick={() => edit(r)}>{t('common.edit')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(r.id)}>{t('promo.who')}</Button>
          </span>,
        ]}
      />

      {selected ? <Completions id={selected} /> : null}

      {editing ? <EditDialog key={editing.id || 'new'} {...editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function Completions({ id }: { id: string }) {
  const { t } = useT();
  const page = useAdminPage<CompletionRow>(`/promotions/${encodeURIComponent(id)}/completions`, ADMIN_PAGE.ledger);
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{t('promo.completionsOf', { id })}</h2>
      <Table
        rows={page.rows}
        pager={page.pager}
        rowKey={(r) => r.userId}
        columns={[t('col.user'), t('promo.col.progress'), t('promo.col.reward'), t('promo.col.completedAt'), t('promo.col.creditedAt')]}
        cells={(r) => [
          <span>{r.email ?? '—'}<br /><Mono>{r.userId}</Mono></span>,
          <span className="tabular-nums">{r.progress}</span>,
          <span className="tabular-nums">{usd(r.rewardMicros)}</span>,
          when(r.completedAt),
          r.creditedAt ? when(r.creditedAt) : <Pill tone="warn">{t('promo.pendingCredit')}</Pill>,
        ]}
      />
    </section>
  );
}

function EditDialog({ id: initialId, isNew, draft: initial, onClose }: { id: string; isNew: boolean; draft: PromotionTaskInput; onClose: () => void }) {
  const { t, term, errorText } = useT();
  const toast = useToast();
  const [id, setId] = useState(initialId);
  const [draft, setDraft] = useState(initial);
  const [confirm, setConfirm] = useState<'save' | 'delete' | null>(null);
  const save = useAdminAction((v: PromotionTaskInput & { reason: string }) => put(`/promotions/${encodeURIComponent(id)}`, v));
  const remove = useAdminAction((reason: string) => del(`/promotions/${encodeURIComponent(id)}`, { reason }));
  const set = <K extends keyof PromotionTaskInput>(k: K, v: PromotionTaskInput[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const unit = PROMOTION_UNIT[draft.criterion];
  const valid = /^[a-z0-9][a-z0-9-]{1,62}$/.test(id) && draft.title.en.trim() && draft.title['zh-CN'].trim() && draft.description.en.trim() && draft.description['zh-CN'].trim() && draft.target >= 1;
  const field = (fid: string, label: string, input: ReactNode, help?: string) => (
    <div className="mb-3">
      <Label htmlFor={fid}>{label}</Label>
      {input}
      {help ? <p className="mt-1 text-xs text-muted">{help}</p> : null}
    </div>
  );

  return (
    <>
      <Dialog
        open={!confirm}
        onOpenChange={(o) => !o && onClose()}
        size="lg"
        title={isNew ? t('promo.new') : t('promo.editTitle', { id })}
        footer={
          <div className="flex flex-wrap justify-between gap-2">
            <div>{!isNew ? <Button variant="danger" onClick={() => setConfirm('delete')}>{t('common.delete')}</Button> : null}</div>
            <div className="flex gap-2">
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={!valid} onClick={() => setConfirm('save')}>{t('common.save')}</Button>
            </div>
          </div>
        }
      >
        <div className="grid gap-x-4 sm:grid-cols-2" data-testid="promotion-form">
          <div className="sm:col-span-2">
            {field('promo-id', t('promo.id'), <Input id="promo-id" value={id} disabled={!isNew} onChange={(e) => setId(e.target.value.trim().toLowerCase())} placeholder="first-browser-20-minutes" />, t('promo.idHelp'))}
          </div>
          {field('promo-title-zh', t('promo.titleZh'), <Input id="promo-title-zh" value={draft.title['zh-CN']} onChange={(e) => set('title', { ...draft.title, 'zh-CN': e.target.value })} />)}
          {field('promo-title-en', t('promo.titleEn'), <Input id="promo-title-en" value={draft.title.en} onChange={(e) => set('title', { ...draft.title, en: e.target.value })} />)}
          {field('promo-desc-zh', t('promo.descZh'), <textarea id="promo-desc-zh" rows={3} className="w-full border border-border bg-bg p-2 text-sm" value={draft.description['zh-CN']} onChange={(e) => set('description', { ...draft.description, 'zh-CN': e.target.value })} />)}
          {field('promo-desc-en', t('promo.descEn'), <textarea id="promo-desc-en" rows={3} className="w-full border border-border bg-bg p-2 text-sm" value={draft.description.en} onChange={(e) => set('description', { ...draft.description, en: e.target.value })} />)}
          {field('promo-criterion', t('promo.criterion'), (
            <Select id="promo-criterion" value={draft.criterion} onChange={(e) => {
              const criterion = e.target.value as PromotionTaskInput['criterion'];
              setDraft((d) => ({ ...d, criterion, target: criterion === 'two_factor_enabled' ? 1 : d.target }));
            }}>
              {CRITERIA.map((c) => <option key={c} value={c}>{term(c)}</option>)}
            </Select>
          ), t(`promo.criterion.${draft.criterion}` as AdminKey))}
          {field('promo-target', `${t('promo.target')} (${t(UNIT_KEY[unit])})`, (
            <Input id="promo-target" type="number" min={1} step={1} disabled={draft.criterion === 'two_factor_enabled'} value={draft.target} onChange={(e) => set('target', Math.max(1, Math.round(Number(e.target.value))))} />
          ))}
          {field('promo-reward', t('promo.reward'), (
            <Input id="promo-reward" type="number" min={0} step="0.01" value={draft.rewardMicros / 1_000_000} onChange={(e) => set('rewardMicros', Math.max(0, Math.round(Number(e.target.value) * 1_000_000)))} />
          ), t('promo.rewardHelp'))}
          {field('promo-action', t('promo.action'), (
            <Input id="promo-action" value={draft.actionUrl ?? ''} placeholder="/browsers/new" onChange={(e) => set('actionUrl', e.target.value.trim() || null)} />
          ), t('promo.actionHelp'))}
          {field('promo-starts', t('promo.startsAt'), <Input id="promo-starts" type="datetime-local" value={toLocalInput(draft.startsAt)} onChange={(e) => set('startsAt', fromLocalInput(e.target.value))} />, t('promo.startsHelp'))}
          {field('promo-ends', t('promo.endsAt'), <Input id="promo-ends" type="datetime-local" value={toLocalInput(draft.endsAt)} onChange={(e) => set('endsAt', fromLocalInput(e.target.value))} />, t('promo.endsHelp'))}
          {field('promo-max', t('promo.max'), (
            <Input id="promo-max" type="number" min={1} step={1} value={draft.maxCompletions ?? ''} placeholder={t('promo.unlimited')} onChange={(e) => set('maxCompletions', e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : null)} />
          ), t('promo.maxHelp'))}
          {field('promo-order', t('promo.order'), <Input id="promo-order" type="number" step={1} value={draft.sortOrder} onChange={(e) => set('sortOrder', Math.round(Number(e.target.value)))} />, t('promo.orderHelp'))}
          <div className="space-y-2 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} /> {t('promo.enabled')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.requiresTopup} onChange={(e) => set('requiresTopup', e.target.checked)} /> {t('promo.requiresTopup')}
            </label>
            <p className="text-xs text-muted">{t('promo.requiresTopupHelp')}</p>
          </div>
        </div>
      </Dialog>
      <ReasonDialog
        open={confirm === 'save'}
        title={isNew ? t('promo.new') : t('promo.editTitle', { id })}
        description={t('promo.saveHelp')}
        confirm={t('common.save')}
        busy={save.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => save.mutate({ ...draft, reason }, { onSuccess: () => { toast(t('common.saved')); onClose(); }, onError: (e) => { toast(errorText(e), 'error'); setConfirm(null); } })}
      />
      <ReasonDialog
        open={confirm === 'delete'}
        danger
        title={t('promo.deleteTitle', { id })}
        description={t('promo.deleteHelp')}
        confirm={t('common.delete')}
        busy={remove.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => remove.mutate(reason, { onSuccess: onClose, onError: (e) => { toast(errorText(e), 'error'); setConfirm(null); } })}
      />
    </>
  );
}
