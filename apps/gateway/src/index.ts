/**
 * The session gateway Worker (page 2, `services/gateway`), on `connect.example.com`:
 *  - `GET /v1/agent`: the agent's outbound tunnel, authenticated by its bootstrap token (first
 *    connect) or long-lived credential, both checked through the api.
 *  - `GET /v1/stream/:instanceId?token=`: a viewer, with a 60 s single-use Ed25519 token that is
 *    verified here and redeemed once through the api.
 *  - `POST /mcp/:instanceId`: a coding agent's remote MCP server, authenticated by the browser's
 *    access key (docs/agent-access.md), and `PUT /u/:token`, its one-time upload URLs.
 * All of them land in the instance's InstanceGateway Durable Object. It also consumes the
 * `cloudbrowser-agent-commands` queue to deliver engine commands to connected agents.
 */
import { verifyViewerToken } from '@cloudbrowser/contracts';
import type { AgentCommandsMessage } from '@cloudbrowser/db';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env.js';
import { connectionAttempt, connectionLog } from './connection-log.js';
import { failedAttempt, handleMcp, isBlocked, stub } from './mcp/http.js';
import { parseUploadToken } from './mcp/session.js';

export { InstanceGateway } from './instance-gateway.js';

const text = (body: string, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers });

/** Instance ids are ours (base32 ULIDs today); anything else is refused before any api call. */
const INSTANCE_ID = /^[A-Za-z0-9]{1,64}$/;
/** An agent's bootstrap token and credential are 64 hex characters. */
const AGENT_SECRET = /^[0-9a-fA-F]{64}$/;
/** A viewer token: base64url claims, a dot and a base64url Ed25519 signature. */
const VIEWER_TOKEN = /^[A-Za-z0-9_-]{16,2048}\.[A-Za-z0-9_-]{64,128}$/;

/** Forwards the upgrade to the instance's object with the identity this Worker verified. */
function forward(env: Env, req: Request, instanceId: string, headers: Record<string, string>) {
  const h = new Headers(req.headers);
  for (const k of [...h.keys()]) if (k.startsWith('x-cb-')) h.delete(k);
  h.set('x-cb-instance', instanceId);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return stub(env, instanceId).fetch(new Request(req.url, { method: 'GET', headers: h }));
}

/**
 * `PUT /u/<instanceId>.<slot>.<secret>`: a file for an upload URL that `upload_file` created. The
 * object checks the secret against its stored hash; this Worker only checks the shape, insists on
 * a Content-Length (curl -T sends one) and slows down an address that guesses.
 */
