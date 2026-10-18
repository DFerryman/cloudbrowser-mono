import { Button, useToast } from '@cloudbrowser/ui';
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { queryClient } from '../../lib/query.js';

type Passkey = { id: string; name?: string | null; createdAt: string };
const KEY = ['passkeys'] as const;

/** Passkeys through Better Auth's passkey plugin (WebAuthn) for the main app account. */
export function Passkeys() {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const list = useQuery({ queryKey: KEY, queryFn: () => api<Passkey[]>('GET', '/api/auth/passkey/list-user-passkeys') });
  const add = useMutation({
    mutationFn: async () => {
      const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>('GET', '/api/auth/passkey/generate-register-options');
      const response = await startRegistration({ optionsJSON });
      const name = `${navigator.platform || 'Passkey'} · ${new Date().toLocaleDateString(locale)}`;
      await api('POST', '/api/auth/passkey/verify-registration', { body: { response, name } });
    },
    onSuccess: () => toast(t('passkeys.added')),
    onError: (e) => {
      // The user closed the browser's passkey dialog: not an error worth a message.
      if ((e as Error).name === 'NotAllowedError') return;
      toast(t('passkeys.failed', { reason: errorMessage(e) }), 'error');
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('POST', '/api/auth/passkey/delete-passkey', { body: { id } }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  const supported = typeof window !== 'undefined' && 'PublicKeyCredential' in window;

  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">{t('passkeys.title')}</h3>
      {list.data?.length ? (
        <ul className="mb-2 divide-y divide-border text-sm">
          {list.data.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <KeyRound className="size-4 shrink-0 text-muted" aria-hidden />
                <span className="truncate">{p.name || t('passkeys.unnamed')}</span>
                <span className="shrink-0 text-muted">· {new Date(p.createdAt).toLocaleDateString(locale)}</span>
              </span>
              <Button size="icon" variant="ghost" aria-label={t('passkeys.remove')} disabled={remove.isPending} onClick={() => remove.mutate(p.id)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2 text-sm text-muted">{t('passkeys.none')}</p>
      )}
      <Button size="sm" disabled={!supported || add.isPending} onClick={() => add.mutate()}>
        <KeyRound /> {t('passkeys.add')}
      </Button>
    </div>
  );
}
