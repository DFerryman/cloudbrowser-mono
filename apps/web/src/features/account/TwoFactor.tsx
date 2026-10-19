import { Button, Dialog, Input, Label, StatusBadge, useToast } from '@cloudbrowser/ui';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, Download, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { encode } from 'uqr';
import { api, ApiError } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { keys, queryClient } from '../../lib/query.js';
import { CodeInput } from '../auth/SignInPage.js';
import { useMe } from '../instances/hooks.js';

type Enabled = { totpURI: string; backupCodes: string[] };

/**
 * Two-step verification with an authenticator app (TOTP). Setting up shows a QR code once; the
 * first code confirms it, then the backup codes are shown. Turning it off, or replacing the backup
 * codes, needs a current code (backup codes also turn it off when the phone is lost).
 */
export function TwoFactorSettings() {
  const { t } = useI18n();
  const me = useMe();
  const on = !!me.data?.user.twoFactorEnabled;
  const [dialog, setDialog] = useState<'setup' | 'disable' | 'codes' | null>(null);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-sm font-medium">{t('twofa.title')}</h3>
          {me.data ? <StatusBadge tone={on ? 'running' : 'sleeping'} icon={on ? ShieldCheck : ShieldOff} label={t(on ? 'twofa.on' : 'twofa.off')} className="text-xs" /> : null}
        </div>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-subtle">{t(on ? 'twofa.onBody' : 'twofa.offBody')}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {on ? (
          <>
            <Button size="sm" onClick={() => setDialog('codes')}>
              <KeyRound /> {t('twofa.newCodes')}
            </Button>
            <Button size="sm" variant="ghost" className="text-error" onClick={() => setDialog('disable')}>
              {t('twofa.turnOff')}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" disabled={!me.data} onClick={() => setDialog('setup')}>
            <ShieldCheck /> {t('twofa.setUp')}
          </Button>
        )}
      </div>
      {dialog === 'setup' ? <SetupDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'disable' ? <CodeDialog kind="disable" onClose={() => setDialog(null)} /> : null}
      {dialog === 'codes' ? <CodeDialog kind="codes" onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

const refreshMe = () => queryClient.invalidateQueries({ queryKey: keys.me });

function SetupDialog({ onClose }: { onClose: () => void }) {
  const { t, errorMessage } = useI18n();
  const [setup, setSetup] = useState<Enabled | null>(null);
  const [step, setStep] = useState<'scan' | 'codes'>('scan');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api<Enabled>('POST', '/api/auth/two-factor/enable', { body: {} }),
    onSuccess: setSetup,
    onError: (e) => setError(errorMessage(e)),
  });
  const confirm = useMutation({
    mutationFn: (c: string) => api('POST', '/api/auth/two-factor/verify-totp', { body: { code: c } }),
    onSuccess: () => {
      setStep('codes');
      void refreshMe();
    },
    onError: (e) => {
      setError(e instanceof ApiError && e.status === 429 ? t('auth.tooMany') : t('auth.2fa.invalid'));
      setCode('');
    },
  });
  // One fresh secret per dialog: a second request would replace the secret behind the QR code.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start.mutate();
  }, []);
  const secret = setup ? new URL(setup.totpURI).searchParams.get('secret') ?? '' : '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    confirm.mutate(code);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={step === 'scan' ? t('twofa.setupTitle') : t('twofa.codesTitle')}
      description={step === 'scan' ? t('twofa.setupBody') : t('twofa.codesBody')}
      closeLabel={t('common.close')}
    >
      {step === 'scan' ? (
        <form onSubmit={submit} className="space-y-5">
          <ol className="space-y-5">
            <li className="flex gap-3">
              <StepNumber n={1} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t('twofa.step1')}</p>
                <div className="mt-3 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                  <div className="grid size-44 shrink-0 place-items-center rounded-[var(--radius-control)] border border-border bg-white p-2">
                    {setup ? <QrCode text={setup.totpURI} label={t('twofa.qrLabel')} /> : <span className="size-8 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" aria-hidden />}
                  </div>
                  <div className="min-w-0 text-sm">
                    <p className="text-muted">{t('twofa.manual')}</p>
                    {secret ? <SecretKey secret={secret} /> : null}
                  </div>
                </div>
              </div>
            </li>
            <li className="flex gap-3">
              <StepNumber n={2} />
              <div className="min-w-0 flex-1">
                <Label htmlFor="totp-confirm">{t('twofa.step2')}</Label>
                <div className="max-w-56">
                  <CodeInput id="totp-confirm" value={code} onChange={setCode} autoFocus={false} />
                </div>
              </div>
            </li>
          </ol>
          {error ? <p role="alert" className="text-sm text-error">{error}</p> : null}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!setup || code.length !== 6 || confirm.isPending}>
              {t('twofa.confirm')}
            </Button>
          </div>
        </form>
      ) : (
        <SavedCodes codes={setup!.backupCodes} onDone={onClose} />
      )}
    </Dialog>
  );
}

