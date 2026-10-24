/**
 * OAuth sign-in for coding agents (docs/agent-access.md, "OAuth sign-in"): the authorization server
 * of the MCP authorization spec, beside access keys. An agent adds a browser's MCP URL without a
 * key; the gateway's 401 points it here; the owner approves on the approval page (/oauth/authorize
 * in the web app), choosing the permission and how long the sign-in lasts.
 *
 * - Apps are public clients (PKCE S256, no secrets), registered through Dynamic Client Registration
 *   (RFC 7591) or identified by their Client ID Metadata Document. Their callbacks are local
 *   (http://127.0.0.1 or localhost, any port), app schemes, or the few hosted clients' websites.
 * - A sign-in is an `automation_clients` row of kind `oauth` bound to one browser. Its access token
 *   lasts an hour and is checked on every MCP request like a key (authenticateMcp), so revoking
 *   works at once; its refresh token rotates on every use until the end the owner chose, which
 *   never moves. A refresh token or code presented again revokes the sign-in.
 * - Only hashes of codes and tokens are stored, each under its own label.
 */
import { AGENT_GRANT_DAYS, AGENT_OAUTH_SCOPES, DEFAULT_AGENT_GRANT_DAYS, type AgentKeyCapability, type OAuthAuthorizeCheck, type OAuthDecision, type OAuthDecisionBody } from '@cloudbrowser/contracts';
import { eventRow, newId, schema, sha256Hex, type Db } from '@cloudbrowser/db';
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { isAdminOrigin } from './admin/access.js';
import { accessTokenHash, MAX_AGENT_KEYS, mcpUrl, newSecret, refreshTokenHash, revokeClientById, setAccess, unavailable, verifiedHostOf } from './automation.js';
import type { AppEnv, Env } from './env.js';
import { sendToUser } from './notifications/send.js';
import { agentSignInMessage } from './notifications/user.js';
import { problem } from './problem.js';

const { automationClients, browserInstances, oauthClients, oauthAuthorizationCodes, auditLog, events } = schema;

type OAuthClient = typeof oauthClients.$inferSelect;

/** An access token's life; a refresh brings a new one, never past the sign-in's end. */
const ACCESS_TOKEN_MS = 3_600_000;
const CODE_MS = 60_000;
/** A refresh token presented again this soon after it was replaced is a duplicate in flight, not a stolen copy. */
const REFRESH_GRACE_MS = 30_000;
/** How long a metadata document is trusted before it is read again. */
const METADATA_TTL_MS = 86_400_000;
const METADATA_MAX_BYTES = 5_120;
const METADATA_TIMEOUT_MS = 3_000;
/** Registered apps that never got a sign-in are forgotten after this (some clients register on every connect). */
const UNUSED_CLIENT_MS = 7 * 86_400_000;
const MAX_BODY_BYTES = 16_384;
/**
 * Websites a registered app may return to: the hosted MCP clients. Local callbacks and installed
 * apps' schemes are always accepted; any other website is refused until someone needs it.
 */
const WEB_CALLBACK_HOSTS = new Set(['claude.ai', 'claude.com', 'chatgpt.com', 'vscode.dev', 'insiders.vscode.dev']);
/** Schemes that are not an installed app's callback. */
const REFUSED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'about', 'blob', 'filesystem', 'view-source', 'ftp', 'ws', 'wss', 'mailto', 'tel', 'sms', 'intent']);

const CLIENT_ID = /^nvzc_[A-Za-z0-9]{24}$/;
const AUTH_CODE = /^[A-Za-z0-9]{43}$/;
const ACCESS_TOKEN = /^nvza_[A-Za-z0-9]{43}$/;
const REFRESH_TOKEN = /^nvzr_[A-Za-z0-9]{43}$/;
/** base64url of a SHA-256 (RFC 7636). */
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const codeHash = (code: string) => sha256Hex(`oauth-code:${code}`);

export const issuer = (env: Pick<Env, 'APP_URL'>) => new URL(env.APP_URL).origin;

