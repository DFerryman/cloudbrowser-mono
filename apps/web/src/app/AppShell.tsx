import { cn, Eyebrow, Menu, MenuItem, MenuSeparator, PageHeader as Header, ResizeHandle, Skeleton, useResizableWidth } from '@cloudbrowser/ui';
import { BookOpen, Globe, LayoutGrid, LogOut, PanelLeftClose, PanelLeftOpen, Plus, UserRound, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
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
      <img
        src="/nevazu-logo.png"
        alt=""
        aria-hidden="true"
        width={32}
        height={16}
        className={cn('h-auto w-8 shrink-0 object-contain', compact && 'w-6 lg:w-8')}
      />
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

const SIDEBAR = { key: 'nevazu.sidebar.width', min: 208, max: 380, initial: 256 } as const;
const COLLAPSED_KEY = 'nevazu.sidebar.collapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** True from Tailwind's `lg` breakpoint up; below it the sidebar is always the icon rail. */
function useWide() {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/**
 * The app frame. From `lg` up a left sidebar the user drags to any width between 208 and 380 px
 * (remembered), or collapses to an icon rail; from `md` it is the rail; on phones a top bar and a
 * bottom tab bar within thumb reach, so nothing important needs scrolling to find.
 */
export function AppShell() {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  const billing = useBilling();
  const location = useLocation();
  const navigate = useNavigate();
  const wide = useWide();
  const [collapsedPref, setCollapsedPref] = useState(readCollapsed);
  const sidebar = useResizableWidth({ ...SIDEBAR, edge: 'right' });
  useLiveEvents(me.isSuccess);

  // "N" anywhere outside a text field starts a new browser.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey || el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      navigate('/browsers/new');
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [navigate]);

  if (me.isError && isUnauthenticated(me.error)) {
    return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }

  const collapsed = !wide || collapsedPref;
  const setCollapsed = (c: boolean) => {
    setCollapsedPref(c);
    try {
      localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0');
    } catch {
      // Not remembered; it still applies now.
    }
  };

  const nav = [
    { to: '/browsers', label: t('nav.browsers'), icon: LayoutGrid },
    { to: '/billing', label: t('nav.billing'), icon: Wallet },
    { to: '/account', label: t('nav.account'), icon: UserRound },
  ];
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'group relative flex h-9 items-center gap-3 px-2.5 text-sm font-medium transition-colors',
      collapsed && 'justify-center px-0',
      isActive ? 'bg-fg/[0.06] text-fg' : 'text-muted hover:bg-fg/[0.04] hover:text-fg',
    );

  const account = me.data ? (
    <Menu
      align="start"
      trigger={
        <button type="button" className={cn('flex w-full min-w-0 items-center gap-2.5 px-2 py-2 text-left text-sm transition-colors hover:bg-fg/[0.04]', collapsed && 'justify-center px-0')}>
          <span className="grid size-7 shrink-0 place-items-center bg-fg text-xs font-semibold text-bg uppercase">
            {me.data.user.email[0]}
          </span>
          {!collapsed ? <span className="min-w-0 flex-1 truncate text-muted">{me.data.user.email}</span> : null}
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

  const b = billing.data;
  const hours = b ? fundedHours(b) : null;
  const used = me.data?.usage.browsers ?? 0;
  const max = me.data?.entitlements.maxBrowsers ?? 0;

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside
        style={collapsed ? undefined : { width: sidebar.width }}
        className={cn('sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-surface md:flex', collapsed ? 'w-[68px] p-2.5' : 'p-3', !sidebar.dragging && 'transition-[width] duration-200 ease-out')}
      >
        {!collapsed ? <ResizeHandle {...sidebar.handleProps} edge="right" dragging={sidebar.dragging} label={t('nav.resize')} /> : null}
        <div className={cn('flex items-center gap-2 py-2', collapsed ? 'justify-center' : 'px-1.5')}>
          <Link to="/" aria-label={t('nav.home')} className="inline-flex min-w-0">
            {collapsed ? <img src="/nevazu-logo.png" alt="" width={28} height={14} className="h-auto w-7" /> : <Logo />}
          </Link>
          {wide && !collapsed ? (
            <button type="button" onClick={() => setCollapsed(true)} className="ml-auto grid size-7 place-items-center text-subtle transition-colors hover:bg-surface-2 hover:text-fg" aria-label={t('nav.collapse')} title={t('nav.collapse')}>
              <PanelLeftClose className="size-4" />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => navigate('/browsers/new')}
          title={collapsed ? t('browsers.new') : t('nav.shortcuts')}
          aria-label={t('browsers.new')}
          className={cn(
            'mt-5 flex h-9 items-center gap-2 bg-fg text-sm font-medium text-bg transition-[background-color,transform] duration-150 hover:bg-fg/88 active:translate-y-px',
            collapsed ? 'justify-center' : 'px-3',
          )}
        >
          <Plus className="size-4" />
          {!collapsed ? (
            <>
              <span className="flex-1 text-left">{t('browsers.new')}</span>
              <kbd className="border border-bg/25 px-1.5 font-mono text-[10px] font-medium text-bg/70">N</kbd>
            </>
          ) : null}
        </button>

        <nav className="mt-6 flex flex-col gap-0.5">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className={linkClass} title={n.label}>
              {({ isActive }) => (
                <>
                  {isActive ? <span className="absolute inset-y-2 left-0 w-0.5 bg-fg" aria-hidden /> : null}
                  <n.icon className={cn('size-4 shrink-0 transition-colors', isActive ? 'text-fg' : 'text-subtle group-hover:text-fg')} />
                  {!collapsed ? <span className="truncate">{n.label}</span> : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-2">
          {me.data && b && !collapsed ? (
            <div className="border border-border bg-bg p-4">
              <Link to="/billing" className="group block">
                <Eyebrow>{t('nav.balanceLabel')}</Eyebrow>
                <p className="mt-2 text-[22px] leading-none font-semibold tracking-[-0.02em] text-fg tabular-nums">{money(b.balanceMicros, locale)}</p>
                <p className={cn('mt-2 truncate text-xs text-subtle tabular-nums', isLowBalance(b) && 'text-error')} title={t('nav.availableHeld', { available: money(b.availableMicros, locale), reserved: money(b.reservedMicros, locale) })}>
                  {t('nav.availableHeld', { available: money(b.availableMicros, locale), reserved: money(b.reservedMicros, locale) })}
                </p>
                {hours !== null ? (
                  <p className={cn('mt-0.5 truncate text-xs tabular-nums', hours < 24 ? 'font-medium text-error' : 'text-subtle')} data-testid="nav-runway">
                    {t('nav.runway', { time: runwayLabel(t, hours) })}
                  </p>
                ) : null}
              </Link>
              <div className="mt-4 border-t border-border pt-3">
                <div className="flex items-center justify-between text-[11px] text-subtle">
                  <span>{t('nav.browsersUsed')}</span>
                  <span className="tabular-nums">{t('nav.usage', { used, max })}</span>
                </div>
                <div className="mt-1.5 h-0.5 bg-surface-2" aria-hidden>
                  <div className={cn('h-full transition-[width] duration-300', used >= max ? 'bg-error' : 'bg-fg')} style={{ width: `${max ? Math.min(100, (used / max) * 100) : 0}%` }} />
                </div>
              </div>
              {b.mode === 'prepaid' ? (
                <Link to="/billing#top-up" className="mt-4 flex h-8 items-center justify-center border border-border-strong text-xs font-medium transition-colors hover:border-fg/50 hover:bg-surface">
                  {t('nav.addCredit')}
                </Link>
              ) : null}
            </div>
          ) : me.data && b && collapsed ? (
            <Link to="/billing" title={`${t('nav.balanceLabel')}: ${money(b.balanceMicros, locale)}`} className={cn('grid h-10 place-items-center border border-border bg-bg text-[11px] font-semibold tabular-nums transition-colors hover:border-border-strong', isLowBalance(b) ? 'text-error' : 'text-fg')}>
              {money(b.balanceMicros, locale).replace(/\.\d+$/, '')}
            </Link>
          ) : (
            <Skeleton className={cn('h-4', collapsed ? 'mx-1' : 'mx-2.5')} />
          )}
          {wide && collapsed ? (
            <button type="button" onClick={() => setCollapsed(false)} className="grid h-8 place-items-center text-subtle transition-colors hover:bg-surface-2 hover:text-fg" aria-label={t('nav.expand')} title={t('nav.expand')}>
              <PanelLeftOpen className="size-4" />
            </button>
          ) : null}
          {account}
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-bg/85 px-4 backdrop-blur-xl md:hidden">
        <Link to="/" aria-label={t('nav.home')} className="inline-flex">
          <Logo />
        </Link>
        {b ? (
          <Link to="/billing" className={cn('ml-auto border border-border px-2 py-1 text-xs font-semibold tabular-nums', isLowBalance(b) ? 'text-error' : 'text-fg')}>
            {money(b.balanceMicros, locale)}
          </Link>
        ) : <span className="ml-auto" />}
        <div className="w-10">{account}</div>
      </header>

      <main className="min-w-0 flex-1 pb-[calc(64px+env(safe-area-inset-bottom))] md:pb-0">
        <div className="mx-auto w-full max-w-[1280px] px-4 py-5 md:px-8 md:py-8 lg:px-10">
          <BillingBanner />
          {/* Each section fades in when the user moves to it; moving within one (a dialog, a tab) does not. */}
          <div key={location.pathname.split('/')[1]} className="[animation:cb-in_220ms_var(--ease-out)]">
            <Outlet />
          </div>
        </div>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden" aria-label={t('nav.menu')}>
        {nav.slice(0, 1).map((n) => <TabLink key={n.to} {...n} />)}
        <button type="button" onClick={() => navigate('/browsers/new')} className="flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium text-fg">
          <span className="grid size-7 place-items-center bg-fg text-bg"><Plus className="size-4" /></span>
          {t('nav.new')}
        </button>
        {nav.slice(1).map((n) => <TabLink key={n.to} {...n} />)}
      </nav>
    </div>
  );
}

function TabLink({ to, label, icon: Icon }: { to: string; label: string; icon: typeof Wallet }) {
  return (
    <NavLink to={to} className={({ isActive }) => cn('flex min-w-0 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors', isActive ? 'text-fg' : 'text-subtle')}>
      <span className="grid size-7 place-items-center"><Icon className="size-5" /></span>
      <span className="max-w-full truncate px-1">{label}</span>
    </NavLink>
  );
}

export function PageHeader({ title, action, description, eyebrow }: { title: string; action?: React.ReactNode; description?: React.ReactNode; eyebrow?: React.ReactNode }) {
  return <Header title={title} description={description} eyebrow={eyebrow} actions={action} />;
}

export function FullPageMessage({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-[50vh] place-items-center text-sm text-muted">{children}</div>;
}

