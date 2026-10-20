import { useRegionInfo } from './hooks.js';
import type { Instance } from '@cloudbrowser/contracts';
import { Button, Card, cn, Menu, MenuItem, MenuSeparator, RegionIpChip, StatusBadge, useToast } from '@cloudbrowser/ui';
import { BarChart3, Moon, MoreHorizontal, Pencil, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
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

export function BrowserCard({ instance: i }: { instance: Instance }) {
  const { t, locale, errorMessage } = useI18n();
  const ago = useRelativeTime();
  const navigate = useNavigate();
  const toast = useToast();
  const lifecycle = useLifecycle();
  const update = useUpdateInstance();
  const billing = useBilling();
  const region = useRegionInfo(i.regionId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const run = (p: Promise<unknown>) => p.catch((e) => toast(errorMessage(e), 'error'));

  const deleted = i.status === 'deleting';
  const recoverable = deleted && i.purgeAfter !== null && Date.parse(i.purgeAfter) > Date.now();
  const failed = i.status === 'failed';
  const creating = i.status === 'creating';
  const status = shownStatus(i);

  let primary: React.ReactNode;
  if (recoverable) {
    primary = (
      <Button variant="secondary" className="flex-1 justify-center" disabled={lifecycle.isPending || !canSpend(billing.data)} onClick={() => run(lifecycle.mutateAsync({ id: i.id, action: 'undelete' }))}>
        {t('browsers.restore')}
      </Button>
    );
  } else if (deleted) {
    primary = <Button variant="secondary" className="flex-1 justify-center" disabled>{t('browsers.deletePending')}</Button>;
  } else if (failed) {
    primary = (
      <Button
        variant="secondary"
        className="flex-1 justify-center"
        onClick={() => navigate(`/browsers/new?retry=${encodeURIComponent(i.id)}`)}
      >
        {t('browsers.tryAgain')}
      </Button>
    );
  } else {
    // Ink for the browsers already awake; waking one is a step further, so it is an outline.
    primary = (
      <Button variant={status === 'sleeping' ? 'secondary' : 'primary'} className="flex-1 justify-center" disabled={creating || !canUseBrowser(billing.data, i)} onClick={() => navigate(`/b/${i.id}`)}>
        {status === 'sleeping' ? t('browsers.wakeOpen') : t('browsers.open')}
      </Button>
    );
  }

  return (
    <Card className="flex flex-col p-5 transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <h2 className="truncate text-lg font-semibold tracking-tight" title={i.name}>
          {i.name}
        </h2>
        <StatusBadge className="shrink-0 pt-0.5 text-[13px]" tone={STATUS_TONE[status]} label={t(statusKey(status))} />
      </div>
      <TrialBadge className="mt-1" trial={i.trial} />
      <RegionIpChip
        className="mt-5 text-[15px]"
        country={region.country}
        city={region.city}
        ip={i.ipAddress}
        copyLabel={t('browsers.copyIp')}
        pendingLabel={t('browsers.reservingIp')}
      />
      <p className="mt-1.5 text-xs text-subtle">
        {recoverable && i.purgeAfter
          ? t('browsers.recoverableUntil', { date: new Date(i.purgeAfter).toLocaleDateString(locale) })
          : deleted
            ? t('browsers.deletePendingHint')
            : i.lastActiveAt
            ? t('browsers.usedAgo', { ago: ago(i.lastActiveAt)! })
            : t('browsers.neverUsed')}
      </p>
      {!deleted && !failed ? <BalanceRequired instance={i} /> : null}
      <StopNotice instance={i} />

      {creating ? (
        <div className="mt-4">
          <CreateProgress instance={i} />
        </div>
      ) : null}
      {(i.status === 'needs_attention' || i.status === 'failed' || i.status === 'waiting_capacity' || i.status === 'provider_issue') &&
      i.statusReason ? (
        <p className="mt-3 text-sm text-muted">{i.statusReason}</p>
      ) : null}

      <div className="min-h-5 flex-1" />
      <div className="-mx-5 -mb-5 flex items-center gap-2 border-t border-border px-5 py-4">
        {primary}
        <Menu
          trigger={
            <Button size="icon" variant="ghost" aria-label={t('browsers.menu')}>
              <MoreHorizontal />
            </Button>
          }
        >
          <MenuItem
            disabled={deleted}
            onSelect={() => {
              const name = window.prompt(t('browsers.renamePrompt'), i.name)?.trim();
              if (name && name !== i.name) void run(update.mutateAsync({ id: i.id, patch: { name } }));
            }}
          >
            <Pencil /> {t('browsers.rename')}
          </MenuItem>
          <MenuItem disabled={deleted || failed} onSelect={() => navigate(`/browsers/${i.id}/settings`)}>
            <Settings /> {t('browsers.settings')}
          </MenuItem>
          <MenuItem disabled={failed} onSelect={() => navigate(`/browsers/${i.id}/usage`)}>
            <BarChart3 /> {t('manage.usage')}
          </MenuItem>
          <MenuItem disabled={deleted || failed || status === 'sleeping' || (lifecycle.isPending && lifecycle.variables.action === 'stop')} onSelect={() => void run(lifecycle.mutateAsync({ id: i.id, action: 'stop' }))}>
            <Moon /> {t('browsers.sleepNow')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            disabled={deleted || (lifecycle.isPending && lifecycle.variables.action === 'delete')}
            onSelect={() => setConfirmDelete(true)}
          >
            <Trash2 /> {t('browsers.delete')}
          </MenuItem>
        </Menu>
      </div>
      <DeleteBrowserDialog instance={i} open={confirmDelete} onClose={() => setConfirmDelete(false)} />
    </Card>
  );
}
