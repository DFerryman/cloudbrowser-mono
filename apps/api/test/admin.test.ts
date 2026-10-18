import { createDb, raiseAlert } from '@cloudbrowser/db';
import { meterAndEnforce } from '@cloudbrowser/engine';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipAllowed } from '../src/admin/access.js';
import { deliverAlerts } from '../src/admin/alerts.js';
import { setup, signIn } from './helpers.js';

const IP = { 'cf-connecting-ip': '203.0.113.9' };
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

/** A software passkey: P-256 key, COSE public key, and WebAuthn assertions signed like an authenticator. */
class SoftPasskey {
  credentialId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  private constructor(readonly keys: CryptoKeyPair) {}

  static async create() {
    return new SoftPasskey((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair);
  }

  async cosePublicKeyB64() {
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, dec(jwk.x!)],
      [-3, dec(jwk.y!)],
    ]);
    return btoa(String.fromCharCode(...isoCBOR.encode(cose)));
  }

  async assert(challenge: string, opts: { rpId?: string; origin?: string; uv?: boolean } = {}) {
    const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: opts.origin ?? 'http://app.test', crossOrigin: false }));
    this.counter++;
    const authData = new Uint8Array(37);
    authData.set(await sha256(new TextEncoder().encode(opts.rpId ?? 'app.test')), 0);
    authData[32] = 0x01 | (opts.uv === false ? 0 : 0x04); // user present, user verified
    new DataView(authData.buffer).setUint32(33, this.counter);
    const signed = new Uint8Array([...authData, ...(await sha256(clientData))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(derSignature(raw)) },
      clientExtensionResults: {},
    };
  }
}

/** WebAuthn ECDSA signatures are DER-encoded; WebCrypto gives raw r‖s. */
function derSignature(raw: Uint8Array) {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    return v[0]! & 0x80 ? new Uint8Array([0, ...v]) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}

let t: ReturnType<typeof setup>;
let userId: string;
let key: SoftPasskey;

async function stepUp(k = key, opts?: Parameters<SoftPasskey['assert']>[1]) {
  const options = await t.call('POST', '/api/v1/admin/step-up/options', undefined, IP);
  return t.call('POST', '/api/v1/admin/step-up/verify', { response: await k.assert(options.body.challenge, opts) }, IP);
}

beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('ops@example.com'), ('user@example.com')`);
  // Several sign-ins per test (switching between the admin and a user): no sign-in throttling here.
  Object.assign(t.env, { ADMIN_IP_ALLOWLIST: '198.51.100.0/24, 203.0.113.9, 2001:db8::/32', AUTH_LIMITER: { limit: async () => ({ success: true }) } });
  await signIn(t, 'ops@example.com');
  userId = (await t.call('GET', '/api/v1/me')).body.user.id;
  key = await SoftPasskey.create();
});
afterEach(() => vi.unstubAllGlobals());

const makeAdmin = () => t.d1.sqlite.prepare('INSERT INTO admins (user_id, created_at) VALUES (?, 0)').run(userId);
const addPasskey = async (k = key) =>
  t.d1.sqlite
    .prepare(`INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up, created_at) VALUES (?, ?, ?, ?, 0, 'singleDevice', 0, 0)`)
    .run(`pk_${Math.random()}`, await k.cosePublicKeyB64(), userId, b64url(k.credentialId));

describe('admin access', () => {
  it('matches IPv4 and IPv6 addresses and ranges', () => {
    const list = '198.51.100.0/24, 203.0.113.9, 2001:db8::/32, ::1';
    expect(ipAllowed(list, '198.51.100.77')).toBe(true);
    expect(ipAllowed(list, '198.51.101.1')).toBe(false);
    expect(ipAllowed(list, '203.0.113.9')).toBe(true);
    expect(ipAllowed(list, '203.0.113.10')).toBe(false);
    expect(ipAllowed(list, '2001:db8:1::5')).toBe(true);
    expect(ipAllowed(list, '2001:db9::5')).toBe(false);
    expect(ipAllowed(list, '::1')).toBe(true);
    expect(ipAllowed('', '203.0.113.9')).toBe(false);
    expect(ipAllowed('garbage, 10.0.0.0/99', '10.0.0.1')).toBe(false);
  });

  it('hides the console from non-admins and from other IPs', async () => {
    expect((await t.call('GET', '/api/v1/admin/session', undefined, IP)).status).toBe(404);
    makeAdmin();
    expect((await t.call('GET', '/api/v1/admin/session', undefined, { 'cf-connecting-ip': '192.0.2.1' })).status).toBe(404);
    const s = await t.call('GET', '/api/v1/admin/session', undefined, IP);
    expect(s.body).toMatchObject({ email: 'ops@example.com', passkeys: 0, stepUpUntil: null });
    // An empty allowlist (the wrangler.jsonc default) admits nobody outside `wrangler dev`.
    Object.assign(t.env, { ADMIN_IP_ALLOWLIST: '' });
    expect((await t.call('GET', '/api/v1/admin/session', undefined, IP)).status).toBe(404);
    Object.assign(t.env, { ENVIRONMENT: 'development' });
    expect((await t.call('GET', '/api/v1/admin/session')).status).toBe(200); // local, no cf-connecting-ip
  });

  it('requires a passkey step-up, single-use and bound to this site', async () => {
    makeAdmin();
    expect((await t.call('GET', '/api/v1/admin/overview', undefined, IP)).body.type).toBe('step_up_required');
    expect((await t.call('POST', '/api/v1/admin/step-up/options', undefined, IP)).status).toBe(409); // no passkey yet
    await addPasskey();

    // Wrong site, missing user verification, or another key: refused and audited.
    expect((await stepUp(key, { rpId: 'evil.test' })).status).toBe(403);
    expect((await stepUp(key, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await stepUp(key, { uv: false })).status).toBe(403);
    expect((await stepUp(await SoftPasskey.create())).status).toBe(400);
    expect(t.d1.sqlite.prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'admin.step_up_failed'`).get()).toEqual({ n: 3 });

    const options = await t.call('POST', '/api/v1/admin/step-up/options', undefined, IP);
    const assertion = await key.assert(options.body.challenge);
    const ok = await t.call('POST', '/api/v1/admin/step-up/verify', { response: assertion }, IP);
    expect(ok.status).toBe(200);
    expect(Date.parse(ok.body.stepUpUntil) - Date.now()).toBeGreaterThan(29 * 60_000);
    // The same assertion cannot be replayed.
    expect((await t.call('POST', '/api/v1/admin/step-up/verify', { response: assertion }, IP)).status).toBe(400);

    const overview = await t.call('GET', '/api/v1/admin/overview', undefined, IP);
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ users: 1, operations: { unfinished: 0 }, alertsOpen: 0 });

    // The step-up expires after 30 minutes.
    t.d1.sqlite.prepare('UPDATE admin_step_ups SET verified_at = ?').run(Date.now() - 31 * 60_000);
    expect((await t.call('GET', '/api/v1/admin/overview', undefined, IP)).body.type).toBe('step_up_required');
  });
});