async function upload(req: Request, env: Env, token: string): Promise<Response> {
  if (req.method !== 'PUT') return text('method not allowed', 405, { allow: 'PUT' });
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (isBlocked(ip)) return text('too many failed attempts; try again in a minute\n', 429, { 'retry-after': '60' });
  const slot = parseUploadToken(token);
  if (!slot) {
    await failedAttempt(env.MCP_LIMITER, `upload-fail:${ip}`, ip);
    return text('unknown upload URL\n', 404);
  }
  const length = req.headers.get('content-length');
  if (length === null || !/^\d{1,12}$/.test(length)) return text('Content-Length required: upload a file (curl -T <file> <url>)\n', 411);
  const response = await stub(env, slot.instanceId).fetch(new Request('https://gateway/mcp/upload', {
    method: 'PUT',
    headers: {
      'x-cb-instance': slot.instanceId, 'x-cb-slot': slot.slotId, 'x-cb-secret': slot.secret,
      'content-length': length, 'content-type': 'application/octet-stream',
    },
    body: req.body,
    // A streamed request body (Node's fetch, in tests, insists on saying so).
    ...({ duplex: 'half' } as RequestInit),
  }));
  if (response.status === 404) await failedAttempt(env.MCP_LIMITER, `upload-fail:${ip}`, ip);
  return response;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });

    // A coding agent's remote MCP server; the trailing slash some clients add is accepted, never redirected.
    const mcp = url.pathname.match(/^\/mcp\/([^/]*)\/?$/);
    if (mcp) {
      if (!INSTANCE_ID.test(mcp[1]!)) return text('not found', 404);
      return handleMcp(req, env, ctx, mcp[1]!);
    }
    const uploadUrl = url.pathname.match(/^\/u\/([^/]+)$/);
    if (uploadUrl) return upload(req, env, uploadUrl[1]!);

    if (req.headers.get('upgrade') !== 'websocket') return text('expected websocket', 426);

    if (url.pathname === '/v1/agent') {
      const instanceId = req.headers.get('x-instance-id') ?? '';
      connectionLog('agent_upgrade_requested', { instanceId, role: 'agent' });
      const [scheme, secret] = (req.headers.get('authorization') ?? '').split(' ');
      if (!INSTANCE_ID.test(instanceId) || (scheme !== 'Bootstrap' && scheme !== 'Bearer') || !secret || !AGENT_SECRET.test(secret)) {
        connectionLog('agent_upgrade_rejected', { instanceId, role: 'agent', code: 'missing_credentials', status: 401 });
        return text('unauthorized', 401);
      }
      try {
        const auth = await env.API.authenticateAgent(
          scheme === 'Bootstrap' ? { instanceId, bootstrap: secret } : { instanceId, credential: secret },
        );
        if (!auth.ok) {
          connectionLog('agent_upgrade_rejected', { instanceId, role: 'agent', code: 'authentication_rejected', status: 401 });
          return text('unauthorized', 401);
        }
        return await forward(env, req, instanceId, {
          'x-cb-role': 'agent',
          'x-cb-generation': String(auth.generation),
          ...(auth.credential ? { 'x-cb-credential': auth.credential } : {}),
        });
      } catch {
        connectionLog('agent_upgrade_failed', { instanceId, role: 'agent', code: 'gateway_unavailable', status: 503 });
        return text('gateway unavailable', 503);
      }
    }

    const stream = url.pathname.match(/^\/v1\/stream\/([^/]+)$/);
    if (stream) {
      const identity = { instanceId: stream[1], attemptId: connectionAttempt(url.searchParams.get('attemptId')), role: 'viewer' as const };
      connectionLog('viewer_upgrade_requested', identity);
      if (!env.VIEWER_TOKEN_PUBLIC_KEY) {
        connectionLog('viewer_upgrade_rejected', { ...identity, code: 'tokens_not_configured', status: 503 });
        return text('viewer tokens not configured', 503);
      }
      const token = url.searchParams.get('token') ?? '';
      if (!INSTANCE_ID.test(stream[1]!) || !VIEWER_TOKEN.test(token)) {
        connectionLog('viewer_upgrade_rejected', { ...identity, code: 'invalid_token', status: 401 });
        return text('invalid token', 401);
      }
      try {
        const claims = await verifyViewerToken(JSON.parse(env.VIEWER_TOKEN_PUBLIC_KEY) as JsonWebKey, token);
        if (!claims || claims.iid !== stream[1]) {
          connectionLog('viewer_upgrade_rejected', { ...identity, code: 'invalid_token', status: 401 });
          return text('invalid token', 401);
        }
        if (!(await env.API.redeemViewerToken(claims))) {
          connectionLog('viewer_upgrade_rejected', { ...identity, sessionId: claims.sid, code: 'session_or_token_rejected', status: 401 });
          return text('token already used or session ended', 401);
        }
        connectionLog('viewer_token_redeemed', { ...identity, sessionId: claims.sid });
        return await forward(env, req, claims.iid, {
          'x-cb-role': 'viewer', 'x-cb-session': claims.sid,
          ...(identity.attemptId ? { 'x-cb-attempt': identity.attemptId } : {}),
        });
      } catch {
        connectionLog('viewer_upgrade_failed', { ...identity, code: 'gateway_unavailable', status: 503 });
        return text('gateway unavailable', 503);
      }
    }
    return text('not found', 404);
  },

  /** The engine created commands for these instances; deliver them if the agent is connected. */
  async queue(batch, env) {
    const ids = new Set(batch.messages.map((m) => m.body.instanceId));
    await Promise.all([...ids].map((id) => stub(env, id).fetch('https://gateway/deliver', { method: 'POST' })));
    batch.ackAll();
  },
} satisfies ExportedHandler<Env, AgentCommandsMessage>;

/** Only a trusted service binding can invoke this entrypoint; no public management URL exists. */
export class Internal extends WorkerEntrypoint<Env> {
  async revokeViewers(instanceId: string): Promise<void> {
    if (!INSTANCE_ID.test(instanceId)) throw new Error('invalid instance id');
    const response = await stub(this.env, instanceId).fetch('https://gateway/revoke-viewers', {
      method: 'POST', headers: { 'x-cb-instance': instanceId },
    });
    if (!response.ok) throw new Error('gateway viewer revocation failed');
  }

  async revokeInstance(instanceId: string): Promise<void> {
    if (!INSTANCE_ID.test(instanceId)) throw new Error('invalid instance id');
    const response = await stub(this.env, instanceId).fetch('https://gateway/revoke', {
      method: 'POST', headers: { 'x-cb-instance': instanceId },
    });
    if (!response.ok) throw new Error('gateway revocation failed');
  }

  /** The user's control choice (hand back, pause, privacy) or the access switch, pushed to the VM at once. */
  async automationControl(instanceId: string, mode: 'agent' | 'user' | 'privacy', access: boolean): Promise<void> {
    if (!INSTANCE_ID.test(instanceId)) throw new Error('invalid instance id');
    const response = await stub(this.env, instanceId).fetch('https://gateway/automation-control', {
      method: 'POST', headers: { 'x-cb-instance': instanceId, 'content-type': 'application/json' },
      body: JSON.stringify({ mode, access }),
    });
    if (!response.ok) throw new Error('gateway automation control failed');
  }

  /** Ends the session of a revoked key (any key's session without a client id). */
  async revokeAutomation(instanceId: string, clientId?: string): Promise<void> {
    if (!INSTANCE_ID.test(instanceId)) throw new Error('invalid instance id');
    const response = await stub(this.env, instanceId).fetch('https://gateway/revoke-automation', {
      method: 'POST', headers: { 'x-cb-instance': instanceId, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: clientId ?? null }),
    });
    if (!response.ok) throw new Error('gateway automation revocation failed');
  }
}