/** RFC 8414 metadata, at /.well-known/oauth-authorization-server. */
export function authorizationServerMetadata(env: Pick<Env, 'APP_URL'>) {
  const iss = issuer(env);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/api/oauth/token`,
    registration_endpoint: `${iss}/api/oauth/register`,
    revocation_endpoint: `${iss}/api/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [AGENT_OAUTH_SCOPES.control, AGENT_OAUTH_SCOPES.view],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${iss}/docs/coding-agents`,
  };
}

// --- apps and their callbacks ----------------------------------------------------------------

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** What an app says about itself, cleaned for display: no control or direction characters, one line. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  return text.slice(0, max) || null;
}

/**
 * Whether an app may return to this callback: a local one (http on 127.0.0.1, localhost or [::1]),
 * an installed app's scheme, or a hosted client's website (or, for a metadata document, its own host).
 */
export function callbackAllowed(uri: string, ownHost?: string): boolean {
  if (uri.length > 512 || uri.includes('#')) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const scheme = u.protocol.slice(0, -1);
  if (scheme === 'http') return isLoopback(u.hostname);
  if (scheme === 'https') return WEB_CALLBACK_HOSTS.has(u.hostname) || (!!ownHost && u.hostname === ownHost);
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && !REFUSED_SCHEMES.has(scheme);
}

function loopbackParts(uri: string) {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && isLoopback(u.hostname) ? { host: u.hostname, path: u.pathname, search: u.search } : null;
  } catch {
    return null;
  }
}

/** The callback an app asks for against those it registered: exactly, or a local one on any port (RFC 8252, 7.3). */
export function callbackMatches(registered: readonly string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  const a = loopbackParts(asked);
  return !!a && registered.some((r) => {
    const b = loopbackParts(r);
    return !!b && b.host === a.host && b.path === a.path && b.search === a.search;
  });
}

/** Where approving sends the user, as the approval page names it. */
function callbackKind(uri: string): { kind: 'loopback' | 'app' | 'web'; label: string } {
  const u = new URL(uri);
  if (u.protocol === 'http:') return { kind: 'loopback', label: u.hostname };
  if (u.protocol === 'https:') return { kind: 'web', label: u.host };
  return { kind: 'app', label: `${u.protocol}//` };
}

/** A metadata document's URL as a client id: https, a path, a public host name, and written exactly as the URL parser would. */
function metadataUrl(clientId: string): string | null {
  if (clientId.length > 512) return null;
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return null;
  }
  const host = u.hostname;
  if (u.protocol !== 'https:' || u.href !== clientId || u.username || u.password || u.hash || u.port || u.pathname === '/') return null;
  if (!host.includes('.') || host.endsWith('.localhost') || host.startsWith('[') || /^[\d.]+$/.test(host)) return null;
  return clientId;
}

/** At most `limit` bytes of a response body, or null when it is longer. */
async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { all.set(p, offset); offset += p.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * Reads a Client ID Metadata Document: https only, no redirects, small and quick. Its `client_id`
 * must be the URL it came from. Callbacks outside callbackAllowed are dropped (its own host's
 * websites are allowed); with none left, the app is refused.
 */
async function fetchClientMetadata(url: string) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
    if (res.status !== 200) return null;
    if (Number(res.headers.get('content-length') ?? 0) > METADATA_MAX_BYTES) return null;
    const text = await readLimited(res.body, METADATA_MAX_BYTES);
    if (text === null) return null;
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (!doc || typeof doc !== 'object' || doc.client_id !== url) return null;
    if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') return null;
    const host = new URL(url).hostname;
    const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === 'string' && callbackAllowed(u, host)).slice(0, 10) : [];
    if (!redirectUris.length) return null;
    return {
      name: cleanText(doc.client_name, 80) ?? host,
      clientUri: typeof doc.client_uri === 'string' && doc.client_uri.startsWith('https://') ? doc.client_uri.slice(0, 512) : null,
      redirectUris,
      softwareId: cleanText(doc.software_id, 120),
      softwareVersion: cleanText(doc.software_version, 60),
    };
  } catch {
    return null;
  }
}