function StepNumber({ n }: { n: number }) {
  return <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/10 text-xs font-semibold text-accent" aria-hidden>{n}</span>;
}

/** The setup key in groups of four, for apps that cannot scan. */
function SecretKey({ secret }: { secret: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-start gap-1">
      <code className="min-w-0 rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs leading-relaxed break-all select-all">{secret.match(/.{1,4}/g)?.join(' ')}</code>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t('twofa.copyKey')}
        onClick={() => void navigator.clipboard?.writeText(secret).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** Rendered locally from the otpauth:// URI: the secret never goes to a QR service. */
function QrCode({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const { data, size } = encode(text, { ecc: 'M', border: 0 });
    let d = '';
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y]![x]) d += `M${x} ${y}h1v1h-1z`;
    return { d, size };
  }, [text]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${path.size} ${path.size}`} className="size-full" shapeRendering="crispEdges">
      <path d={path.d} fill="#09090b" />
    </svg>
  );
}

/** Backup codes, shown once: copy, download, and confirm they are kept somewhere safe. */
function SavedCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const text = `${t('twofa.fileHeader')}\n\n${codes.join('\n')}\n`;
  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-[var(--radius-control)] border border-border bg-surface p-4 font-mono text-sm">
        {codes.map((c) => <li key={c} className="tabular-nums">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast(t('twofa.copied')))}>
          <Copy /> {t('twofa.copy')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = 'cloudbrowser-backup-codes.txt';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          <Download /> {t('twofa.download')}
        </Button>
      </div>
      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t('twofa.saved')}</span>
      </label>
      <div className="flex justify-end border-t border-border pt-4">
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          {t('twofa.done')}
        </Button>
      </div>
    </div>
  );
}

/** Turning 2FA off, or replacing the backup codes, needs a current code. */
function CodeDialog({ kind, onClose }: { kind: 'disable' | 'codes'; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[] | null>(null);
  const run = useMutation({
    mutationFn: (c: string) => kind === 'disable'
      ? api('POST', '/api/auth/two-factor/disable', { body: { code: c } })
      : api<{ backupCodes: string[] }>('POST', '/api/auth/two-factor/generate-backup-codes', { body: { code: c } }),
    onSuccess: (res) => {
      if (kind === 'disable') {
        toast(t('twofa.turnedOff'));
        void refreshMe();
        onClose();
      } else setFresh((res as { backupCodes: string[] }).backupCodes);
    },
    onError: (e) => {
      setError(e instanceof ApiError && (e.status === 429 || e.code === 'ACCOUNT_TEMPORARILY_LOCKED') ? t('auth.2fa.locked') : t(kind === 'disable' ? 'twofa.invalidAny' : 'auth.2fa.invalid'));
      setCode('');
    },
  });
  const valid = kind === 'disable' ? /^\d{6}$/.test(code) || code.length >= 8 : /^\d{6}$/.test(code);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={fresh ? t('twofa.codesTitle') : t(kind === 'disable' ? 'twofa.disableTitle' : 'twofa.newCodesTitle')}
      description={fresh ? t('twofa.newCodesSaved') : t(kind === 'disable' ? 'twofa.disableBody' : 'twofa.newCodesBody')}
      closeLabel={t('common.close')}
    >
      {fresh ? (
        <SavedCodes codes={fresh} onDone={onClose} />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            run.mutate(code.trim());
          }}
        >
          <div className="max-w-64">
            <Label htmlFor="twofa-code">{t(kind === 'disable' ? 'twofa.codeOrBackup' : 'auth.2fa.label')}</Label>
            <Input
              id="twofa-code"
              autoComplete="one-time-code"
              autoFocus
              required
              autoCapitalize="off"
              spellCheck={false}
              className="h-11 text-center font-mono text-base tracking-widest"
              value={code}
              onChange={(e) => setCode(kind === 'disable' ? e.target.value.trim().slice(0, 32) : e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          {error ? <p role="alert" className="text-sm text-error">{error}</p> : null}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant={kind === 'disable' ? 'danger' : 'primary'} disabled={!valid || run.isPending}>
              {t(kind === 'disable' ? 'twofa.turnOff' : 'twofa.newCodes')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
