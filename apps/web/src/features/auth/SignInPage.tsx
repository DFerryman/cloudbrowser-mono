import { Button, Card, Input, Label } from '@cloudbrowser/ui';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Logo } from '../../app/AppShell.js';
import { api, ApiError } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { queryClient } from '../../lib/query.js';

/** Email one-time code sign-in (page 1, "Auth"). Google is unavailable from mainland China. */
export function SignInPage() {
  const { t, locale, setLocale } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/email-otp/send-verification-otp', { body: { email: email.trim().toLowerCase(), type: 'sign-in' } });
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
      await api('POST', '/api/auth/sign-in/email-otp', { body: { email: email.trim().toLowerCase(), otp: code.trim() } });
      queryClient.clear();
      const next = params.get('next');
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/browsers', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? t('auth.tooMany') : t('auth.invalidCode'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <button type="button" className="text-sm text-muted hover:text-fg" onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>
            {locale === 'en' ? '中文' : 'English'}
          </button>
        </div>
        <Card className="p-6">
          <h1 className="text-lg font-semibold">{t('auth.title')}</h1>
          <p className="mt-1 text-sm text-muted">{step === 'email' ? t('auth.subtitle') : t('auth.codeSent', { email })}</p>
          {step === 'email' ? (
            <form onSubmit={sendCode} className="mt-5 space-y-4">
              <div>
                <Label htmlFor="email">{t('auth.email')}</Label>
                <Input id="email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <Button type="submit" variant="primary" className="w-full justify-center" disabled={busy}>
                {t('auth.sendCode')}
              </Button>
            </form>
          ) : (
            <form onSubmit={signIn} className="mt-5 space-y-4">
              <div>
                <Label htmlFor="code">{t('auth.code')}</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  autoFocus
                  className="font-mono tracking-[0.3em]"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              </div>
              <Button type="submit" variant="primary" className="w-full justify-center" disabled={busy || code.length !== 6}>
                {t('auth.signIn')}
              </Button>
              <button type="button" className="w-full text-center text-sm text-muted hover:text-fg" onClick={() => setStep('email')}>
                {t('auth.useOtherEmail')}
              </button>
            </form>
          )}
          {error ? (
            <p role="alert" className="mt-4 text-sm text-error">
              {error}
            </p>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
