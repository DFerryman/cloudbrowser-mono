import { Button, Dialog, Hint } from '@cloudbrowser/ui';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useI18n } from '../../lib/i18n.js';
import { rich } from '../../lib/rich.js';
import { isTermsRequired } from './hooks.js';

/**
 * Asked before a top-up until the user has accepted the current version (TERMS_VERSION) of the
 * Terms of Service and Privacy Policy: Confirm stays disabled until they tick the box agreeing to
 * both and confirming they are not subject to sanctions, and only then is the checkout created,
 * with the version they accepted; the api records it and asks again only for a new version. Both
 * documents open in a new tab, so the box stays as the user left it.
 */
export function TermsConsentDialog({
  open,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** The checkout is being created, or the browser is on its way to it. */
  busy: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t, errorMessage } = useI18n();
  const [read, setRead] = useState(false);
  const id = useId();
  // Every opening starts unticked: the box is the user's own act, never carried over.
  useEffect(() => {
    if (open) setRead(false);
  }, [open]);
  const changed = isTermsRequired(error);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onCancel()}
      title={t('consent.title')}
      description={t('consent.description')}
      closeLabel={t('common.cancel')}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button className="justify-center" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" className="justify-center" disabled={!read || busy || changed} onClick={onConfirm} data-testid="consent-confirm">
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {busy ? t('consent.opening') : t('consent.confirm')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="border border-border bg-surface px-3 py-3">
          <div className="flex items-start gap-3">
            <input
              id={`${id}-read`}
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--color-fg)]"
              checked={read}
              disabled={busy}
              onChange={(e) => setRead(e.target.checked)}
              data-testid="consent-read"
            />
            <label htmlFor={`${id}-read`} className="cursor-pointer font-medium">
              {rich(t('consent.checkbox'), {
                terms: <DocumentLink href="/terms" label={t('footer.terms')} hint={`${id}-tab`} />,
                privacy: <DocumentLink href="/privacy" label={t('footer.privacy')} hint={`${id}-tab`} />,
              })}
            </label>
          </div>
          <Hint id={`${id}-tab`} className="mt-1.5 pl-7">
            {t('consent.newTab')}
          </Hint>
        </div>
        {error ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-error bg-error/5 px-3 py-2.5 text-error">
            <span>{changed ? t('consent.changed') : errorMessage(error)}</span>
            {changed ? (
              <Button size="sm" onClick={() => window.location.reload()}>
                {t('consent.reload')}
              </Button>
            ) : null}
          </div>
        ) : null}
        <p role="status" className="sr-only">
          {busy ? t('consent.opening') : ''}
        </p>
      </div>
    </Dialog>
  );
}

/** A policy, opened in a new tab so the dialog keeps its state; `hint` says so. */
function DocumentLink({ href, label, hint }: { href: string; label: string; hint: string }) {
  return (
    <a href={href} target="_blank" rel="noopener" aria-describedby={hint} className="text-accent underline underline-offset-2 hover:text-fg">
      {label}
      <ExternalLink className="ml-0.5 inline size-3.5 align-[-2px]" aria-hidden />
    </a>
  );
}
