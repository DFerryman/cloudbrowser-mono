import { createDb, raiseAlert } from '@cloudbrowser/db';
import { meterUsage } from '@cloudbrowser/engine';
import { SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverAlerts } from '../src/admin/alerts.js';
import {
  ACCESS_AUD,
  ACCESS_ISSUER,
  ADMIN_ACTOR,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  ADMIN_SUB,
  accessToken,
  adminCall,
  configureAdmin,
  mockAccessJwks,
  prepareAdminKeys,
} from './admin-helpers.js';
import { ORIGIN, setup, signIn } from './helpers.js';

const IP = { 'cf-connecting-ip': '203.0.113.9' };
let t: ReturnType<typeof setup>;
const quote = async (regionId = 'tyo1') => (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string; version: string }) => p.regionId === regionId).version as string;
let token: string;
const callAdmin = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => adminCall(t, token, method, path, body, headers);

beforeAll(prepareAdminKeys);
beforeEach(async () => {
  t = setup();
  configureAdmin(t);
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('user@example.com')`);
  mockAccessJwks();
  token = await accessToken();
});
afterEach(() => vi.unstubAllGlobals());

describe('admin access', () => {
  it('authenticates an Access operator without a main-site user, session, passkey or admin row', async () => {
    const session = await callAdmin('GET', '/api/v1/admin/session');
    expect(session.status).toBe(200);
    expect(session.body).toEqual({ email: ADMIN_EMAIL });
    const overview = await callAdmin('GET', '/api/v1/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ users: 0, operations: { unfinished: 0 }, alertsOpen: 0 });
    for (const table of ['user', 'session', 'admins', 'passkey', 'admin_step_ups']) {
      expect(t.d1.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('rejects missing assertions, a bare email header, and a main-site cookie', async () => {
    const url = `${ADMIN_ORIGIN}/api/v1/admin/session`;
    expect((await t.call('GET', url)).status).toBe(403);
    expect((await t.call('GET', url, undefined, { 'cf-access-authenticated-user-email': ADMIN_EMAIL })).status).toBe(403);
    t.d1.sqlite.prepare('INSERT INTO invites (email) VALUES (?)').run(ADMIN_EMAIL);
    await signIn(t, ADMIN_EMAIL);
    expect(t.cookie()).toBeTruthy();
    const mainSession = await t.call('GET', '/api/v1/me');
    expect(mainSession.status).toBe(200);
    // Even a legacy SQL administrator cannot reuse the main-site cookie for this host.
    t.d1.sqlite.prepare('INSERT INTO admins (user_id, created_at) VALUES (?, 0)').run(mainSession.body.user.id);
    expect((await t.call('GET', url)).status).toBe(403);
    expect((await callAdmin('GET', '/api/v1/admin/session')).status).toBe(200);
  });

  it('rejects forged signatures even when the email and other claims are valid', async () => {
    const [header, payload, signature] = token.split('.');
    const forged = `${header}.${payload}.${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
    expect((await adminCall(t, forged, 'GET', '/api/v1/admin/session')).status).toBe(403);
  });

  it('derives the operator identity only from the verified assertion', async () => {
    const session = await callAdmin('GET', '/api/v1/admin/session', undefined, { 'cf-access-authenticated-user-email': 'attacker@example.com' });
    expect(session.status).toBe(200);
    expect(session.body).toEqual({ email: ADMIN_EMAIL });
    const otherSubject = 'access-operator-456';
    const response = await adminCall(t, await accessToken({ sub: otherSubject }), 'PUT', '/api/v1/admin/flags/creation_freeze', { value: 'true', reason: 'identity check' });
    expect(response.status).toBe(200);
    const row = t.d1.sqlite.prepare(`SELECT actor, detail FROM audit_log WHERE action = 'flag.creation_freeze'`).get() as { actor: string; detail: string };
    expect(row.actor).toBe(`admin:cf-access:${otherSubject}`);
    expect(JSON.parse(row.detail)).toMatchObject({ email: ADMIN_EMAIL });
  });

  it.each([
    ['audience', () => ({ aud: ['different-app-aud'] })],
    ['issuer', () => ({ iss: 'https://attacker.cloudflareaccess.com' })],
    ['expired', () => ({ exp: Math.floor(Date.now() / 1000) - 1 })],
    ['not yet valid', () => ({ nbf: Math.floor(Date.now() / 1000) + 60 })],
    ['older than eight hours', () => ({ iat: Math.floor(Date.now() / 1000) - 8 * 60 * 60 - 1 })],
    ['service token type', () => ({ type: 'service' })],
    ['different email', () => ({ email: 'other@example.com' })],
    ['email suffix lookalike', () => ({ email: `${ADMIN_EMAIL}.attacker.example` })],
    ['missing subject', () => ({ sub: undefined })],
    ['empty subject', () => ({ sub: '' })],
    ['missing email', () => ({ email: undefined })],
    ['missing audience', () => ({ aud: undefined })],
    ['missing issuer', () => ({ iss: undefined })],
    ['missing expiry', () => ({ exp: undefined })],
    ['missing issued-at', () => ({ iat: undefined })],
    ['missing type', () => ({ type: undefined })],
  ])('rejects a signed token with %s', async (_name, claims) => {
    expect((await adminCall(t, await accessToken(claims()), 'GET', '/api/v1/admin/session')).status).toBe(403);
  });

  it('rejects an HMAC token with the same trusted claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongAlgorithm = await new SignJWT({ sub: ADMIN_SUB, email: ADMIN_EMAIL, type: 'app' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ACCESS_ISSUER)
      .setAudience(ACCESS_AUD)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode('test-access-hmac-key-not-an-rsa-key-1234'));
    expect((await adminCall(t, wrongAlgorithm, 'GET', '/api/v1/admin/session')).status).toBe(403);
  });

  it.each(['ACCESS_AUD', 'ACCESS_TEAM_DOMAIN', 'ADMIN_EMAIL_ALLOWLIST'])('fails closed without %s', async (key) => {
    Object.assign(t.env, { [key]: '' });
    expect((await callAdmin('GET', '/api/v1/admin/session')).status).toBe(403);
  });

  it('isolates the administrator hostname from the main site and workers.dev', async () => {
    for (const origin of [ORIGIN, 'https://cloudbrowser.example.workers.dev', 'https://preview.cloudbrowser.example.workers.dev', 'https://admin.test.attacker.example', 'http://admin.test', 'https://admin.test:444']) {
      expect((await t.call('GET', `${origin}/api/v1/admin/session`, undefined, { 'cf-access-jwt-assertion': token })).status).toBe(404);
    }
    for (const path of ['/api/auth/get-session', '/api/v1/me', '/api/v1/instances']) {
      expect((await callAdmin('GET', path)).status).toBe(404);
    }
    expect((await callAdmin('POST', '/api/auth/email-otp/send-verification-otp', { email: ADMIN_EMAIL, type: 'sign-in' })).status).toBe(404);
    expect((await callAdmin('POST', '/api/v1/admin/step-up/options')).status).toBe(404);
    expect((await callAdmin('POST', '/api/v1/admin/step-up/verify', { response: {} })).status).toBe(404);
  });

  it('requires the exact administrator origin on writes', async () => {
    const body = { value: 'true', reason: 'incident' };
    for (const origin of ['', ORIGIN, 'https://attacker.example', 'https://admin.test.attacker.example']) {
      expect((await callAdmin('PUT', '/api/v1/admin/flags/creation_freeze', body, { origin })).status).toBe(403);
    }
    expect(t.d1.sqlite.prepare(`SELECT count(*) AS n FROM control_flags WHERE key = 'creation_freeze'`).get()).toEqual({ n: 0 });
    expect((await callAdmin('PUT', '/api/v1/admin/flags/creation_freeze', body)).status).toBe(200);
  });
});

