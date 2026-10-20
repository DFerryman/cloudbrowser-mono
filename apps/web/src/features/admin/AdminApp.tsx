import { Button, cn } from '@cloudbrowser/ui';
import { Languages, LogOut, Shield } from 'lucide-react';
import { NavLink, Navigate, Route, Routes } from 'react-router';
import { ApiError } from '../../lib/api.js';
import { AlertsPage, AuditPage, FindingsPage, OperationsPage, UsersPage } from './Lists.js';
import { BrowserDetailPage, BrowsersPage } from './Browsers.js';
import { LimitsPage } from './Limits.js';
import { OverviewPage } from './Overview.js';
import { PricingPage } from './Pricing.js';
import { PromotionsPage } from './Promotions.js';
import { AwsProviderPage } from './AwsProvider.js';
import { useAdmin, type AdminSession } from './data.js';
import { AdminI18nProvider, useT, type AdminKey } from './i18n.js';
import { ACCESS_LOGIN_URL, ACCESS_LOGOUT_URL, APP_URL } from './location.js';

/**
 * The operator console has its own host and Cloudflare Access email session. It does not use
 * the main app's Better Auth session. Internal, Chinese by default with English, loaded on demand.
 */
export function AdminApp() {
  return (
    <AdminI18nProvider>
      <Gate />
    </AdminI18nProvider>
  );
}

function Gate() {
  const { t } = useT();
  const session = useAdmin<AdminSession>('/session');
  if (session.isPending) return <Centered>{t('common.loading')}</Centered>;
  if (session.isError) {
    const status = session.error instanceof ApiError ? session.error.status : null;
    return (
      <Centered>
        <Shield className="mx-auto size-8" aria-hidden />
        <h1 className="text-base font-semibold text-fg">{t('shell.title')}</h1>
        <p className="max-w-sm">{t(status === 403 ? 'shell.denied' : status === 401 ? 'shell.expired' : 'shell.unverified')}</p>
        <div className="flex flex-wrap justify-center gap-3">
          {status !== 403 ? <a href={ACCESS_LOGIN_URL} className="bg-fg px-4 py-2.5 font-medium text-bg hover:bg-fg/85">{t('shell.signIn')}</a> : null}
          {status !== 401 && status !== 403 ? <Button onClick={() => void session.refetch()}>{t('shell.retry')}</Button> : null}
          <a href={ACCESS_LOGOUT_URL} className="border border-border-strong px-4 py-2.5 font-medium text-fg hover:border-fg">{t('shell.signOut')}</a>
        </div>
        <LanguageToggle />
        <a href={APP_URL} className="block text-accent hover:underline">
          {t('shell.backToApp')}
        </a>
      </Centered>
    );
  }
  return <Console session={session.data} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-4 text-center text-sm text-muted">{<div className="space-y-3">{children}</div>}</div>;
}

function LanguageToggle() {
  const { t, locale, setLocale } = useT();
  return (
    <button type="button" onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')} className="mx-auto flex w-fit items-center gap-1.5 text-accent hover:underline" lang={locale === 'zh-CN' ? 'en' : 'zh-CN'}>
      <Languages className="size-4" aria-hidden /> {t('common.language')}
    </button>
  );
}

const NAV: [string, AdminKey][] = [
  ['', 'nav.overview'],
  ['alerts', 'nav.alerts'],
  ['operations', 'nav.operations'],
  ['browsers', 'nav.browsers'],
  ['users', 'nav.users'],
  ['aws-provider', 'nav.aws'],
  ['pricing', 'nav.pricing'],
  ['promotions', 'nav.promotions'],
  ['findings', 'nav.findings'],
  ['limits', 'nav.limits'],
  ['audit', 'nav.audit'],
];

function Console({ session }: { session: AdminSession }) {
  const { t } = useT();
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-b border-border bg-surface p-3 md:sticky md:top-0 md:h-dvh md:w-52 md:shrink-0 md:border-r md:border-b-0">
        <a href={APP_URL} className="flex w-fit items-center gap-2 px-2 py-2 text-sm font-semibold">
          <Shield className="size-4" aria-hidden /> {t('shell.title')}
        </a>
        <nav className="mt-2 flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map(([to, label]) => (
            <NavLink
              key={to}
              to={`/${to}`}
              end={to === ''}
              className={({ isActive }) =>
                cn('relative px-3 py-2 text-sm whitespace-nowrap', isActive ? 'bg-surface-2 font-semibold text-fg md:before:absolute md:before:inset-y-0 md:before:left-0 md:before:w-0.5 md:before:bg-fg' : 'text-muted hover:bg-surface hover:text-fg')
              }
            >
              {t(label)}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 space-y-3 px-2 text-xs text-muted">
          <p className="break-all">{t('shell.signedInAs', { email: session.email })}</p>
          <div className="[&>button]:mx-0">
            <LanguageToggle />
          </div>
          <a href={APP_URL} className="block text-accent hover:underline">
            {t('shell.backToApp')}
          </a>
          <a href={ACCESS_LOGOUT_URL} className="flex w-fit items-center gap-2 border border-border-strong px-3 py-2 text-sm font-medium text-fg hover:border-fg">
            <LogOut className="size-4" aria-hidden /> {t('shell.signOut')}
          </a>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <Routes>
          <Route index element={<OverviewPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="browsers" element={<BrowsersPage />} />
          <Route path="browsers/:id" element={<BrowserDetailPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="aws-provider" element={<AwsProviderPage />} />
          <Route path="pricing" element={<PricingPage />} />
          <Route path="promotions" element={<PromotionsPage />} />
          <Route path="findings" element={<FindingsPage />} />
          <Route path="limits" element={<LimitsPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
