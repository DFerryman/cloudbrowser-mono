import { CLOSURE_ERASE_DAYS, type ClosurePreview, type ClosureReason, type ClosureResult } from '@cloudbrowser/contracts';
import { Button, Dialog, Label, Section, Select } from '@cloudbrowser/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { queryClient } from '../../lib/query.js';
import { rich } from '../../lib/rich.js';
import { SUPPORT_EMAIL } from '../../lib/site.js';
import { CodeInput } from '../auth/SignInPage.js';
import { useMe } from '../instances/hooks.js';

const REASONS: ClosureReason[] = ['terms', 'price', 'not_needed', 'other'];

/**
 * Closing the account (Terms sections 8 and 9): first what it does (the browsers deleted, where to
 * ask about a refund, what is kept), then a code sent to the account's email and a box the user
 * ticks. The api signs the user out everywhere, so success leaves the app for the closed page.
 */
export function CloseAccount({ className }: { className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Section title={t('account.close.title')} description={t('account.close.body')} className={className}>
      <Button variant="danger" onClick={() => setOpen(true)} data-testid="close-account">
        {t('account.close.open')}
      </Button>
      <CloseAccountDialog open={open} onClose={() => setOpen(false)} />
    </Section>
  );
}

function CloseAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, errorMessage } = useI18n();
  const id = useId();
  const me = useMe();
  const preview = useQuery({ queryKey: ['account', 'closure'], queryFn: () => api<ClosurePreview>('GET', '/account/closure'), enabled: open, staleTime: 0 });
  const [step, setStep] = useState<'review' | 'confirm'>('review');
  const [reason, setReason] = useState<ClosureReason | ''>('');
  const [code, setCode] = useState('');
  const [understood, setUnderstood] = useState(false);
  const send = useMutation({ mutationFn: () => api<void>('POST', '/account/closure/code') });
  const close = useMutation({
    mutationFn: () => api<ClosureResult>('POST', '/account/closure', { body: { code, confirm: true, ...(reason ? { reason } : {}) } }),
    // A full load, as after signing out: nothing of the session stays in memory.
    onSuccess: () => {
      queryClient.clear();
      window.location.assign('/account-closed');
    },
  });
  // Every opening starts over: the box is the user's own act, never carried over.
  useEffect(() => {
    if (!open) return;
    setStep('review');
    setCode('');
    setUnderstood(false);
    send.reset();
    close.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const p = preview.data;
  const usd = (micros: number) => money(micros, locale);
  const blocked = p?.blocker ? t(`account.close.blocked.${p.blocker}`, { email: SUPPORT_EMAIL }) : null;
  const sendCode = () => send.mutate(undefined, { onSuccess: () => setStep('confirm') });
  const link = (href: string, label: string, external = true) => (
    <a href={href} {...(external ? { target: '_blank', rel: 'noopener' } : {})} className="inline-flex items-center gap-1 text-accent underline underline-offset-2 hover:text-fg">
      {label}
      {external ? <ExternalLink className="size-3.5" aria-hidden /> : null}
    </a>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !close.isPending && onClose()}
      title={t('account.close.dialogTitle')}
      description={t('account.close.dialogDescription')}
      closeLabel={t('common.cancel')}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {step === 'confirm' ? (
            <Button className="justify-center" disabled={close.isPending} onClick={() => setStep('review')}>
              {t('account.close.back')}
            </Button>
          ) : (
            <Button className="justify-center" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          )}
          {step === 'review' ? (
            <Button variant="danger" className="justify-center" disabled={!p || !!blocked || send.isPending} onClick={sendCode} data-testid="close-send-code">
              {send.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t('account.close.sendCode')}
            </Button>
          ) : (
            <Button variant="danger" className="justify-center" disabled={code.length !== 6 || !understood || close.isPending} onClick={() => close.mutate()} data-testid="close-confirm">
              {close.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {close.isPending ? t('account.close.closing') : t('account.close.confirm')}
            </Button>
          )}
        </div>
      }
    >
      {!p ? (
        <p className="text-sm text-muted">{preview.isError ? errorMessage(preview.error) : t('common.loading')}</p>
      ) : step === 'review' ? (
        <div className="space-y-4 text-sm">
          {blocked ? (
            <p role="alert" className="border-l-2 border-error bg-error/5 px-3 py-2.5 text-error">{blocked}</p>
          ) : null}
          <div>
            <p className="font-medium">{p.browsers.length ? t('account.close.browsers', { n: p.browsers.length }) : t('account.close.noBrowsers')}</p>
            {p.browsers.length ? (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted" data-testid="close-browsers">
                {p.browsers.map((b) => <li key={b.id} className="break-all">{b.name}</li>)}
              </ul>
            ) : null}
          </div>
          <dl className="border-y border-border">
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted">{t('account.close.balance')}</dt>
              <dd className="tabular-nums">{usd(p.balanceMicros)}</dd>
            </div>
          </dl>
          <p data-testid="close-refund">{rich(t('account.close.refundAsk', { days: CLOSURE_ERASE_DAYS }), { email: link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL, false) })}</p>
          <p className="text-muted">
            {rich(t('account.close.kept', { days: CLOSURE_ERASE_DAYS }), { privacy: link('/privacy', t('footer.privacy')) })}{' '}
            {rich(t('account.close.terms'), { terms: link('/terms', t('footer.terms')) })}
          </p>
          <div>
            <Label htmlFor={`${id}-reason`}>{t('account.close.reason')}</Label>
            <Select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value as ClosureReason | '')}>
              <option value="">{t('account.close.reason.none')}</option>
              {REASONS.map((r) => <option key={r} value={r}>{t(`account.close.reason.${r}`)}</option>)}
            </Select>
          </div>
          {send.error ? <p role="alert" className="text-error">{errorMessage(send.error)}</p> : null}
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p>{t('account.close.codeSent', { email: me.data?.user.email ?? '' })}</p>
          <div>
            <Label htmlFor={`${id}-code`}>{t('account.close.code')}</Label>
            <CodeInput id={`${id}-code`} value={code} onChange={setCode} />
            <button type="button" className="mt-2 text-muted underline underline-offset-4 hover:text-fg" disabled={send.isPending} onClick={sendCode}>
              {t('account.close.resend')}
            </button>
          </div>
          <div className="flex items-start gap-3 border border-border bg-surface px-3 py-3">
            <input
              id={`${id}-understand`}
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--color-fg)]"
              checked={understood}
              disabled={close.isPending}
              onChange={(e) => setUnderstood(e.target.checked)}
              data-testid="close-understand"
            />
            <label htmlFor={`${id}-understand`} className="cursor-pointer font-medium">
              {t('account.close.understand')}
            </label>
          </div>
          {send.error || close.error ? <p role="alert" className="text-error">{errorMessage(close.error ?? send.error)}</p> : null}
        </div>
      )}
    </Dialog>
  );
}