/** An app by its client id: a registered one, or one whose metadata document is (read again, at most daily and) cached. */
export async function resolveClient(db: Db, clientId: string, now = new Date()): Promise<OAuthClient | null> {
  if (CLIENT_ID.test(clientId)) {
    const [row] = await db.select().from(oauthClients).where(and(eq(oauthClients.id, clientId), eq(oauthClients.kind, 'dcr')));
    return row ?? null;
  }
  const url = metadataUrl(clientId);
  if (!url) return null;
  const [cached] = await db.select().from(oauthClients).where(and(eq(oauthClients.id, url), eq(oauthClients.kind, 'cimd')));
  if (cached?.fetchedAt && now.getTime() - cached.fetchedAt.getTime() < METADATA_TTL_MS) return cached;
  const doc = await fetchClientMetadata(url);
  if (!doc) return null;
  const row: OAuthClient = { id: url, kind: 'cimd', ...doc, createdAt: cached?.createdAt ?? now, fetchedAt: now, lastUsedAt: cached?.lastUsedAt ?? null };
  await db.insert(oauthClients).values(row).onConflictDoUpdate({
    target: oauthClients.id,
    set: { name: row.name, clientUri: row.clientUri, redirectUris: row.redirectUris, softwareId: row.softwareId, softwareVersion: row.softwareVersion, fetchedAt: now },
  });
  return row;
}

// --- the authorization request ----------------------------------------------------------------

/** The browser a resource (RFC 8707) names: its MCP URL on the gateway, with or without a trailing slash. */
export function resourceInstance(env: Pick<Env, 'GATEWAY_URL'>, resource: string): string | null {
  const base = mcpUrl(env, '');
  if (!base) return null;
  let u: URL;
  try {
    u = new URL(resource);
  } catch {
    return null;
  }
  const gateway = new URL(base);
  if (u.protocol !== gateway.protocol || u.host !== gateway.host || u.search || u.hash || u.username || u.password) return null;
  return u.pathname.match(/^\/mcp\/([A-Za-z0-9]{1,64})\/?$/)?.[1] ?? null;
}

/** The app's callback with these parameters and the issuer (RFC 9207). */
function callbackUrl(env: Pick<Env, 'APP_URL'>, redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set('iss', issuer(env));
  return u.toString();
}

interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  /** The most the app asked for: `control` unless it asked for `browser:view` alone. */
  capability: AgentKeyCapability;
  resource: string | null;
  /** The browser the resource names; null when the app named none. */
  instanceId: string | null;
}
type Refusal = Extract<OAuthAuthorizeCheck, { ok: false }>;

/**
 * Checks an authorization request's parameters. An unknown app or callback is refused without a
 * way back (it must never be redirected to); every later problem can be reported to the callback.
 */
async function readAuthorizeRequest(db: Db, env: Pick<Env, 'APP_URL' | 'GATEWAY_URL'>, params: Record<string, string>, now: Date): Promise<{ ok: true; request: AuthorizeRequest } | Refusal> {
  const client = params.client_id ? await resolveClient(db, params.client_id, now) : null;
  if (!client) {
    return { ok: false, error: 'invalid_client', description: 'This app is not known to Nevazu: it did not register, or its metadata document could not be read.', redirect: null };
  }
  const redirectUri = params.redirect_uri ?? '';
  if (!redirectUri || !callbackMatches(client.redirectUris, redirectUri)) {
    return { ok: false, error: 'invalid_request', description: 'The app asked to return to an address it did not register.', redirect: null };
  }
  const state = params.state;
  const refuse = (error: string, description: string): Refusal => ({ ok: false, error, description, redirect: callbackUrl(env, redirectUri, { error, error_description: description, state }) });
  if (params.response_type !== 'code') return refuse('unsupported_response_type', 'Only the authorization code flow is supported.');
  if (params.code_challenge_method !== 'S256' || !CODE_CHALLENGE.test(params.code_challenge ?? '')) return refuse('invalid_request', 'PKCE with S256 is required.');
  // Unknown scopes (offline_access, openid) are ignored: a sign-in always gets a refresh token.
  const scopes = new Set((params.scope ?? '').split(' ').filter(Boolean));
  const capability: AgentKeyCapability = scopes.has(AGENT_OAUTH_SCOPES.view) && !scopes.has(AGENT_OAUTH_SCOPES.control) ? 'view' : 'control';
  const resource = params.resource || null;
  const instanceId = resource ? resourceInstance(env, resource) : null;
  if (resource && !instanceId) return refuse('invalid_target', 'The app asked for something other than a Nevazu browser\'s MCP server.');
  return { ok: true, request: { client, redirectUri, state, codeChallenge: params.code_challenge!, capability, resource, instanceId } };
}

