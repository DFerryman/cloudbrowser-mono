import { Button } from '@cloudbrowser/ui';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { FullPageMessage } from '../../app/AppShell.js';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { useBilling, useTransactions } from './hooks.js';

/**
 * Creem's success redirect lands here. Credit is never added from the redirect (page 6): the page
 * waits for the top-up that Creem's webhook records, which arrives over SSE.
 */
export function BillingSuccessPage() {
  const { t, locale } = useI18n();
  const billing = useBilling();
  const tx = useTransactions(0, 5);
  const [slow, setSlow] = useState(false);
  const arrivedAt = useRef(Date.now());
  useEffect(() => {
    const h = setTimeout(() => setSlow(true), 60_000);
    return () => clearTimeout(h);
  }, []);
  // Done once a top-up newer than this page shows up (refreshed by the entitlements event).
  const done = (tx.rows ?? []).some((x) => x.kind === 'topup' && Date.parse(x.createdAt) > arrivedAt.current - 15 * 60_000);

  return (
    <FullPageMessage>
      <div className="max-w-sm space-y-4 text-center">
        {done && billing.data ? (
          <>
            <p className="text-base font-medium text-fg">{t('billing.success.done', { amount: money(billing.data.balanceMicros, locale) })}</p>
            <p>{t('billing.availableAndReserved', {
              available: money(billing.data.availableMicros, locale),
              reserved: money(billing.data.reservedMicros, locale),
            })}</p>
            <Link to="/billing">
              <Button variant="primary">{t('billing.success.go')}</Button>
            </Link>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto size-6 animate-spin text-muted" aria-hidden />
            <p className="text-base font-medium text-fg">{t('billing.success.adding')}</p>
            <p>{slow ? t('billing.success.slow') : t('billing.success.wait')}</p>
          </>
        )}
      </div>
    </FullPageMessage>
  );
}
