import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { useEffect } from 'react';
import { AppShell } from './app/AppShell.js';
import { AccountPage } from './features/account/AccountPage.js';
import { BillingPage } from './features/billing/BillingPage.js';
import { BillingSuccessPage } from './features/billing/BillingSuccessPage.js';
import { SignInPage } from './features/auth/SignInPage.js';
import { BrowsersPage } from './features/instances/BrowsersPage.js';
import { useMe } from './features/instances/hooks.js';
import { isUnauthenticated } from './lib/api.js';
import { useLiveEvents } from './lib/events.js';
import { adminRedirectUrl, isAdminHost } from './features/admin/location.js';

/** Routes from page 1, "Information architecture". Landing and pricing pages come later. */
export const router = createBrowserRouter(isAdminHost() ? [
  { path: '/admin/*', element: <AdminRedirect /> },
  { path: '*', lazy: async () => ({ Component: (await import('./features/admin/AdminApp.js')).AdminApp }) },
] : [
  { path: '/', element: <Navigate to="/browsers" replace /> },
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/sign-up', element: <Navigate to="/sign-in" replace /> },
  { path: '/admin/*', element: <AdminRedirect /> },
  // The session view has its own dark full-screen layout, still behind the auth check.
  // The viewer is loaded on demand (page 1, "Performance and quality").
  {
    element: <AppShellGate />,
    children: [
      { path: '/b/:id', lazy: async () => ({ Component: (await import('./features/session/SessionPage.js')).SessionPage }) },
    ],
  },
  {
    element: <AppShell />,
    children: [
      { path: '/browsers', element: <BrowsersPage /> },
      { path: '/browsers/new', element: <BrowsersPage /> },
      // The browser management area: one header, three tabs (page 1).
      {
        path: '/browsers/:id',
        lazy: async () => ({ Component: (await import('./features/instances/BrowserLayout.js')).BrowserLayout }),
        children: [
          { index: true, element: <Navigate to="settings" replace /> },
          { path: 'settings', lazy: async () => ({ Component: (await import('./features/instances/SettingsPage.js')).SettingsPage }) },
          { path: 'storage', lazy: async () => ({ Component: (await import('./features/instances/StoragePage.js')).StoragePage }) },
          { path: 'usage', lazy: async () => ({ Component: (await import('./features/instances/UsagePage.js')).UsagePage }) },
        ],
      },
      { path: '/account', element: <AccountPage /> },
      { path: '/settings', element: <Navigate to="/account" replace /> },
      { path: '/billing', element: <BillingPage /> },
      { path: '/billing/success', element: <BillingSuccessPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/browsers" replace /> },
]);

function AdminRedirect() {
  const location = useLocation();
  const url = adminRedirectUrl(location);
  useEffect(() => window.location.replace(url), [url]);
  return <a href={url}>Open the operator console</a>;
}

function AppShellGate() {
  const me = useMe();
  const location = useLocation();
  useLiveEvents(me.isSuccess);
  if (me.isError && isUnauthenticated(me.error)) {
    return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <Outlet />;
}