async function userBrowsers(db: Db, userId: string) {
  const rows = await db.select({ id: browserInstances.id, name: browserInstances.name, agentAccess: browserInstances.agentAccess, desiredState: browserInstances.desiredState, status: browserInstances.status })
    .from(browserInstances).where(eq(browserInstances.userId, userId)).orderBy(asc(browserInstances.createdAt));
  return rows.filter((r) => !unavailable(r)).map(({ id, name, agentAccess }) => ({ id, name, agentAccess }));
}

/** What the approval page shows the signed-in user, or why the request cannot be approved. */
export async function checkAuthorization(db: Db, env: Pick<Env, 'APP_URL' | 'GATEWAY_URL'>, userId: string, params: Record<string, string>, now = new Date()): Promise<OAuthAuthorizeCheck> {
  const read = await readAuthorizeRequest(db, env, params, now);
  if (!read.ok) return read;
  const { request } = read;
  const browsers = await userBrowsers(db, userId);
  const browser = request.instanceId ? browsers.find((b) => b.id === request.instanceId) ?? null : null;
  if (request.instanceId && !browser) {
    const description = 'This browser is not in the account you are signed in to, or it was deleted.';
    return { ok: false, error: 'invalid_target', description, redirect: callbackUrl(env, request.redirectUri, { error: 'invalid_target', error_description: description, state: request.state }) };
  }
  return {
    ok: true,
    client: { name: request.client.name, verifiedHost: verifiedHostOf(request.client) },
    redirect: callbackKind(request.redirectUri),
    capability: request.capability,
    browser,
    browsers: browser ? [] : browsers,
    grantDays: [...AGENT_GRANT_DAYS],
    defaultGrantDays: DEFAULT_AGENT_GRANT_DAYS,
  };
}

/**
 * The owner's answer. Approving issues a 60-second code for the chosen browser, permission and
 * length, and emails the owner, since a stolen session could approve an app too; the sign-in
 * itself is made when the app exchanges the code.
 */
