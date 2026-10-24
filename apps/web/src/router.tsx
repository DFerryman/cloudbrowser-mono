import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { useEffect } from 'react';
import { AppShell } from './app/AppShell.js';
import { RouteError } from './app/RouteError.js';
import { AccountPage } from './features/account/AccountPage.js';
import { BillingPage } from './features/billing/BillingPage.js';
import { BillingSuccessPage } from './features/billing/BillingSuccessPage.js';
import { SignInPage } from './features/auth/SignInPage.js';
import { TermsAcceptanceGate } from './features/auth/TermsAcceptanceGate.js';
import { SignUpCompletePage, SignUpPage } from './features/auth/SignUpPage.js';
import { BrowsersPage } from './features/instances/BrowsersPage.js';
import { useMe } from './features/instances/hooks.js';
import { isUnauthenticated } from './lib/api.js';
import { useLiveEvents } from './lib/events.js';
import { adminRedirectUrl, isAdminHost } from './features/admin/location.js';
import { ContactPage } from './site/ContactPage.js';
import { HomePage } from './site/HomePage.js';
import { NotFoundPage } from './site/NotFoundPage.js';
import { PricingPage } from './site/PricingPage.js';
import { PublicShell } from './site/PublicShell.js';
import { StatusPage } from './site/StatusPage.js';

/**
 * Routes from page 1, "Information architecture": the public site (home, pricing, docs, status,
 * policies) for everyone, sign-in and sign-up, and the app behind it. Every route renders its
 * errors with RouteError (a lazily loaded page gone after a deployment, a render error).
 */
export const router = createBrowserRouter([{ errorElement: <RouteError />, children: isAdminHost() ? [
  { path: '/admin/*', element: <AdminRedirect /> },
  { path: '*', lazy: async () => ({ Component: (await import('./features/admin/AdminApp.js')).AdminApp }) },
] : [
  {
    element: <PublicShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/pricing', element: <PricingPage /> },
      // Long-form content is loaded on demand, outside the app's main bundle.
      { path: '/docs', lazy: async () => ({ Component: (await import('./site/DocsPage.js')).DocsPage }) },
      { path: '/docs/:slug', lazy: async () => ({ Component: (await import('./site/DocsPage.js')).DocsPage }) },
      { path: '/status', element: <StatusPage /> },
      { path: '/terms', lazy: async () => { const { LegalPage } = await import('./site/LegalPage.js'); return { Component: () => <LegalPage policy="terms" /> }; } },
      { path: '/privacy', lazy: async () => { const { LegalPage } = await import('./site/LegalPage.js'); return { Component: () => <LegalPage policy="privacy" /> }; } },
      { path: '/refunds', lazy: async () => { const { LegalPage } = await import('./site/LegalPage.js'); return { Component: () => <LegalPage policy="refunds" /> }; } },
      { path: '/contact', element: <ContactPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/sign-up', element: <SignUpPage /> },
  { path: '/sign-up/complete', element: <SignUpCompletePage /> },
  { path: '/register', element: <Navigate to="/sign-up" replace /> },
  { path: '/admin/*', element: <AdminRedirect /> },
  {
    element: <TermsAcceptanceGate />,
    children: [
      // A coding agent's OAuth sign-in also confirms changed Terms before authorizing access.
      { path: '/oauth/authorize', lazy: async () => ({ Component: (await import('./features/oauth/AuthorizePage.js')).AuthorizePage }) },
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
          { path: '/promotions', lazy: async () => ({ Component: (await import('./features/promotions/PromotionsPage.js')).PromotionsPage }) },
        ],
      },
    ],
  },
] }]);

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
    return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <Outlet />;
}
