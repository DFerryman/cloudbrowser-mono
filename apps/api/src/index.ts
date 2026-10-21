/**
 * The api Worker: public REST + SSE under /api on the app's own origin, Better Auth under
 * /api/auth, and the built web app as static assets for every other path (page 2).
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ViewerTokenClaims } from '@cloudbrowser/contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createDb } from '@cloudbrowser/db';
import { adminOrigin, isAdminOrigin, isAdminPath, requireAdmin } from './admin/access.js';
import { creemFrom } from './billing/creem.js';
import { billingSweep } from './billing/sweep.js';
import { processWebhook, receiveWebhook } from './billing/webhooks.js';
import type { MiddlewareHandler } from 'hono';
import { createAuth } from './auth.js';
import type { AppEnv, Env } from './env.js';
import { internalApi } from './internal.js';
import { adminSweep, deliverAlerts } from './notifications/admin.js';
import { rewardNotices } from './notifications/user.js';
import { requireTurnstile, SENDS_EMAIL, signInRoute, tooMany } from './sign-in.js';
import { problem, ProblemError } from './problem.js';
import { promotionSweep } from './promotions.js';
import { adminRoute } from './routes/admin.js';
import { publicRoute } from './routes/public.js';
import { v1 } from './routes/v1.js';

const app = new OpenAPIHono<AppEnv>();

app.onError((err) => {
  if (err instanceof ProblemError) return err.toResponse();
  console.error(err);
  return problem(500, 'internal').toResponse();
});
app.notFound((c) => (c.req.path.startsWith('/api/') ? problem(404, 'not_found').toResponse() : c.env.ASSETS.fetch(c.req.raw)));

app.use('/api/*', async (c, next) => {
  // The administrator host exposes only its own API. Its identity never comes from Better Auth.
  const adminHost = isAdminOrigin(c.env, c.req.url);
  if ((isAdminPath(c.req.path) && !adminHost) || (adminHost && !isAdminPath(c.req.path))) throw problem(404, 'not_found');
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
  // Second-factor codes have their own budget per IP, besides the plugin's per-challenge attempt
  // cap and its account lock after repeated wrong codes.
  if (limiter && c.req.method === 'POST' && /\/two-factor\/[a-z-]+$/.test(c.req.path)) {
    const { success } = await limiter.limit({ key: `2fa-ip:${c.req.header('cf-connecting-ip') ?? 'unknown'}` });
    if (!success) return c.json(tooMany, 429);
  }
  if (limiter && c.req.method === 'POST' && (SENDS_EMAIL.test(c.req.path) || c.req.path.endsWith('/sign-in/email-otp'))) {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const email = String(((await c.req.raw.clone().json().catch(() => ({}))) as { email?: unknown }).email ?? '')
      .trim()
      .toLowerCase();
    const checks = [limiter.limit({ key: `ip:${ip}` }), ...(email ? [limiter.limit({ key: `email:${email}` })] : [])];
    if ((await Promise.all(checks)).some((r) => !r.success)) {
      return c.json(tooMany, 429);
    }
  }
  await next();
};

// Turnstile first: requests without a valid token do not use up an address's rate-limit budget.
app.use('/api/auth/*', requireTurnstile, limitSignIn);
app.route('/api/auth', signInRoute);
app.on(['GET', 'POST'], '/api/auth/*', (c) => c.get('auth').handler(c.req.raw));

/**
 * IP echo for the agent's in-Chrome IP check (page 3): hosted on Cloudflare, outside the browser
 * provider, it returns the address the request came from.
 */
app.get('/api/echo/ip', (c) => {
  c.header('cache-control', 'no-store');
  // The agent checks from a fresh about:blank context, whose origin is null.
  c.header('access-control-allow-origin', '*');
  return c.text(c.req.header('cf-connecting-ip') ?? '');
});

/**
 * Creem webhooks (page 6): signature over the raw body, stored by event id, processed from the
 * `cloudbrowser-billing` queue. Outside /api/v1: no session, no origin check.
 */
