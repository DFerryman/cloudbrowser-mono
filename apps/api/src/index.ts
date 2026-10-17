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

app.on(['GET', 'POST'], '/api/auth/*', (c) => c.get('auth').handler(c.req.raw));

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

app.get('/api/v1/health', (c) => c.json({ ok: true }));
app.doc31('/api/v1/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'CloudBrowser API', version: '1.0.0' },
});
app.use('/api/v1/*', sameOrigin, requireUser);
app.route('/api/v1', v1);

export default app;
