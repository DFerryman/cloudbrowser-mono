/**
 * The api Worker: public REST + SSE under /api on the app's own origin, Better Auth under
 * /api/auth, and the built web app as static assets for every other path (page 2).
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { createDb } from '@cloudbrowser/db';
import type { MiddlewareHandler } from 'hono';
import { createAuth } from './auth.js';
import type { AppEnv } from './env.js';
import { problem, ProblemError } from './problem.js';
import { v1 } from './routes/v1.js';

const app = new OpenAPIHono<AppEnv>();

app.onError((err) => {
  if (err instanceof ProblemError) return err.toResponse();
  console.error(err);
  return problem(500, 'internal').toResponse();
});
app.notFound((c) => (c.req.path.startsWith('/api/') ? problem(404, 'not_found').toResponse() : c.env.ASSETS.fetch(c.req.raw)));

app.use('/api/*', async (c, next) => {
  const db = createDb(c.env.DB);
  c.set('db', db);
  c.set('auth', createAuth(c.env, db, (p) => c.executionCtx.waitUntil(p)));
  await next();
  c.header('cache-control', c.res.headers.get('cache-control') ?? 'no-store');
  c.header('x-content-type-options', 'nosniff');
});

/**
 * Sign-in throttling with the Workers Rate Limiting binding, per client IP and per email, on top of
 * Better Auth's own limits and the OTP attempt cap. Cloudflare's limiter is per location and
 * eventually consistent, which is fine for slowing down abuse.
 */
const limitSignIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limiter = c.env.AUTH_LIMITER;
  if (limiter && c.req.method === 'POST' && /\/(email-otp\/send-verification-otp|sign-in\/email-otp)$/.test(c.req.path)) {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const email = String(((await c.req.raw.clone().json().catch(() => ({}))) as { email?: unknown }).email ?? '')
      .trim()
      .toLowerCase();
    const checks = [limiter.limit({ key: `ip:${ip}` }), ...(email ? [limiter.limit({ key: `email:${email}` })] : [])];
    if ((await Promise.all(checks)).some((r) => !r.success)) {
      return c.json({ code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again in a minute.' }, 429);
    }
  }
  await next();
};

app.on(['GET', 'POST'], '/api/auth/*', limitSignIn, (c) => c.get('auth').handler(c.req.raw));

/**
 * IP echo for the agent's in-Chrome IP check (page 3): hosted on Cloudflare, outside the browser
 * provider, it returns the address the request came from.
 */
app.get('/api/echo/ip', (c) => {
  c.header('cache-control', 'no-store');
  return c.text(c.req.header('cf-connecting-ip') ?? '');
});

/** State-changing requests must come from our own origin (page 1, "Security"). */
const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    const allowed = new Set([new URL(c.env.APP_URL).origin, new URL(c.req.url).origin]);
    if (!origin || !allowed.has(origin)) throw problem(403, 'forbidden', 'Cross-origin request refused.');
  }
  await next();
};

const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await c.get('auth').api.getSession({ headers: c.req.raw.headers });
  if (!session) throw problem(401, 'unauthenticated');
  c.set('user', { id: session.user.id, email: session.user.email, name: session.user.name });
  await next();
};

/** Per-user limit on API writes (page 2: rate limits per user), via the Workers Rate Limiting binding. */
const limitWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.API_LIMITER && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const { success } = await c.env.API_LIMITER.limit({ key: `user:${c.get('user').id}` });
    if (!success) throw problem(429, 'rate_limited');
  }
  await next();
};

app.get('/api/v1/health', (c) => c.json({ ok: true }));
app.doc31('/api/v1/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'CloudBrowser API', version: '1.0.0' },
});
app.use('/api/v1/*', sameOrigin, requireUser, limitWrites);
app.route('/api/v1', v1);

export default app;
