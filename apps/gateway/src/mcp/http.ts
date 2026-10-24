import { AGENT_OAUTH_SCOPES, isObjectLocationHint } from '@cloudbrowser/contracts';
import type { Env } from '../env.js';
import { connectionLog } from '../connection-log.js';
import { isToolName, SERVER_INSTRUCTIONS, TOOLS } from './tools.js';

/**
 * The remote MCP endpoint, `POST /mcp/:instanceId` (docs/agent-access.md): Streamable HTTP in its
 * stateless form. Every request carries the access key or a sign-in's access token (OAuth, when
 * MCP_OAUTH is on); every answer is a single JSON body (never
 * an event stream), and no `Mcp-Session-Id` is issued, so any request can arrive on its own, with
 * or without an `initialize` before it. The handshake, `ping` and `tools/list` are answered here;
 * tool calls and cancellations go to the browser's Durable Object, which holds the agent's session.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const SERVER_VERSION = '1.0.0';
const MAX_BODY_BYTES = 1024 * 1024;
/** Access keys, a retired bridge's credentials, and sign-ins' access tokens. */
const KEY_FORMAT = /^(?:nvz[ka]_[A-Za-z0-9]{43}|[0-9a-f]{64})$/;
/** An address whose failed authentications hit the limiter is refused here, without an api call, for this long. */
const BLOCK_MS = 60_000;

type JsonRpcId = string | number;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

/**
 * Addresses refused for repeated failed authentications, per isolate. The limiter decides; this
 * only keeps a refused address from costing an api call per attempt until its minute is over.
 */
const blocked = new Map<string, number>();
export function isBlocked(ip: string, now = Date.now()) {
  const until = blocked.get(ip);
  if (until && until > now) return true;
  if (until) blocked.delete(ip);
  return false;
}
function block(ip: string, now = Date.now()) {
  if (blocked.size >= 1000) blocked.delete(blocked.keys().next().value!);
  blocked.set(ip, now + BLOCK_MS);
}
/** For tests: forget every blocked address. */
export function resetBlocks() {
  blocked.clear();
}

/** Counts a failed authentication; true when this address is over its budget (and is now blocked). */
export async function failedAttempt(limiter: RateLimit | undefined, key: string, ip: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key }).catch(() => ({ success: true }));
  if (!success) block(ip);
  return !success;
}

export const oauthOn = (env: Pick<Env, 'MCP_OAUTH' | 'OAUTH_ISSUER'>) => env.MCP_OAUTH === 'on' && !!env.OAUTH_ISSUER;

const METADATA_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'mcp-protocol-version' };

/**
 * RFC 9728 metadata of a browser's MCP server, at /.well-known/oauth-protected-resource/mcp/:id:
 * the resource (the URL as the agent wrote it, trailing slash and all) and its authorization
 * server. It is the same for every well-formed id, so it never says whether a browser exists.
 */
export function protectedResourceMetadata(req: Request, env: Env, instanceId: string, slash: boolean): Response {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: METADATA_CORS });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET', ...METADATA_CORS } });
  const issuer = env.OAUTH_ISSUER!.replace(/\/$/, '');
  return new Response(JSON.stringify({
    resource: `${new URL(req.url).origin}/mcp/${instanceId}${slash ? '/' : ''}`,
    authorization_servers: [issuer],
    scopes_supported: [AGENT_OAUTH_SCOPES.control, AGENT_OAUTH_SCOPES.view],
    bearer_methods_supported: ['header'],
    resource_name: 'Nevazu cloud browser',
    resource_documentation: `${issuer}/docs/coding-agents`,
  }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', ...METADATA_CORS } });
}

export function allowedOrigins(env: Pick<Env, 'MCP_ALLOWED_ORIGINS'>): Set<string> {
  return new Set((env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean));
}

/** The protocol version for an `initialize` (or `server/discover`): the client's when supported, else the newest. */
export function negotiate(asked: unknown): string {
  return typeof asked === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
}

export function serverInfo(asked: unknown) {
  return {
    protocolVersion: negotiate(asked),
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'nevazu', title: 'Nevazu cloud browser', version: SERVER_VERSION },
    instructions: SERVER_INSTRUCTIONS,
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin ? {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
    'access-control-expose-headers': 'www-authenticate',
    vary: 'origin',
  } : {};
}

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

const rpcError = (id: JsonRpcId | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });

