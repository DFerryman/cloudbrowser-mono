import { Button } from '@cloudbrowser/ui';
import { useEffect } from 'react';
import { useNavigate, useRouteError } from 'react-router';
import { isChunkLoadError } from '../lib/chunks.js';
import { useI18n } from '../lib/i18n.js';

/**
 * The app's own error page, in place of react-router's unstyled default: a page whose files are
 * gone after a deployment (when the automatic reload did not help), or any render error. Reload
 * fetches the current app; the other way out leads back to the dashboard.
 */
export function RouteError() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const error = useRouteError();
  const stale = isChunkLoadError(error);
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-6 py-16 text-center text-fg">
      <div className="max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">{t('app.error.title')}</h1>
        <p className="mt-2 text-sm text-muted">{t(stale ? 'app.error.stale' : 'app.error.body')}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button variant="primary" size="lg" onClick={() => window.location.reload()}>
            {t('app.error.reload')}
          </Button>
          <Button size="lg" onClick={() => navigate('/browsers')}>
            {t('app.error.home')}
          </Button>
        </div>
      </div>
    </main>
  );
}