export async function decideAuthorization(
  db: Db, env: Env, waitUntil: (p: Promise<unknown>) => void, userId: string, body: OAuthDecisionBody, now = new Date(),
): Promise<OAuthDecision> {
  const read = await readAuthorizeRequest(db, env, body.params, now);
  if (!read.ok) {
    if (!body.approve && read.redirect) return { redirect: read.redirect };
    throw problem(400, 'validation_failed', read.description);
  }
  const { request } = read;
  const back = (params: Record<string, string>) => callbackUrl(env, request.redirectUri, { ...params, state: request.state });
  if (!body.approve) return { redirect: back({ error: 'access_denied', error_description: 'The owner declined the request.' }) };
  const instanceId = request.instanceId ?? body.instanceId;
  if (!instanceId) throw problem(400, 'validation_failed', 'Choose the browser this app may use.');
  if (request.instanceId && body.instanceId && body.instanceId !== request.instanceId) throw problem(400, 'validation_failed', 'The app asked for another browser.');
  const [row] = await db.select().from(browserInstances).where(and(eq(browserInstances.id, instanceId), eq(browserInstances.userId, userId)));
  if (!row || unavailable(row)) throw problem(404, 'not_found');
  if (!row.agentAccess) {
    if (!body.enableAccess) throw problem(409, 'agent_access_off', 'Coding agent access is turned off for this browser. Turn it on to approve.');
    await setAccess(db, env, userId, row, true, now);
  }
  const [active] = await db.select({ n: sql<number>`count(*)` }).from(automationClients).where(and(
    eq(automationClients.instanceId, row.id), eq(automationClients.kind, 'oauth'), isNull(automationClients.revokedAt), gt(automationClients.expiresAt, now),
  ));
  if ((active?.n ?? 0) >= MAX_AGENT_KEYS) {
    throw problem(409, 'agent_grant_limit', `A browser can have at most ${MAX_AGENT_KEYS} active sign-ins. Disconnect one you no longer use first.`);
  }
  const capability: AgentKeyCapability = request.capability === 'view' ? 'view' : body.capability ?? 'control';
  const code = newSecret('');
  await db.batch([
    db.insert(oauthAuthorizationCodes).values({
      codeHash: await codeHash(code), clientId: request.client.id, userId, instanceId: row.id, redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge, resource: request.resource, capability, grantDays: body.grantDays, createdAt: now, expiresAt: new Date(now.getTime() + CODE_MS),
    }),
    db.insert(auditLog).values({ actor: `user:${userId}`, action: 'automation.oauth_approved', target: `instance:${row.id}`,
      detail: { app: request.client.id, name: request.client.name, capability, grantDays: body.grantDays }, createdAt: now }),
  ]);
  waitUntil(sendToUser(env, db, userId, agentSignInMessage(request.client.name, row.name, body.grantDays, capability === 'view', `${env.APP_URL}/browsers/${row.id}/settings`)));
  return { redirect: back({ code }) };
}

// --- the token endpoint -----------------------------------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache', ...CORS, ...headers } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
const tooMany = () => json({ error: 'temporarily_unavailable', error_description: 'Too many requests; try again in a minute.' }, 429, { 'retry-after': '60' });

/** A token or revocation request's parameters: form-encoded as OAuth says, or JSON from lenient clients. */
async function readParams(req: Request): Promise<URLSearchParams | null> {
  const text = await readLimited(req.body, MAX_BODY_BYTES);
  if (text === null) return null;
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return null;
    }
  }
  return new URLSearchParams(text);
}

const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkceChallenge = async (verifier: string) => base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

function tokenResponse(access: string, refresh: string, accessEnd: Date, now: Date, capability: string) {
  return json({
    access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.round((accessEnd.getTime() - now.getTime()) / 1000)),
    refresh_token: refresh, scope: AGENT_OAUTH_SCOPES[capability === 'view' ? 'view' : 'control'],
  });
}

const instanceAlive = async (db: Db, instanceId: string, userId: string) => {
  const [inst] = await db.select({ status: browserInstances.status, desiredState: browserInstances.desiredState })
    .from(browserInstances).where(and(eq(browserInstances.id, instanceId), eq(browserInstances.userId, userId)));
  return !!inst && !unavailable(inst);
};

