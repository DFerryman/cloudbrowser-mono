/**
 * The app's own steps around Better Auth's email-only sign-in and sign-up (auth.ts), under
 * /api/auth next to Better Auth's endpoints:
 *
 * - GET  /sign-in/options     what the sign-in and sign-up forms need (the Turnstile site key)
 * - POST /sign-in/start       first sign-in step: passkey or email code for this address
 * - POST /sign-up/start       registration link for a new address, email code for an existing one
 * - POST /sign-up/complete    finishes sign-up with the token from a registration link
 *
 * Every request that sends an email (the start step, a registration link, an email code) must carry
 * a Cloudflare Turnstile token when TURNSTILE_SECRET_KEY is set, on top of the rate limits.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { startSignIn, startSignUp } from './auth.js';
import type { AppEnv, Env } from './env.js';

/** Better Auth endpoints (and ours) that send an email. */
export const SENDS_EMAIL = /\/api\/auth\/(sign-up\/start|sign-in\/start|sign-in\/magic-link|email-otp\/send-verification-otp)$/;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const tooMany = { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again in a minute.' };

/** Cloudflare Turnstile: the widget's token (`cf-turnstile-response` header) checked with siteverify. */
export async function verifyTurnstile(env: Env, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}), idempotency_key: crypto.randomUUID() }),
    });
    const data = (await res.json()) as { success?: boolean; hostname?: string };
    // Tokens are bound to the hostname that rendered the widget: only the app's own.
    return !!data.success && (!data.hostname || data.hostname === new URL(env.APP_URL).hostname || env.ENVIRONMENT !== 'production');
  } catch (e) {
    console.error('turnstile siteverify failed', e);
    return false;
  }
}

/** Requests that send an email need a valid Turnstile token (when Turnstile is configured). */
export const requireTurnstile: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'POST' && SENDS_EMAIL.test(c.req.path)) {
    if (!(await verifyTurnstile(c.env, c.req.header('cf-turnstile-response'), c.req.header('cf-connecting-ip')))) {
      return c.json({ code: 'CAPTCHA_FAILED', message: 'The security check failed. Try again.' }, 403);
    }
  }
  await next();
};

/** Our POST endpoints come from the app's own pages only (Better Auth checks its own). */
const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'POST' && c.req.header('origin') !== new URL(c.env.APP_URL).origin && c.req.header('origin') !== new URL(c.req.url).origin) {
    return c.json({ code: 'FORBIDDEN', message: 'Cross-origin request refused.' }, 403);
  }
  await next();
};

export const signInRoute = new Hono<AppEnv>();
signInRoute.get('/sign-in/options', (c) => c.json({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? null }));

signInRoute.post('/sign-up/start', sameOrigin, async (c) => {
  const body = z.object({ email: z.email() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ code: 'INVALID_EMAIL', message: 'Enter a valid email address.' }, 400);
  const method = await startSignUp(c.get('auth'), c.get('db'), body.data.email.trim().toLowerCase(), c.req.raw.headers);
  return c.json({ method });
});

signInRoute.post('/sign-in/start', sameOrigin, async (c) => {
  const body = z.object({ email: z.email() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ code: 'INVALID_EMAIL', message: 'Enter a valid email address.' }, 400);
  const method = await startSignIn(c.get('auth'), c.get('db'), body.data.email.trim().toLowerCase(), c.req.raw.headers);
  return c.json({ method });
});

/**
 * Completes a registration link with a POST from the confirmation page (a link scanner's GET does
 * nothing). Runs Better Auth's own link check, so its hooks apply (two-factor.ts), and turns its
 * error redirect into a JSON error the page can show.
 */
signInRoute.post('/sign-up/complete', sameOrigin, async (c) => {
  const body = z.object({ token: z.string().min(1).max(256) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ code: 'INVALID_TOKEN', message: 'This link is not valid.' }, 400);
  // The registration token is per email; a burst of guesses from one address is refused.
  const limiter = c.env.AUTH_LIMITER;
  if (limiter && !(await limiter.limit({ key: `ip:${c.req.header('cf-connecting-ip') ?? 'unknown'}` })).success) return c.json(tooMany, 429);
  const url = new URL('/api/auth/magic-link/verify', c.env.APP_URL);
  url.searchParams.set('token', body.data.token);
  const headers = new Headers(c.req.raw.headers);
  headers.delete('content-type');
  headers.delete('content-length');
  const res = await c.get('auth').handler(new Request(url, { method: 'GET', headers }));
  if (res.status >= 300 && res.status < 400) {
    const error = new URL(res.headers.get('location') ?? '/', c.env.APP_URL).searchParams.get('error') ?? 'INVALID_TOKEN';
    return c.json({ code: error, message: error === 'INVALID_TOKEN' ? 'This link has expired or was already used.' : 'The account could not be created.' }, 400);
  }
  return res;
});
