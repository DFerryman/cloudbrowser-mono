
import { createTestD1 } from '@cloudbrowser/db/testing';
import engine from '@cloudbrowser/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.js';

const ORIGIN = 'http://app.test';

function setup() {
  const d1 = createTestD1();
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const engineEnv = { DB: d1, ENGINE_MODE: 'worker' as const, ENV_NAME: 'test', FAKE_DELAY_MS: '0' };
  const env = {
    DB: d1,
    APP_URL: ORIGIN,
    ENVIRONMENT: 'development',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret',
    ASSETS: { fetch: async () => new Response('<html>app</html>') },
    ENGINE: { fetch: (url: string, init?: RequestInit) => engine.fetch!(new Request(url, init) as never, engineEnv, ctx) },
  };
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          origin: ORIGIN,
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
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  return { d1, call, settle };
}

async function signIn(t: ReturnType<typeof setup>, email: string) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await t.call('POST', '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
  await t.settle();
  const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(email));
  log.mockRestore();
  if (!line) return null;
  const otp = line.match(/(\d{6})$/)![1];
  return t.call('POST', '/api/auth/sign-in/email-otp', { email, otp });
}

let t: ReturnType<typeof setup>;
beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('pilot@example.com')`);
});

describe('auth', () => {
  it('signs in an invited user with an email code', async () => {
    expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
    const res = await signIn(t, 'pilot@example.com');
    expect(res?.status).toBe(200);
    const me = await t.call('GET', '/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('pilot@example.com');
    expect(me.body.entitlements.maxBrowsers).toBe(2);
  });

  it('never sends a code to an address that was not invited', async () => {
    expect(await signIn(t, 'stranger@example.com')).toBeNull();
    const users = t.d1.sqlite.prepare('SELECT count(*) AS n FROM user').get() as { n: number };
    expect(users.n).toBe(0);
  });
});

describe('browsers', () => {
  beforeEach(async () => {
    await signIn(t, 'pilot@example.com');
  });

  it('refuses cross-origin writes', async () => {
    const res = await t.call('POST', '/api/v1/instances', { name: 'x', regionId: 'tyo1' }, { origin: 'https://evil.test', 'idempotency-key': 'k' });
    expect(res.status).toBe(403);
  });

  it('creates exactly one browser per Idempotency-Key and runs it', async () => {
    const body = { name: 'Work', regionId: 'tyo1' };
    expect((await t.call('POST', '/api/v1/instances', body)).body.type).toBe('idempotency_key_required');
    const a = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'k1' });
    const b = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'k1' });
    expect(a.status).toBe(202);
    expect(b.body).toEqual(a.body);
    await t.settle();

    const list = await t.call('GET', '/api/v1/instances');
    expect(list.body).toHaveLength(1);
    const inst = list.body[0];
    expect(inst.status).toBe('running');
    expect(inst.ipAddress).toMatch(/^203\.0\.113\./);
    expect(inst.lastIpCheck.ok).toBe(true);

    const op = await t.call('GET', `/api/v1/operations/${a.body.operationId}`);
    expect(op.body.status).toBe('succeeded');
  });

  it('enforces the plan limits', async () => {
    for (const k of ['a', 'b']) await t.call('POST', '/api/v1/instances', { name: k, regionId: 'usw1' }, { 'idempotency-key': k });
    await t.settle();
    const third = await t.call('POST', '/api/v1/instances', { name: 'c', regionId: 'usw1' }, { 'idempotency-key': 'c' });
    expect(third.status).toBe(403);
    expect(third.body.type).toBe('plan_limit');
  });

  it('opens, sleeps, wakes, changes IP, deletes and restores a browser', async () => {
    const created = await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1' }, { 'idempotency-key': 'c1' });
    await t.settle();
    const id = created.body.instanceId;

    const open = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    expect(open.status).toBe(201);
    const sid = open.body.session.id;
    expect((await t.call('GET', `/api/v1/sessions/${sid}/connect`)).body).toEqual({ mode: 'simulated' });
    const hb = await t.call('POST', `/api/v1/sessions/${sid}/heartbeat`, { input: true });
    expect(new Date(hb.body.sleepAt).getTime()).toBeGreaterThan(Date.now());

    // A second tab takes over; the first sees "open elsewhere".
    const other = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    expect((await t.call('POST', `/api/v1/sessions/${sid}/heartbeat`, { input: false })).status).toBe(409);
    expect(other.status).toBe(201);

    expect((await t.call('POST', `/api/v1/instances/${id}/stop`, undefined, { 'idempotency-key': 's1' })).status).toBe(202);
    await t.settle();
    let inst = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(inst.status).toBe('sleeping');
    const ip = inst.ipAddress;

    const wake = await t.call('POST', `/api/v1/instances/${id}/sessions`);
    expect(wake.body.operationId).toBeTruthy();
    await t.settle();
    inst = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(inst.status).toBe('running');
    expect(inst.ipAddress).toBe(ip);

    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { regionId: 'usw1' })).status).toBe(400);
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { idleTimeoutS: 3600 })).body.type).toBe('plan_limit');
    expect((await t.call('PATCH', `/api/v1/instances/${id}`, { name: 'Renamed', idleTimeoutS: 900 })).body.name).toBe('Renamed');

    expect((await t.call('POST', `/api/v1/instances/${id}/ip-change-requests`, {}, { 'idempotency-key': 'ip0' })).status).toBe(400);
    expect((await t.call('POST', `/api/v1/instances/${id}/ip-change-requests`, { confirm: true }, { 'idempotency-key': 'ip1' })).status).toBe(202);
    await t.settle();
    const limited = await t.call('POST', `/api/v1/instances/${id}/ip-change-requests`, { confirm: true }, { 'idempotency-key': 'ip2' });
    expect(limited.body.type).toBe('ip_change_limit');

    expect((await t.call('DELETE', `/api/v1/instances/${id}`, undefined, { 'idempotency-key': 'd1' })).status).toBe(202);
    await t.settle();
    inst = (await t.call('GET', `/api/v1/instances/${id}`)).body;
    expect(inst.status).toBe('deleting');
    expect(inst.purgeAfter).toBeTruthy();

    expect((await t.call('POST', `/api/v1/instances/${id}/undelete`, undefined, { 'idempotency-key': 'u1' })).status).toBe(202);
    await t.settle();
    expect((await t.call('GET', `/api/v1/instances/${id}`)).body.status).toBe('sleeping');
  });

  it('serves the OpenAPI document', async () => {
    const doc = await t.call('GET', '/api/v1/openapi.json');
    expect(doc.status).toBe(200);
    expect(Object.keys(doc.body.paths)).toContain('/api/v1/instances/{id}/ip-change-requests');
  });
});