/** The code from the approval page, for the sign-in's first tokens. */
async function exchangeCode(db: Db, env: Env, form: URLSearchParams, now: Date): Promise<Response> {
  const code = form.get('code') ?? '';
  if (!AUTH_CODE.test(code)) return oauthError('invalid_grant', 'The authorization code is not valid.');
  const hash = await codeHash(code);
  const [row] = await db.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.codeHash, hash));
  if (!row) return oauthError('invalid_grant', 'The authorization code is not valid.');
  if (row.usedAt) {
    // A code is used once; seen again, whatever was made with it may be in the wrong hands.
    if (row.grantId) await revokeClientById(db, env, row.grantId, `automation:${row.grantId}`, 'code_reused', now);
    return oauthError('invalid_grant', 'The authorization code was already used.');
  }
  if (row.expiresAt <= now) return oauthError('invalid_grant', 'The authorization code has expired; approve again.');
  if (form.get('client_id') !== row.clientId) return oauthError('invalid_grant', 'The authorization code was issued to another app.');
  if (form.get('redirect_uri') !== row.redirectUri) return oauthError('invalid_grant', 'redirect_uri does not match the authorization request.');
  const verifier = form.get('code_verifier') ?? '';
  if (!CODE_VERIFIER.test(verifier) || (await pkceChallenge(verifier)) !== row.codeChallenge) return oauthError('invalid_grant', 'PKCE verification failed.');
  const resource = form.get('resource');
  if (resource && resourceInstance(env, resource) !== row.instanceId) return oauthError('invalid_target', 'The resource is not the browser that was approved.');
  // Used once, even when two exchanges race.
  const claimed = await db.update(oauthAuthorizationCodes).set({ usedAt: now })
    .where(and(eq(oauthAuthorizationCodes.codeHash, hash), isNull(oauthAuthorizationCodes.usedAt))).returning({ codeHash: oauthAuthorizationCodes.codeHash });
  if (!claimed.length) return oauthError('invalid_grant', 'The authorization code was already used.');
  if (!(await instanceAlive(db, row.instanceId, row.userId))) return oauthError('invalid_grant', 'The browser was deleted.');
  const [app] = await db.select({ name: oauthClients.name }).from(oauthClients).where(eq(oauthClients.id, row.clientId));
  const grantEnd = new Date(now.getTime() + row.grantDays * 86_400_000);
  const accessEnd = new Date(Math.min(now.getTime() + ACCESS_TOKEN_MS, grantEnd.getTime()));
  const access = newSecret('nvza_');
  const refresh = newSecret('nvzr_');
  const grantId = newId(now.getTime());
  await db.batch([
    db.insert(automationClients).values({
      id: grantId, instanceId: row.instanceId, userId: row.userId, name: (app?.name ?? 'Coding agent').slice(0, 64), kind: 'oauth', capability: row.capability,
      credentialHash: await accessTokenHash(access), refreshHash: await refreshTokenHash(refresh), accessExpiresAt: accessEnd, expiresAt: grantEnd,
      oauthClientId: row.clientId, createdAt: now, activatedAt: now,
    }),
    db.update(oauthAuthorizationCodes).set({ grantId }).where(eq(oauthAuthorizationCodes.codeHash, hash)),
    db.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.id, row.clientId)),
    db.insert(auditLog).values({ actor: `automation:${grantId}`, action: 'automation.oauth_connected', target: `instance:${row.instanceId}`,
      detail: { clientId: grantId, app: row.clientId, capability: row.capability, expiresAt: grantEnd.toISOString() }, createdAt: now }),
    db.insert(events).values(eventRow(row.userId, 'instance.updated', { instanceId: row.instanceId }, now)),
  ]);
  return tokenResponse(access, refresh, accessEnd, now, row.capability);
}

/** A new access token and a new refresh token for the current one, until the sign-in's end. */
async function refreshTokens(db: Db, env: Env, form: URLSearchParams, now: Date): Promise<Response> {
  const token = form.get('refresh_token') ?? '';
  if (!REFRESH_TOKEN.test(token)) return oauthError('invalid_grant', 'The refresh token is not valid; sign in again.');
  const hash = await refreshTokenHash(token);
  const [grant] = await db.select().from(automationClients)
    .where(and(eq(automationClients.refreshHash, hash), eq(automationClients.kind, 'oauth'), isNull(automationClients.revokedAt)));
  if (!grant) {
    // The token this one was replaced by is in use: a late duplicate is forgiven, anything later is a copy.
    const [replaced] = await db.select({ id: automationClients.id, rotatedAt: automationClients.refreshRotatedAt }).from(automationClients)
      .where(and(eq(automationClients.prevRefreshHash, hash), isNull(automationClients.revokedAt)));
    if (replaced && (!replaced.rotatedAt || now.getTime() - replaced.rotatedAt.getTime() >= REFRESH_GRACE_MS)) {
      await revokeClientById(db, env, replaced.id, `automation:${replaced.id}`, 'refresh_reused', now);
    }
    return oauthError('invalid_grant', 'The refresh token is not valid; sign in again.');
  }
  if (form.get('client_id') !== grant.oauthClientId) return oauthError('invalid_grant', 'The refresh token was issued to another app.');
  if (!grant.expiresAt || grant.expiresAt <= now) return oauthError('invalid_grant', 'This sign-in has ended; sign in again.');
  const resource = form.get('resource');
  if (resource && resourceInstance(env, resource) !== grant.instanceId) return oauthError('invalid_target', 'The resource is not the browser this sign-in is for.');
  if (!(await instanceAlive(db, grant.instanceId, grant.userId))) return oauthError('invalid_grant', 'The browser was deleted.');
  const accessEnd = new Date(Math.min(now.getTime() + ACCESS_TOKEN_MS, grant.expiresAt.getTime()));
  const access = newSecret('nvza_');
  const refresh = newSecret('nvzr_');
  const rotated = await db.update(automationClients).set({
    credentialHash: await accessTokenHash(access), refreshHash: await refreshTokenHash(refresh), prevRefreshHash: hash, refreshRotatedAt: now, accessExpiresAt: accessEnd,
  }).where(and(eq(automationClients.id, grant.id), eq(automationClients.refreshHash, hash), isNull(automationClients.revokedAt))).returning({ id: automationClients.id });
  if (!rotated.length) return oauthError('invalid_grant', 'The refresh token is not valid; sign in again.');
  return tokenResponse(access, refresh, accessEnd, now, grant.capability);
}

