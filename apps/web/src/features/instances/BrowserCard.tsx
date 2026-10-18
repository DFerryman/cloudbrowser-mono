import type { Instance } from '@cloudbrowser/contracts';
import { Button, Card, Menu, MenuItem, MenuSeparator, RegionIpChip, StatusBadge, useToast } from '@cloudbrowser/ui';
import { BarChart3, Moon, MoreHorizontal, Pencil, Settings, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useI18n, useRelativeTime } from '../../lib/i18n.js';
import { CreateProgress } from './CreateProgress.js';
import { useCreateInstance, useLifecycle, useUpdateInstance } from './hooks.js';
import { regionInfo, STATUS_TONE, statusKey } from './status.js';
import { TrialBadge } from './Trial.js';

export function BrowserCard({ instance: i }: { instance: Instance }) {
  const { t, locale, errorMessage } = useI18n();
  const ago = useRelativeTime();
  const navigate = useNavigate();
  const toast = useToast();
  const lifecycle = useLifecycle();
  const update = useUpdateInstance();
  const create = useCreateInstance();
  const region = regionInfo(i.regionId);
  const run = (p: Promise<unknown>) => p.catch((e) => toast(errorMessage(e), 'error'));

  const deleted = i.status === 'deleting';
  const failed = i.status === 'failed';
  const creating = i.status === 'creating';

  let primary: React.ReactNode;
  if (deleted) {
    primary = (
      <Button variant="secondary" className="flex-1 justify-center" disabled={lifecycle.isPending} onClick={() => run(lifecycle.mutateAsync({ id: i.id, action: 'undelete' }))}>
        {t('browsers.restore')}
      </Button>
    );
  } else if (failed) {
    primary = (
      <Button
        variant="secondary"
        className="flex-1 justify-center"
        disabled={create.isPending}
        onClick={() =>
          run(
            lifecycle
              .mutateAsync({ id: i.id, action: 'delete' })
              .then(() => create.mutateAsync({ name: i.name, regionId: i.regionId, locale: i.locale, screen: i.screen })),
          )
        }
      >
        {t('browsers.tryAgain')}
      </Button>
    );
  } else {
    primary = (
      <Button variant="primary" className="flex-1 justify-center" disabled={creating} onClick={() => navigate(`/b/${i.id}`)}>
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
      <p className="mt-1 text-xs text-muted">
        {deleted && i.purgeAfter
          ? t('browsers.recoverableUntil', { date: new Date(i.purgeAfter).toLocaleDateString(locale) })
          : i.lastActiveAt
            ? t('browsers.usedAgo', { ago: ago(i.lastActiveAt)! })
            : t('browsers.neverUsed')}
      </p>

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
          <MenuItem disabled={i.status !== 'running'} onSelect={() => void run(lifecycle.mutateAsync({ id: i.id, action: 'stop' }))}>
            <Moon /> {t('browsers.sleepNow')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            disabled={deleted || creating}
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
