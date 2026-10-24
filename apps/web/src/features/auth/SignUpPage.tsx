import { Button, Input, Label } from '@cloudbrowser/ui';
import { MailCheck, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { queryClient } from '../../lib/query.js';
import { money } from '../../lib/money.js';
import { SUPPORT_EMAIL } from '../../lib/site.js';
import { usePublicPricing, useSignedIn } from '../../site/hooks.js';
import { AuthLayout } from './AuthLayout.js';
import { SecondFactor, sendError } from './SignInPage.js';
import { useTurnstile } from './turnstile.js';

const signInLink = 'font-medium text-accent underline-offset-4 hover:underline';

/**
 * Sign-up with an email address only: the api emails a single-use registration link (30 minutes)
 * that opens SignUpCompletePage. An existing address gets a sign-in code and goes straight to
 * the code-entry step, where the normal sign-in and two-factor checks apply.
 */
export function SignUpPage() {
  const { t, locale } = useI18n();
  const pricing = usePublicPricing();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const signedIn = useSignedIn();
  const turnstile = useTurnstile();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = email.trim().toLowerCase();

  useEffect(() => {
    if (signedIn) navigate('/browsers', { replace: true });
  }, [signedIn, navigate]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ method: 'registration' | 'code' | 'closed' }>('POST', '/api/auth/sign-up/start', { body: { email: address }, headers: await turnstile.headers() });
      if (res.method === 'closed') {
        setError(t('auth.closed', { email: SUPPORT_EMAIL }));
      } else if (res.method === 'code') {
        navigate(`/sign-in?email=${encodeURIComponent(address)}`, { replace: true, state: { emailCodeSentFor: address } });
      } else {
        setSent(true);
      }
    } catch (err) {
      setError(sendError(t, err));
    } finally {
      turnstile.finish();
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      agree="signup.agree"
      footer={
        <>
          {t('signup.haveAccount')}{' '}
          <Link to={`/sign-in${address ? `?email=${encodeURIComponent(address)}` : ''}`} className={signInLink}>
            {t('nav.signIn')}
          </Link>
        </>
      }
    >
      {sent ? (
        <div role="status">
          <span className="mb-5 grid size-10 place-items-center border border-border bg-surface" aria-hidden>
            <MailCheck className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">{t('signup.sentTitle')}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t('signup.sent', { email: address })}</p>
          <button type="button" className="mt-6 w-full text-center text-sm text-muted hover:text-fg" onClick={() => setSent(false)}>
            {t('auth.useOtherEmail')}
          </button>
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{t('signup.title')}</h1>
          {pricing.data && pricing.data.signupCreditMicros > 0 ? <p className="mt-3 border-l-2 border-fg bg-surface px-3 py-2 text-sm" data-testid="signup-credit-offer">{t('signup.creditOffer', { amount: money(pricing.data.signupCreditMicros, locale) })}</p> : null}
          <p className="mt-2 text-sm leading-relaxed text-muted">{t('signup.subtitle')}</p>
          <form onSubmit={send} className="mt-8 space-y-4">
            <div>
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input id="email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button type="submit" variant="primary" size="lg" className="w-full justify-center" disabled={busy}>
              {t('signup.send')}
            </Button>
          </form>
        </>
      )}
      {turnstile.active ? <div className="mt-6 w-full">{turnstile.widget}</div> : null}
      {turnstile.checking && !turnstile.failed ? (
        <p role="status" className="mt-4 text-sm text-muted">
          {t(turnstile.loadingWidget ? 'auth.captchaLoading' : 'auth.captchaChecking')}{' '}
          <button type="button" className="underline underline-offset-4" onClick={turnstile.retry}>{t('browsers.tryAgain')}</button>
        </p>
      ) : null}
      {turnstile.failed ? (
        <p role="alert" className="mt-4 text-sm text-error">
          {t('auth.captchaFailed')}{' '}
          <button type="button" className="underline underline-offset-4" onClick={turnstile.retry}>{t('browsers.tryAgain')}</button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-error">
          {error}
        </p>
      ) : null}
    </AuthLayout>
  );
}

/**
 * The registration link's landing page. Creating the account takes a click (a POST), so a mail
 * scanner that opens links in advance cannot use up the token. The click signs in too; the
 * two-step check only applies if this account somehow already turned it on.
 */
export function SignUpCompletePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'ready' | 'second-factor' | 'invalid' | 'failed'>(token ? 'ready' : 'invalid');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enter = () => {
    queryClient.clear();
    navigate('/browsers', { replace: true });
  };

  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ twoFactorRedirect?: boolean }>('POST', '/api/auth/sign-up/complete', { body: { token } });
      if (res?.twoFactorRedirect) setState('second-factor');
      else enter();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError(t('auth.tooMany'));
      else setState(err instanceof ApiError && err.code === 'INVALID_TOKEN' ? 'invalid' : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout agree="signup.agree">
      {state === 'second-factor' ? (
        <SecondFactor onSignedIn={enter} onRestart={() => navigate('/sign-in', { replace: true })} restartMessage="" />
      ) : state === 'ready' ? (
        <div>
          <span className="mb-5 grid size-10 place-items-center border border-border bg-surface" aria-hidden>
            <UserPlus className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">{t('signup.complete.title')}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t('signup.complete.body')}</p>
          <Button type="button" variant="primary" size="lg" className="mt-8 w-full justify-center" disabled={busy} onClick={complete} autoFocus>
            {t('signup.complete.button')}
          </Button>
          {error ? (
            <p role="alert" className="mt-4 text-sm text-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div role="alert">
          <h1 className="text-2xl font-semibold tracking-tight">{t('signup.complete.title')}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t(state === 'invalid' ? 'signup.complete.invalid' : 'signup.complete.failed')}</p>
          <div className="mt-8 space-y-3">
            <Button type="button" variant="primary" size="lg" className="w-full justify-center" onClick={() => navigate('/sign-up', { replace: true })}>
              {t('signup.complete.again')}
            </Button>
            <p className="text-center text-sm text-muted">
              {t('signup.haveAccount')}{' '}
              <Link to="/sign-in" className={signInLink}>
                {t('nav.signIn')}
              </Link>
            </p>
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