app.post('/api/webhooks/creem', async (c) => {
  const status = await receiveWebhook(c.env, c.get('db'), await c.req.text(), c.req.header('creem-signature'));
  return c.text(status === 200 ? 'ok' : 'rejected', status as 200 | 400 | 401);
});

/** State-changing requests must come from our own origin (page 1, "Security"). */
const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    const allowed = new Set(isAdminPath(c.req.path)
      ? [adminOrigin(c.env)]
      : [new URL(c.env.APP_URL).origin, new URL(c.req.url).origin]);
    if (!origin || !allowed.has(origin)) throw problem(403, 'forbidden', 'Cross-origin request refused.');
  }
  await next();
};

const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await c.get('auth').api.getSession({ headers: c.req.raw.headers });
  if (!session) throw problem(401, 'unauthenticated');
  c.set('user', { id: session.user.id, email: session.user.email, name: session.user.name, twoFactorEnabled: !!session.user.twoFactorEnabled });
  c.set('sessionId', session.session.id);
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
/** Signed-out price list and status for the public site; GET only, nothing per user. */
app.route('/api/public', publicRoute);
app.doc31('/api/v1/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Nevazu API', version: '1.0.0' },
});
app.use('/api/v1/*', sameOrigin, async (c, next) => {
  if (isAdminPath(c.req.path)) return requireAdmin(c, next);
  return requireUser(c, next);
}, limitWrites);
app.route('/api/v1/admin', adminRoute);
app.route('/api/v1', v1);

export default {
  fetch: app.fetch,

  /** `cloudbrowser-billing`: one message per new Creem webhook event. */
  async queue(batch: MessageBatch<{ eventId: string }>, env: Env) {
    const creem = creemFrom(env);
    const db = createDb(env.DB);
    for (const msg of batch.messages) {
      if (!creem) {
        msg.ack(); // billing not configured; the stored event waits for the cron once it is
        continue;
      }
      try {
        await processWebhook(env, db, creem, msg.body.eventId);
        msg.ack();
      } catch (e) {
        console.error('billing webhook failed', msg.body.eventId, e);
        msg.retry({ delaySeconds: 30 });
      }
    }
  },

  /** Every 5 minutes: billing sweep (the 03:00–03:04 UTC run also reconciles with Creem), alert delivery and promotion rewards. */
  async scheduled(controller: ScheduledController, env: Env) {
    const at = new Date(controller.scheduledTime);
    const nightly = at.getUTCHours() === 3 && at.getUTCMinutes() < 5;
    const db = createDb(env.DB);
    console.log('billing sweep', JSON.stringify(await billingSweep(env, db, creemFrom(env), new Date(), { nightly })));
    console.log('promotions', JSON.stringify(await promotionSweep(env, db, new Date()).catch((e) => ({ error: String(e) }))));
    console.log('reward emails', await rewardNotices(env, db, new Date()).catch((e) => String(e)));
    // Admin watchers raise alerts; deliver afterwards so they go out in the same run.
    console.log('admin notifications', JSON.stringify(await adminSweep(db, new Date())));
    console.log('alerts delivered', await deliverAlerts(env, db));
  },
} satisfies ExportedHandler<Env, { eventId: string }>;

/** RPC entrypoint for the session gateway's service binding (`entrypoint: "Internal"`). */
export class Internal extends WorkerEntrypoint<Env> {
  authenticateAgent(input: { instanceId: string; bootstrap?: string; credential?: string }) {
    return internalApi(this.env).authenticateAgent(input);
  }
  agentMessage(instanceId: string, generation: number, frame: unknown) {
    return internalApi(this.env).agentMessage(instanceId, generation, frame);
  }
  redeemViewerToken(claims: ViewerTokenClaims) {
    return internalApi(this.env).redeemViewerToken(claims);
  }
  archiveKey(instanceId: string) {
    return internalApi(this.env).archiveKey(instanceId);
  }
}
