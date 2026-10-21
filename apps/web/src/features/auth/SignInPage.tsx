import { Button, Input, Label } from '@cloudbrowser/ui';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { ArrowLeft, CheckCircle2, Fingerprint, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { queryClient } from '../../lib/query.js';
import { useSignedIn } from '../../site/hooks.js';
import { AuthLayout, safeNext } from './AuthLayout.js';
import { useTurnstile } from './turnstile.js';

type Step = 'email' | 'passkey' | 'code' | 'second-factor';

/** The message for a failed request that sends an email (rate limit, Turnstile, anything else). */
export function sendError(t: ReturnType<typeof useI18n>['t'], err: unknown) {
  if (err instanceof ApiError && err.status === 429) return t('auth.tooMany');
  if (err instanceof ApiError && err.code === 'CAPTCHA_FAILED') return t('auth.captchaFailed');
  return t('error.internal');
}

/**
 * Email-only sign-in (page 1, "Auth"). The address comes first: an account with a passkey is
 * offered the passkey, any other account gets a 6-digit email code. An address with no account
 * is prompted to register, without sending an email. An email code
 * is always available, passkey or not. With two-factor sign-in on, the email code is followed by a
 * code from an authenticator app (or a one-time backup code) before a session exists; a passkey
 * already proves two factors. New accounts are made on the sign-up page. Google is unavailable
 * from mainland China.
 */
export function SignInPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const signedIn = useSignedIn();
  const turnstile = useTurnstile();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>(() => location.state?.emailCodeSentFor === email.trim().toLowerCase() ? 'code' : 'email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrationRequired, setRegistrationRequired] = useState(false);
  const address = email.trim().toLowerCase();

  const enter = () => {
    queryClient.clear();
    navigate(safeNext(params.get('next')), { replace: true });
  };
  // Already signed in (for example from a bookmark): go straight in.
  useEffect(() => {
    if (signedIn && step === 'email') navigate(safeNext(params.get('next')), { replace: true });
  }, [signedIn, step, navigate, params]);
  const signedOut = params.has('signedOut') && step === 'email' && !error;

  const run = async (work: () => Promise<void>, onError: (err: unknown) => string | null) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(onError(err));
    } finally {
      setBusy(false);
    }
  };

  const start = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setRegistrationRequired(false);
    void run(async () => {
      const res = await api<{ method: 'passkey' | 'code' | 'register' }>('POST', '/api/auth/sign-in/start', { body: { email: address }, headers: await turnstile.headers() }).finally(turnstile.reset);
      setCode('');
      if (res.method === 'register') {
        setRegistrationRequired(true);
        return;
      }
      setStep(res.method === 'passkey' ? 'passkey' : 'code');
    }, (err) => sendError(t, err));
  };

  const sendCode = () =>
    void run(async () => {
      await api('POST', '/api/auth/email-otp/send-verification-otp', { body: { email: address, type: 'sign-in' }, headers: await turnstile.headers() }).finally(turnstile.reset);
      setCode('');
      setStep('code');
    }, (err) => sendError(t, err));

  const usePasskey = () =>
    void run(async () => {
      const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>('GET', '/api/auth/passkey/generate-authenticate-options');
      const response = await startAuthentication({ optionsJSON });
      await api('POST', '/api/auth/passkey/verify-authentication', { body: { response } });
      enter();
    }, (err) => {
      // The user closed the browser's passkey dialog: let them choose again, no message needed.
      if (err instanceof Error && err.name === 'NotAllowedError') return null;
      if (err instanceof ApiError && err.code === 'USER_VERIFICATION_REQUIRED') return t('auth.passkey.verifyRequired');
      return err instanceof ApiError && err.status === 429 ? t('auth.tooMany') : t('auth.passkey.failed');
    });

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ twoFactorRedirect?: boolean }>('POST', '/api/auth/sign-in/email-otp', { body: { email: address, otp: code.trim() } });
      if (res?.twoFactorRedirect) setStep('second-factor');
      else enter();
    }, (err) => (err instanceof ApiError && err.status === 429 ? t('auth.tooMany') : t('auth.invalidCode')));
  };

  const restart = (message: string | null = null) => {
    setStep('email');
    setCode('');
    setError(message);
  };

  const otherEmail = (
    <button type="button" className="w-full text-center text-sm text-muted hover:text-fg" onClick={() => restart()}>
      {t('auth.useOtherEmail')}
    </button>
  );
  const waiting = busy;

  return (
    <AuthLayout
      notice={signedOut ? (
        <p role="status" className="mb-3 flex items-center gap-2 border-l-2 border-running bg-bg px-3 py-2.5 text-sm">
          <CheckCircle2 className="size-4 shrink-0 text-running" aria-hidden /> {t('auth.signedOut')}
        </p>
      ) : null}
      footer={step === 'email' ? (
        <>
          {t('auth.noAccount')}{' '}
          <Link to={`/sign-up${address ? `?email=${encodeURIComponent(address)}` : ''}`} className="font-medium text-accent underline-offset-4 hover:underline">
            {t('auth.createAccount')}
          </Link>
        </>
      ) : null}
    >
      {step === 'second-factor' ? (
        <SecondFactor onSignedIn={enter} onRestart={restart} restartMessage={t('auth.2fa.restart')} />
      ) : step === 'passkey' ? (
        <div>
          <span className="mb-5 grid size-10 place-items-center border border-border bg-surface" aria-hidden>
            <Fingerprint className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">{t('auth.passkey.title')}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t('auth.passkey.body', { email: address })}</p>
          <div className="mt-8 space-y-3">
            <Button type="button" variant="primary" size="lg" className="w-full justify-center" disabled={busy} onClick={usePasskey} autoFocus>
              <Fingerprint /> {t('auth.passkey.use')}
            </Button>
            <Button type="button" variant="secondary" size="lg" className="w-full justify-center" disabled={waiting} onClick={sendCode}>
              {t('auth.passkey.emailCode')}
            </Button>
            {otherEmail}
          </div>
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{t('auth.title')}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">{step === 'email' ? t('auth.subtitle') : t(location.state?.emailCodeSentFor === address ? 'signup.existingCodeSent' : 'auth.codeSent', { email: address })}</p>
          {step === 'email' ? (
            <form onSubmit={start} className="mt-8 space-y-4">
              <div>
                <Label htmlFor="email">{t('auth.email')}</Label>
                <Input id="email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => { setEmail(e.target.value); setRegistrationRequired(false); }} />
              </div>
              <Button type="submit" variant="primary" size="lg" className="w-full justify-center" disabled={waiting}>
                {t('auth.continue')}
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
              {otherEmail}
            </form>
          )}
        </>
      )}
      {/* Outside the steps, so the widget lives as long as the page. */}
      {step !== 'second-factor' ? <div className="mt-6 flex justify-center">{turnstile.widget}</div> : null}
      {turnstile.checking ? <p role="status" className="mt-4 text-sm text-muted">{t('auth.captchaChecking')}</p> : null}
      {turnstile.failed && step !== 'second-factor' ? (
        <p role="alert" className="mt-4 text-sm text-error">
          {t('auth.captchaFailed')}{' '}
          <button type="button" className="underline underline-offset-4" onClick={turnstile.retry}>{t('browsers.tryAgain')}</button>
        </p>
      ) : null}
      {registrationRequired && step === 'email' ? (
        <p role="alert" className="mt-4 text-sm text-muted">
          {t('auth.notRegistered')}{' '}
          <Link to={`/sign-up?email=${encodeURIComponent(address)}`} className="font-medium text-accent underline underline-offset-4">{t('auth.createAccount')}</Link>
        </p>
      ) : null}
      {error && step !== 'second-factor' ? (
        <p role="alert" className="mt-4 text-sm text-error">
          {error}
        </p>
      ) : null}
    </AuthLayout>
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
export function SecondFactor({ onSignedIn, onRestart, restartMessage }: { onSignedIn: () => void; onRestart: (message?: string | null) => void; restartMessage: string }) {
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
      // An expired challenge (10 minutes) or five wrong codes: start again from the first factor.
      if (e?.code === 'INVALID_TWO_FACTOR_COOKIE' || e?.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE') onRestart(restartMessage);
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
      <span className="mb-5 grid size-10 place-items-center border border-border bg-surface" aria-hidden>
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
          className="font-medium text-accent underline-offset-4 hover:underline"
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
