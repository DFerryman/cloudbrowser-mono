import { Button, Card, Input, Label } from '@cloudbrowser/ui';
import { ArrowLeft, CheckCircle2, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Logo } from '../../app/AppShell.js';
import { LanguageButton, ThemeButton } from '../../app/Preferences.js';
import { api, ApiError } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { queryClient } from '../../lib/query.js';
import { rich } from '../../lib/rich.js';
import { SUPPORT_EMAIL } from '../../lib/site.js';
import { useSignedIn } from '../../site/hooks.js';

type Step = 'email' | 'code' | 'second-factor';

/** Only same-site paths, so a crafted link cannot send a fresh session elsewhere. */
const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/browsers');

/**
 * Email one-time code sign-in (page 1, "Auth"), invite-only. Google is unavailable from mainland
 * China. With two-factor sign-in on, the email code is followed by a code from an authenticator
 * app (or a one-time backup code) before a session exists: the second factor guards the whole
 * account at its one entrance, rather than single pages or actions later on.
 */
export function SignInPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const signedIn = useSignedIn();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enter = () => {
    queryClient.clear();
    navigate(safeNext(params.get('next')), { replace: true });
  };
  // Already signed in (for example from a bookmark): go straight in.
  useEffect(() => {
    if (signedIn && step === 'email') navigate(safeNext(params.get('next')), { replace: true });
  }, [signedIn, step, navigate, params]);
  const signedOut = params.has('signedOut') && step === 'email' && !error;

  const sendCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/email-otp/send-verification-otp', { body: { email: email.trim().toLowerCase(), type: 'sign-in' } });
      setCode('');
      setStep('code');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? t('auth.tooMany') : t('error.internal'));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ twoFactorRedirect?: boolean }>('POST', '/api/auth/sign-in/email-otp', { body: { email: email.trim().toLowerCase(), otp: code.trim() } });
      if (res?.twoFactorRedirect) setStep('second-factor');
      else enter();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? t('auth.tooMany') : t('auth.invalidCode'));
    } finally {
      setBusy(false);
    }
  };

  const restart = (message: string | null = null) => {
    setStep('email');
    setCode('');
    setError(message);
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" aria-label={t('auth.backHome')}>
            <Logo />
          </Link>
          <div className="flex items-center gap-1">
            <LanguageButton />
            <ThemeButton />
          </div>
        </div>
        {signedOut ? (
          <p role="status" className="mb-3 flex items-center gap-2 border-l-2 border-running bg-bg px-3 py-2.5 text-sm">
            <CheckCircle2 className="size-4 shrink-0 text-running" aria-hidden /> {t('auth.signedOut')}
          </p>
        ) : null}
        <Card className="border-fg p-8">
          {step === 'second-factor' ? (
            <SecondFactor onSignedIn={enter} onRestart={restart} />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">{t('auth.title')}</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted">{step === 'email' ? t('auth.subtitle') : t('auth.codeSent', { email })}</p>
              {step === 'email' ? (
                <form onSubmit={sendCode} className="mt-8 space-y-4">
                  <div>
                    <Label htmlFor="email">{t('auth.email')}</Label>
                    <Input id="email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
                  </div>
                  <Button type="submit" variant="primary" size="lg" className="w-full justify-center" disabled={busy}>
                    {t('auth.sendCode')}
                  </Button>
                </form>
              ) : (
                <form onSubmit={signIn} className="mt-8 space-y-4">
                  <div>
                    <Label htmlFor="code">{t('auth.code')}</Label>
                    <CodeInput id="code" value={code} onChange={setCode} />
                  </div>
                  <Button type="submit" variant="primary" size="lg" className="w-full justify-center" disabled={busy || code.length !== 6}>
                    {t('auth.signIn')}
                  </Button>
                  <button type="button" className="w-full text-center text-sm text-muted hover:text-fg" onClick={() => restart()}>
                    {t('auth.useOtherEmail')}
                  </button>
                </form>
              )}
            </>
          )}
          {error && step !== 'second-factor' ? (
            <p role="alert" className="mt-4 text-sm text-error">
              {error}
            </p>
          ) : null}
        </Card>
        <div className="mt-4 space-y-2 px-1 text-center text-xs leading-relaxed text-subtle">
          <p>
            {rich(t('auth.agree'), {
              terms: <Link to="/terms" className="underline hover:text-fg">{t('footer.terms')}</Link>,
              privacy: <Link to="/privacy" className="underline hover:text-fg">{t('footer.privacy')}</Link>,
            })}
          </p>
          <p>
            {rich(t('auth.inviteHint'), {
              contact: (
                <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Nevazu invitation')}`} className="text-accent hover:underline">
                  {t('auth.requestInvite')}
                </a>
              ),
            })}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Six digits, as typed or pasted (spaces and dashes are dropped). */
export function CodeInput({ id, value, onChange, autoFocus = true }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      required
      autoFocus={autoFocus}
      className="h-11 text-center font-mono text-lg tracking-[0.4em]"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  );
}

