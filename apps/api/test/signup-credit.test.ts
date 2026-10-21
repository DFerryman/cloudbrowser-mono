import { createTestD1 } from '@cloudbrowser/db/testing';
import { beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import { accessToken, adminCall, configureAdmin, mockAccessJwks, prepareAdminKeys } from './admin-helpers.js';
import { registrationToken, setup, signIn } from './helpers.js';

const setCredit = (t: ReturnType<typeof setup>, cents: number) => t.d1.sqlite.prepare("UPDATE caps SET `limit`=? WHERE scope='user:default' AND metric='signup_credit_cents'").run(cents);
const awards = (t: ReturnType<typeof setup>) => t.d1.sqlite.prepare("SELECT kind, amount_micros, reference, applied_at FROM balance_transactions WHERE kind='signup'").all();
async function register(t: ReturnType<typeof setup>, email = 'new@example.com') {
  expect((await t.call('POST', '/api/auth/sign-up/start', { email })).status).toBe(200);
  await t.settle();
  const token = registrationToken(t.emails.at(-1)!.text)!;
  expect(token).toBeTruthy();
  return { token, finish: () => t.call('POST', '/api/auth/sign-up/complete', { token }) };
}

describe('signup credit', () => {
  it('seeds a $2 default and removes the old trial configuration', () => {
    const d1 = createTestD1();
    expect(d1.sqlite.prepare("SELECT `limit` FROM caps WHERE scope='user:default' AND metric='signup_credit_cents'").get()).toEqual({ limit: 200 });
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM caps WHERE metric='trial_minutes'").get()).toEqual({ n: 0 });
  });

  it('awards the verified registration exactly once; resending, replaying and signing in do not award again', async () => {
    const t = setup({ signupCreditCents: 200 });
    const signup = await register(t);
    expect(awards(t)).toHaveLength(0); // Sending a link is not registration.
    expect((await signup.finish()).status).toBe(200);
    const state = await t.call('GET', '/api/v1/billing');
    expect(state.body).toMatchObject({ balanceMicros: 2_000_000, availableMicros: 2_000_000 });
    expect(state.body).not.toHaveProperty('trial');
    expect(awards(t)).toEqual([expect.objectContaining({ kind: 'signup', amount_micros: 2_000_000, applied_at: expect.any(Number) })]);
    const tx = (await t.call('GET', '/api/v1/billing/transactions')).body;
    expect(JSON.stringify(tx)).toContain('Signup credit');
    await t.call('POST', '/api/auth/sign-out', {});
    expect((await signup.finish()).status).not.toBe(200);
    setCredit(t, 500);
    await signIn(t, 'new@example.com');
    expect((await t.call('GET', '/api/v1/billing')).body.balanceMicros).toBe(2_000_000);
    expect(awards(t)).toHaveLength(1);
  });

  it('uses the configured amount at completion and permits a fractional dollar award', async () => {
    const t = setup({ signupCreditCents: 200 });
    const signup = await register(t);
    setCredit(t, 325);
    expect((await signup.finish()).status).toBe(200);
    expect((await t.call('GET', '/api/v1/billing')).body.balanceMicros).toBe(3_250_000);
    expect((await t.call('GET', '/api/public/pricing')).body.signupCreditMicros).toBe(3_250_000);
  });

  it('awards nothing at zero and never grants retroactively when re-enabled', async () => {
    const t = setup({ signupCreditCents: 0 });
    const signup = await register(t);
    expect((await signup.finish()).status).toBe(200);
    expect((await t.call('GET', '/api/v1/billing')).body.balanceMicros).toBe(0);
    expect((await t.call('GET', '/api/public/pricing')).body.signupCreditMicros).toBe(0);
    expect(awards(t)).toHaveLength(0);
    setCredit(t, 200);
    await t.call('POST', '/api/auth/sign-out', {});
    await signIn(t, 'new@example.com');
    expect((await t.call('GET', '/api/v1/billing')).body.balanceMicros).toBe(0);
    expect(awards(t)).toHaveLength(0);
  });

  it('rolls the account back if the credit ledger cannot be written, then safely retries', () => {
    const d1 = createTestD1();
    d1.sqlite.exec("CREATE TRIGGER signup_fault BEFORE INSERT ON balance_transactions WHEN NEW.kind='signup' BEGIN SELECT RAISE(ABORT,'ledger unavailable'); END;");
    const insert = () => d1.sqlite.exec("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('atomic','A','atomic@example.com',1,0,0)");
    expect(insert).toThrow('ledger unavailable');
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM user WHERE id='atomic'").get()).toEqual({ n: 0 });
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM billing_accounts WHERE user_id='atomic'").get()).toEqual({ n: 0 });
    d1.sqlite.exec('DROP TRIGGER signup_fault');
    insert();
    expect(d1.sqlite.prepare("SELECT balance_micros AS balance FROM billing_accounts WHERE user_id='atomic'").get()).toEqual({ balance: 2_000_000 });
    expect(insert).toThrow();
    expect(d1.sqlite.prepare("SELECT balance_micros AS balance FROM billing_accounts WHERE user_id='atomic'").get()).toEqual({ balance: 2_000_000 });
  });

  it('uses award credit for regular browsers outside Sydney and rejects the removed trial request', async () => {
    const t = setup({ signupCreditCents: 500 });
    const signup = await register(t);
    await signup.finish();
    t.d1.sqlite.exec("UPDATE control_flags SET value='true' WHERE key='billing_required'");
    const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
    const body = { name: 'First browser', regionId: 'tyo1', storageGb: 10, priceVersion: price.version };
    expect((await t.call('POST', '/api/v1/instances', { ...body, trial: true }, { 'idempotency-key': 'obsolete-trial' })).status).toBe(400);
    const created = await t.call('POST', '/api/v1/instances', body, { 'idempotency-key': 'regular' });
    expect(created.status).toBe(202);
    await t.settle();
    const instance = (await t.call('GET', `/api/v1/instances/${created.body.instanceId}`)).body;
    expect(instance).toMatchObject({ regionId: 'tyo1', storageGb: 10 });
    expect(instance).not.toHaveProperty('trial');
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM browser_reservations').get()).toEqual({ n: 1 });
  });
});

describe('admin signup credit setting', () => {
  beforeAll(prepareAdminKeys);
  afterEach(() => vi.unstubAllGlobals());
  it('allows zero and whole cents globally, audits the change, and rejects invalid scope or amounts', async () => {
    const t = setup();
    configureAdmin(t); mockAccessJwks();
    const token = await accessToken();
    const put = (scope: string, limit: number, metric = 'signup_credit_cents') => adminCall(t, token, 'PUT', '/api/v1/admin/caps', { scope, metric, limit });
    expect((await put('user:default', 325)).status).toBe(200);
    expect((await t.call('GET', '/api/public/pricing')).body.signupCreditMicros).toBe(3_250_000);
    expect((await put('user:default', 0)).status).toBe(200);
    expect((await t.call('GET', '/api/public/pricing')).body.signupCreditMicros).toBe(0);
    for (const [scope, amount] of [['user:default', -1], ['user:default', 1.5], ['user:default', 100001], ['user:someone', 200], ['global', 200]] as const) expect((await put(scope, amount)).status).toBe(400);
    expect((await put('user:default', 30, 'trial_minutes')).status).toBe(400);
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action='cap.set' AND target='cap:user:default/signup_credit_cents'").get()).toEqual({ n: 2 });
  });
});
