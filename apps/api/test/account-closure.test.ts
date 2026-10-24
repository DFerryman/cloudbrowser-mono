import { createDb } from '@cloudbrowser/db';
import engine from '@cloudbrowser/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { applyBalance } from '../src/billing/ledger.js';
import { closureSweep, erasedEmail, refundPlan } from '../src/closure.js';
import { sendToUser } from '../src/notifications/send.js';
import { accessToken, adminCall, configureAdmin, mockAccessJwks } from './admin-helpers.js';
import { setup, signIn } from './helpers.js';

/**
 * Closing an account (Terms sections 8 and 9): confirmed with an email code, it signs the user out
 * everywhere and deletes every browser at once; the unused paid credit is fixed once the browsers
 * are purged and refunded by an operator; then the personal data is erased and billing records and
 * Terms acceptances stay.
 */
const SECRET = 'whsec_test';
const EMAIL = 'leaver@example.com';
const DAY = 86_400_000;

let t: ReturnType<typeof setup>;
let userId: string;
const db = () => createDb(t.d1 as never);
const rows = (q: string, ...params: unknown[]) => t.d1.sqlite.prepare(q).all(...(params as never[])) as Record<string, unknown>[];
const closure = () => rows('SELECT * FROM account_closures WHERE user_id = ?', userId)[0];

/** A paid top-up as the Creem webhook credits it: `net` credit in cents, plus `tax`. */
async function paid(orderId: string, net: number, tax: number, at = new Date()) {
  await applyBalance(db(), { userId, kind: 'topup', amountMicros: net * 10_000, orderId, grossAmountCents: net + tax, currency: 'USD', reference: `order:${orderId}`, description: 'Credit', actor: 'creem' }, at);
}
const credit = (kind: 'promotion' | 'adjustment', cents: number, reference: string) =>
  applyBalance(db(), { userId, kind, amountMicros: cents * 10_000, reference, actor: 'test' }, new Date());

