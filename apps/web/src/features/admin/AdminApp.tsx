import { Button, cn } from '@cloudbrowser/ui';
import { LogOut, Shield } from 'lucide-react';
import { NavLink, Navigate, Route, Routes } from 'react-router';
import { ApiError } from '../../lib/api.js';
import { AlertsPage, AuditPage, FindingsPage, LedgerPage, OperationsPage, UsersPage } from './Lists.js';
import { BrowserDetailPage, BrowsersPage } from './Browsers.js';
import { LimitsPage } from './Limits.js';
import { OverviewPage } from './Overview.js';
import { useAdmin, type AdminSession } from './data.js';
import { ACCESS_LOGIN_URL, ACCESS_LOGOUT_URL, APP_URL } from './location.js';

/**
 * The operator console has its own host and Cloudflare Access email session. It does not use
 * the main app's Better Auth session. Internal and English-only, loaded on demand.
 */
export function AdminApp() {
  const session = useAdmin<AdminSession>('/session');
  if (session.isPending) return <Centered>Loading…</Centered>;
  if (session.isError) {
    const status = session.error instanceof ApiError ? session.error.status : null;
    return (
      <Centered>
        <Shield className="mx-auto size-8 text-accent" aria-hidden />
        <h1 className="text-base font-semibold text-fg">Operator console</h1>
        <p className="max-w-sm">
          {status === 403
            ? 'Access denied. Your email is not authorized to use this console.'
            : status === 401
              ? 'Your administrator session has expired. Sign in again with your email verification code.'
              : 'Could not verify your administrator session. Try again or sign in with your email verification code.'}
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {status !== 403 ? <a href={ACCESS_LOGIN_URL} className="rounded-[var(--radius-control)] bg-accent px-3 py-2 font-medium text-white">Sign in with email</a> : null}
          {status !== 401 && status !== 403 ? <Button onClick={() => void session.refetch()}>Try again</Button> : null}
          <a href={ACCESS_LOGOUT_URL} className="rounded-[var(--radius-control)] border border-border px-3 py-2 font-medium text-fg">Sign out</a>
        </div>
        <a href={APP_URL} className="text-accent hover:underline">
          Back to the app
        </a>
      </Centered>
    );
  }
  return <Console session={session.data} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-4 text-center text-sm text-muted">{<div className="space-y-3">{children}</div>}</div>;
}

const NAV = [
  ['', 'Overview'],
  ['alerts', 'Alerts'],
  ['operations', 'Operations'],
  ['browsers', 'Browsers'],
  ['users', 'Users'],
  ['ledger', 'Ledger'],
  ['findings', 'Findings'],
  ['limits', 'Limits & switches'],
  ['audit', 'Audit log'],
] as const;

function Console({ session }: { session: AdminSession }) {
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-b border-border bg-surface p-3 md:sticky md:top-0 md:h-dvh md:w-52 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-2 py-2 text-sm font-semibold">
          <Shield className="size-4 text-accent" aria-hidden /> Operator console
        </div>
        <nav className="mt-2 flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map(([to, label]) => (
            <NavLink
              key={to}
              to={`/${to}`}
              end={to === ''}
              className={({ isActive }) =>
                cn('rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm whitespace-nowrap', isActive ? 'bg-surface-2 font-medium' : 'text-muted hover:bg-surface-2 hover:text-fg')
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 space-y-3 px-2 text-xs text-muted">
          <p className="break-all">Signed in as {session.email}</p>
          <a href={APP_URL} className="block text-accent hover:underline">
            Back to the app
          </a>
          <a href={ACCESS_LOGOUT_URL} className="flex w-fit items-center gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-surface-2">
            <LogOut className="size-4" aria-hidden /> Sign out
          </a>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">
        <Routes>
          <Route index element={<OverviewPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="browsers" element={<BrowsersPage />} />
          <Route path="browsers/:id" element={<BrowserDetailPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="ledger" element={<LedgerPage />} />
          <Route path="findings" element={<FindingsPage />} />
          <Route path="limits" element={<LimitsPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
