import { useRegionInfo } from './hooks.js';
import type { Instance } from '@cloudbrowser/contracts';
import { Button, Card, Menu, MenuItem, MenuSeparator, RegionIpChip, StatusBadge, useToast } from '@cloudbrowser/ui';
import { BarChart3, Moon, MoreHorizontal, Pencil, Settings, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useI18n, useRelativeTime } from '../../lib/i18n.js';
import { CreateProgress } from './CreateProgress.js';
import { useLifecycle, useUpdateInstance } from './hooks.js';
import { STATUS_TONE, statusKey } from './status.js';
import { TrialBadge } from './Trial.js';
import { useBilling } from '../billing/hooks.js';
import { canSpend, canUseBrowser } from '../billing/access.js';
import { BalanceRequired } from '../billing/BalanceRequired.js';

export function BrowserCard({ instance: i }: { instance: Instance }) {
  const { t, locale, errorMessage } = useI18n();
  const ago = useRelativeTime();
  const navigate = useNavigate();
  const toast = useToast();
  const lifecycle = useLifecycle();
  const update = useUpdateInstance();
  const billing = useBilling();
  const region = useRegionInfo(i.regionId);
  const run = (p: Promise<unknown>) => p.catch((e) => toast(errorMessage(e), 'error'));

  const deleted = i.status === 'deleting';
  const recoverable = deleted && i.purgeAfter !== null && Date.parse(i.purgeAfter) > Date.now();
  const failed = i.status === 'failed';
  const creating = i.status === 'creating';

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
    primary = (
      <Button variant="primary" className="flex-1 justify-center" disabled={creating || !canUseBrowser(billing.data, i)} onClick={() => navigate(`/b/${i.id}`)}>
        {i.status === 'sleeping' ? t('browsers.wakeOpen') : t('browsers.open')}
      </Button>
    );
  }

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="truncate text-base font-semibold" title={i.name}>
          {i.name}
        </h2>
      </div>
      <StatusBadge className="mt-1" tone={STATUS_TONE[i.status]} label={t(statusKey(i.status))} />
      <TrialBadge className="mt-1" trial={i.trial} />
      <RegionIpChip
        className="mt-3"
        country={region.country}
        city={region.city}
        ip={i.ipAddress}
        copyLabel={t('browsers.copyIp')}
        pendingLabel={t('browsers.reservingIp')}
      />
      <p className="mt-1 text-xs text-subtle">
        {recoverable && i.purgeAfter
          ? t('browsers.recoverableUntil', { date: new Date(i.purgeAfter).toLocaleDateString(locale) })
          : deleted
            ? t('browsers.deletePendingHint')
            : i.lastActiveAt
            ? t('browsers.usedAgo', { ago: ago(i.lastActiveAt)! })
            : t('browsers.neverUsed')}
      </p>
      {!deleted && !failed ? <BalanceRequired instance={i} /> : null}

      {creating ? (
        <div className="mt-4">
          <CreateProgress instance={i} />
        </div>
      ) : null}
      {(i.status === 'needs_attention' || i.status === 'failed' || i.status === 'waiting_capacity' || i.status === 'provider_issue') &&
      i.statusReason ? (
        <p className="mt-3 text-sm text-muted">{i.statusReason}</p>
      ) : null}

      <div className="mt-auto flex items-center gap-2 pt-4">
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
          <MenuItem disabled={deleted || failed || i.status === 'sleeping' || (lifecycle.isPending && lifecycle.variables.action === 'stop')} onSelect={() => void run(lifecycle.mutateAsync({ id: i.id, action: 'stop' }))}>
            <Moon /> {t('browsers.sleepNow')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            disabled={deleted || (lifecycle.isPending && lifecycle.variables.action === 'delete')}
            onSelect={() => {
              if (window.confirm(t('browsers.deleteConfirm', { name: i.name }))) void run(lifecycle.mutateAsync({ id: i.id, action: 'delete' }));
            }}
          >
            <Trash2 /> {t('browsers.delete')}
          </MenuItem>
        </Menu>
      </div>
    </Card>
  );
}
