/** Cloudflare Access is the only identity provider for the separate administrator origin. */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env.js';
import { problem } from '../problem.js';

export const DEFAULT_ADMIN_EMAIL = 'sanchai20@163.com';
const MAX_ASSERTION_BYTES = 16 * 1024;
// Shared public-key caches contain no identity or request state. jose handles signing-key rotation.
const publicKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function adminOrigin(env: Env): string | null {
  if (!env.ADMIN_URL) return null;
  try {
    const url = new URL(env.ADMIN_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const isAdminPath = (path: string) => path === '/api/v1/admin' || path.startsWith('/api/v1/admin/');
export const isAdminOrigin = (env: Env, url: string) => new URL(url).origin === adminOrigin(env);

export function isAdminEmail(env: Env, email: string): boolean {
  const allowed = (env.ADMIN_EMAIL_ALLOWLIST ?? DEFAULT_ADMIN_EMAIL).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

function accessIssuer(env: Env): string | null {
  // Use only the configured team, never an unverified JWT's iss/jku or a request header.
  const domain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  if (!domain || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(domain)) return null;
  return `https://${domain}`;
}

/** Missing configuration, tokens, or permissions always fail closed, without a main-site fallback. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdminOrigin(c.env, c.req.url)) throw problem(404, 'not_found');
  const forbidden = () => problem(403, 'forbidden', 'You do not have permission to access the administrator console. Sign in with the authorized administrator email.');
  const issuer = accessIssuer(c.env);
  const audience = c.env.ACCESS_AUD?.trim();
  const assertion = c.req.header('cf-access-jwt-assertion');
  if (!issuer || !audience || !assertion || assertion.length > MAX_ASSERTION_BYTES) throw forbidden();

  let identity: { sub: string; email: string };
  try {
    let jwks = publicKeys.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000,
        cacheMaxAge: 10 * 60_000,
        cooldownDuration: 30_000,
      });
      publicKeys.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'email', 'exp', 'iat'],
      maxTokenAge: '8h',
    });
    if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub.trim()
      || typeof payload.email !== 'string' || !payload.email.trim()) throw forbidden();
    identity = { sub: payload.sub, email: payload.email.trim().toLowerCase() };
  } catch {
    // Do not log assertions, claims, or provider internals on failed authentication.
    throw forbidden();
  }
  if (!isAdminEmail(c.env, identity.email)) throw forbidden();
  c.set('user', { id: `cf-access:${identity.sub}`, email: identity.email, name: identity.email });
  await next();
};