async function sign(raw: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Creem reports a refund an operator made in its dashboard. */
async function refundWebhook(id: string, orderId: string, cents: number) {
  const raw = JSON.stringify({ id: `evt_${id}`, eventType: 'refund.created', created_at: Date.now(), object: { id, refund_amount: cents, refund_currency: 'USD', status: 'succeeded', order: { id: orderId } } });
  const res = await worker.fetch(new Request('http://app.test/api/webhooks/creem', { method: 'POST', headers: { 'creem-signature': await sign(raw) }, body: raw }), t.env as never, t.ctx);
  await t.settle();
  expect(res.status).toBe(200);
}

async function createBrowser(name: string) {
  const sheet = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
  const created = await t.call('POST', '/api/v1/instances', { name, regionId: 'tyo1', storageGb: 10, priceVersion: sheet.version }, { 'idempotency-key': `create-${name}` });
  expect(created.status).toBe(202);
  await t.settle();
  return created.body.instanceId as string;
}

/** Asks for a closure code and reads it from the email. */
async function code() {
  expect((await t.call('POST', '/api/v1/account/closure/code')).status).toBe(204);
  const sent = t.emails.filter((m) => m.to === EMAIL).pop()!;
  return sent.text.match(/account closure code is (\d{6})/)![1]!;
}
const close = (c: string, reason?: string) => t.call('POST', '/api/v1/account/closure', { code: c, confirm: true, ...(reason ? { reason } : {}) });

/** The reaper purges deleted browsers (every 15 minutes in production). */
const reaper = () => engine.scheduled!({ scheduledTime: Date.now(), cron: '*/15 * * * *', noRetry() {} } as never, { ...t.engineEnv, ENGINE_MODE: 'reaper' } as never, t.ctx);
const sweep = (at = new Date()) => closureSweep(t.env as never, db(), at);

beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('${EMAIL}')`);
  Object.assign(t.env, {
    CREEM_API_BASE: 'https://test-api.creem.io',
    CREEM_API_KEY: 'creem_test_key',
    CREEM_WEBHOOK_SECRET: SECRET,
    CREEM_TOPUP_PRODUCTS: 'prod_10',
    BILLING: { send: async (body: { eventId: string }) => worker.queue({ messages: [{ id: body.eventId, body, ack() {}, retry() {} }], queue: 'billing' } as never, t.env as never) },
  });
  await signIn(t, EMAIL);
  userId = (await t.call('GET', '/api/v1/me')).body.user.id;
});
afterEach(() => vi.unstubAllGlobals());

describe('the refund of unused credit', () => {
  it('is the unused paid credit, newest order first, with its share of the tax; other credit counts as spent first', async () => {
    await paid('ord_sep', 1000, 200, new Date(Date.UTC(2026, 8, 1)));
    await paid('ord_oct', 2000, 400, new Date(Date.UTC(2026, 9, 1)));
    await credit('promotion', 200, 'promotion:welcome');
    await credit('adjustment', -700, 'usage');
    // Balance $25 of $32 credited: the $2 promotion and $5 of September's order were spent.
    expect(await refundPlan(db(), userId)).toEqual({
      balanceMicros: 25_000_000, refundMicros: 25_000_000, forfeitMicros: 0,
      plan: [
        { orderId: 'ord_oct', provider: 'creem', creditMicros: 20_000_000, refundCents: 2400, currency: 'USD' },
        { orderId: 'ord_sep', provider: 'creem', creditMicros: 5_000_000, refundCents: 600, currency: 'USD' },
      ],
    });
  });

  it('leaves out credit already refunded, and never refunds promotional credit', async () => {
    await paid('ord_1', 1000, 100);
    await credit('promotion', 300, 'promotion:task');
    await refundWebhook('ref_early', 'ord_1', 550); // half the order, tax included
    expect(await refundPlan(db(), userId)).toMatchObject({ balanceMicros: 8_000_000, refundMicros: 5_000_000, forfeitMicros: 3_000_000, plan: [{ orderId: 'ord_1', creditMicros: 5_000_000, refundCents: 550 }] });
    const preview = (await t.call('GET', '/api/v1/account/closure')).body;
    expect(preview).toEqual({ blocker: null, browsers: [], balanceMicros: 8_000_000, refundMicros: 5_000_000, forfeitMicros: 3_000_000 });
  });
});

describe('closing an account', () => {
  it('needs the emailed code: a wrong one counts, and the fifth wrong one ends it', async () => {
    expect(await close('123456')).toMatchObject({ status: 400, body: { type: 'invalid_code' } });
    const right = await code();
    expect(t.emails.at(-1)).toMatchObject({ to: EMAIL, subject: `Your Nevazu account closure code: ${right}` });
    // One code a minute.
    expect((await t.call('POST', '/api/v1/account/closure/code')).status).toBe(429);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect((await close(wrong)).body.detail).toContain('not right');
    expect((await close(wrong)).body.detail).toContain('Too many');
    expect(await close(right)).toMatchObject({ status: 400, body: { type: 'invalid_code' } });
    expect(closure()).toBeUndefined();
    expect((await t.call('GET', '/api/v1/me')).status).toBe(200);
    // Without ticking the box, nothing happens either.
    expect((await t.call('POST', '/api/v1/account/closure', { code: right })).status).toBe(400);
  });

  it('signs out everywhere, deletes every browser and refuses sign-in, at once', async () => {
    const a = await createBrowser('Shopping');
    const b = await createBrowser('Work');
    t.d1.sqlite.prepare(`INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up) VALUES ('pk1', 'k', ?, 'c', 0, 'singleDevice', 0)`).run(userId);
    const other = t.cookie();
    await signIn(t, EMAIL); // a second device
    expect(rows('SELECT id FROM session WHERE user_id = ?', userId)).toHaveLength(2);
    const preview = (await t.call('GET', '/api/v1/account/closure')).body;
    expect(preview.browsers.map((x: { name: string }) => x.name)).toEqual(['Shopping', 'Work']);

    const res = await close(await code(), 'terms');
    expect(res).toMatchObject({ status: 200, body: { browsers: 2, refundMicros: 0 } });
    await t.settle();
    expect(closure()).toMatchObject({ status: 'closing', reason: 'terms', browsers: 2 });
    expect(rows('SELECT id FROM session WHERE user_id = ?', userId)).toHaveLength(0);
    expect(rows('SELECT id FROM passkey WHERE user_id = ?', userId)).toHaveLength(0);
    for (const cookie of [t.cookie(), other]) {
      t.setCookie(cookie);
      expect((await t.call('GET', '/api/v1/me')).status).toBe(401);
    }
    expect(rows('SELECT id, status, desired_state FROM browser_instances ORDER BY name')).toEqual([
      { id: a, status: 'deleting', desired_state: 'deleted' },
      { id: b, status: 'deleting', desired_state: 'deleted' },
    ]);
    expect(rows(`SELECT action FROM audit_log WHERE action = 'account.closure_requested'`)).toHaveLength(1);
    expect(t.emails.at(-1)).toMatchObject({ to: EMAIL, subject: 'Your Nevazu account is closed' });

    // The address cannot sign in, and no code is sent to it.
    const sent = t.emails.length;
    expect((await t.call('POST', '/api/auth/sign-in/check', { email: EMAIL })).body).toEqual({ method: 'closed' });
    expect((await t.call('POST', '/api/auth/sign-up/start', { email: EMAIL })).body).toEqual({ method: 'closed' });
    await t.call('POST', '/api/auth/email-otp/send-verification-otp', { email: EMAIL, type: 'sign-in' });
    await t.settle();
    expect(t.emails.length).toBe(sent);
    // Whatever path tries, no session can be created for the account.
    expect(() => t.d1.sqlite.prepare(`INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('s', 0, 't', 0, 0, ?)`).run(userId)).toThrow(/account_closed/);
    // And it gets no other email.
    expect(await sendToUser(t.env as never, db(), userId, { subject: 'Low balance', text: 'x' })).toBe(false);
  });

  it('fixes the refund once every browser is purged, then erases the data when the refund webhooks arrive', async () => {
    await paid('ord_sep', 1000, 200, new Date(Date.UTC(2026, 8, 1)));
    await paid('ord_oct', 2000, 400, new Date(Date.UTC(2026, 9, 1)));
    await credit('promotion', 200, 'promotion:welcome');
    await credit('adjustment', -700, 'usage');
    t.d1.sqlite.exec(`INSERT INTO terms_versions (version, sha256, document, recorded_at) VALUES ('2026-10-24.2', 'x', '{}', 0)`);
    t.d1.sqlite.prepare(`INSERT INTO terms_acceptances (id, user_id, terms_version, context, ip, accepted_at) VALUES ('ta1', ?, '2026-10-24.2', 'checkout', '203.0.113.7', 0)`).run(userId);
    const id = await createBrowser('Private');
    expect((await close(await code())).body).toEqual({ browsers: 1, refundMicros: 25_000_000 });
    await t.settle();

    // Still deleting: nothing is fixed yet.
    await sweep();
    expect(closure()).toMatchObject({ status: 'closing', refund_micros: null });
    await reaper();
    expect(rows('SELECT status FROM browser_instances WHERE id = ?', id)).toEqual([{ status: 'purged' }]);
    await sweep();
    expect(closure()).toMatchObject({ status: 'refund_due', refund_micros: 25_000_000 });
    expect(JSON.parse(String(closure()!.refund_plan))).toEqual([
      { orderId: 'ord_oct', provider: 'creem', creditMicros: 20_000_000, refundCents: 2400, currency: 'USD' },
      { orderId: 'ord_sep', provider: 'creem', creditMicros: 5_000_000, refundCents: 600, currency: 'USD' },
    ]);
    expect(rows(`SELECT severity, title FROM alerts WHERE dedupe_key = ?`, `closure-refund:${userId}`)).toEqual([
      expect.objectContaining({ severity: 'warning', title: expect.stringContaining('$25.00 on 2 orders') }),
    ]);

    // The operator refunds both orders in Creem; one webhook alone is not enough.
    await refundWebhook('ref_oct', 'ord_oct', 2400);
    await sweep();
    expect(closure()).toMatchObject({ status: 'refund_due', erased_at: null });
    await refundWebhook('ref_sep', 'ord_sep', 600);
    await sweep();
    expect(closure()).toMatchObject({ status: 'closed', refund_recorded_by: 'webhook', erased_at: expect.any(Number), closed_at: expect.any(Number) });

    // Erased: the address, the name, the browser's name; the address gets one last email.
    expect(t.emails.at(-1)).toMatchObject({ to: EMAIL, subject: 'Your Nevazu account data has been erased' });
    expect(t.emails.at(-1)!.text).toContain('Your refund of $25.00 has been made');
    expect(rows('SELECT email, name FROM user WHERE id = ?', userId)).toEqual([{ email: erasedEmail(userId), name: 'Closed account' }]);
    expect(rows('SELECT name FROM browser_instances WHERE id = ?', id)).toEqual([{ name: 'Deleted browser' }]);
    expect(rows('SELECT id FROM viewer_sessions WHERE user_id = ?', userId)).toHaveLength(0);
    expect(rows('SELECT email FROM invites WHERE email = ?', EMAIL)).toHaveLength(0);
    // Kept: billing records, with a zero balance, and the Terms acceptance.
    expect(rows('SELECT balance_micros FROM billing_accounts WHERE user_id = ?', userId)).toEqual([{ balance_micros: 0 }]);
    expect(rows(`SELECT kind FROM balance_transactions WHERE user_id = ? ORDER BY created_at, id`, userId).map((r) => r.kind)).toEqual(expect.arrayContaining(['topup', 'topup', 'promotion', 'refund', 'refund']));
    expect(rows('SELECT ip FROM terms_acceptances WHERE user_id = ?', userId)).toEqual([{ ip: '203.0.113.7' }]);

    // The address is free again: signing up makes a new, empty account.
    t.setCookie('');
    t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('${EMAIL}')`);
    await signIn(t, EMAIL);
    const fresh = (await t.call('GET', '/api/v1/me')).body.user;
    expect(fresh).toMatchObject({ email: EMAIL });
    expect(fresh.id).not.toBe(userId);
  });

  it('closes at once when no paid credit is left, writing off the rest', async () => {
    await credit('promotion', 300, 'promotion:task');
    expect((await close(await code())).body).toEqual({ browsers: 0, refundMicros: 0 });
    await sweep();
    expect(closure()).toMatchObject({ status: 'closed', refund_micros: 0, refund_recorded_by: null, erased_at: expect.any(Number) });
    expect(rows('SELECT balance_micros FROM billing_accounts WHERE user_id = ?', userId)).toEqual([{ balance_micros: 0 }]);
    expect(rows(`SELECT amount_micros, description FROM balance_transactions WHERE reference = ?`, `closure:${userId}`)).toEqual([{ amount_micros: -3_000_000, description: 'Account closed: credit not refunded' }]);
    expect(t.emails.at(-1)!.text).toContain('There was no unused paid credit to refund');
  });

  it('warns operators of a refund still owed, erases the data after 30 days anyway, and takes a refund made another way', async () => {
    await paid('ord_1', 1000, 0);
    await close(await code());
    const requested = Number(closure()!.requested_at);
    await sweep();
    expect(closure()).toMatchObject({ status: 'refund_due', refund_micros: 10_000_000 });
    await sweep(new Date(requested + 21 * DAY));
    expect(rows('SELECT severity FROM alerts WHERE dedupe_key = ?', `closure-refund-overdue:${userId}`)).toEqual([{ severity: 'critical' }]);
    await sweep(new Date(requested + 29 * DAY));
    expect(closure()!.erased_at).toBeNull();
    await sweep(new Date(requested + 30 * DAY));
    expect(closure()).toMatchObject({ status: 'refund_due', erased_at: expect.any(Number) });
    expect(t.emails.at(-1)!.text).toContain('still being processed');
    expect(rows('SELECT email FROM user WHERE id = ?', userId)).toEqual([{ email: erasedEmail(userId) }]);

    // The operator paid it by bank transfer and records it in the console.
    configureAdmin(t);
    mockAccessJwks();
    const token = await accessToken();
    const listed = await adminCall(t, token, 'GET', '/api/v1/admin/closures');
    expect(listed.body).toEqual([expect.objectContaining({ userId, status: 'refund_due', email: null, refundMicros: 10_000_000 })]);
    expect((await adminCall(t, token, 'POST', `/api/v1/admin/closures/${userId}/refund-recorded`, { reason: 'Paid by bank transfer' })).status).toBe(200);
    expect(closure()).toMatchObject({ status: 'closed', refund_recorded_by: expect.stringMatching(/^admin:/) });
    expect(rows('SELECT balance_micros FROM billing_accounts WHERE user_id = ?', userId)).toEqual([{ balance_micros: 0 }]);
    expect((await adminCall(t, token, 'POST', `/api/v1/admin/closures/${userId}/refund-recorded`, { reason: 'again' })).status).toBe(409);
  });

  it('is refused during a dispute hold, with a suspended browser, and for operators', async () => {
    const id = await createBrowser('Held');
    t.d1.sqlite.prepare('UPDATE browser_instances SET suspended_at = ?, suspended_reason = ? WHERE id = ?').run(Date.now(), 'abuse report', id);
    expect((await t.call('GET', '/api/v1/account/closure')).body.blocker).toBe('suspended');
    expect(await t.call('POST', '/api/v1/account/closure/code')).toMatchObject({ status: 409, body: { type: 'suspended' } });
    t.d1.sqlite.prepare('UPDATE browser_instances SET suspended_at = NULL WHERE id = ?').run(id);
    const c = await code();
    t.d1.sqlite.prepare('INSERT INTO billing_accounts (user_id, balance_micros, frozen_at, updated_at) VALUES (?, 0, ?, 0)').run(userId, Date.now());
    expect(await close(c)).toMatchObject({ status: 409, body: { type: 'account_frozen' } });
    t.d1.sqlite.prepare('UPDATE billing_accounts SET frozen_at = NULL WHERE user_id = ?').run(userId);
    Object.assign(t.env, { ADMIN_EMAIL_ALLOWLIST: EMAIL });
    expect(await close(c)).toMatchObject({ status: 403, body: { type: 'forbidden' } });
    expect(closure()).toBeUndefined();
    expect(rows('SELECT status FROM browser_instances WHERE id = ?', id)).toEqual([{ status: 'running' }]);
  });
});