/** At most `limit` bytes of the body, or null when it is longer. */
async function readBody(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
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

const validId = (id: unknown): id is JsonRpcId => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

/**
 * The browser's object. `location` (from the api: objectLocationHint) only counts for the call
 * that creates it: an object stays where it was created, near its first caller without a hint.
 * A hint this version does not know is ignored.
 */
export function stub(env: Env, instanceId: string, location?: string) {
  const id = env.INSTANCE_GATEWAY.idFromName(instanceId);
  return isObjectLocationHint(location) ? env.INSTANCE_GATEWAY.get(id, { locationHint: location }) : env.INSTANCE_GATEWAY.get(id);
}

export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext, instanceId: string): Promise<Response> {
  const origin = req.headers.get('origin');
  // A page in a browser could otherwise use a key it got hold of (CSRF, DNS rebinding). Coding
  // agents send no Origin.
  if (origin && !allowedOrigins(env).has(origin)) return json(rpcError(null, -32600, 'Origin not allowed'), 403);
  const cors = corsHeaders(origin);
  if (req.method === 'OPTIONS' && origin) return new Response(null, { status: 204, headers: cors });
  // No server-initiated stream (GET) and no sessions to end (DELETE): POST only, never a redirect.
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', ...cors } });
  const version = req.headers.get('mcp-protocol-version');
  if (version && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version; supported: ${MCP_PROTOCOL_VERSIONS.join(', ')}`), 400, cors);
  }

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const [scheme, key = ''] = (req.headers.get('authorization') ?? '').split(' ');
  // What the agent sent decides the challenge. A key that failed keeps the plain one, so a key
  // user is never pushed into a sign-in; no credential, or a sign-in's token, names the metadata
  // for OAuth (RFC 9728) when it is on.
  const sent = scheme?.toLowerCase() !== 'bearer' ? 'none' : key.startsWith('nvza_') ? 'oauth' : /^(?:nvzk_|[0-9a-f]{64}$)/.test(key) ? 'key' : 'none';
  const oauth = oauthOn(env) && sent !== 'key';
  const path = new URL(req.url).pathname;
  const challenge = oauth
    ? `Bearer realm="nevazu", resource_metadata="${new URL(req.url).origin}/.well-known/oauth-protected-resource/mcp/${instanceId}${path.endsWith('/') ? '/' : ''}", scope="${AGENT_OAUTH_SCOPES.control}"${sent === 'oauth' ? ', error="invalid_token"' : ''}`
    : 'Bearer realm="nevazu"';
  const unauthorized = async (id: JsonRpcId | null, message: string) => {
    if (await failedAttempt(env.MCP_LIMITER, `mcp-fail:${ip}`, ip)) return json(rpcError(id, -32000, 'Too many failed attempts; try again in a minute.'), 429, { 'retry-after': '60', ...cors });
    connectionLog('mcp_auth_rejected', { instanceId, role: 'mcp', status: 401 });
    return json(rpcError(id, -32001, message), 401, { 'www-authenticate': challenge, ...cors });
  };
  if (isBlocked(ip)) return json(rpcError(null, -32000, 'Too many failed attempts; try again in a minute.'), 429, { 'retry-after': '60', ...cors });
  if (scheme?.toLowerCase() !== 'bearer' || !KEY_FORMAT.test(key)) {
    return unauthorized(null, oauth
      ? 'Unauthorized: sign in to Nevazu (your MCP client offers it for this server), or send this browser\'s access key as "Authorization: Bearer <key>".'
      : 'Unauthorized: send this browser\'s access key as "Authorization: Bearer <key>". Create one in the browser\'s Settings → Coding agent access.');
  }

  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(rpcError(null, -32600, 'Request too large'), 413, cors);
  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) return json(rpcError(null, -32600, 'Request too large'), 413, cors);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400, cors);
  }
  if (Array.isArray(message)) return json(rpcError(null, -32600, 'Batch requests are not supported; send one message per request.'), 400, cors);
  if (!message || typeof message !== 'object') return json(rpcError(null, -32600, 'Invalid request'), 400, cors);
  const msg = message as Message;
  const hasId = 'id' in msg && msg.id !== undefined;
  if (msg.jsonrpc !== '2.0' || (hasId && !validId(msg.id))) return json(rpcError(null, -32600, 'Invalid request'), 400, cors);
  const id = hasId ? (msg.id as JsonRpcId) : null;
  const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params as Record<string, unknown> : {};

  // The MCP client names itself in `initialize`; on later requests only its user agent does.
  const clientInfo = msg.method === 'initialize' && params.clientInfo && typeof params.clientInfo === 'object' ? params.clientInfo as { name?: unknown; version?: unknown } : null;
  const client = clientInfo && typeof clientInfo.name === 'string'
    ? `${clientInfo.name}${typeof clientInfo.version === 'string' ? `/${clientInfo.version}` : ''}`.slice(0, 120)
    : undefined;
  let auth;
  try {
    auth = await env.API.authenticateMcp({ instanceId, key, ip, ...(client ? { client } : {}) });
  } catch {
    connectionLog('mcp_auth_failed', { instanceId, role: 'mcp', code: 'gateway_unavailable', status: 503 });
    return json(rpcError(id, -32603, 'The service is temporarily unavailable; try again shortly.'), 503, cors);
  }
  if (!auth.ok) {
    return unauthorized(id, sent === 'oauth'
      ? auth.reason === 'expired'
        ? 'Unauthorized: the access token has expired; refresh it, or sign in again if the sign-in has ended.'
        : 'Unauthorized: this sign-in is not valid for this browser (disconnected, or made for another browser); sign in again.'
      : auth.reason === 'expired'
        ? 'Unauthorized: this access key has expired. Create a new one in the browser\'s Settings → Coding agent access.'
        : 'Unauthorized: this access key is not valid for this browser (revoked, or made for another browser).');
  }
  // Each key's or sign-in's calls are limited, so one runaway agent cannot monopolize the gateway.
  if (env.MCP_LIMITER && !(await env.MCP_LIMITER.limit({ key: `mcp:${auth.clientId}` }).catch(() => ({ success: true }))).success) {
    return json(rpcError(id, -32000, 'Rate limited: too many calls with this key; slow down.'), 429, { 'retry-after': '10', ...cors });
  }

  const method = typeof msg.method === 'string' ? msg.method : null;
  // A response or a notification needs no answer; a cancellation stops the running action.
  if (!method || id === null) {
    if (method === 'notifications/cancelled' && validId(params.requestId)) {
      ctx.waitUntil(forward(env, instanceId, auth, '/mcp/cancel', { id: params.requestId }, req).then(() => {}, () => {}));
    }
    return new Response(null, { status: 202, headers: cors });
  }
  switch (method) {
    case 'initialize':
    case 'server/discover':
      if (client) ctx.waitUntil(forward(env, instanceId, auth, '/mcp/hello', { client }, req).then(() => {}, () => {}));
      return json(rpcResult(id, serverInfo(params.protocolVersion)), 200, cors);
    case 'ping':
      return json(rpcResult(id, {}), 200, cors);
    case 'tools/list':
      return json(rpcResult(id, { tools: TOOLS }), 200, cors);
    case 'tools/call': {
      if (!isToolName(params.name)) return json(rpcError(id, -32602, `Unknown tool: ${String(params.name)}`), 200, cors);
      try {
        const res = await forward(env, instanceId, auth, '/mcp/call', { id, name: params.name, arguments: params.arguments ?? {} }, req);
        if (!res.ok) throw new Error(`gateway object answered ${res.status}`);
        return json(rpcResult(id, await res.json()), 200, cors);
      } catch {
        connectionLog('mcp_call_failed', { instanceId, role: 'mcp', code: 'gateway_unavailable' });
        return json(rpcResult(id, {
          content: [{ type: 'text', text: 'refused: relay_unavailable\nThe connection to the browser was interrupted; the outcome is unknown. Take a screenshot before acting again.' }],
          isError: true,
        }), 200, cors);
      }
    }
    default:
      return json(rpcError(id, -32601, `Method not found: ${method}`), 200, cors);
  }
}

/** Hands a call to the browser's Durable Object with the identity checked above. */
function forward(env: Env, instanceId: string, auth: Extract<Awaited<ReturnType<Env['API']['authenticateMcp']>>, { ok: true }>, path: string, body: unknown, req: Request) {
  return stub(env, instanceId, auth.location).fetch(new Request(`https://gateway${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cb-instance': instanceId,
      'x-cb-client': auth.clientId,
      'x-cb-user': auth.userId,
      'x-cb-capability': auth.capability,
      'x-cb-key-name': encodeURIComponent(auth.name),
      'x-cb-agent': encodeURIComponent((req.headers.get('user-agent') ?? '').slice(0, 120)),
      'x-cb-origin': new URL(req.url).origin,
    },
    body: JSON.stringify(body),
  }));
}
