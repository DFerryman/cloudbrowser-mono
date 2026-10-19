import { Button } from '@cloudbrowser/ui';
import { useNavigate } from 'react-router';
import { useI18n } from '../lib/i18n.js';
import { container } from './PublicShell.js';

export function NotFoundPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <section className={`${container} grid min-h-[50vh] place-items-center py-16 text-center`}>
      <div>
        <p className="font-mono text-sm text-subtle">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t('notFound.title')}</h1>
        <p className="mt-2 text-sm text-muted">{t('notFound.body')}</p>
        <Button variant="primary" className="mt-6" onClick={() => navigate('/')}>
          {t('notFound.home')}
        </Button>
      </div>
    </section>
  );
}
