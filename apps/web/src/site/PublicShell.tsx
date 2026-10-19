import { Button, cn, Menu, MenuItem } from '@cloudbrowser/ui';
import { Menu as MenuIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Logo } from '../app/AppShell.js';
import { LanguageButton, ThemeButton } from '../app/Preferences.js';
import { useI18n } from '../lib/i18n.js';
import { useSignedIn } from './hooks.js';

/** Header, page and footer for the pages anyone can read: home, pricing, docs, status and policies. */
export function PublicShell() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { pathname, hash } = useLocation();
  const signedIn = useSignedIn();
  // A new page starts at the top, unless the link points at a heading.
  useEffect(() => {
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);

  const nav = [
    { to: '/pricing', label: t('nav.pricing') },
    { to: '/docs', label: t('nav.docs') },
    { to: '/status', label: t('nav.status') },
  ];
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn('rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium transition-colors', isActive ? 'text-fg' : 'text-muted hover:text-fg');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1120px] items-center gap-2 px-4 md:px-6">
          <Link to="/" aria-label={t('nav.home')} className="mr-2">
            <Logo />
          </Link>
          <nav className="hidden items-center md:flex" aria-label={t('nav.menu')}>
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} className={linkClass}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <LanguageButton className="hidden sm:inline-flex" />
            <ThemeButton />
            {signedIn ? (
              <Button variant="primary" size="sm" onClick={() => navigate('/browsers')}>
                {t('nav.dashboard')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => navigate('/sign-in')}>
                {t('nav.signIn')}
              </Button>
            )}
            <div className="md:hidden">
              <Menu
                trigger={
                  <Button size="icon" variant="ghost" aria-label={t('nav.menu')}>
                    <MenuIcon />
                  </Button>
                }
              >
                {nav.map((n) => (
                  <MenuItem key={n.to} onSelect={() => navigate(n.to)}>
                    {n.label}
                  </MenuItem>
                ))}
                <MenuItem onSelect={() => navigate('/contact')}>{t('footer.contact')}</MenuItem>
              </Menu>
            </div>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

function Footer() {
  const { t } = useI18n();
  const columns = [
    { title: t('footer.product'), links: [['/pricing', t('nav.pricing')], ['/docs', t('nav.docs')], ['/status', t('nav.status')]] },
    { title: t('footer.legal'), links: [['/terms', t('footer.terms')], ['/privacy', t('footer.privacy')], ['/refunds', t('footer.refunds')]] },
    { title: t('footer.company'), links: [['/contact', t('footer.contact')], ['/docs/troubleshooting', t('nav.help')]] },
  ];
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto grid w-full max-w-[1120px] gap-8 px-4 py-10 sm:grid-cols-2 md:grid-cols-4 md:px-6">
        <div>
          <Logo />
          <p className="mt-3 max-w-56 text-xs leading-relaxed text-subtle">{t('footer.tagline')}</p>
        </div>
        {columns.map((col) => (
          <div key={col.title}>
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{col.title}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {col.links.map(([to, label]) => (
                <li key={to}>
                  <Link to={to!} className="text-muted hover:text-fg">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center justify-between gap-2 px-4 py-4 md:px-6">
          <p className="text-xs text-subtle">{t('footer.rights', { year: new Date().getFullYear() })}</p>
          <LanguageButton />
        </div>
      </div>
    </footer>
  );
}

/** A page's title block on the public site. */
export function PublicHero({ title, subtitle, children, className }: { title: string; subtitle?: string; children?: React.ReactNode; className?: string }) {
  return (
    <section className={cn('mx-auto w-full max-w-[1120px] px-4 pt-12 pb-8 md:px-6 md:pt-16', className)}>
      <h1 className="max-w-3xl text-2xl font-semibold tracking-tight md:text-[40px] md:leading-tight">{title}</h1>
      {subtitle ? <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">{subtitle}</p> : null}
      {children}
    </section>
  );
}

export const container = 'mx-auto w-full max-w-[1120px] px-4 md:px-6';
