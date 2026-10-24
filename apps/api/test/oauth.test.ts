import { createDb, sha256Hex } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.js';
import { internalApi } from '../src/internal.js';
import { callbackAllowed, callbackMatches, oauthSweep, resetOAuthBlocks } from '../src/oauth.js';
import { ORIGIN, setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let instanceId: string;
let resource: string;
let gateway: { automationControl: ReturnType<typeof vi.fn>; revokeAutomation: ReturnType<typeof vi.fn>; revokeInstance: ReturnType<typeof vi.fn> };

const CALLBACK = 'http://127.0.0.1/callback';
const VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const challengeOf = async (verifier: string) => base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
let CHALLENGE: string;

beforeEach(async () => {
  t = setup();
  gateway = { automationControl: vi.fn().mockResolvedValue(undefined), revokeAutomation: vi.fn().mockResolvedValue(undefined), revokeInstance: vi.fn().mockResolvedValue(undefined) };
  Object.assign(t.env, { GATEWAY: gateway, GATEWAY_URL: 'wss://connect.test' });
  t.d1.sqlite.exec("INSERT INTO invites (email) VALUES ('oauth-owner@example.com'), ('oauth-other@example.com')");
  await signIn(t, 'oauth-owner@example.com');
  const price = (await t.call('GET', '/api/v1/pricing')).body.find((p: { regionId: string }) => p.regionId === 'tyo1');
  const created = await t.call('POST', '/api/v1/instances', { name: 'Agent browser', regionId: 'tyo1', storageGb: 10, priceVersion: price.version }, { 'idempotency-key': 'oauth-browser' });
  expect(created.status).toBe(202);
  await t.settle();
  instanceId = created.body.instanceId;
  resource = `https://connect.test/mcp/${instanceId}`;
  t.d1.sqlite.prepare(`INSERT OR IGNORE INTO agent_credentials (instance_id, generation, created_at) VALUES (?, 1, 0)`).run(instanceId);
  CHALLENGE = await challengeOf(VERIFIER);
  resetOAuthBlocks();
});

afterEach(async () => { await t.settle(); t.d1.sqlite.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/** A request from an app: no cookie, no origin, form-encoded unless JSON is asked for. */
async function raw(method: string, path: string, body?: Record<string, unknown>, { json = false, headers = {} }: { json?: boolean; headers?: Record<string, string> } = {}) {
  const res = await app.fetch(new Request(new URL(path, ORIGIN), {
    method,
    headers: { ...(body ? { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' } : {}), ...headers },
    body: body ? (json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString()) : undefined,
  }), t.env as never, t.ctx);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text && (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text };
}

const register = (meta: Record<string, unknown> = {}) =>
  raw('POST', '/api/oauth/register', { client_name: 'Cursor', redirect_uris: [CALLBACK, 'cursor://anysphere.cursor-mcp/oauth/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...meta }, { json: true });

const params = (clientId: string, extra: Record<string, string | undefined> = {}) => Object.fromEntries(Object.entries({
  response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:53682/callback', code_challenge: CHALLENGE, code_challenge_method: 'S256',
  state: 'state-1', scope: 'browser:control', resource, ...extra,
}).filter((e): e is [string, string] => e[1] !== undefined));

const check = (clientId: string, extra: Record<string, string | undefined> = {}) => t.call('POST', '/api/v1/oauth/authorize/check', { params: params(clientId, extra) });
const decide = (clientId: string, body: Record<string, unknown> = {}, extra: Record<string, string | undefined> = {}) =>
  t.call('POST', '/api/v1/oauth/authorize/decision', { params: params(clientId, extra), approve: true, ...body });
const codeOf = (redirect: string) => new URL(redirect).searchParams.get('code')!;
const exchange = (clientId: string, code: string, extra: Record<string, string> = {}, json = false) => raw('POST', '/api/oauth/token', {
  grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'http://127.0.0.1:53682/callback', code_verifier: VERIFIER, resource, ...extra,
}, { json });
const refresh = (clientId: string, token: string, extra: Record<string, string> = {}) =>
  raw('POST', '/api/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: clientId, ...extra });

/** A registered app, approved for the browser and signed in. */
async function signedIn(body: Record<string, unknown> = {}) {
  const clientId: string = (await register()).body.client_id;
  const decision = await decide(clientId, body);
  expect(decision.status).toBe(200);
  const tokens = await exchange(clientId, codeOf(decision.body.redirect));
  expect(tokens.status).toBe(200);
  const grantId = (t.d1.sqlite.prepare(`SELECT id FROM automation_clients WHERE kind = 'oauth' ORDER BY created_at DESC, id DESC`).get() as { id: string }).id;
  return { clientId, grantId, access: tokens.body.access_token as string, refresh: tokens.body.refresh_token as string };
}

const mcp = (key: string, id = instanceId) => internalApi(t.env as never).authenticateMcp({ instanceId: id, key });

describe('OAuth sign-in for coding agents', () => {
  it('publishes its metadata for discovery, and no OpenID configuration', async () => {
    const metadata = await raw('GET', '/.well-known/oauth-authorization-server');
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('access-control-allow-origin')).toBe('*');
    expect(metadata.body).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['browser:control', 'browser:view'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect((await raw('GET', '/.well-known/openid-configuration')).status).toBe(404);
    const preflight = await raw('OPTIONS', '/api/oauth/token');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(await raw('POST', '/api/oauth/token', { grant_type: 'client_credentials' })).toMatchObject({ status: 400, body: { error: 'unsupported_grant_type' } });
  });

  it('registers public apps whose callbacks are local, an app scheme or a known hosted client', async () => {
    const made = await register({ client_name: 'Cursor‮\u0007  v2', software_id: 'cursor', software_version: '1.2' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      client_id: expect.stringMatching(/^nvzc_[A-Za-z0-9]{24}$/), client_name: 'Cursor v2', token_endpoint_auth_method: 'none',
      redirect_uris: [CALLBACK, 'cursor://anysphere.cursor-mcp/oauth/callback'], grant_types: ['authorization_code', 'refresh_token'],
    });
    expect((await register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })).status).toBe(201);
    for (const uri of ['https://evil.example/callback', 'http://192.168.1.20/callback', 'http://localhost.evil.example/cb', 'javascript:alert(1)', 'http://127.0.0.1/cb#frag', 'https://user@claude.ai/cb']) {
      expect(await register({ redirect_uris: [CALLBACK, uri] })).toMatchObject({ status: 400, body: { error: 'invalid_redirect_uri' } });
    }
    expect(await register({ redirect_uris: [] })).toMatchObject({ status: 400, body: { error: 'invalid_redirect_uri' } });
    expect(await register({ grant_types: ['client_credentials'] })).toMatchObject({ status: 400, body: { error: 'invalid_client_metadata' } });
    expect(await register({ response_types: ['token'] })).toMatchObject({ status: 400, body: { error: 'invalid_client_metadata' } });
    const notJson = await app.fetch(new Request(`${ORIGIN}/api/oauth/register`, { method: 'POST', body: '{nope' }), t.env as never, t.ctx);
    expect(notJson.status).toBe(400);

    // A local callback matches on any port, never another host or path.
    expect(callbackMatches([CALLBACK], 'http://127.0.0.1:61000/callback')).toBe(true);
    expect(callbackMatches([CALLBACK], 'http://localhost:61000/callback')).toBe(false);
    expect(callbackMatches([CALLBACK], 'http://127.0.0.1:61000/other')).toBe(false);
    expect(callbackMatches(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback?x=1')).toBe(false);
    expect(callbackAllowed('vscode://vscode.github-authentication/did-authenticate')).toBe(true);
    expect(callbackAllowed('https://tools.example.com/cb', 'tools.example.com')).toBe(true);
    expect(callbackAllowed('data:text/html,hi')).toBe(false);
  });

  it('shows the approval page the app, its callback and the browser, and refuses what it cannot approve', async () => {
    const clientId: string = (await register()).body.client_id;
    const shown = await check(clientId);
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({
      ok: true, client: { name: 'Cursor', verifiedHost: null }, redirect: { kind: 'loopback', label: '127.0.0.1' }, capability: 'control',
      browser: { id: instanceId, name: 'Agent browser', agentAccess: true }, browsers: [], grantDays: [1, 7, 30, 90], defaultGrantDays: 7,
    });
    // No resource: the owner picks the browser. Asking for view alone caps the permission.
    expect((await check(clientId, { resource: undefined, scope: 'browser:view' })).body).toMatchObject({
      ok: true, capability: 'view', browser: null, browsers: [{ id: instanceId, name: 'Agent browser', agentAccess: true }],
    });
    expect((await check(clientId, { resource: `${resource}/`, scope: 'browser:view browser:control offline_access' })).body).toMatchObject({ ok: true, capability: 'control' });
    expect((await check(clientId, { redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback' })).body.redirect).toEqual({ kind: 'app', label: 'cursor://' });

    // Never redirected to: an unknown app or a callback it did not register.
    expect((await check('nvzc_AAAAAAAAAAAAAAAAAAAAAAAA')).body).toMatchObject({ ok: false, error: 'invalid_client', redirect: null });
    expect((await check(clientId, { redirect_uri: 'http://127.0.0.1:53682/elsewhere' })).body).toMatchObject({ ok: false, error: 'invalid_request', redirect: null });
    // Reported to the app's callback, with its state and the issuer.
    const noPkce = (await check(clientId, { code_challenge_method: 'plain' })).body;
    expect(noPkce).toMatchObject({ ok: false, error: 'invalid_request' });
    const back = new URL(noPkce.redirect);
    expect(back.origin + back.pathname).toBe('http://127.0.0.1:53682/callback');
    expect(Object.fromEntries(back.searchParams)).toMatchObject({ error: 'invalid_request', state: 'state-1', iss: ORIGIN });
    expect((await check(clientId, { response_type: 'token' })).body).toMatchObject({ ok: false, error: 'unsupported_response_type' });
    expect((await check(clientId, { resource: 'https://elsewhere.example/mcp/x' })).body).toMatchObject({ ok: false, error: 'invalid_target' });
    expect((await check(clientId, { resource: 'https://connect.test/mcp/nobrowser1' })).body).toMatchObject({ ok: false, error: 'invalid_target', redirect: expect.stringContaining('error=invalid_target') });

    // Another account's browser is not offered.
    const owner = t.cookie();
    t.setCookie('');
    expect((await check(clientId)).status).toBe(401);
    await signIn(t, 'oauth-other@example.com');
    expect((await check(clientId)).body).toMatchObject({ ok: false, error: 'invalid_target' });
    expect((await decide(clientId)).status).toBe(404);
    t.setCookie(owner);
  });

  it('approves for the chosen days and permission, emails the owner, and trades the code for tokens once', async () => {
    const clientId: string = (await register()).body.client_id;
    const decision = await decide(clientId, { capability: 'view', grantDays: 30 });
    expect(decision.status).toBe(200);
    const back = new URL(decision.body.redirect);
    expect(Object.fromEntries(back.searchParams)).toEqual({ code: expect.stringMatching(/^[A-Za-z0-9]{43}$/), state: 'state-1', iss: ORIGIN });
    await t.settle();
    expect(t.emails.at(-1)).toMatchObject({ to: 'oauth-owner@example.com', subject: "'Cursor' can now use 'Agent browser'" });
    expect(t.emails.at(-1)!.text).toContain('30 days');
    const code = back.searchParams.get('code')!;
    expect(t.d1.sqlite.prepare(`SELECT code_hash, capability, grant_days FROM oauth_authorization_codes`).get()).toEqual({ code_hash: await sha256Hex(`oauth-code:${code}`), capability: 'view', grant_days: 30 });

    // Each mismatch is refused without using the code up.
    expect((await exchange(clientId, code, { code_verifier: 'x'.repeat(43) })).body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('PKCE') });
    expect((await exchange(clientId, code, { redirect_uri: 'http://127.0.0.1:1/callback' })).body).toMatchObject({ error: 'invalid_grant' });
    expect((await exchange('nvzc_BBBBBBBBBBBBBBBBBBBBBBBB', code)).body).toMatchObject({ error: 'invalid_grant' });
    expect((await exchange(clientId, code, { resource: 'https://connect.test/mcp/otherbrowser' })).body).toMatchObject({ error: 'invalid_target' });

    const before = Date.now();
    const tokens = await exchange(clientId, code);
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get('cache-control')).toBe('no-store');
    expect(tokens.body).toEqual({
      access_token: expect.stringMatching(/^nvza_[A-Za-z0-9]{43}$/), token_type: 'Bearer', expires_in: 3600,
      refresh_token: expect.stringMatching(/^nvzr_[A-Za-z0-9]{43}$/), scope: 'browser:view',
    });
    const { access_token: access, refresh_token: refreshToken } = tokens.body as { access_token: string; refresh_token: string };
    const row = t.d1.sqlite.prepare(`SELECT * FROM automation_clients WHERE kind = 'oauth'`).get() as Record<string, number | string>;
    expect(row).toMatchObject({
      instance_id: instanceId, name: 'Cursor', capability: 'view', oauth_client_id: clientId, key_prefix: null,
      credential_hash: await sha256Hex(`oauth-access:${access}`), refresh_hash: await sha256Hex(`oauth-refresh:${refreshToken}`),
    });
    expect(Number(row.expires_at) - before).toBeGreaterThanOrEqual(30 * 86_400_000);
    expect(Number(row.expires_at) - before).toBeLessThan(30 * 86_400_000 + 60_000);
    expect(JSON.stringify(row)).not.toContain(access.slice(5));
    expect(JSON.stringify(row)).not.toContain(refreshToken.slice(5));

    // The gateway takes the access token like a key, for this browser only.
    expect(await mcp(access)).toEqual({ ok: true, clientId: row.id, userId: row.user_id, generation: 1, capability: 'view', name: 'Cursor', location: 'apac-ne' });
    expect(await mcp(access, 'otherbrowser')).toEqual({ ok: false, reason: 'invalid_token' });
    expect(await mcp(`nvza_${'x'.repeat(43)}`)).toEqual({ ok: false, reason: 'invalid_token' });
    // A refresh token is never an access token.
    expect(await mcp(refreshToken)).toEqual({ ok: false, reason: 'invalid_token' });

    // The browser's panel lists it beside the keys.
    const status = await t.call('GET', `/api/v1/instances/${instanceId}/automation`);
    expect(status.body.clients).toEqual([expect.objectContaining({ id: row.id, kind: 'oauth', name: 'Cursor', keyPrefix: null, capability: 'view', verifiedHost: null })]);

    // A code seen again revokes what was made with it.
    expect((await exchange(clientId, code)).body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') });
    expect(await mcp(access)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(gateway.revokeAutomation).toHaveBeenCalledWith(instanceId, row.id);
    const audit = t.d1.sqlite.prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'automation.%' ORDER BY id`).all() as { action: string; detail: string }[];
    expect(audit.map((a) => a.action)).toEqual(['automation.oauth_approved', 'automation.oauth_connected', 'automation.client_revoked']);
    expect(audit.at(-1)!.detail).toContain('code_reused');
  });

  it('takes JSON from lenient clients, refuses expired codes, and declines back to the app', async () => {
    const clientId: string = (await register()).body.client_id;
    const first = codeOf((await decide(clientId)).body.redirect);
    expect((await exchange(clientId, first, {}, true)).body).toMatchObject({ token_type: 'Bearer', scope: 'browser:control' });

    const late = codeOf((await decide(clientId)).body.redirect);
    t.d1.sqlite.prepare(`UPDATE oauth_authorization_codes SET expires_at = ? WHERE used_at IS NULL`).run(Date.now() - 1);
    expect((await exchange(clientId, late)).body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('expired') });

    const declined = await t.call('POST', '/api/v1/oauth/authorize/decision', { params: params(clientId), approve: false });
    expect(Object.fromEntries(new URL(declined.body.redirect).searchParams)).toMatchObject({ error: 'access_denied', state: 'state-1', iss: ORIGIN });
    // An unknown app is never sent anywhere, even to decline.
    expect((await t.call('POST', '/api/v1/oauth/authorize/decision', { params: params('nvzc_CCCCCCCCCCCCCCCCCCCCCCCC'), approve: false })).status).toBe(400);
    // Without a resource the owner must pick the browser, and only one the app did not rule out.
    expect((await decide(clientId, {}, { resource: undefined })).status).toBe(400);
    expect((await decide(clientId, { instanceId }, { resource: undefined })).status).toBe(200);
    expect((await decide(clientId, { instanceId: 'otherbrowser' })).status).toBe(400);
  });

  it('rotates the refresh token, forgives a duplicate in flight and revokes a copy used later', async () => {
    const { clientId, grantId, access, refresh: first } = await signedIn();
    const next = await refresh(clientId, first);
    expect(next.status).toBe(200);
    expect(next.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'browser:control' });
    const { access_token: access2, refresh_token: second } = next.body as { access_token: string; refresh_token: string };
    expect(second).not.toBe(first);
    expect(await mcp(access)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(await mcp(access2)).toMatchObject({ ok: true, clientId: grantId });

    expect((await refresh('nvzc_DDDDDDDDDDDDDDDDDDDDDDDD', second)).body).toMatchObject({ error: 'invalid_grant' });
    // The old token again, within seconds: a retry, not a theft.
    expect((await refresh(clientId, first)).body).toMatchObject({ error: 'invalid_grant' });
    expect(await mcp(access2)).toMatchObject({ ok: true });
    // Later, it is a copy: the whole sign-in ends, however many refreshes ago it was replaced.
    const third = (await refresh(clientId, second)).body as { access_token: string; refresh_token: string };
    const fourth = (await refresh(clientId, third.refresh_token)).body as { access_token: string; refresh_token: string };
    expect(t.d1.sqlite.prepare(`SELECT count(*) AS n FROM oauth_spent_refresh_tokens WHERE grant_id = ?`).get(grantId)).toEqual({ n: 3 });
    t.d1.sqlite.prepare(`UPDATE oauth_spent_refresh_tokens SET spent_at = ? WHERE grant_id = ?`).run(Date.now() - 31_000, grantId);
    expect((await refresh(clientId, first)).body).toMatchObject({ error: 'invalid_grant' });
    expect(await mcp(fourth.access_token)).toEqual({ ok: false, reason: 'invalid_token' });
    expect((await refresh(clientId, fourth.refresh_token)).body).toMatchObject({ error: 'invalid_grant' });
    expect((t.d1.sqlite.prepare(`SELECT detail FROM audit_log WHERE action = 'automation.client_revoked'`).get() as { detail: string }).detail).toContain('refresh_reused');
  });

  it('never lets a token outlive the days the owner chose', async () => {
    const { clientId, grantId, access, refresh: token } = await signedIn({ grantDays: 1 });
    const end = t.d1.sqlite.prepare(`SELECT expires_at FROM automation_clients WHERE id = ?`).get(grantId) as { expires_at: number };
    expect(end.expires_at - Date.now()).toBeGreaterThan(86_400_000 - 60_000);
    // The access token's hour runs out: the gateway says expired, and a refresh brings a new one.
    t.d1.sqlite.prepare(`UPDATE automation_clients SET access_expires_at = ? WHERE id = ?`).run(Date.now() - 1, grantId);
    expect(await mcp(access)).toEqual({ ok: false, reason: 'expired' });
    // Ten minutes before the end, a new access token lasts ten minutes, not an hour.
    t.d1.sqlite.prepare(`UPDATE automation_clients SET expires_at = ? WHERE id = ?`).run(Date.now() + 600_000, grantId);
    const near = await refresh(clientId, token);
    expect(near.body.expires_in).toBeGreaterThan(590);
    expect(near.body.expires_in).toBeLessThanOrEqual(600);
    // At the end, nothing works and the app must sign in again.
    t.d1.sqlite.prepare(`UPDATE automation_clients SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, grantId);
    expect(await mcp(near.body.access_token)).toEqual({ ok: false, reason: 'expired' });
    expect((await refresh(clientId, near.body.refresh_token)).body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('ended') });
  });

  it('lets the app sign itself out (RFC 7009)', async () => {
    const one = await signedIn();
    expect((await raw('POST', '/api/oauth/revoke', { token: one.access, client_id: 'nvzc_EEEEEEEEEEEEEEEEEEEEEEEE' })).status).toBe(200);
    expect(await mcp(one.access)).toMatchObject({ ok: true });
    expect((await raw('POST', '/api/oauth/revoke', { token: one.access, client_id: one.clientId })).status).toBe(200);
    expect(await mcp(one.access)).toEqual({ ok: false, reason: 'invalid_token' });
    expect((await refresh(one.clientId, one.refresh)).body).toMatchObject({ error: 'invalid_grant' });
    const two = await signedIn();
    expect((await raw('POST', '/api/oauth/revoke', { token: two.refresh, client_id: two.clientId, token_type_hint: 'refresh_token' })).status).toBe(200);
    expect(await mcp(two.access)).toEqual({ ok: false, reason: 'invalid_token' });
    expect((await raw('POST', '/api/oauth/revoke', { token: 'unknown', client_id: two.clientId })).status).toBe(200);
  });

  it('knows apps by their Client ID Metadata Document, read safely and cached for a day', async () => {
    const CLAUDE = 'https://claude.ai/oauth/claude-code-client-metadata';
    const documents: Record<string, () => Response> = {
      [CLAUDE]: () => Response.json({ client_id: CLAUDE, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'https://evil.example/cb'], token_endpoint_auth_method: 'none' }),
      'https://tools.example.com/agent.json': () => Response.json({ client_id: 'https://tools.example.com/agent.json', client_name: 'Tools', redirect_uris: ['https://tools.example.com/cb'] }),
      'https://wrong.example.com/meta': () => Response.json({ client_id: 'https://other.example.com/meta', redirect_uris: [CALLBACK] }),
      'https://secret.example.com/meta': () => Response.json({ client_id: 'https://secret.example.com/meta', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic' }),
      'https://moved.example.com/meta': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/meta' } }),
      'https://big.example.com/meta': () => new Response(JSON.stringify({ client_id: 'https://big.example.com/meta', redirect_uris: [CALLBACK], pad: 'x'.repeat(6000) })),
    };
    const fetchMock = vi.fn(async (url: string | URL | Request) => (documents[String(url)] ?? (() => new Response('nope', { status: 404 })))());
    vi.stubGlobal('fetch', fetchMock);

    const shown = await check(CLAUDE, { redirect_uri: 'http://localhost:3118/callback' });
    expect(shown.body).toMatchObject({ ok: true, client: { name: 'Claude Code', verifiedHost: 'claude.ai' }, redirect: { kind: 'loopback', label: 'localhost' } });
    // Callbacks outside the rules are dropped from the document.
    expect((await check(CLAUDE, { redirect_uri: 'https://evil.example/cb' })).body).toMatchObject({ ok: false, error: 'invalid_request', redirect: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // An app's own website may be its callback.
    expect((await check('https://tools.example.com/agent.json', { redirect_uri: 'https://tools.example.com/cb' })).body).toMatchObject({ ok: true, redirect: { kind: 'web', label: 'tools.example.com' } });
    for (const id of ['https://wrong.example.com/meta', 'https://secret.example.com/meta', 'https://moved.example.com/meta', 'https://big.example.com/meta', 'https://gone.example.com/meta']) {
      expect((await check(id)).body).toMatchObject({ ok: false, error: 'invalid_client', redirect: null });
    }
    // Not fetched at all: not https, an address, a port, no path, or not written exactly.
    const calls = fetchMock.mock.calls.length;
    for (const id of ['http://claude.ai/meta', 'https://10.0.0.1/meta', 'https://claude.ai:8443/meta', 'https://claude.ai/', 'https://CLAUDE.ai/meta', 'https://localhost/meta']) {
      expect((await check(id)).body).toMatchObject({ ok: false, error: 'invalid_client' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(calls);

    // The sign-in works as with a registered app, and lists the verified host.
    const code = codeOf((await decide(CLAUDE, {}, { redirect_uri: 'http://localhost:3118/callback' })).body.redirect);
    const tokens = await raw('POST', '/api/oauth/token', { grant_type: 'authorization_code', code, client_id: CLAUDE, redirect_uri: 'http://localhost:3118/callback', code_verifier: VERIFIER });
    expect(tokens.status).toBe(200);
    const listed = await t.call('GET', '/api/v1/agent-connections');
    expect(listed.body).toEqual([expect.objectContaining({ kind: 'oauth', name: 'Claude Code', verifiedHost: 'claude.ai', instanceId, instanceName: 'Agent browser' })]);

    // Read again after a day.
    t.d1.sqlite.prepare(`UPDATE oauth_clients SET fetched_at = ? WHERE id = ?`).run(Date.now() - 86_400_001, CLAUDE);
    await check(CLAUDE, { redirect_uri: 'http://localhost:3118/callback' });
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === CLAUDE)).toHaveLength(2);
  });

  it('needs agent access on (or turns it on when asked) and limits sign-ins apart from keys', async () => {
    const clientId: string = (await register()).body.client_id;
    expect((await t.call('PATCH', `/api/v1/instances/${instanceId}`, { agentAccess: false })).status).toBe(200);
    expect((await check(clientId)).body.browser).toEqual({ id: instanceId, name: 'Agent browser', agentAccess: false });
    const off = await decide(clientId);
    expect(off.status).toBe(409);
    expect(off.body.type).toBe('agent_access_off');
    expect((await decide(clientId, { enableAccess: true })).status).toBe(200);
    expect((await t.call('GET', `/api/v1/instances/${instanceId}`)).body.agentAccess).toBe(true);

    const userId = (t.d1.sqlite.prepare(`SELECT user_id FROM browser_instances WHERE id = ?`).get(instanceId) as { user_id: string }).user_id;
    const insert = t.d1.sqlite.prepare(`INSERT INTO automation_clients (id, instance_id, user_id, name, kind, credential_hash, created_at, activated_at, capability, expires_at, oauth_client_id)
      VALUES (?, ?, ?, 'app', 'oauth', ?, 0, 0, 'control', ?, ?)`);
    for (let i = 0; i < 10; i++) insert.run(`grant${i}`, instanceId, userId, `hash${i}`, Date.now() + 86_400_000, clientId);
    const over = await decide(clientId);
    expect(over.status).toBe(409);
    expect(over.body.type).toBe('agent_grant_limit');
    // Keys have their own ten.
    expect((await t.call('POST', `/api/v1/instances/${instanceId}/automation/keys`, { name: 'laptop', capability: 'control', expiresInDays: 30 })).status).toBe(201);
    // An ended sign-in no longer counts.
    t.d1.sqlite.prepare(`UPDATE automation_clients SET expires_at = 1 WHERE id = 'grant0'`).run();
    // Two approvals made while there is room for one: only the first exchange becomes a sign-in.
    const a = codeOf((await decide(clientId)).body.redirect);
    const b = codeOf((await decide(clientId)).body.redirect);
    expect((await exchange(clientId, a)).status).toBe(200);
    expect((await exchange(clientId, b)).body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('10 active sign-ins') });
    expect(t.d1.sqlite.prepare(`SELECT count(*) AS n FROM automation_clients WHERE kind = 'oauth' AND revoked_at IS NULL AND expires_at > ?`).get(Date.now())).toEqual({ n: 10 });
  });

  it('lists every key and sign-in on the account and disconnects one or all', async () => {
    const key = await t.call('POST', `/api/v1/instances/${instanceId}/automation/keys`, { name: 'laptop', capability: 'control', expiresInDays: 30 });
    const app1 = await signedIn();
    const app2 = await signedIn({ grantDays: 1 });
    const listed = await t.call('GET', '/api/v1/agent-connections');
    expect(listed.status).toBe(200);
    expect(listed.body.map((c: { id: string }) => c.id).sort()).toEqual([key.body.clientId, app1.grantId, app2.grantId].sort());
    expect(listed.body.find((c: { id: string }) => c.id === key.body.clientId)).toMatchObject({ kind: 'key', instanceId, instanceName: 'Agent browser' });

    const one = await t.call('DELETE', `/api/v1/agent-connections/${app1.grantId}`);
    expect(one.status).toBe(204);
    expect(await mcp(app1.access)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(gateway.revokeAutomation).toHaveBeenCalledWith(instanceId, app1.grantId);
    expect((await t.call('DELETE', `/api/v1/agent-connections/${app1.grantId}`)).status).toBe(404);
    expect((await t.call('GET', '/api/v1/agent-connections')).body).toHaveLength(2);

    // An ended sign-in stays listed for a day, then drops off.
    t.d1.sqlite.prepare(`UPDATE automation_clients SET expires_at = ? WHERE id = ?`).run(Date.now() - 3_600_000, app2.grantId);
    expect((await t.call('GET', '/api/v1/agent-connections')).body).toHaveLength(2);
    t.d1.sqlite.prepare(`UPDATE automation_clients SET expires_at = ? WHERE id = ?`).run(Date.now() - 25 * 3_600_000, app2.grantId);
    expect((await t.call('GET', '/api/v1/agent-connections')).body).toHaveLength(1);

    // Another account can neither see nor disconnect them.
    const owner = t.cookie();
    await signIn(t, 'oauth-other@example.com');
    expect((await t.call('GET', '/api/v1/agent-connections')).body).toEqual([]);
    expect((await t.call('DELETE', `/api/v1/agent-connections/${key.body.clientId}`)).status).toBe(404);
    t.setCookie(owner);

    const all = await t.call('DELETE', '/api/v1/agent-connections');
    expect(all.body).toEqual({ revoked: 2 });
    expect((await t.call('GET', '/api/v1/agent-connections')).body).toEqual([]);
    const audit = t.d1.sqlite.prepare(`SELECT detail FROM audit_log WHERE action = 'automation.clients_revoked'`).get() as { detail: string };
    expect(audit.detail).toContain('disconnect_all');
  });

  it('ends sign-ins, and approvals not yet exchanged, on disconnect all, sign out everywhere and deletion', async () => {
    const one = await signedIn();
    const pending = codeOf((await decide(one.clientId)).body.redirect);
    expect((await t.call('DELETE', '/api/v1/agent-connections')).body).toEqual({ revoked: 1 });
    expect((await exchange(one.clientId, pending)).body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') });
    expect(t.d1.sqlite.prepare(`SELECT count(*) AS n FROM automation_clients WHERE kind = 'oauth' AND revoked_at IS NULL`).get()).toEqual({ n: 0 });

    const two = await signedIn();
    const later = codeOf((await decide(two.clientId)).body.redirect);
    expect((await t.call('POST', '/api/auth/revoke-sessions', {})).status).toBe(200);
    await t.settle();
    expect(await mcp(two.access)).toEqual({ ok: false, reason: 'invalid_token' });
    expect((await refresh(two.clientId, two.refresh)).body).toMatchObject({ error: 'invalid_grant' });
    expect((await exchange(two.clientId, later)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('spends a deleted browser\'s approvals in the deletion itself', async () => {
    const clientId: string = (await register()).body.client_id;
    const code = codeOf((await decide(clientId)).body.redirect);
    expect((await t.call('DELETE', `/api/v1/instances/${instanceId}`, undefined, { 'idempotency-key': 'delete-oauth' })).status).toBe(202);
    expect(t.d1.sqlite.prepare(`SELECT used_at FROM oauth_authorization_codes`).get()).toEqual({ used_at: expect.any(Number) });
    expect((await exchange(clientId, code)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('limits registration and token calls, and sweeps spent codes and apps that never signed in', async () => {
    const used = await signedIn();
    const stale: string = (await register()).body.client_id;
    const unusedCode = codeOf((await decide(stale)).body.redirect);
    expect(unusedCode).toBeTruthy();
    const old = Date.now() - 8 * 86_400_000;
    t.d1.sqlite.prepare(`UPDATE oauth_clients SET created_at = ?, last_used_at = NULL WHERE id IN (?, ?)`).run(old, used.clientId, stale);
    t.d1.sqlite.prepare(`UPDATE oauth_authorization_codes SET expires_at = ?`).run(Date.now() - 2 * 86_400_000);
    const rotated = (await refresh(used.clientId, used.refresh)).body as { refresh_token: string };
    expect(await oauthSweep(createDb(t.d1 as never))).toEqual({ codes: 2, spentTokens: 0, apps: 1 });
    expect(t.d1.sqlite.prepare(`SELECT id FROM oauth_clients ORDER BY id`).all()).toEqual([{ id: used.clientId }]);
    // Replaced refresh tokens go once their sign-in is over.
    t.d1.sqlite.prepare(`UPDATE automation_clients SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, used.grantId);
    expect(await oauthSweep(createDb(t.d1 as never))).toMatchObject({ spentTokens: 1 });
    t.d1.sqlite.prepare(`UPDATE automation_clients SET expires_at = ? WHERE id = ?`).run(Date.now() + 86_400_000, used.grantId);

    // Refreshes are counted per sign-in, so an app's other users and a shared address are unaffected.
    const keys: string[] = [];
    Object.assign(t.env, { OAUTH_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !key.startsWith('oauth-refresh:') }; } } });
    expect((await refresh(used.clientId, rotated.refresh_token)).status).toBe(429);
    expect(keys).toEqual([`oauth-refresh:${used.grantId}`]);
    // Failed calls are counted per address; over budget, the address is refused for a minute.
    Object.assign(t.env, { OAUTH_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !key.startsWith('oauth-fail:') }; } } });
    const fromIp = { headers: { 'cf-connecting-ip': '198.51.100.9' } };
    expect((await raw('POST', '/api/oauth/token', { grant_type: 'refresh_token', refresh_token: `nvzr_${'x'.repeat(43)}`, client_id: used.clientId }, fromIp)).status).toBe(400);
    expect(keys.at(-1)).toBe('oauth-fail:198.51.100.9');
    expect((await raw('POST', '/api/oauth/token', { grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: used.clientId }, fromIp)).status).toBe(429);
    expect((await raw('POST', '/api/oauth/revoke', { token: 'x', client_id: used.clientId }, fromIp)).status).toBe(429);
    // Another address is not affected.
    expect((await refresh(used.clientId, rotated.refresh_token)).status).toBe(200);
    Object.assign(t.env, { OAUTH_LIMITER: { limit: async () => ({ success: false }) } });
    expect(await register()).toMatchObject({ status: 429, body: { error: 'temporarily_unavailable' } });
  });
});
