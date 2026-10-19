import { useRegionInfo } from './hooks.js';
import type { Instance } from '@cloudbrowser/contracts';
import { Button, cn, RegionIpChip, Skeleton, StatusBadge } from '@cloudbrowser/ui';
import { ArrowLeft } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { useInstance } from './hooks.js';
import { shownStatus, STATUS_TONE, statusKey } from './status.js';
import { TrialBadge, TrialNotice } from './Trial.js';
import { useBilling } from '../billing/hooks.js';
import { canUseBrowser } from '../billing/access.js';
import { BalanceRequired } from '../billing/BalanceRequired.js';

/** The browser management area (page 1): one header and three tabs, Settings, Storage and Usage. */
export function BrowserLayout() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const instance = useInstance(id);
  const billing = useBilling();
  const region = useRegionInfo(instance.data?.regionId ?? '');
  if (instance.isPending) return <Skeleton className="h-96" />;
  if (instance.isError) return <p className="text-sm text-error">{t('error.not_found')}</p>;
  const i = instance.data;
  const tabs = [
    { to: 'settings', label: t('manage.settings') },
    { to: 'storage', label: t('manage.storage') },
    { to: 'usage', label: t('manage.usage') },
  ];
  return (
    <>
      <Link to="/browsers" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> {t('manage.back')}
      </Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{i.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <StatusBadge tone={STATUS_TONE[shownStatus(i)]} label={t(statusKey(shownStatus(i)))} />
            <RegionIpChip
              country={region.country}
              city={region.city}
              ip={i.ipAddress}
              copyLabel={t('browsers.copyIp')}
              pendingLabel={t('browsers.reservingIp')}
            />
            <TrialBadge trial={i.trial} />
          </div>
        </div>
        <Button variant="primary" onClick={() => navigate(`/b/${i.id}`)} disabled={i.status === 'deleting' || i.status === 'failed' || !canUseBrowser(billing.data, i)}>
          {shownStatus(i) === 'sleeping' ? t('browsers.wakeOpen') : t('browsers.open')}
        </Button>
      </div>
      <TrialNotice trial={i.trial} />
      {i.status !== 'deleting' && i.status !== 'failed' ? <BalanceRequired instance={i} /> : null}
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-border" aria-label={i.name}>
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet context={i} />
    </>
  );
}

/** The browser of the management area a tab belongs to. */
export const useManagedInstance = () => useOutletContext<Instance>();
