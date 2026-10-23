import { Button } from '@cloudbrowser/ui';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { FullPageMessage } from '../../app/AppShell.js';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { useBilling, useTransactions } from './hooks.js';

/**
 * The payment provider's success redirect (Stripe or Creem) lands here. Credit is never added from
 * the redirect (page 6): the page waits for the top-up that the provider's webhook records, which
 * arrives over SSE.
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
  // Top-ups already listed on the first load are older payments, unless they were credited just
  // before the redirect landed (the webhook can be faster than the browser).
  const seen = useRef<Set<string> | null>(null);
  if (tx.rows && !tx.isPlaceholderData && seen.current === null) seen.current = new Set(tx.rows.map((x) => x.id));
  // Done once this checkout's top-up shows up (refreshed by the entitlements event).
  const done = (tx.rows ?? []).some(
    (x) => x.kind === 'topup' && (!seen.current?.has(x.id) || Date.parse(x.createdAt) > arrivedAt.current - 2 * 60_000),
  );

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
