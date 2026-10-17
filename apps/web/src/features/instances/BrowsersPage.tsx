import { Button, Card, Skeleton } from '@cloudbrowser/ui';
import { Check, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { PageHeader } from '../../app/AppShell.js';
import { useI18n } from '../../lib/i18n.js';
import { BrowserCard } from './BrowserCard.js';
import { CreateDialog } from './CreateDialog.js';
import { useInstances } from './hooks.js';

export function BrowsersPage() {
  const { t, errorMessage } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const instances = useInstances();
  const dialogOpen = location.pathname === '/browsers/new';
  // The session view opens automatically once a new browser's IP check passes (page 1).
  const [openWhenReady, setOpenWhenReady] = useState<string | null>(null);

  useEffect(() => {
    if (!openWhenReady) return;
    const i = instances.data?.find((x) => x.id === openWhenReady);
    if (i?.status === 'running') navigate(`/b/${i.id}`);
    else if (i && i.status !== 'creating') setOpenWhenReady(null);
  }, [instances.data, openWhenReady, navigate]);

  const newButton = (
    <Button variant="primary" onClick={() => navigate('/browsers/new')}>
      <Plus /> {t('browsers.new')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('browsers.title')} action={instances.data?.length ? newButton : null} />
      {instances.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="h-48" />
          ))}
        </div>
      ) : instances.isError ? (
        <p className="text-sm text-error">{errorMessage(instances.error)}</p>
      ) : instances.data.length === 0 ? (
        <Card className="mx-auto max-w-xl p-8 text-center">
          <p className="text-base font-medium">{t('browsers.emptyTitle')}</p>
          <ul className="mx-auto mt-5 inline-flex flex-col gap-2 text-left text-sm text-muted">
            {(['browsers.guarantee.ip', 'browsers.guarantee.data', 'browsers.guarantee.view'] as const).map((k) => (
              <li key={k} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-running" aria-hidden />
                {t(k)}
              </li>
            ))}
          </ul>
          <div className="mt-6">{newButton}</div>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {instances.data.map((i) => (
            <BrowserCard key={i.id} instance={i} />
          ))}
        </div>
      )}
      <CreateDialog
        open={dialogOpen}
        onClose={() => navigate('/browsers')}
        onCreated={(id) => {
          setOpenWhenReady(id);
          navigate('/browsers');
        }}
      />
    </>
  );
}