/** RFC 7009: the app's own sign-out. Either token ends the whole sign-in; unknown tokens are answered the same way. */
async function revokeToken(db: Db, env: Env, form: URLSearchParams, now: Date) {
  const token = form.get('token') ?? '';
  const where = REFRESH_TOKEN.test(token) ? eq(automationClients.refreshHash, await refreshTokenHash(token))
    : ACCESS_TOKEN.test(token) ? eq(automationClients.credentialHash, await accessTokenHash(token)) : null;
  if (!where) return;
  const [grant] = await db.select({ id: automationClients.id, app: automationClients.oauthClientId }).from(automationClients)
    .where(and(where, eq(automationClients.kind, 'oauth'), isNull(automationClients.revokedAt)));
  if (grant && grant.app === form.get('client_id')) await revokeClientById(db, env, grant.id, `automation:${grant.id}`, 'app_signed_out', now);
}

/** RFC 7591 for public clients: callbacks checked by callbackAllowed, everything else is the app's say. */
async function register(db: Db, body: unknown, now: Date): Promise<Response> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return oauthError('invalid_client_metadata', 'Send the client metadata as a JSON object.');
  const meta = body as Record<string, unknown>;
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u): u is string => typeof u === 'string')) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must list 1 to 10 callback URLs.');
  }
  const refused = uris.find((u) => !callbackAllowed(u));
  if (refused !== undefined) {
    return oauthError('invalid_redirect_uri', `This callback is not accepted: ${refused.slice(0, 200)}. Use a local callback (http://127.0.0.1 or http://localhost, any port) or an app scheme.`);
  }
  const listOf = (v: unknown) => (Array.isArray(v) ? v : []);
  if (meta.grant_types !== undefined && !listOf(meta.grant_types).every((g) => g === 'authorization_code' || g === 'refresh_token')) {
    return oauthError('invalid_client_metadata', 'Only the authorization_code and refresh_token grants are supported.');
  }
  if (meta.response_types !== undefined && !listOf(meta.response_types).every((r) => r === 'code')) {
    return oauthError('invalid_client_metadata', 'Only the code response type is supported.');
  }
  const row = {
    id: newSecret('nvzc_', 24), kind: 'dcr', name: cleanText(meta.client_name, 80) ?? 'Coding agent',
    clientUri: typeof meta.client_uri === 'string' && meta.client_uri.startsWith('https://') ? meta.client_uri.slice(0, 512) : null,
    redirectUris: uris, softwareId: cleanText(meta.software_id, 120), softwareVersion: cleanText(meta.software_version, 60), createdAt: now,
  };
  await db.insert(oauthClients).values(row);
  return json({
    client_id: row.id, client_id_issued_at: Math.floor(now.getTime() / 1000), client_name: row.name, redirect_uris: row.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    ...(row.clientUri ? { client_uri: row.clientUri } : {}), ...(row.softwareId ? { software_id: row.softwareId } : {}), ...(row.softwareVersion ? { software_version: row.softwareVersion } : {}),
  }, 201);
}

