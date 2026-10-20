import { useRegionInfo } from './hooks.js';
import type { Instance } from '@cloudbrowser/contracts';
import { Button, cn, RegionIpChip, Skeleton, StatusBadge } from '@cloudbrowser/ui';
import { ArrowLeft } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { useInstance } from './hooks.js';
import { shownStatus, STATUS_TONE, statusKey } from './status.js';
import { StopNotice } from './BrowserCard.js';
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
      <Link to="/browsers" className="group mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-4 transition-transform duration-150 group-hover:-translate-x-0.5" aria-hidden /> {t('manage.back')}
      </Link>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-[26px] leading-tight font-semibold tracking-[-0.025em] md:text-[30px]">{i.name}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
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
        <Button variant="primary" className="min-w-32 justify-center" onClick={() => navigate(`/b/${i.id}`)} disabled={i.status === 'deleting' || i.status === 'failed' || !canUseBrowser(billing.data, i)}>
          {shownStatus(i) === 'sleeping' ? t('browsers.wakeOpen') : t('browsers.open')}
        </Button>
      </div>
      <TrialNotice trial={i.trial} />
      <StopNotice instance={i} className="mb-4 max-w-3xl text-sm" />
      {i.status !== 'deleting' && i.status !== 'failed' ? <BalanceRequired instance={i} /> : null}
      <nav className="mb-8 flex gap-6 overflow-x-auto overflow-y-hidden border-b border-border" aria-label={i.name}>
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                'border-b-2 py-3 text-sm font-medium whitespace-nowrap transition-colors',
                isActive ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg',
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