/** The second step: a code from the authenticator app, or a backup code if the phone is not at hand. */
function SecondFactor({ onSignedIn, onRestart }: { onSignedIn: () => void; onRestart: (message?: string | null) => void }) {
  const { t } = useI18n();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = backup ? code.trim().length >= 8 : code.length === 6;

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', backup ? '/api/auth/two-factor/verify-backup-code' : '/api/auth/two-factor/verify-totp', { body: { code: code.trim(), trustDevice: trust } });
      onSignedIn();
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      // An expired challenge (10 minutes) or five wrong codes: start again from the email code.
      if (e?.code === 'INVALID_TWO_FACTOR_COOKIE' || e?.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE') onRestart(t('auth.2fa.restart'));
      else if (e?.code === 'ACCOUNT_TEMPORARILY_LOCKED') setError(t('auth.2fa.locked'));
      else if (e?.status === 429) setError(t('auth.tooMany'));
      else setError(t(backup ? 'auth.2fa.invalidBackup' : 'auth.2fa.invalid'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={verify}>
      <span className="mb-4 grid size-10 place-items-center border border-fg" aria-hidden>
        <ShieldCheck className="size-5" />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">{t('auth.2fa.title')}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">{t(backup ? 'auth.2fa.backupBody' : 'auth.2fa.body')}</p>
      <div className="mt-5">
        <Label htmlFor="second-factor">{t(backup ? 'auth.2fa.backupLabel' : 'auth.2fa.label')}</Label>
        {backup ? (
          <Input
            id="second-factor"
            autoComplete="one-time-code"
            autoCapitalize="off"
            spellCheck={false}
            required
            autoFocus
            className="h-11 text-center font-mono text-base tracking-widest"
            placeholder="XXXXX-XXXXX"
            value={code}
            onChange={(e) => setCode(e.target.value.trim().slice(0, 32))}
          />
        ) : (
          <CodeInput id="second-factor" value={code} onChange={setCode} />
        )}
      </div>
      <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-fg)]" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
        <span>
          {t('auth.2fa.trust')}
          <span className="block text-xs text-muted">{t('auth.2fa.trustHint')}</span>
        </span>
      </label>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-error">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" className="mt-5 w-full justify-center" disabled={busy || !valid}>
        {t('auth.2fa.verify')}
      </Button>
      <div className="mt-4 flex items-center justify-between gap-3 text-sm">
        <button type="button" className="inline-flex items-center gap-1 text-muted hover:text-fg" onClick={() => onRestart()}>
          <ArrowLeft className="size-3.5" aria-hidden /> {t('auth.2fa.startOver')}
        </button>
        <button
          type="button"
          className="font-medium text-accent hover:underline"
          onClick={() => {
            setBackup((b) => !b);
            setCode('');
            setError(null);
          }}
        >
          {t(backup ? 'auth.2fa.useApp' : 'auth.2fa.useBackup')}
        </button>
      </div>
    </form>
  );
}
