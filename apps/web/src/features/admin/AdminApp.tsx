import { Button, cn, useToast } from '@cloudbrowser/ui';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { KeyRound, Shield } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { queryClient } from '../../lib/query.js';
import { AlertsPage, AuditPage, FindingsPage, LedgerPage, OperationsPage, UsersPage } from './Lists.js';
import { BrowserDetailPage, BrowsersPage } from './Browsers.js';
import { LimitsPage } from './Limits.js';
import { OverviewPage } from './Overview.js';
import { useAdmin, type AdminSession } from './data.js';

/**
 * The operator console (page 10): staff only, from allowlisted IPs, after a passkey step-up that
 * lasts 30 minutes. Internal and English-only. Loaded on demand, so app users never download it.
 */
export function AdminApp() {
  const session = useAdmin<AdminSession>('/session');
  if (session.isPending) return <Centered>Loading…</Centered>;
  if (session.isError) {
    return (
      <Centered>
        <p>Not found.</p>
        <Link to="/browsers" className="text-accent hover:underline">
          Back to the app
        </Link>
      </Centered>
    );
  }
  const s = session.data;
  if (!s.stepUpUntil || Date.parse(s.stepUpUntil) <= Date.now()) return <StepUp session={s} />;
  return <Console session={s} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-4 text-center text-sm text-muted">{<div className="space-y-3">{children}</div>}</div>;
}

function StepUp({ session }: { session: AdminSession }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>('POST', '/admin/step-up/options');
      const response = await startAuthentication({ optionsJSON });
      await api('POST', '/admin/step-up/verify', { body: { response } });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') toast(e instanceof ApiError ? e.message : (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered>
      <Shield className="mx-auto size-8 text-accent" aria-hidden />
      <h1 className="text-base font-semibold text-fg">Operator console</h1>
      {session.passkeys ? (
        <>
          <p className="max-w-xs">Confirm it’s you with your passkey. The confirmation lasts 30 minutes.</p>
          <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
            <KeyRound /> Confirm with passkey
          </Button>
        </>
      ) : (
        <p className="max-w-xs">
          Add a passkey to your account first, in{' '}
          <Link to="/settings" className="text-accent hover:underline">
            Settings → Security
          </Link>
          .
        </p>
      )}
      <p className="text-xs">Signed in as {session.email}</p>
    </Centered>
  );
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
  const until = new Date(session.stepUpUntil!);
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
              to={`/admin${to ? `/${to}` : ''}`}
              end={to === ''}
              className={({ isActive }) =>
                cn('rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm whitespace-nowrap', isActive ? 'bg-surface-2 font-medium' : 'text-muted hover:bg-surface-2 hover:text-fg')
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="mt-4 hidden px-2 text-xs text-muted md:block">
          {session.email}
          <br />
          Step-up until {until.toLocaleTimeString()}
          <br />
          <Link to="/browsers" className="text-accent hover:underline">
            Back to the app
          </Link>
        </p>
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
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  );
}
