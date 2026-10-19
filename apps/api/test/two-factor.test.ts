import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { beforeEach, describe, expect, it } from 'vitest';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let ip = 0;
const EMAIL = 'two@example.com';

/** Each call from its own address, so the per-IP limiter does not interfere (it has its own test). */
const auth = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  t.call('POST', `/api/auth${path}`, body, { 'cf-connecting-ip': `198.51.100.${++ip % 250}`, ...headers });

/** The current code for the secret in an otpauth:// URI, as an authenticator app computes it. */
async function codeFor(uri: string, offsetPeriods = 0) {
  const secret = new TextDecoder().decode(base32.decode(new URL(uri).searchParams.get('secret')!));
  if (!offsetPeriods) return createOTP(secret, { digits: 6, period: 30 }).totp();
  return createOTP(secret, { digits: 6, period: 30 }).hotp(Math.floor(Date.now() / 30_000) + offsetPeriods);
}
const wrong = async (uri: string) => String((Number(await codeFor(uri)) + 1) % 1_000_000).padStart(6, '0');

async function enable() {
  const setup2fa = await auth('/two-factor/enable');
  expect(setup2fa.status).toBe(200);
  expect(setup2fa.body.totpURI).toMatch(/^otpauth:\/\/totp\/Nevazu:two%40example\.com\?secret=[A-Z2-7]+/);
  expect(setup2fa.body.totpURI).toContain('issuer=Nevazu');
  expect(setup2fa.body.backupCodes).toHaveLength(10);
  expect((await auth('/two-factor/verify-totp', { code: await codeFor(setup2fa.body.totpURI) })).status).toBe(200);
  return setup2fa.body as { totpURI: string; backupCodes: string[] };
}

async function signOut() {
  await auth('/sign-out');
  expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
}

beforeEach(async () => {
  t = setup();
  // These tests sign in several times; only the second-factor budget per address is under test.
  const hits = new Map<string, number>();
  t.env.AUTH_LIMITER = { limit: async ({ key }: { key: string }) => {
    hits.set(key, (hits.get(key) ?? 0) + 1);
    return { success: !key.startsWith('2fa-ip:') || hits.get(key)! <= 5 };
  } };
  t.d1.sqlite.prepare('INSERT INTO invites (email) VALUES (?)').run(EMAIL);
  await signIn(t, EMAIL);
});

