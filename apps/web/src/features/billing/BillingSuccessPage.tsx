import { Button } from '@cloudbrowser/ui';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { FullPageMessage } from '../../app/AppShell.js';
import { useI18n } from '../../lib/i18n.js';
import { useMe } from '../instances/hooks.js';

/**
 * Creem's success redirect lands here. Access is never granted from the redirect (page 6): the page
 * waits for the entitlement update that the webhook triggers, which arrives over SSE.
 */
export function BillingSuccessPage() {
  const { t } = useI18n();
  const me = useMe();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setSlow(true), 60_000);
    return () => clearTimeout(h);
  }, []);
  const plan = me.data?.entitlements.plan;
  const active = plan === 'personal' || plan === 'pro';

  return (
    <FullPageMessage>
      <div className="max-w-sm space-y-4 text-center">
        {active ? (
          <>
            <p className="text-base font-medium text-fg">{t('billing.success.active', { plan: t(`billing.${plan}`) })}</p>
            <Link to="/browsers">
              <Button variant="primary">{t('billing.success.go')}</Button>
            </Link>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto size-6 animate-spin text-muted" aria-hidden />
            <p className="text-base font-medium text-fg">{t('billing.success.activating')}</p>
            <p>{slow ? t('billing.success.slow') : t('billing.success.wait')}</p>
          </>
        )}
      </div>
    </FullPageMessage>
  );
}
