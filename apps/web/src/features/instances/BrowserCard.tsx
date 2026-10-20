import { useRegionInfo } from './hooks.js';
import type { Instance } from '@cloudbrowser/contracts';
import { Button, Card, cn, Menu, MenuItem, MenuSeparator, RegionIpChip, StatusBadge, useToast } from '@cloudbrowser/ui';
import { BarChart3, Check, Copy, HardDrive, Moon, MoreHorizontal, Pencil, Play, Power, RotateCcw, Settings, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n, useRelativeTime } from '../../lib/i18n.js';
import type { MessageKey } from '../../messages/en.js';
import { CreateProgress } from './CreateProgress.js';
import { DeleteBrowserDialog } from './DeleteBrowser.js';
import { useLifecycle, useUpdateInstance } from './hooks.js';
import { shownStatus, STATUS_TONE, statusKey } from './status.js';
import { TrialBadge } from './Trial.js';
import { useBilling } from '../billing/hooks.js';
import { canSpend, canUseBrowser } from '../billing/access.js';
import { BalanceRequired } from '../billing/BalanceRequired.js';
import { TONE, toneFor } from '../../lib/tones.js';

/**
 * Why a browser was stopped when the user did not do it, and when an unfunded browser will be
 * deleted. Neither kind of stop is ever undone automatically: the user opens the browser again.
 */
export function StopNotice({ instance: i, className }: { instance: Instance; className?: string }) {
  const { t, locale } = useI18n();
  if (!i.stopReason && !i.deletesAt) return null;
  return (
    <div className={cn('mt-3 border-l-2 border-error bg-error/5 px-3 py-2.5 text-xs text-error', className)} role="status" data-testid="stop-notice">
      {i.stopReason ? <p>{t(`browsers.stopped.${i.stopReason}` as MessageKey)}</p> : null}
      {i.deletesAt ? <p className={i.stopReason ? 'mt-1 font-medium' : 'font-medium'}>{t('browsers.deletesAt', { date: new Date(i.deletesAt).toLocaleString(locale) })}</p> : null}
    </div>
  );
}