describe('two-factor sign-in with an authenticator app', () => {
  it('is only on once a first code is confirmed, then asks for a code after every email-code sign-in', async () => {
    const started = await auth('/two-factor/enable');
    expect((await t.call('GET', '/api/v1/me')).body.user.twoFactorEnabled).toBe(false);
    expect((await auth('/two-factor/verify-totp', { code: await wrong(started.body.totpURI) })).status).toBe(401);
    expect((await t.call('GET', '/api/v1/me')).body.user.twoFactorEnabled).toBe(false);
    expect((await auth('/two-factor/verify-totp', { code: await codeFor(started.body.totpURI) })).status).toBe(200);
    expect((await t.call('GET', '/api/v1/me')).body.user.twoFactorEnabled).toBe(true);

    await signOut();
    const first = await signIn(t, EMAIL);
    // The email code alone yields no session, only the challenge for the second factor.
    expect(first?.body).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
    expect((await t.call('GET', '/api/v1/instances')).status).toBe(401);
    expect((await auth('/two-factor/verify-totp', { code: await wrong(started.body.totpURI) })).status).toBe(401);
    expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
    expect((await auth('/two-factor/verify-totp', { code: await codeFor(started.body.totpURI) })).status).toBe(200);
    expect((await t.call('GET', '/api/v1/me')).body.user).toMatchObject({ email: EMAIL, twoFactorEnabled: true });
  });

  it('accepts the code of the previous 30-second period, for clock drift, but not older ones', async () => {
    const { totpURI } = await enable();
    await signOut();
    await signIn(t, EMAIL);
    expect((await auth('/two-factor/verify-totp', { code: await codeFor(totpURI, -3) })).status).toBe(401);
    expect((await auth('/two-factor/verify-totp', { code: await codeFor(totpURI, -1) })).status).toBe(200);
  });

  it('signs in with a one-time backup code instead, which cannot be used twice', async () => {
    const { backupCodes } = await enable();
    await signOut();
    await signIn(t, EMAIL);
    expect((await auth('/two-factor/verify-backup-code', { code: backupCodes[0] })).status).toBe(200);
    expect((await t.call('GET', '/api/v1/me')).status).toBe(200);
    await signOut();
    await signIn(t, EMAIL);
    expect((await auth('/two-factor/verify-backup-code', { code: backupCodes[0] })).status).toBe(401);
    expect((await auth('/two-factor/verify-backup-code', { code: backupCodes[1] })).status).toBe(200);
  });

  it('ends a sign-in challenge after five wrong codes', async () => {
    const { totpURI } = await enable();
    await signOut();
    await signIn(t, EMAIL);
    for (let i = 0; i < 5; i++) expect((await auth('/two-factor/verify-totp', { code: await wrong(totpURI) })).status).toBe(401);
    expect((await auth('/two-factor/verify-totp', { code: await codeFor(totpURI) })).status).not.toBe(200);
    expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
    // A fresh email-code sign-in starts a new challenge.
    await signIn(t, EMAIL);
    expect((await auth('/two-factor/verify-totp', { code: await codeFor(totpURI) })).status).toBe(200);
  });

  it('needs a current code to turn it off or to replace backup codes, and never reveals the secret again', async () => {
    const { totpURI, backupCodes } = await enable();
    expect((await auth('/two-factor/get-totp-uri')).status).toBe(404);
    expect((await auth('/two-factor/generate-backup-codes')).status).toBe(400);
    expect((await auth('/two-factor/generate-backup-codes', { code: backupCodes[0] })).status).toBe(400);
    const fresh = await auth('/two-factor/generate-backup-codes', { code: await codeFor(totpURI) });
    expect(fresh.status).toBe(200);
    expect(fresh.body.backupCodes).toHaveLength(10);
    expect(fresh.body.backupCodes).not.toContain(backupCodes[0]);

    expect((await auth('/two-factor/disable')).status).toBe(400);
    expect((await auth('/two-factor/disable', { code: await wrong(totpURI) })).status).toBe(400);
    expect((await auth('/two-factor/disable', { code: backupCodes[0] })).status).toBe(400); // replaced above
    expect((await t.call('GET', '/api/v1/me')).body.user.twoFactorEnabled).toBe(true);
    expect((await auth('/two-factor/disable', { code: await codeFor(totpURI) })).status).toBe(200);
    expect((await t.call('GET', '/api/v1/me')).body.user.twoFactorEnabled).toBe(false);
    await signOut();
    expect((await signIn(t, EMAIL))?.body.twoFactorRedirect).toBeUndefined();
    expect((await t.call('GET', '/api/v1/me')).status).toBe(200);
  });

  it('turns off with a backup code when the authenticator is lost', async () => {
    const { backupCodes } = await enable();
    await signOut();
    await signIn(t, EMAIL);
    expect((await auth('/two-factor/verify-backup-code', { code: backupCodes[0] })).status).toBe(200);
    expect((await auth('/two-factor/disable', { code: backupCodes[1] })).status).toBe(200);
    expect((await t.call('GET', '/api/v1/me')).body.user.twoFactorEnabled).toBe(false);
  });

  it('locks changes for 15 minutes after ten wrong codes', async () => {
    const { totpURI } = await enable();
    for (let i = 0; i < 10; i++) expect((await auth('/two-factor/disable', { code: await wrong(totpURI) })).status).toBe(400);
    expect((await auth('/two-factor/disable', { code: await codeFor(totpURI) })).status).toBe(429);
    t.d1.sqlite.prepare('UPDATE two_factor SET locked_until = ?').run(Date.now() - 1);
    expect((await auth('/two-factor/disable', { code: await codeFor(totpURI) })).status).toBe(200);
  });

  it('limits second-factor attempts per address', async () => {
    const { totpURI } = await enable();
    await signOut();
    await signIn(t, EMAIL);
    const same = { 'cf-connecting-ip': '203.0.113.50' };
    for (let i = 0; i < 5; i++) await t.call('POST', '/api/auth/two-factor/verify-totp', { code: '000000' }, same);
    expect((await t.call('POST', '/api/auth/two-factor/verify-totp', { code: await codeFor(totpURI) }, same)).status).toBe(429);
  });
});
