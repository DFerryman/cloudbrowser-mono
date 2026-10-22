/**
 * The session gateway Worker (page 2, `services/gateway`), on `connect.example.com`:
 *  - `GET /v1/agent`: the agent's outbound tunnel, authenticated by its bootstrap token (first
 *    connect) or long-lived credential, both checked through the api.
 *  - `GET /v1/stream/:instanceId?token=`: a viewer, with a 60 s single-use Ed25519 token that is
 *    verified here and redeemed once through the api.
 * Both land in the instance's InstanceGateway Durable Object. It also consumes the
 * `cloudbrowser-agent-commands` queue to deliver engine commands to connected agents.
 */
import { verifyViewerToken } from '@cloudbrowser/contracts';
import type { AgentCommandsMessage } from '@cloudbrowser/db';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env.js';
import { connectionAttempt, connectionLog } from './connection-log.js';

export { InstanceGateway } from './instance-gateway.js';

const text = (body: string, status: number) => new Response(body, { status });

function stub(env: Env, instanceId: string) {
  return env.INSTANCE_GATEWAY.get(env.INSTANCE_GATEWAY.idFromName(instanceId));
}

/** Forwards the upgrade to the instance's object with the identity this Worker verified. */
function forward(env: Env, req: Request, instanceId: string, headers: Record<string, string>) {
  const h = new Headers(req.headers);
  for (const k of [...h.keys()]) if (k.startsWith('x-cb-')) h.delete(k);
  h.set('x-cb-instance', instanceId);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return stub(env, instanceId).fetch(new Request(req.url, { method: 'GET', headers: h }));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (req.headers.get('upgrade') !== 'websocket') return text('expected websocket', 426);

    if (url.pathname === '/v1/agent') {
      const instanceId = req.headers.get('x-instance-id') ?? '';
      connectionLog('agent_upgrade_requested', { instanceId, role: 'agent' });
      const [scheme, secret] = (req.headers.get('authorization') ?? '').split(' ');
      if (!instanceId || !secret) {
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

    const stream = url.pathname.match(/^\/v1\/stream\/([A-Za-z0-9]+)$/);
    if (stream) {
      const identity = { instanceId: stream[1], attemptId: connectionAttempt(url.searchParams.get('attemptId')), role: 'viewer' as const };
      connectionLog('viewer_upgrade_requested', identity);
      if (!env.VIEWER_TOKEN_PUBLIC_KEY) {
        connectionLog('viewer_upgrade_rejected', { ...identity, code: 'tokens_not_configured', status: 503 });
        return text('viewer tokens not configured', 503);
      }
      try {
        const claims = await verifyViewerToken(JSON.parse(env.VIEWER_TOKEN_PUBLIC_KEY) as JsonWebKey, url.searchParams.get('token') ?? '');
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
    if (!/^[A-Za-z0-9]+$/.test(instanceId)) throw new Error('invalid instance id');
    const response = await stub(this.env, instanceId).fetch('https://gateway/revoke-viewers', {
      method: 'POST', headers: { 'x-cb-instance': instanceId },
    });
    if (!response.ok) throw new Error('gateway viewer revocation failed');
  }

  async revokeInstance(instanceId: string): Promise<void> {
    if (!/^[A-Za-z0-9]+$/.test(instanceId)) throw new Error('invalid instance id');
    const response = await stub(this.env, instanceId).fetch('https://gateway/revoke', {
      method: 'POST', headers: { 'x-cb-instance': instanceId },
    });
    if (!response.ok) throw new Error('gateway revocation failed');
  }
}
