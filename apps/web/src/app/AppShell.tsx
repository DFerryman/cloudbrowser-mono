import { cn, Eyebrow, Menu, MenuItem, MenuSeparator, PageHeader as Header, Skeleton } from '@cloudbrowser/ui';
import { BookOpen, Globe, LayoutGrid, LogOut, UserRound, Wallet } from 'lucide-react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { fundedHours, isLowBalance, runwayLabel } from '../features/billing/access.js';
import { BillingBanner } from '../features/billing/BillingBanner.js';
import { useBilling } from '../features/billing/hooks.js';
import { money } from '../lib/money.js';
import { useMe } from '../features/instances/hooks.js';
import { api, isUnauthenticated } from '../lib/api.js';
import { useLiveEvents } from '../lib/events.js';
import { useI18n } from '../lib/i18n.js';
import { queryClient } from '../lib/query.js';
import { ThemeItems } from './Preferences.js';

export function Logo({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
      {/* A square in a square: a browser window, drawn in ink. */}
      <span className="grid size-6 place-items-center bg-fg" aria-hidden>
        <span className="size-2.5 border-2 border-bg" />
      </span>
      <span className={cn(compact && 'hidden lg:inline')}>{t('app.name')}</span>
    </span>
  );
}

/** Ends the session (every session with `everywhere`) and lands on sign-in with a confirmation. */
export async function signOut({ everywhere = false }: { everywhere?: boolean } = {}) {
  if (everywhere) await api('POST', '/api/auth/revoke-sessions', { body: {} }).catch(() => {});
  await api('POST', '/api/auth/sign-out', { body: {} }).catch(() => {});
  queryClient.clear();
  window.location.assign('/sign-in?signedOut=1');
}

/** Left sidebar (240 px, a 64 px rail below 1024 px, a top bar on mobile) around the app pages. */
export function AppShell() {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  const billing = useBilling();
  const location = useLocation();
  useLiveEvents(me.isSuccess);

  if (me.isError && isUnauthenticated(me.error)) {
    return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }

  const nav = [
    { to: '/browsers', label: t('nav.browsers'), icon: LayoutGrid },
    { to: '/billing', label: t('nav.billing'), icon: Wallet },
    { to: '/account', label: t('nav.account'), icon: UserRound },
  ];
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'relative flex items-center gap-3 px-3 py-2 text-sm transition-colors [&_svg]:size-[18px]',
      isActive ? 'bg-surface-2 font-semibold text-fg before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-fg' : 'font-medium text-muted hover:bg-surface hover:text-fg',
    );

  const account = me.data ? (
    <Menu
      align="start"
      trigger={
        <button type="button" className="flex w-full min-w-0 items-center gap-2.5 px-2 py-2 text-left text-sm hover:bg-surface-2">
          <span className="grid size-7 shrink-0 place-items-center border border-border-strong text-xs font-semibold uppercase">
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
      <ThemeItems />
      <MenuSeparator />
      <MenuItem onSelect={() => window.open('/docs', '_blank', 'noopener')}>
        <BookOpen /> {t('nav.help')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => void signOut()}>
        <LogOut /> {t('nav.signOut')}
      </MenuItem>
    </Menu>
  ) : null;

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="sticky top-0 hidden h-dvh w-16 shrink-0 flex-col border-r border-border bg-bg p-3 md:flex lg:w-64">
        <div className="px-2 py-2.5">
          <Logo compact />
        </div>
        <nav className="mt-8 flex flex-col gap-0.5">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className={linkClass} title={n.label}>
              <n.icon />
              <span className="hidden lg:inline">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2">
          {me.data ? (
            <NavLink to="/billing" className="hidden border border-border px-3 py-3 text-xs text-muted transition-colors hover:border-border-strong lg:block">
              {billing.data ? (
                <>
                  <Eyebrow>{t('nav.balanceLabel')}</Eyebrow>
                  <p className="mt-1.5 mb-1 text-xl font-semibold tracking-tight text-fg tabular-nums">{money(billing.data.balanceMicros, locale)}</p>
                  <p className={cn('tabular-nums', isLowBalance(billing.data) && 'text-error')}>
                    {t('nav.availableHeld', {
                      available: money(billing.data.availableMicros, locale),
                      reserved: money(billing.data.reservedMicros, locale),
                    })}
                  </p>
                  {fundedHours(billing.data) !== null ? (
                    <p className={cn('tabular-nums', fundedHours(billing.data)! < 24 && 'text-error')} data-testid="nav-runway">
                      {t('nav.runway', { time: runwayLabel(t, fundedHours(billing.data)!) })}
                    </p>
                  ) : null}
                </>
              ) : null}
              <p className="mt-2 border-t border-border pt-2">{t('nav.usage', { used: me.data.usage.browsers, max: me.data.entitlements.maxBrowsers })}</p>
            </NavLink>
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
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-10 md:py-10">
          <BillingBanner />
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PageHeader({ title, action, description, eyebrow }: { title: string; action?: React.ReactNode; description?: React.ReactNode; eyebrow?: React.ReactNode }) {
  return <Header title={title} description={description} eyebrow={eyebrow} actions={action} />;
}

export function FullPageMessage({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-[50vh] place-items-center text-sm text-muted">{children}</div>;
}

