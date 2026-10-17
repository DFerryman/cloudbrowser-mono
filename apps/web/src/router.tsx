import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { AppShell } from './app/AppShell.js';
import { AccountPage } from './features/account/AccountPage.js';
import { BillingSuccessPage } from './features/billing/BillingSuccessPage.js';
import { SignInPage } from './features/auth/SignInPage.js';
import { BrowsersPage } from './features/instances/BrowsersPage.js';
import { useMe } from './features/instances/hooks.js';
import { isUnauthenticated } from './lib/api.js';
import { useLiveEvents } from './lib/events.js';

/** Routes from page 1, "Information architecture". Landing and pricing pages come later. */
export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/browsers" replace /> },
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/sign-up', element: <Navigate to="/sign-in" replace /> },
  // The session view has its own dark full-screen layout, still behind the auth check.
  // The viewer is loaded on demand (page 1, "Performance and quality").
  {
    element: <AppShellGate />,
    children: [{ path: '/b/:id', lazy: async () => ({ Component: (await import('./features/session/SessionPage.js')).SessionPage }) }],
  },
  {
    element: <AppShell />,
    children: [
      { path: '/browsers', element: <BrowsersPage /> },
      { path: '/browsers/new', element: <BrowsersPage /> },
      {
        path: '/browsers/:id/settings',
        lazy: async () => ({ Component: (await import('./features/instances/SettingsPage.js')).SettingsPage }),
      },
      { path: '/settings', element: <AccountPage /> },
      { path: '/billing/success', element: <BillingSuccessPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/browsers" replace /> },
]);

function AppShellGate() {
  const me = useMe();
  const location = useLocation();
  useLiveEvents(me.isSuccess);
  if (me.isError && isUnauthenticated(me.error)) {
    return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <Outlet />;
}
