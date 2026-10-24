/** Shared setup: the api app with the engine in process and stand-ins for every binding. */

import { TERMS_VERSION, termsDocumentPath } from '@cloudbrowser/contracts';
import { createTestD1 } from '@cloudbrowser/db/testing';
import engine from '@cloudbrowser/engine';
import app from '../src/index.js';
import { termsDocument } from '../../web/src/content/terms-document.js';

export const ORIGIN = 'http://app.test';

/** What the fake executor's `prices` reports; the engine stores it per region (seeded here). */
export const SIMULATED_SHEET = {
  source: 'simulated',
  instanceType: 'fake.large',
  vmHour: 0.1,
  instanceTypes: { 'fake.large': 0.1 },
  volumeGbMonth: 0.08,
  snapshotGbMonth: 0.05,
  ipHour: 0.005,
  transferOutGb: 0.09,
  rootVolumeGb: 16,
  effectiveDate: null,
};

export function setup(opts: { prices?: boolean; signupCreditCents?: number } = {}) {
  const d1 = createTestD1();
  // Keep explicit-balance fixtures deterministic; registration tests opt into the production award.
  d1.sqlite.prepare("UPDATE caps SET `limit` = ? WHERE scope = 'user:default' AND metric = 'signup_credit_cents'").run(opts.signupCreditCents ?? 0);
  if (opts.prices !== false) {
    d1.sqlite.exec(
      `INSERT INTO provider_prices (region_id, executor, provider_region, sheet, fetched_at)
       SELECT id, executor, provider_region, '${JSON.stringify(SIMULATED_SHEET)}', ${Date.now()} FROM regions`,
    );
  }
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  // In-process stand-ins for the Cloudflare bindings.
  const emails: { to: string; subject?: string; text: string }[] = [];
  const hits = new Map<string, number>();
  const limiter = (max: number) => ({
    limit: async ({ key }: { key: string }) => {
      hits.set(key, (hits.get(key) ?? 0) + 1);
      return { success: hits.get(key)! <= max };
    },
  });
  const hub = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) };
  const queue = {
    send: async (body: { operationId: string }) => {
      const msg = { id: body.operationId, body, ack() {}, retry() {} };
      await engine.queue!({ messages: [msg], queue: 'ops' } as never, engineEnv as never, ctx);
    },
  };
  const engineEnv = { DB: d1, ENGINE_MODE: 'worker' as const, ENV_NAME: 'test', FAKE_DELAY_MS: '0', OPERATIONS: queue, EVENT_HUB: hub };
  const env = {
    DB: d1,
    APP_URL: ORIGIN,
    ENVIRONMENT: 'test',
    EMAIL: { send: async (m: { to: string; subject?: string; text: string }) => void emails.push(m) },
    OPERATIONS: queue,
    EVENT_HUB: hub,
    AUTH_LIMITER: limiter(5),
    API_LIMITER: limiter(60),
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret',
    // The built site: the app shell for every path, and the Terms document the build publishes.
    ASSETS: { fetch: async (req: Request) => (new URL(req.url).pathname === termsDocumentPath(TERMS_VERSION) ? new Response(termsDocument()) : new Response('<html>app</html>')) },
    ENGINE: { fetch: (url: string, init?: RequestInit) => engine.fetch!(new Request(url, init) as never, engineEnv, ctx) },
  };
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const url = new URL(path, ORIGIN);
    const res = await app.fetch(
      new Request(url, {
        method,
        headers: {
          origin: url.origin,
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      env as never,
      ctx,
    );
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: text ? (json ? JSON.parse(text) : text) : null };
  };
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  // Switch between signed-in users within one test.
  const getCookie = () => cookie;
  const setCookie = (v: string) => void (cookie = v);
  return { d1, call, settle, emails, env, engineEnv, ctx, cookie: getCookie, setCookie };
}

/**
 * Creates the test account through sign-up when needed, or signs an existing one in by email
 * code. Uses the sign-up entry point, which handles both cases. Null when nothing was sent.
 */
export async function signIn(t: ReturnType<typeof setup>, email: string) {
  const before = t.emails.length;
  await t.call('POST', '/api/auth/sign-up/start', { email });
  await t.settle();
  const sent = t.emails.slice(before).filter((m) => m.to === email).pop();
  if (!sent) return null;
  const token = registrationToken(sent.text);
  if (token) return t.call('POST', '/api/auth/sign-up/complete', { token });
  const otp = sent.text.match(/(\d{6})/)![1];
  return t.call('POST', '/api/auth/sign-in/email-otp', { email, otp });
}

/** The token in a registration email, if it is one. */
export function registrationToken(text: string) {
  const m = text.match(/\/sign-up\/complete\?token=([^\s]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
