import { TERMS_VERSION, type BillingState } from '@cloudbrowser/contracts';
import { Button } from '@cloudbrowser/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet } from 'react-router';
import { signOut } from '../../app/AppShell.js';
import { api } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { keys } from '../../lib/query.js';
import { TermsConsentDialog } from '../billing/TermsConsentDialog.js';
import { useMe } from '../instances/hooks.js';

type ConsentState = Pick<BillingState, 'termsVersion' | 'termsAccepted'>;

/** Every sign-in method reaches this gate; only an explicit checkbox confirms a revision. */
export function TermsAcceptanceGate() {
  const me = useMe();
  const { t, errorMessage } = useI18n();
  const client = useQueryClient();
  const queryKey = ['terms-consent', me.data?.user.id, TERMS_VERSION] as const;
  const state = useQuery({
    queryKey,
    queryFn: () => api<ConsentState>('GET', '/terms-consent'),
    enabled: me.isSuccess,
  });
  const accept = useMutation({
    mutationFn: () => api<ConsentState>('POST', '/terms-consent', { body: { acceptedTermsVersion: TERMS_VERSION } }),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      void client.invalidateQueries({ queryKey: keys.billing });
    },
  });

  // Existing route guards handle expired sessions and sign-in redirects.
  if (me.isError) return <Outlet />;
  if (me.isPending || state.isPending) return <p role="status" className="p-8 text-sm text-muted">{t('common.loading')}</p>;
  const changed = state.data && state.data.termsVersion !== TERMS_VERSION;
  if (state.isError || changed) {
    return (
      <div className="space-y-4 p-8 text-sm">
        <p role="alert">{changed ? t('consent.changed') : errorMessage(state.error)}</p>
        <Button onClick={() => changed ? window.location.reload() : void state.refetch()}>{t(changed ? 'consent.reload' : 'common.retry')}</Button>
        <Button onClick={() => void signOut()}>{t('nav.signOut')}</Button>
      </div>
    );
  }
  if (state.data?.termsAccepted) return <Outlet />;
  return (
    <div className="min-h-dvh bg-surface">
      <TermsConsentDialog
        open context="sign-in" busy={accept.isPending} error={accept.error}
        onConfirm={() => { if (!accept.isPending) accept.mutate(); }}
        onCancel={() => void signOut()}
      />
    </div>
  );
}