describe('admin console', () => {
  let browser: string;
  let owner: string;

  beforeEach(async () => {
    // A user with one running browser.
    await signIn(t, 'user@example.com');
    owner = (await t.call('GET', '/api/v1/me')).body.user.id;
    browser = (await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1', storageGb: 10, priceVersion: await quote('tyo1') }, { 'idempotency-key': 'w' })).body.instanceId;
    await t.settle();
  });

  it('finds browsers by email or IP and shows their timeline', async () => {
    const found = (await callAdmin('GET', '/api/v1/admin/instances?q=user@example', undefined, IP)).body;
    expect(found).toHaveLength(1);
    const ip = found[0].ipAddress;
    expect((await callAdmin('GET', `/api/v1/admin/instances?q=${ip}`, undefined, IP)).body[0].id).toBe(browser);
    const detail = (await callAdmin('GET', `/api/v1/admin/instances/${browser}`, undefined, IP)).body;
    expect(detail.owner.email).toBe('user@example.com');
    expect(detail.resources.map((r: { kind: string }) => r.kind).sort()).toEqual(['ip', 'network_interface', 'vm', 'volume']);
    expect(detail.operations[0].kind).toBe('create');
    const op = (await callAdmin('GET', `/api/v1/admin/operations/${detail.operations[0].id}`, undefined, IP)).body;
    expect(op.steps.map((s: { step: string }) => s.step).slice(0, 3)).toEqual(['allocate_ip', 'screen_ip', 'create_nic']); // in run order
  });

  it('suspends a browser: it sleeps within a minute and cannot start until released', async () => {
    const r = await callAdmin('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'suspend', reason: 'abuse report #12' }, IP);
    expect(r.status).toBe(200);
    expect((await meterUsage({ db: createDb(t.d1 as never), now: () => new Date(), notify: () => {} } as never)).stopped).toBe(1);
    const stop = t.d1.sqlite.prepare(`SELECT id, params FROM operations WHERE kind = 'stop'`).get() as { id: string; params: string };
    expect(JSON.parse(stop.params).reason).toBe('suspended');
    await t.env.OPERATIONS.send({ operationId: stop.id });
    await t.settle();

    await signIn(t, 'user@example.com');
    expect((await t.call('POST', `/api/v1/instances/${browser}/start`, undefined, { 'idempotency-key': 's1' })).body.type).toBe('suspended');
    await callAdmin('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'unsuspend', reason: 'resolved' }, IP);
    await signIn(t, 'user@example.com');
    expect((await t.call('POST', `/api/v1/instances/${browser}/start`, undefined, { 'idempotency-key': 's2' })).status).toBe(202);

    const audit = t.d1.sqlite.prepare(`SELECT actor, action, detail FROM audit_log WHERE target = ? AND actor LIKE 'admin:%' ORDER BY id`).all(`instance:${browser}`) as { actor: string; action: string; detail: string }[];
    expect(audit.map(({ actor, action }) => ({ actor, action }))).toEqual([
      { actor: ADMIN_ACTOR, action: 'instance.suspend' },
      { actor: ADMIN_ACTOR, action: 'instance.unsuspend' },
    ]);
    for (const row of audit) expect(JSON.parse(row.detail)).toMatchObject({ email: ADMIN_EMAIL, ip: IP['cf-connecting-ip'] });
  });

  it('recovers, stops and retries through operations, and needs a reason', async () => {
    expect((await callAdmin('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'recover' }, IP)).status).toBe(400);
    const rec = await callAdmin('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'recover', reason: 'host degraded' }, IP);
    expect(rec.body.operationId).toBeTruthy();
    await t.settle();
    expect((await callAdmin('GET', `/api/v1/admin/operations/${rec.body.operationId}`, undefined, IP)).body.operation.status).toBe('succeeded');
    expect((await callAdmin('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'retry', reason: 'nothing failed' }, IP)).status).toBe(409);
    const stop = await callAdmin('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'stop', reason: 'maintenance' }, IP);
    await t.settle();
    expect((await callAdmin('GET', `/api/v1/admin/operations/${stop.body.operationId}`, undefined, IP)).body.operation.status).toBe('succeeded');
  });

  it('changes caps and flags with an audit trail', async () => {
    await callAdmin('PUT', '/api/v1/admin/flags/creation_freeze', { value: 'true', reason: 'incident 7' }, IP);
    expect((await callAdmin('PUT', '/api/v1/admin/flags/anything', { value: 'true', reason: 'nope' }, IP)).status).toBe(404);
    expect((await callAdmin('PUT', '/api/v1/admin/caps', { scope: 'bogus', metric: 'instances', limit: 5 }, IP)).status).toBe(400);
    await callAdmin('PUT', '/api/v1/admin/caps', { scope: `user:${owner}`, metric: 'instances', limit: 5 }, IP);
    expect((await callAdmin('GET', '/api/v1/admin/caps', undefined, IP)).body).toContainEqual({ scope: `user:${owner}`, metric: 'instances', limit: 5 });

    await signIn(t, 'user@example.com');
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.maxBrowsers).toBe(5);
    expect((await t.call('POST', '/api/v1/instances', { name: 'x', regionId: 'tyo1', storageGb: 10, priceVersion: await quote('tyo1') }, { 'idempotency-key': 'x' })).body.type).toBe('creation_frozen');
    const audit = (await callAdmin('GET', '/api/v1/admin/audit', undefined, IP)).body.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['flag.creation_freeze', 'cap.set']));
  });

  it('lists users with their plan and suspends all of a user’s browsers', async () => {
    t.d1.sqlite.prepare('INSERT INTO invites (email) VALUES (?)').run(ADMIN_EMAIL);
    await signIn(t, ADMIN_EMAIL);
    const users = (await callAdmin('GET', '/api/v1/admin/users', undefined, IP)).body;
    expect(users.find((u: { email: string }) => u.email === ADMIN_EMAIL).admin).toBe(true);
    expect(users.find((u: { email: string }) => u.email === 'user@example.com')).toMatchObject({ browsers: 1, suspended: 0, balanceMicros: 0, reservedMicros: 0, availableMicros: 0, frozenAt: null });
    // The console splits a balance exactly as the user's Billing page does.
    await callAdmin('POST', `/api/v1/admin/users/${owner}/credit`, { amountMicros: 5_000_000, reason: 'pilot credit' }, IP);
    t.d1.sqlite.prepare(`INSERT INTO browser_reservations (instance_id, user_id, required_micros, reserved_micros, fixed_hour_micros, rates, updated_at)
      VALUES (?, ?, 1200000, 1200000, 7000, '{}', ?) ON CONFLICT (instance_id) DO UPDATE SET reserved_micros = 1200000, required_micros = 1200000`).run(browser, owner, Date.now());
    const split = (await callAdmin('GET', '/api/v1/admin/users?q=user@', undefined, IP)).body[0];
    await signIn(t, 'user@example.com');
    const mine = (await t.call('GET', '/api/v1/billing')).body;
    expect(split).toMatchObject({ balanceMicros: mine.balanceMicros, reservedMicros: mine.reservedMicros, availableMicros: mine.availableMicros });
    expect(split).toMatchObject({ balanceMicros: 5_000_000, reservedMicros: 1_200_000, availableMicros: 3_800_000 });
    await signIn(t, ADMIN_EMAIL);
    await callAdmin('POST', `/api/v1/admin/users/${owner}/actions`, { action: 'suspend', reason: 'chargeback' }, IP);
    expect((await callAdmin('GET', '/api/v1/admin/users?q=user@', undefined, IP)).body[0].suspended).toBe(1);
  });

  it('sets the markup, shows cost against price per region, and credits a user', async () => {
    const pricing = (await callAdmin('GET', '/api/v1/admin/pricing', undefined, IP)).body;
    const tyo = pricing.regions.find((r: { regionId: string }) => r.regionId === 'tyo1');
    expect(pricing.settings.markupPercent).toBe(120);
    expect(tyo.cost).toMatchObject({ compute: 100_000, ip: 5_000 });
    expect(tyo.price).toMatchObject({ compute: 120_000, ip: 6_000 });

    expect((await callAdmin('PUT', '/api/v1/admin/pricing/settings', { ...pricing.settings, markupPercent: 90, reason: 'below cost' }, IP)).status).toBe(400);
    await callAdmin('PUT', '/api/v1/admin/pricing/settings', { ...pricing.settings, markupPercent: 135, reason: 'margin review' }, IP);
    await signIn(t, 'user@example.com');
    const prices = (await t.call('GET', '/api/v1/pricing')).body;
    expect(prices.find((r: { regionId: string }) => r.regionId === 'tyo1').rates).toMatchObject({ compute: 135_000, ip: 6_750 });

    await callAdmin('POST', `/api/v1/admin/users/${owner}/credit`, { amountMicros: 5_000_000, reason: 'pilot credit' }, IP);
    expect((await t.call('GET', '/api/v1/billing')).body.balanceMicros).toBe(5_000_000);
    expect((await t.call('GET', '/api/v1/billing/transactions')).body[0]).toMatchObject({ kind: 'adjustment', amountMicros: 5_000_000, description: 'pilot credit' });
    const audit = (await callAdmin('GET', '/api/v1/admin/audit', undefined, IP)).body.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['pricing.settings', 'user.credit']));
  });

  it('reports only money actually charged as revenue, while retaining the cost of free usage', async () => {
    const day = new Date().toISOString().slice(0, 10);
    t.d1.sqlite.prepare(`INSERT INTO usage_records
      (instance_id, user_id, region_id, item, day, unit_price_micros, unit_cost_micros, quantity, amount_micros, charged_micros, cost_micros, updated_at)
      VALUES (?, ?, 'tyo1', 'compute', ?, 120000, 100000, 1, 120000, 0, 100000, ?)`)
      .run(browser, owner, day, Date.now());
    let month = (await callAdmin('GET', '/api/v1/admin/pricing')).body.month;
    expect(month).toMatchObject({ revenueMicros: 0, costMicros: 100_000, grossMarginMicros: -100_000 });
    t.d1.sqlite.prepare('UPDATE usage_records SET charged_micros = 120000 WHERE instance_id = ?').run(browser);
    month = (await callAdmin('GET', '/api/v1/admin/pricing')).body.month;
    expect(month).toMatchObject({ revenueMicros: 120_000, costMicros: 100_000, grossMarginMicros: 20_000 });
    expect(month.byItem.compute).toEqual({ revenueMicros: 120_000, costMicros: 100_000 });
  });

  it('adds every item to the totals and estimates payment fees on what customers paid, tax included', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const insert = t.d1.sqlite.prepare(`INSERT INTO usage_records
      (instance_id, user_id, region_id, item, day, unit_price_micros, unit_cost_micros, quantity, amount_micros, charged_micros, cost_micros, updated_at)
      VALUES (?, ?, 'tyo1', ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
    insert.run(browser, owner, 'compute', day, 120_000, 100_000, 120_000, 120_000, 100_000, Date.now());
    insert.run(browser, owner, 'snapshot', day, 0, 50_000, 0, 0, 50_000, Date.now()); // internal recovery snapshot: cost only
    t.d1.sqlite.prepare(`INSERT INTO balance_transactions (id, user_id, kind, amount_micros, reference, order_id, gross_amount_cents, currency, actor, created_at, applied_at)
      VALUES ('tx-paid', ?, 'topup', 10000000, 'order:o1', 'o1', 1100, 'USD', 'creem', ?, ?)`).run(owner, Date.now(), Date.now());
    const before = (await callAdmin('GET', '/api/v1/admin/pricing')).body;
    await callAdmin('PUT', '/api/v1/admin/pricing/settings', { ...before.settings, paymentFeeBps: 390, paymentFeeFixedCents: 40, reason: 'creem fees' }, IP);
    const { month } = (await callAdmin('GET', '/api/v1/admin/pricing')).body;
    const items = Object.values(month.byItem as Record<string, { revenueMicros: number; costMicros: number }>);
    expect(items.reduce((a, i) => a + i.revenueMicros, 0)).toBe(month.revenueMicros);
    expect(items.reduce((a, i) => a + i.costMicros, 0)).toBe(month.costMicros);
    expect(month.byItem.snapshot).toEqual({ revenueMicros: 0, costMicros: 50_000 });
    // $10.00 credited from $11.00 paid (tax $1.00): 3.9% of $11.00 + $0.40 = $0.829.
    expect(month).toMatchObject({ topupMicros: 10_000_000, topupGrossMicros: 11_000_000, topups: 1, estimatedFeesMicros: 829_000 });
  });

  it('raises alerts once, delivers them to email and the chat webhook, and acknowledges them', async () => {
    const db = createDb(t.d1 as never);
    for (let i = 0; i < 2; i++) await raiseAlert(db, { source: 'reconciler', severity: 'critical', title: 'Circuit breaker', dedupeKey: 'circuit_breaker' });
    await raiseAlert(db, { source: 'engine', severity: 'warning', title: 'IP check failed' });
    const posted: string[] = [];
    mockAccessJwks(async (input, init) => {
      expect(String(input)).toBe('https://hooks.test/x');
      posted.push(String(init?.body));
      return new Response('ok');
    });
    Object.assign(t.env, { ALERT_WEBHOOK_URL: 'https://hooks.test/x', ALERT_EMAILS: 'oncall@example.com' });
    expect(await deliverAlerts(t.env as never, db)).toBe(2);
    expect(await deliverAlerts(t.env as never, db)).toBe(0);
    expect(posted[0]).toMatch(/CRITICAL\] reconciler: Circuit breaker/);
    expect(posted[0]).toContain(`${ADMIN_ORIGIN}/alerts`);
    expect(t.emails.at(-1)).toMatchObject({ to: 'oncall@example.com' });
    expect(t.emails.at(-1)?.text).toContain(`${ADMIN_ORIGIN}/alerts`);

    const open = (await callAdmin('GET', '/api/v1/admin/alerts', undefined, IP)).body;
    expect(open).toHaveLength(2);
    await callAdmin('POST', `/api/v1/admin/alerts/${open[0].id}/ack`, undefined, IP);
    expect((await callAdmin('GET', '/api/v1/admin/alerts', undefined, IP)).body).toHaveLength(1);
    expect(t.d1.sqlite.prepare('SELECT acknowledged_by AS actor FROM alerts WHERE id = ?').get(open[0].id)).toEqual({ actor: ADMIN_ACTOR });
  });
});
