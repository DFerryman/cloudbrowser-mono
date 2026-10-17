/**
 * Internal API for the session gateway (page 2: `/internal/agents/authenticate`,
 * `/internal/agents/:id/messages`, `/internal/viewer-tokens/redeem`). Exposed as the `Internal`
 * RPC entrypoint of this Worker, reachable only through the gateway's service binding, never from
 * the internet.
 */
import { AgentFrame, type GatewayToAgent, type ViewerTokenClaims } from '@cloudbrowser/contracts';
import { createDb, eventRow, schema, sha256Hex, type Db } from '@cloudbrowser/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from './env.js';
import { turnIceServers } from './turn.js';

const { agentCredentials, agentCommands, instanceHealth, browserInstances, operations, viewerSessions, viewerTokens, auditLog, events } = schema;

export type AgentAuth =
  | { ok: true; generation: number; credential?: string }
  | { ok: false; reason: 'unknown_instance' | 'invalid_token' | 'expired' };

function randomSecret() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Bootstrap tokens are single-use: the first connect swaps one for a long-lived credential, which
 * the agent stores. Afterwards only the credential works.
 */
export async function authenticateAgent(
  db: Db,
  input: { instanceId: string; bootstrap?: string; credential?: string },
  now = new Date(),
): Promise<AgentAuth> {
  const [row] = await db.select().from(agentCredentials).where(eq(agentCredentials.instanceId, input.instanceId));
  const [inst] = await db.select({ status: browserInstances.status }).from(browserInstances).where(eq(browserInstances.id, input.instanceId));
  if (!row || !inst || inst.status === 'purged') return { ok: false, reason: 'unknown_instance' };

  if (input.credential) {
    return row.credentialHash && row.credentialHash === (await sha256Hex(input.credential))
      ? { ok: true, generation: row.generation }
      : { ok: false, reason: 'invalid_token' };
  }
  if (input.bootstrap) {
    if (!row.bootstrapHash || row.bootstrapHash !== (await sha256Hex(input.bootstrap))) return { ok: false, reason: 'invalid_token' };
    if (!row.bootstrapExpiresAt || row.bootstrapExpiresAt <= now) return { ok: false, reason: 'expired' };
    const credential = randomSecret();
    await db
      .update(agentCredentials)
      .set({ credentialHash: await sha256Hex(credential), bootstrapHash: null, activatedAt: now })
      .where(and(eq(agentCredentials.instanceId, input.instanceId), eq(agentCredentials.bootstrapHash, row.bootstrapHash)));
    return { ok: true, generation: row.generation, credential };
  }
  return { ok: false, reason: 'invalid_token' };
}

/** Wakes the engine for the instance's unfinished operation, e.g. one waiting for `ready`. */
async function kickOperation(env: Env, db: Db, instanceId: string) {
  const [op] = await db
    .select({ id: operations.id })
    .from(operations)
    .where(and(eq(operations.instanceId, instanceId), isNull(operations.finishedAt)));
  if (op) await env.OPERATIONS.send({ operationId: op.id });
}

