import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { vi } from 'vitest';
import type { setup } from './helpers.js';

export const ADMIN_ORIGIN = 'https://admin.test';
export const ACCESS_TEAM_DOMAIN = 'gotagma.cloudflareaccess.com';
export const ACCESS_ISSUER = `https://${ACCESS_TEAM_DOMAIN}`;
export const ACCESS_AUD = 'test-admin-aud';
export const ADMIN_EMAIL = 'sanchai20@163.com';
export const ADMIN_SUB = 'access-operator-123';
export const ADMIN_ACTOR = `admin:cf-access:${ADMIN_SUB}`;
const KEY_ID = 'admin-test-rs256';
const CERTS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;

// The production JWKS resolver caches by trusted team domain across requests. Keep this keypair
// constant across the suite so warm resolvers and fresh mock responses always refer to the same key.
const keys = generateKeyPair('RS256', { extractable: true });
const publicJwk = keys.then(async ({ publicKey }) => ({ ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }));

export async function prepareAdminKeys() {
  await publicJwk;
}

export function configureAdmin(t: ReturnType<typeof setup>) {
  Object.assign(t.env, {
    ADMIN_URL: ADMIN_ORIGIN,
    ACCESS_TEAM_DOMAIN,
    ACCESS_AUD,
    ADMIN_EMAIL_ALLOWLIST: ADMIN_EMAIL,
    AUTH_LIMITER: { limit: async () => ({ success: true }) },
  });
}

/** Produce a real signed application token; overrides also allow malformed/missing claim tests. */
export async function accessToken(overrides: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ACCESS_ISSUER,
    aud: [ACCESS_AUD],
    sub: ADMIN_SUB,
    email: ADMIN_EMAIL,
    type: 'app',
    iat: now,
    nbf: now - 1,
    exp: now + 8 * 60 * 60,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .sign((await keys).privateKey);
}

/** Only the trusted Access certs endpoint is mocked; optional callers handle unrelated webhooks. */
export function mockAccessJwks(otherFetch?: typeof fetch) {
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === CERTS_URL) {
      return new Response(JSON.stringify({ keys: [await publicJwk] }), { headers: { 'content-type': 'application/json' } });
    }
    if (otherFetch) return otherFetch(input, init);
    throw new Error(`Unexpected fetch in admin test: ${url}`);
  });
}

export function adminCall(t: ReturnType<typeof setup>, token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return t.call(method, new URL(path, ADMIN_ORIGIN).href, body, { 'cf-access-jwt-assertion': token, ...headers });
}