/** Over budget: registrations per address, token and revocation calls per app (or address). */
async function limited(env: Env, key: string) {
  if (!env.OAUTH_LIMITER) return false;
  const { success } = await env.OAUTH_LIMITER.limit({ key }).catch(() => ({ success: true }));
  return !success;
}

/**
 * The public endpoints: metadata, registration, token and revocation. No session and no origin
 * check (apps call them from anywhere); the approval itself is a signed-in call (routes/oauth.ts).
 */
export const oauthPublicRoute = new Hono<AppEnv>();

oauthPublicRoute.get('/.well-known/oauth-authorization-server', (c) => {
  if (isAdminOrigin(c.env, c.req.url)) return c.notFound();
  return json(authorizationServerMetadata(c.env), 200, { 'cache-control': 'public, max-age=3600' });
});
// Discovery tries OpenID Connect too; there is none, and the app's fallback page must not answer for it.
oauthPublicRoute.get('/.well-known/openid-configuration', () => json({ error: 'not_found' }, 404));

oauthPublicRoute.options('/api/oauth/*', () => new Response(null, { status: 204, headers: CORS }));

oauthPublicRoute.post('/api/oauth/register', async (c) => {
  if (await limited(c.env, `oauth-register:${c.req.header('cf-connecting-ip') ?? 'unknown'}`)) return tooMany();
  const text = await readLimited(c.req.raw.body, MAX_BODY_BYTES);
  let body: unknown = null;
  try {
    body = text === null ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return register(c.get('db'), body, new Date());
});

oauthPublicRoute.post('/api/oauth/token', async (c) => {
  const form = await readParams(c.req.raw);
  if (!form) return oauthError('invalid_request', 'Send the parameters as application/x-www-form-urlencoded.');
  if (await limited(c.env, `oauth-token:${form.get('client_id') || c.req.header('cf-connecting-ip') || 'unknown'}`)) return tooMany();
  const now = new Date();
  switch (form.get('grant_type')) {
    case 'authorization_code': return exchangeCode(c.get('db'), c.env, form, now);
    case 'refresh_token': return refreshTokens(c.get('db'), c.env, form, now);
    default: return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }
});

oauthPublicRoute.post('/api/oauth/revoke', async (c) => {
  const form = await readParams(c.req.raw);
  if (!form) return oauthError('invalid_request', 'Send the parameters as application/x-www-form-urlencoded.');
  if (await limited(c.env, `oauth-token:${form.get('client_id') || c.req.header('cf-connecting-ip') || 'unknown'}`)) return tooMany();
  await revokeToken(c.get('db'), c.env, form, new Date());
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store', ...CORS } });
});

/**
 * Nightly: spent codes, and apps that never got a sign-in (some clients register again on every
 * connect). An app with any sign-in, even a revoked one, stays for the audit trail.
 */
export async function oauthSweep(db: Db, now = new Date()) {
  const codes = await db.delete(oauthAuthorizationCodes).where(lt(oauthAuthorizationCodes.expiresAt, new Date(now.getTime() - 86_400_000)))
    .returning({ codeHash: oauthAuthorizationCodes.codeHash });
  const before = new Date(now.getTime() - UNUSED_CLIENT_MS);
  const apps = await db.delete(oauthClients).where(and(
    lt(oauthClients.createdAt, before),
    or(isNull(oauthClients.lastUsedAt), lt(oauthClients.lastUsedAt, before)),
    sql`not exists (select 1 from ${automationClients} where ${automationClients.oauthClientId} = ${oauthClients.id})`,
    sql`not exists (select 1 from ${oauthAuthorizationCodes} where ${oauthAuthorizationCodes.clientId} = ${oauthClients.id})`,
  )).returning({ id: oauthClients.id });
  return { codes: codes.length, apps: apps.length };
}
