import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registrationToken, setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let ip = 0;
/** Each call from its own address, so the per-IP limiter does not interfere. */
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  t.call('POST', `/api/auth${path}`, body, { 'cf-connecting-ip': `192.0.2.${++ip % 250}`, ...headers });
const sentTo = async (email: string) => {
  await t.settle();
  return t.emails.filter((m) => m.to === email);
};
const users = () => (t.d1.sqlite.prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n;

async function signOut() {
  await post('/sign-out', {});
  expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
}

function addPasskey(email: string) {
  const { id } = t.d1.sqlite.prepare('SELECT id FROM user WHERE email = ?').get(email) as { id: string };
  t.d1.sqlite
    .prepare("INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up, created_at) VALUES ('pk1', 'x', ?, 'cred1', 0, 'multiDevice', 1, ?)")
    .run(id, Date.now());
}

beforeEach(() => {
  t = setup();
});
afterEach(() => vi.unstubAllGlobals());

describe('sign-up by registration link', () => {
  it('emails a single-use link that creates the account and signs in', async () => {
    expect((await post('/sign-in/magic-link', { email: 'New@Example.com' })).status).toBe(200);
    const [mail] = await sentTo('new@example.com');
    expect(mail?.subject).toBe('Create your Nevazu account');
    const token = registrationToken(mail!.text)!;
    expect(token).toBeTruthy();
    expect(users()).toBe(0);

    const done = await post('/sign-up/complete', { token });
    expect(done.status).toBe(200);
    expect((await t.call('GET', '/api/v1/me')).body.user.email).toBe('new@example.com');
    await signOut();
    expect((await post('/sign-up/complete', { token })).body.code).toBe('INVALID_TOKEN');
    expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
  });

  it('sends a sign-in code for an existing address submitted on the sign-up form', async () => {
    await signIn(t, 'pilot@example.com');
    await signOut();
    const beforeUsers = users();
    const beforeMail = t.emails.length;
    expect((await post('/sign-up/start', { email: 'PILOT@Example.com' })).body).toEqual({ method: 'code' });
    const mail = (await sentTo('pilot@example.com')).slice(-1)[0]!;
    expect(t.emails.length).toBe(beforeMail + 1);
    expect(mail.subject).toMatch(/sign-in code: \d{6}$/);
    expect(registrationToken(mail.text)).toBeNull();
    expect(users()).toBe(beforeUsers);
    expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
    const otp = mail.text.match(/(\d{6})/)![1];
    expect((await post('/sign-in/email-otp', { email: 'pilot@example.com', otp })).status).toBe(200);
  });

  it('sends a registration link for a new address submitted on the sign-up form', async () => {
    expect((await post('/sign-up/start', { email: 'fresh@example.com' })).body).toEqual({ method: 'registration' });
    const [mail] = await sentTo('fresh@example.com');
    expect(mail?.subject).toBe('Create your Nevazu account');
    expect(registrationToken(mail!.text)).toBeTruthy();
    expect(users()).toBe(0);
  });

  it('validates and checks the origin of sign-up starts', async () => {
    expect((await post('/sign-up/start', { email: 'bad' })).status).toBe(400);
    expect((await post('/sign-up/start', { email: 'a@example.com' }, { origin: 'https://evil.test' })).status).toBe(403);
  });

  it('never sends a sign-in link to an existing account, only a pointer to sign-in', async () => {
    await signIn(t, 'pilot@example.com');
    await signOut();
    const before = t.emails.length;
    expect((await post('/sign-in/magic-link', { email: 'pilot@example.com' })).status).toBe(200);
    const mail = (await sentTo('pilot@example.com')).slice(-1)[0]!;
    expect(t.emails.length).toBe(before + 1);
    expect(mail.subject).toBe('You already have a Nevazu account');
    expect(registrationToken(mail.text)).toBeNull();
  });

  it('sends nothing to an address that was not invited while invite only is on', async () => {
    t.d1.sqlite.exec("UPDATE control_flags SET value = 'true' WHERE key = 'invite_only'");
    expect((await post('/sign-in/magic-link', { email: 'stranger@example.com' })).status).toBe(200);
    expect(await sentTo('stranger@example.com')).toHaveLength(0);
    t.d1.sqlite.exec("INSERT INTO invites (email) VALUES ('stranger@example.com')");
    expect(await signIn(t, 'stranger@example.com')).toMatchObject({ status: 200 });
    expect(users()).toBe(1);
  });
});

describe('sign-in', () => {
  it('no longer creates accounts from an email code', async () => {
    expect((await post('/email-otp/send-verification-otp', { email: 'nobody@example.com', type: 'sign-in' })).status).toBe(200);
    expect(await sentTo('nobody@example.com')).toHaveLength(0);
    expect(users()).toBe(0);
  });

  it('directs an unknown sign-in address to registration without sending any email', async () => {
    const res = await post('/sign-in/start', { email: 'fresh@example.com' });
    expect(res.body).toEqual({ method: 'register' });
    expect(await sentTo('fresh@example.com')).toHaveLength(0);
    expect(users()).toBe(0);
  });

  it('emails a code to an account without a passkey', async () => {
    await signIn(t, 'pilot@example.com');
    await signOut();
    expect((await post('/sign-in/start', { email: 'pilot@example.com' })).body).toEqual({ method: 'code' });
    expect((await sentTo('pilot@example.com')).slice(-1)[0]!.subject).toMatch(/sign-in code: \d{6}$/);
  });

  it('offers the passkey first, and still signs in with an email code', async () => {
    await signIn(t, 'pilot@example.com');
    addPasskey('pilot@example.com');
    await signOut();
    const before = t.emails.length;
    expect((await post('/sign-in/start', { email: 'pilot@example.com' })).body).toEqual({ method: 'passkey' });
    await t.settle();
    expect(t.emails.length).toBe(before);
    // "Email me a code instead"
    expect((await post('/email-otp/send-verification-otp', { email: 'pilot@example.com', type: 'sign-in' })).status).toBe(200);
    const otp = (await sentTo('pilot@example.com')).slice(-1)[0]!.text.match(/(\d{6})/)![1];
    expect((await post('/sign-in/email-otp', { email: 'pilot@example.com', otp })).status).toBe(200);
    expect((await t.call('GET', '/api/v1/me')).status).toBe(200);
  });

  it('rejects malformed addresses and cross-origin starts', async () => {
    expect((await post('/sign-in/start', { email: 'not-an-email' })).status).toBe(400);
    expect((await post('/sign-in/start', { email: 'a@example.com' }, { origin: 'https://evil.test' })).status).toBe(403);
  });
});

describe('Cloudflare Turnstile', () => {
  beforeEach(() => {
    Object.assign(t.env, { TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { response } = JSON.parse(String(init.body)) as { response: string };
      return Response.json({ success: response === 'good', hostname: 'app.test' });
    });
  });

  it('publishes the site key and guards every request that sends an email', async () => {
    expect((await t.call('GET', '/api/auth/sign-in/options')).body).toEqual({ turnstileSiteKey: 'site' });
    for (const [path, body] of [
      ['/sign-up/start', { email: 'a@example.com' }],
      ['/sign-in/start', { email: 'a@example.com' }],
      ['/sign-in/magic-link', { email: 'a@example.com' }],
      ['/email-otp/send-verification-otp', { email: 'a@example.com', type: 'sign-in' }],
    ] as const) {
      expect((await post(path, body)).body.code).toBe('CAPTCHA_FAILED');
      expect((await post(path, body, { 'cf-turnstile-response': 'bad' })).status).toBe(403);
      expect((await post(path, body, { 'cf-turnstile-response': 'good' })).status).toBe(200);
    }
    expect(await sentTo('a@example.com')).toHaveLength(2);
  });
});