/** Handles one frame from an agent. Returns a frame to send back, if any. */
export async function agentMessage(env: Env, db: Db, instanceId: string, generation: number, raw: unknown, now = new Date()): Promise<GatewayToAgent | null> {
  const frame = AgentFrame.parse(raw);
  switch (frame.t) {
    case 'hello':
    case 'viewer':
      return null; // handled by the gateway
    case 'turn_request':
      // neko's own TURN allocation, refreshed by the agent at each wake (page 5).
      return { t: 'turn', iceServers: await turnIceServers(env, 24 * 3600) };
    case 'reply': {
      await db
        .update(agentCommands)
        .set({
          status: frame.ok ? 'succeeded' : 'failed',
          reply: frame.ok ? (frame.result ?? {}) : { ...(frame.result ?? {}), error: frame.error ?? 'failed' },
          completedAt: now,
        })
        .where(and(eq(agentCommands.id, frame.commandId), eq(agentCommands.instanceId, instanceId)));
      await kickOperation(env, db, instanceId);
      return null;
    }
    case 'event': {
      const d = frame.data;
      if (frame.kind === 'ready') {
        const chromeMajor = typeof d.chromeMajor === 'number' ? d.chromeMajor : null;
        const [h] = await db.select({ chromeMajor: instanceHealth.chromeMajor }).from(instanceHealth).where(eq(instanceHealth.instanceId, instanceId));
        const set = {
          agentReadyGeneration: generation,
          agentReadyAt: now,
          lastHeartbeatAt: now,
          chromeMajor: Math.max(h?.chromeMajor ?? 0, chromeMajor ?? 0) || null,
        };
        await db.insert(instanceHealth).values({ instanceId, ...set }).onConflictDoUpdate({ target: instanceHealth.instanceId, set });
        await kickOperation(env, db, instanceId);
      } else if (frame.kind === 'heartbeat') {
        const lastInputAt = typeof d.lastInputAt === 'string' && !Number.isNaN(Date.parse(d.lastInputAt)) ? new Date(d.lastInputAt) : null;
        const set = {
          lastHeartbeatAt: now,
          viewers: typeof d.viewers === 'number' ? d.viewers : 0,
          ...(lastInputAt ? { lastInputAt } : {}),
        };
        await db.insert(instanceHealth).values({ instanceId, ...set }).onConflictDoUpdate({ target: instanceHealth.instanceId, set });
      } else if (frame.kind === 'ip_check') {
        const observed = Array.isArray(d.observed) ? d.observed.filter((x): x is string => typeof x === 'string') : [];
        const lastIpCheck = {
          ok: d.ok === true,
          expected: typeof d.expected === 'string' ? d.expected : null,
          observed,
          checkedAt: now.toISOString(),
          ...(typeof d.detail === 'string' ? { detail: d.detail } : {}),
        };
        const [inst] = await db.select({ userId: browserInstances.userId }).from(browserInstances).where(eq(browserInstances.id, instanceId));
        await db.batch([
          db.insert(instanceHealth).values({ instanceId, lastIpCheck }).onConflictDoUpdate({ target: instanceHealth.instanceId, set: { lastIpCheck } }),
          db.insert(events).values(eventRow(inst?.userId ?? '', 'instance.updated', { instanceId }, now)),
        ]);
      } else {
        await db.insert(auditLog).values({ actor: `agent:${instanceId}`, action: `agent.${frame.kind}`, target: `instance:${instanceId}`, detail: d, createdAt: now });
      }
      return null;
    }
  }
}

/**
 * Redeems a viewer token once. The gateway has already checked its signature and expiry; this
 * checks that it was never used and that its viewer session is still the open one.
 */
export async function redeemViewerToken(db: Db, claims: ViewerTokenClaims, now = new Date()): Promise<boolean> {
  const [session] = await db
    .select()
    .from(viewerSessions)
    .where(and(eq(viewerSessions.id, claims.sid), eq(viewerSessions.instanceId, claims.iid), eq(viewerSessions.userId, claims.uid)));
  if (!session || session.endedAt) return false;
  try {
    await db.insert(viewerTokens).values({ jti: claims.jti, sessionId: claims.sid, redeemedAt: now });
    return true;
  } catch {
    return false; // already redeemed
  }
}

export function internalApi(env: Env) {
  const db = createDb(env.DB);
  return {
    authenticateAgent: (input: { instanceId: string; bootstrap?: string; credential?: string }) => authenticateAgent(db, input),
    agentMessage: (instanceId: string, generation: number, frame: unknown) => agentMessage(env, db, instanceId, generation, frame),
    redeemViewerToken: (claims: ViewerTokenClaims) => redeemViewerToken(db, claims),
  };
}