/** What the user can do with a browser, shared by the card and the list row. */
function useBrowserActions(i: Instance) {
  const { t, errorMessage } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const lifecycle = useLifecycle();
  const update = useUpdateInstance();
  const billing = useBilling();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const run = (p: Promise<unknown>) => p.catch((e) => toast(errorMessage(e), 'error'));

  const deleted = i.status === 'deleting';
  const recoverable = deleted && i.purgeAfter !== null && Date.parse(i.purgeAfter) > Date.now();
  const failed = i.status === 'failed';
  const creating = i.status === 'creating';
  const status = shownStatus(i);
  const sleeping = status === 'sleeping';
  const stopping = lifecycle.isPending && lifecycle.variables.action === 'stop';
  const rename = (name: string) => {
    const next = name.trim();
    if (next && next !== i.name) void run(update.mutateAsync({ id: i.id, patch: { name: next } }));
  };

  const primary = (className?: string) => {
    if (recoverable) {
      return (
        <Button variant="secondary" className={className} disabled={lifecycle.isPending || !canSpend(billing.data)} onClick={() => run(lifecycle.mutateAsync({ id: i.id, action: 'undelete' }))}>
          <RotateCcw /> {t('browsers.restore')}
        </Button>
      );
    }
    if (deleted) return <Button variant="secondary" className={className} disabled>{t('browsers.deletePending')}</Button>;
    if (failed) {
      return (
        <Button variant="secondary" className={className} onClick={() => navigate(`/browsers/new?retry=${encodeURIComponent(i.id)}`)}>
          <RotateCcw /> {t('browsers.tryAgain')}
        </Button>
      );
    }
    // Ink for the browsers already awake; waking one is a step further, so it is an outline.
    return (
      <Button variant={sleeping ? 'secondary' : 'primary'} className={className} disabled={creating || !canUseBrowser(billing.data, i)} onClick={() => navigate(`/b/${i.id}`)}>
        {sleeping ? <Power /> : <Play />} {sleeping ? t('browsers.wakeOpen') : t('browsers.open')}
      </Button>
    );
  };

  // Fixed slots, so the buttons line up from row to row whichever of them a browser offers.
  const quick = (
    <>
      {status === 'running' ? (
        <Button size="icon" variant="ghost" aria-label={t('browsers.sleepNow')} title={t('browsers.sleepNow')} disabled={stopping} onClick={() => void run(lifecycle.mutateAsync({ id: i.id, action: 'stop' }))}>
          <Moon />
        </Button>
      ) : <span className="size-8 shrink-0" aria-hidden />}
      {!deleted && !failed ? (
        <Button size="icon" variant="ghost" aria-label={t('browsers.settings')} title={t('browsers.settings')} onClick={() => navigate(`/browsers/${i.id}/settings`)}>
          <Settings />
        </Button>
      ) : <span className="size-8 shrink-0" aria-hidden />}
    </>
  );

  const menu = (onRename: () => void) => (
    <>
      <Menu
        trigger={
          <Button size="icon" variant="ghost" aria-label={t('browsers.menu')} title={t('browsers.menu')}>
            <MoreHorizontal />
          </Button>
        }
      >
        <MenuItem disabled={deleted} onSelect={onRename}>
          <Pencil /> {t('browsers.rename')}
        </MenuItem>
        <MenuItem disabled={!i.ipAddress} onSelect={() => i.ipAddress && void navigator.clipboard.writeText(i.ipAddress).then(() => toast(t('browsers.copied')), () => {})}>
          <Copy /> {t('browsers.copyIp')}
        </MenuItem>
        <MenuItem disabled={deleted || failed} onSelect={() => navigate(`/browsers/${i.id}/settings`)}>
          <Settings /> {t('browsers.settings')}
        </MenuItem>
        <MenuItem disabled={deleted || failed} onSelect={() => navigate(`/browsers/${i.id}/storage`)}>
          <HardDrive /> {t('manage.storage')}
        </MenuItem>
        <MenuItem disabled={failed} onSelect={() => navigate(`/browsers/${i.id}/usage`)}>
          <BarChart3 /> {t('manage.usage')}
        </MenuItem>
        <MenuItem disabled={deleted || failed || sleeping || stopping} onSelect={() => void run(lifecycle.mutateAsync({ id: i.id, action: 'stop' }))}>
          <Moon /> {t('browsers.sleepNow')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger disabled={deleted || (lifecycle.isPending && lifecycle.variables.action === 'delete')} onSelect={() => setConfirmDelete(true)}>
          <Trash2 /> {t('browsers.delete')}
        </MenuItem>
      </Menu>
      <DeleteBrowserDialog instance={i} open={confirmDelete} onClose={() => setConfirmDelete(false)} />
    </>
  );

  return { status, deleted, recoverable, failed, creating, primary, quick, menu, rename };
}

/** The browser's name; double-click (or Rename in its menu) edits it in place. Enter saves, Escape cancels. */
function InlineName({ name, editing, setEditing, onSave, disabled, className }: { name: string; editing: boolean; setEditing: (e: boolean) => void; onSave: (n: string) => void; disabled?: boolean; className?: string }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(name);
      requestAnimationFrame(() => ref.current?.select());
    }
  }, [editing, name]);
  if (editing) {
    return (
      <form
        className="flex min-w-0 flex-1 items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(draft);
          setEditing(false);
        }}
      >
        <input
          ref={ref}
          value={draft}
          maxLength={64}
          aria-label={t('browsers.rename')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onSave(draft); setEditing(false); }}
          onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), setEditing(false))}
          className={cn('h-8 min-w-0 flex-1 border border-indigo bg-bg px-2 text-base font-semibold outline-none', className)}
        />
        <button type="submit" className="grid size-8 place-items-center bg-indigo text-white" aria-label={t('browsers.saveName')} onMouseDown={(e) => e.preventDefault()}>
          <Check className="size-4" />
        </button>
      </form>
    );
  }
  return (
    <h2
      className={cn('min-w-0 truncate font-semibold tracking-tight', !disabled && 'cursor-text', className)}
      title={disabled ? name : `${name} · ${t('browsers.renameHint')}`}
      onDoubleClick={() => !disabled && setEditing(true)}
    >
      {name}
    </h2>
  );
}

function UsedLine({ instance: i }: { instance: Instance }) {
  const { t, locale } = useI18n();
  const ago = useRelativeTime();
  const deleted = i.status === 'deleting';
  const recoverable = deleted && i.purgeAfter !== null && Date.parse(i.purgeAfter) > Date.now();
  return (
    <>
      {recoverable && i.purgeAfter
        ? t('browsers.recoverableUntil', { date: new Date(i.purgeAfter).toLocaleDateString(locale) })
        : deleted
          ? t('browsers.deletePendingHint')
          : i.lastActiveAt
            ? t('browsers.usedAgo', { ago: ago(i.lastActiveAt)! })
            : t('browsers.neverUsed')}
    </>
  );
}

