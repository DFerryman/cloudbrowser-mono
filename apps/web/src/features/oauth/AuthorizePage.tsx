import type { OAuthAuthorizeCheck, OAuthDecision, OAuthDecisionBody } from '@cloudbrowser/contracts';
import { Button, Card, cn, Hint, Label, Select } from '@cloudbrowser/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck, LogIn, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { Logo } from '../../app/AppShell.js';
import { LanguageButton, ThemeButton } from '../../app/Preferences.js';
import { api, isUnauthenticated } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { en, type MessageKey } from '../../messages/en.js';
import { queryClient } from '../../lib/query.js';
import { useMe } from '../instances/hooks.js';

type Approval = Extract<OAuthAuthorizeCheck, { ok: true }>;
type GrantDays = OAuthDecisionBody['grantDays'];

/** The frame of the approval page: the logo, preferences and one card, like sign-in. */
function Frame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-1 py-8 min-[360px]:px-3 sm:px-4">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" aria-label={t('auth.backHome')}><Logo /></Link>
          <div className="flex items-center gap-1">
            <LanguageButton />
            <ThemeButton />
          </div>
        </div>
        <Card className="p-4 shadow-pop min-[400px]:p-6 sm:p-8">{children}</Card>
      </div>
    </div>
  );
}

/**
 * The approval page of a coding agent's OAuth sign-in (docs/agent-access.md, "OAuth sign-in"),
 * at /oauth/authorize with the app's request in the query. A signed-out visitor signs in first
 * and comes back with the request intact. The api checks the request and says what to show; the
 * owner allows (browser, permission, how long) or denies, and the page goes back to the app.
 * Navigating with location.assign reaches local, app-scheme and https callbacks alike, which a
 * form post would not under the site's form-action policy.
 */
