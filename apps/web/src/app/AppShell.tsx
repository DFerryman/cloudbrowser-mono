import { cn, Menu, MenuItem, MenuSeparator, Skeleton } from '@cloudbrowser/ui';
import { Globe, LayoutGrid, LogOut, UserRound, Wallet } from 'lucide-react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { BillingBanner } from '../features/billing/BillingBanner.js';
import { useBilling } from '../features/billing/hooks.js';
import { money } from '../lib/money.js';
import { useMe } from '../features/instances/hooks.js';
import { api, isUnauthenticated } from '../lib/api.js';
import { useLiveEvents } from '../lib/events.js';
import { useI18n } from '../lib/i18n.js';
import { queryClient } from '../lib/query.js';

export function Logo({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="flex items-center gap-2 font-semibold">
      <span className="grid size-6 place-items-center rounded-md bg-accent text-white">◆</span>
      <span className={cn(compact && 'hidden lg:inline')}>{t('app.name')}</span>
    </span>
  );
}

export async function signOut() {
  await api('POST', '/api/auth/sign-out', { body: {} }).catch(() => {});
  queryClient.clear();
  window.location.assign('/sign-in');
}

/** Left sidebar (240 px, a 64 px rail below 1024 px, a top bar on mobile) around the app pages. */
export function AppShell() {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  const billing = useBilling();
  const location = useLocation();
  useLiveEvents(me.isSuccess);

  if (me.isError && isUnauthenticated(me.error)) {
    return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname)}`} replace />;
  }

  const nav = [
    { to: '/browsers', label: t('nav.browsers'), icon: LayoutGrid },
    { to: '/billing', label: t('nav.billing'), icon: Wallet },
    { to: '/account', label: t('nav.account'), icon: UserRound },
  ];
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-3 rounded-[var(--radius-control)] px-2.5 py-2 text-sm font-medium transition-colors [&_svg]:size-5',
      isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
    );

  const account = me.data ? (
    <Menu
      align="start"
      trigger={
        <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-sm hover:bg-surface-2">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold uppercase">
            {me.data.user.email[0]}
          </span>
          <span className="hidden truncate lg:inline">{me.data.user.email}</span>
        </button>
      }
    >
      <MenuItem onSelect={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>
        <Globe /> {locale === 'en' ? '中文' : 'English'}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => void signOut()}>
        <LogOut /> {t('nav.signOut')}
      </MenuItem>
    </Menu>
  ) : null;

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="sticky top-0 hidden h-dvh w-16 shrink-0 flex-col border-r border-border bg-surface p-3 md:flex lg:w-60">
        <div className="px-1.5 py-2">
          <Logo compact />
        </div>
        <nav className="mt-6 flex flex-col gap-1">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className={linkClass} title={n.label}>
              <n.icon />
              <span className="hidden lg:inline">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2">
          {me.data ? (
            <div className="hidden space-y-0.5 px-2.5 text-xs text-muted lg:block">
              {billing.data ? (
                <p className={billing.data.mode === 'prepaid' && billing.data.balanceMicros <= billing.data.lowBalanceMicros ? 'font-medium text-error' : ''}>
                  {billing.data.mode === 'pilot' ? t('nav.pilot') : t('nav.balance', { amount: money(billing.data.balanceMicros, locale) })}
                </p>
              ) : null}
              <p>{t('nav.usage', { used: me.data.usage.browsers, max: me.data.entitlements.maxBrowsers })}</p>
            </div>
          ) : (
            <Skeleton className="mx-2.5 hidden h-4 lg:block" />
          )}
          {account}
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-bg px-4 md:hidden">
        <Logo />
        <nav className="ml-auto flex items-center gap-1">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className={linkClass} aria-label={n.label}>
              <n.icon />
            </NavLink>
          ))}
          <div className="w-10">{account}</div>
        </nav>
      </header>

      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6">
          <BillingBanner />
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PageHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between gap-4">
      <h1 className="truncate text-xl font-semibold">{title}</h1>
      {action}
    </div>
  );
}

export function FullPageMessage({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-[50vh] place-items-center text-sm text-muted">{children}</div>;
}