export function BrowserCard({ instance: i }: { instance: Instance }) {
  const { t } = useI18n();
  const region = useRegionInfo(i.regionId);
  const a = useBrowserActions(i);
  const [editing, setEditing] = useState(false);
  const tone = TONE[toneFor(i.regionId)];

  return (
    <Card className="group relative flex flex-col overflow-hidden border-border/70 p-5 transition-[border-color,box-shadow] duration-200 hover:border-border-strong hover:shadow-[0_18px_40px_-28px_rgb(0_0_0/0.35)]">
      <span className={cn('absolute inset-x-0 top-0 h-[3px]', a.status === 'running' ? 'bg-running' : tone.bg, a.status !== 'running' && 'opacity-60')} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className={cn('grid size-10 shrink-0 place-items-center font-mono text-xs font-semibold', tone.soft, tone.text)} aria-hidden>
            {region.country || '··'}
          </span>
          <div className="min-w-0 flex-1">
            <InlineName name={i.name} editing={editing} setEditing={setEditing} onSave={a.rename} disabled={a.deleted} className="text-[17px]" />
            <p className="truncate text-xs text-subtle"><UsedLine instance={i} /></p>
          </div>
        </div>
        <StatusBadge pill className="mt-0.5 shrink-0" tone={STATUS_TONE[a.status]} label={t(statusKey(a.status))} />
      </div>
      <TrialBadge className="mt-2" trial={i.trial} />
      <div className="mt-4 bg-surface px-3 py-2.5">
        <RegionIpChip
          className="text-[14px]"
          country={region.country}
          city={region.city}
          ip={i.ipAddress}
          copyLabel={t('browsers.copyIp')}
          pendingLabel={t('browsers.reservingIp')}
        />
      </div>
      {!a.deleted && !a.failed ? <BalanceRequired instance={i} /> : null}
      <StopNotice instance={i} />

      {a.creating ? (
        <div className="mt-4">
          <CreateProgress instance={i} />
        </div>
      ) : null}
      {(i.status === 'needs_attention' || i.status === 'failed' || i.status === 'waiting_capacity' || i.status === 'provider_issue') && i.statusReason ? (
        <p className="mt-3 text-sm text-muted">{i.statusReason}</p>
      ) : null}

      <div className="min-h-4 flex-1" />
      <div className="mt-4 flex items-center gap-1">
        {a.primary('flex-1 justify-center')}
        {a.quick}
        {a.menu(() => setEditing(true))}
      </div>
    </Card>
  );
}

/** The list's columns, shared by its header and every row so they line up. */
export const ROW_COLUMNS = 'lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,1fr)_248px]';

/** One browser as a dense row: for many browsers, and for phones where cards would mean scrolling. */
export function BrowserRow({ instance: i }: { instance: Instance }) {
  const { t } = useI18n();
  const region = useRegionInfo(i.regionId);
  const a = useBrowserActions(i);
  const [editing, setEditing] = useState(false);
  const tone = TONE[toneFor(i.regionId)];
  return (
    <div className={cn('group flex flex-col gap-2 px-3 py-3 transition-colors hover:bg-surface sm:px-4 lg:grid lg:items-center lg:gap-4', ROW_COLUMNS)} data-testid="browser-row">
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn('grid size-8 shrink-0 place-items-center font-mono text-[11px] font-semibold', tone.soft, tone.text)} aria-hidden>
          {region.country || '··'}
        </span>
        <div className="min-w-0 flex-1">
          <InlineName name={i.name} editing={editing} setEditing={setEditing} onSave={a.rename} disabled={a.deleted} className="text-sm" />
          <StatusBadge pill className="mt-0.5 lg:hidden" tone={STATUS_TONE[a.status]} label={t(statusKey(a.status))} />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 lg:hidden">
          {a.primary('h-8 px-3 text-[13px]')}
          {a.menu(() => setEditing(true))}
        </div>
      </div>
      <div className="min-w-0 pl-11 lg:pl-0">
        <RegionIpChip className="text-[13px]" country={region.country} city={region.city} ip={i.ipAddress} copyLabel={t('browsers.copyIp')} pendingLabel={t('browsers.reservingIp')} />
        {a.creating ? <div className="mt-2"><CreateProgress instance={i} /></div> : null}
        <StopNotice instance={i} className="mt-2" />
      </div>
      <div className="hidden min-w-0 items-center gap-3 lg:flex">
        <StatusBadge pill className="w-[92px] shrink-0" tone={STATUS_TONE[a.status]} label={t(statusKey(a.status))} />
        <span className="truncate text-xs text-subtle"><UsedLine instance={i} /></span>
      </div>
      <div className="hidden items-center justify-end gap-0.5 lg:flex">
        {a.primary('h-8 w-[140px] justify-center px-3 text-[13px]')}
        {a.quick}
        {a.menu(() => setEditing(true))}
      </div>
    </div>
  );
}