export function AuthorizePage() {
  const { t, errorMessage, locale } = useI18n();
  const location = useLocation();
  const me = useMe();
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(location.search)), [location.search]);
  const check = useQuery({
    queryKey: ['oauth-authorize', location.search],
    queryFn: () => api<OAuthAuthorizeCheck>('POST', '/oauth/authorize/check', { body: { params } }),
    enabled: me.isSuccess,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (me.isError && isUnauthenticated(me.error)) {
    return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  if (me.isError || check.isError) {
    return <Frame><Refused title={t('oauth.refused.title')} description={errorMessage(me.error ?? check.error)} /></Frame>;
  }
  if (!check.data || !me.data) return <Frame><p className="text-sm text-muted">{t('common.loading')}</p></Frame>;
  if (!check.data.ok) {
    // The api's description is English; other languages say the same by the error's code.
    const key = `oauth.error.${check.data.error}` as MessageKey;
    const description = locale !== 'en' && key in en ? t(key) : check.data.description;
    return <Frame><Refused title={t('oauth.refused.title')} description={description} back={check.data.redirect} /></Frame>;
  }
  return <Frame><Approve request={check.data} params={params} email={me.data.user.email} /></Frame>;
}

/** A request that cannot be approved: why, and the way back to the app when it may be told. */
function Refused({ title, description, back }: { title: string; description: string; back?: string | null }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4" role="alert">
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><TriangleAlert className="size-5 text-error" aria-hidden /> {title}</h1>
      <p className="text-sm leading-relaxed text-muted">{description}</p>
      <Hint>{t('oauth.refused.hint')}</Hint>
      <div className="flex flex-wrap gap-2">
        {back ? <Button onClick={() => window.location.assign(back)}>{t('oauth.refused.back')}</Button> : null}
        <Link to="/browsers"><Button variant="ghost">{t('oauth.refused.home')}</Button></Link>
      </div>
    </div>
  );
}

function Approve({ request: r, params, email }: { request: Approval; params: Record<string, string>; email: string }) {
  const { t, errorMessage, locale } = useI18n();
  const [instanceId, setInstanceId] = useState(r.browser?.id ?? r.browsers[0]?.id ?? '');
  const [capability, setCapability] = useState(r.capability);
  const [days, setDays] = useState<GrantDays>((r.grantDays.includes(r.defaultGrantDays) ? r.defaultGrantDays : r.grantDays[0]) as GrantDays);
  const [done, setDone] = useState<'allowed' | 'denied' | null>(null);
  const browser = r.browser ?? r.browsers.find((b) => b.id === instanceId) ?? null;
  const decide = useMutation({
    mutationFn: (approve: boolean) => api<OAuthDecision>('POST', '/oauth/authorize/decision', {
      body: {
        params, approve, grantDays: days, capability, enableAccess: approve && !!browser && !browser.agentAccess,
        // The browser the owner picked, only when allowing a request that named none.
        ...(approve && !r.browser && instanceId ? { instanceId } : {}),
      } satisfies OAuthDecisionBody,
    }),
    onSuccess: ({ redirect }, approve) => {
      setDone(approve ? 'allowed' : 'denied');
      window.location.assign(redirect);
    },
  });
  const end = new Date(Date.now() + days * 86_400_000).toLocaleDateString(locale);
  const where = r.redirect.kind === 'loopback' ? t('oauth.return.loopback') : r.redirect.kind === 'app' ? t('oauth.return.app', { scheme: r.redirect.label }) : r.redirect.label;

  if (done) {
    return (
      <div className="space-y-3" role="status">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <CircleCheck className="size-5 text-running" aria-hidden /> {t(done === 'allowed' ? 'oauth.done.allowed' : 'oauth.done.denied', { app: r.client.name })}
        </h1>
        <p className="text-sm leading-relaxed text-muted">{t('oauth.done.body', { app: r.client.name })}</p>
      </div>
    );
  }

  const switchAccount = async () => {
    await api('POST', '/api/auth/sign-out', { body: {} }).catch(() => {});
    queryClient.clear();
    window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-subtle uppercase"><LogIn className="size-3.5" aria-hidden /> {t('oauth.eyebrow')}</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight break-words">{t('oauth.title', { app: r.client.name })}</h1>
        {r.client.verifiedHost ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-muted"><ShieldCheck className="size-4 shrink-0 text-running" aria-hidden /> {t('oauth.verified', { host: r.client.verifiedHost })}</p>
        ) : (
          <p className="mt-3 flex gap-2 border border-starting/40 bg-starting/5 p-3 text-xs leading-relaxed text-muted">
            <ShieldAlert className="size-4 shrink-0 text-starting" aria-hidden /> <span>{t('oauth.unverified', { app: r.client.name })}</span>
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="oauth-browser">{t('oauth.browser')}</Label>
        {r.browser ? (
          <p id="oauth-browser" className="border border-border bg-surface px-3 py-2 text-sm font-medium">{r.browser.name}</p>
        ) : r.browsers.length ? (
          <Select id="oauth-browser" value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
            {r.browsers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        ) : (
          <p className="text-sm text-muted">{t('oauth.noBrowser')} <Link to="/browsers" className="underline">{t('oauth.createBrowser')}</Link></p>
        )}
        {browser && !browser.agentAccess ? <Hint>{t('oauth.accessOff')}</Hint> : null}
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-[13px] font-medium">{t('oauth.permission')}</legend>
        {(['control', 'view'] as const).map((c) => {
          const disabled = c === 'control' && r.capability === 'view';
          return (
            <label key={c} className={cn('flex items-start gap-3 border p-3', capability === c ? 'border-fg' : 'border-border', disabled ? 'opacity-50' : 'cursor-pointer')}>
              <input type="radio" name="oauth-capability" className="mt-0.5 accent-[var(--color-fg)]" value={c} checked={capability === c} disabled={disabled} onChange={() => setCapability(c)} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t(`agents.key.capability.${c}`)}</span>
                <span className="block text-xs leading-relaxed text-subtle">{t(`oauth.permission.${c}`)}</span>
              </span>
            </label>
          );
        })}
        {r.capability === 'view' ? <Hint>{t('oauth.permission.askedView', { app: r.client.name })}</Hint> : null}
      </fieldset>

      <div className="space-y-2">
        <p className="text-[13px] font-medium" id="oauth-days">{t('oauth.days')}</p>
        <div role="radiogroup" aria-labelledby="oauth-days" className="grid grid-cols-4 gap-1">
          {r.grantDays.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={d === days}
              className={cn('border px-2 py-1.5 text-sm transition-colors', d === days ? 'border-fg bg-fg text-bg' : 'border-border text-muted hover:border-border-strong hover:text-fg')}
              onClick={() => setDays(d as GrantDays)}
            >
              {t(d === 1 ? 'oauth.days.one' : 'oauth.days.n', { n: d })}
            </button>
          ))}
        </div>
        <Hint>{t('oauth.days.hint', { date: end })}</Hint>
      </div>

      <p className="text-xs leading-relaxed text-subtle">{t('oauth.return', { where })}</p>

      {decide.isError ? <p role="alert" className="text-sm text-error">{errorMessage(decide.error)}</p> : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button className="justify-center" disabled={decide.isPending} onClick={() => decide.mutate(false)}>{t('oauth.deny')}</Button>
        <Button variant="primary" className="justify-center" disabled={decide.isPending || !browser} onClick={() => decide.mutate(true)} data-testid="oauth-allow">
          {t('oauth.allow')}
        </Button>
      </div>

      <p className="border-t border-border pt-4 text-xs text-subtle">
        {t('oauth.signedInAs', { email })}{' '}
        <button type="button" className="underline hover:text-fg" onClick={() => void switchAccount()}>{t('oauth.switchAccount')}</button>
      </p>
    </div>
  );
}
