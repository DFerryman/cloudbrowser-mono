import { ToastProvider } from '@cloudbrowser/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { recoverStaleChunks } from './lib/chunks.js';
import { I18nProvider } from './lib/i18n.js';
import { queryClient } from './lib/query.js';
import { ThemeProvider } from './lib/theme.js';
import { router } from './router.js';
import './styles.css';

recoverStaleChunks(() => {
  const pending = router.state.navigation.location;
  return pending ? pending.pathname + pending.search + pending.hash : null;
});
const container = document.getElementById('root')!;
const mount = () => createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
// A prerendered public page (src/prerender) arrives with its content in #root, which the first
// render replaces. Until a lazily loaded route (docs, policies) is in, the router renders nothing,
// so keep the prerendered page on screen until then rather than flashing an empty one.
// A prerendered page's title names that page only: elsewhere the app keeps the shell's title.
const landing = { path: location.pathname, title: document.title };
router.subscribe(({ location: at }) => {
  document.title = at.pathname === landing.path ? landing.title : 'Nevazu';
});
if (container.hasChildNodes() && !router.state.initialized) {
  const unsubscribe = router.subscribe((state) => {
    if (!state.initialized) return;
    unsubscribe();
    mount();
  });
} else {
  mount();
}