describe('admin console', () => {
  let browser: string;
  let owner: string;

  beforeEach(async () => {
    makeAdmin();
    await addPasskey();
    expect((await stepUp()).status).toBe(200);
    // A user with one running browser.
    const adminCookie = t.cookie();
    await signIn(t, 'user@example.com');
    owner = (await t.call('GET', '/api/v1/me')).body.user.id;
    browser = (await t.call('POST', '/api/v1/instances', { name: 'Work', regionId: 'tyo1' }, { 'idempotency-key': 'w' })).body.instanceId;
    await t.settle();
    t.setCookie(adminCookie);
  });

  it('finds browsers by email or IP and shows their timeline', async () => {
    const found = (await t.call('GET', '/api/v1/admin/instances?q=user@example', undefined, IP)).body;
    expect(found).toHaveLength(1);
    const ip = found[0].ipAddress;
    expect((await t.call('GET', `/api/v1/admin/instances?q=${ip}`, undefined, IP)).body[0].id).toBe(browser);
    const detail = (await t.call('GET', `/api/v1/admin/instances/${browser}`, undefined, IP)).body;
    expect(detail.owner.email).toBe('user@example.com');
    expect(detail.resources.map((r: { kind: string }) => r.kind).sort()).toEqual(['ip', 'network_interface', 'vm', 'volume']);
    expect(detail.operations[0].kind).toBe('create');
    const op = (await t.call('GET', `/api/v1/admin/operations/${detail.operations[0].id}`, undefined, IP)).body;
    expect(op.steps.map((s: { step: string }) => s.step).slice(0, 3)).toEqual(['allocate_ip', 'screen_ip', 'create_nic']); // in run order
  });

  it('suspends a browser: it sleeps within a minute and cannot start until released', async () => {
    const r = await t.call('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'suspend', reason: 'abuse report #12' }, IP);
    expect(r.status).toBe(200);
    expect((await meterAndEnforce({ db: createDb(t.d1 as never), now: () => new Date(), notify: () => {} } as never)).stopped).toBe(1);
    const stop = t.d1.sqlite.prepare(`SELECT id, params FROM operations WHERE kind = 'stop'`).get() as { id: string; params: string };
    expect(JSON.parse(stop.params).reason).toBe('suspended');
    await t.env.OPERATIONS.send({ operationId: stop.id });
    await t.settle();

    const adminCookie = t.cookie();
    await signIn(t, 'user@example.com');
    expect((await t.call('POST', `/api/v1/instances/${browser}/start`, undefined, { 'idempotency-key': 's1' })).body.type).toBe('suspended');
    t.setCookie(adminCookie);
    await t.call('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'unsuspend', reason: 'resolved' }, IP);
    await signIn(t, 'user@example.com');
    expect((await t.call('POST', `/api/v1/instances/${browser}/start`, undefined, { 'idempotency-key': 's2' })).status).toBe(202);

    const audit = t.d1.sqlite.prepare(`SELECT actor, action FROM audit_log WHERE target = ? AND actor LIKE 'admin:%' ORDER BY id`).all(`instance:${browser}`);
    expect(audit).toEqual([
      { actor: `admin:${userId}`, action: 'instance.suspend' },
      { actor: `admin:${userId}`, action: 'instance.unsuspend' },
    ]);
  });

  it('recovers, stops and retries through operations, and needs a reason', async () => {
    expect((await t.call('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'recover' }, IP)).status).toBe(400);
    const rec = await t.call('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'recover', reason: 'host degraded' }, IP);
    expect(rec.body.operationId).toBeTruthy();
    await t.settle();
    expect((await t.call('GET', `/api/v1/admin/operations/${rec.body.operationId}`, undefined, IP)).body.operation.status).toBe('succeeded');
    expect((await t.call('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'retry', reason: 'nothing failed' }, IP)).status).toBe(409);
    const stop = await t.call('POST', `/api/v1/admin/instances/${browser}/actions`, { action: 'stop', reason: 'maintenance' }, IP);
    await t.settle();
    expect((await t.call('GET', `/api/v1/admin/operations/${stop.body.operationId}`, undefined, IP)).body.operation.status).toBe('succeeded');
  });

  it('changes caps and flags with an audit trail', async () => {
    await t.call('PUT', '/api/v1/admin/flags/creation_freeze', { value: 'true', reason: 'incident 7' }, IP);
    expect((await t.call('PUT', '/api/v1/admin/flags/anything', { value: 'true', reason: 'nope' }, IP)).status).toBe(404);
    expect((await t.call('PUT', '/api/v1/admin/caps', { scope: 'bogus', metric: 'instances', limit: 5 }, IP)).status).toBe(400);
    await t.call('PUT', '/api/v1/admin/caps', { scope: `user:${owner}`, metric: 'instances', limit: 5 }, IP);
    expect((await t.call('GET', '/api/v1/admin/caps', undefined, IP)).body).toContainEqual({ scope: `user:${owner}`, metric: 'instances', limit: 5 });

    const adminCookie = t.cookie();
    await signIn(t, 'user@example.com');
    expect((await t.call('GET', '/api/v1/me')).body.entitlements.maxBrowsers).toBe(5);
    expect((await t.call('POST', '/api/v1/instances', { name: 'x', regionId: 'tyo1' }, { 'idempotency-key': 'x' })).body.type).toBe('creation_frozen');
    t.setCookie(adminCookie);
    const audit = (await t.call('GET', '/api/v1/admin/audit', undefined, IP)).body.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['flag.creation_freeze', 'cap.set', 'admin.step_up']));
  });

  it('lists users with their plan and suspends all of a user’s browsers', async () => {
    const users = (await t.call('GET', '/api/v1/admin/users?q=example.com', undefined, IP)).body;
    expect(users.find((u: { email: string }) => u.email === 'ops@example.com').admin).toBe(true);
    expect(users.find((u: { email: string }) => u.email === 'user@example.com')).toMatchObject({ browsers: 1, suspended: 0, subscription: null });
    await t.call('POST', `/api/v1/admin/users/${owner}/actions`, { action: 'suspend', reason: 'chargeback' }, IP);
    expect((await t.call('GET', '/api/v1/admin/users?q=user@', undefined, IP)).body[0].suspended).toBe(1);
  });

  it('raises alerts once, delivers them to email and the chat webhook, and acknowledges them', async () => {
    const db = createDb(t.d1 as never);
    for (let i = 0; i < 2; i++) await raiseAlert(db, { source: 'reconciler', severity: 'critical', title: 'Circuit breaker', dedupeKey: 'circuit_breaker' });
    await raiseAlert(db, { source: 'engine', severity: 'warning', title: 'IP check failed' });
    const posted: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      posted.push(String(init.body));
      return new Response('ok');
    });
    Object.assign(t.env, { ALERT_WEBHOOK_URL: 'https://hooks.test/x', ALERT_EMAILS: 'oncall@example.com' });
    expect(await deliverAlerts(t.env as never, db)).toBe(2);
    expect(await deliverAlerts(t.env as never, db)).toBe(0);
    expect(posted[0]).toMatch(/CRITICAL\] reconciler: Circuit breaker/);
    expect(t.emails.at(-1)).toMatchObject({ to: 'oncall@example.com' });

    const open = (await t.call('GET', '/api/v1/admin/alerts', undefined, IP)).body;
    expect(open).toHaveLength(2);
    await t.call('POST', `/api/v1/admin/alerts/${open[0].id}/ack`, undefined, IP);
    expect((await t.call('GET', '/api/v1/admin/alerts', undefined, IP)).body).toHaveLength(1);
  });
});
