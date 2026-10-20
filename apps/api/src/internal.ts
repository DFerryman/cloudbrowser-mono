/**
 * Internal API for the session gateway (page 2: `/internal/agents/authenticate`,
 * `/internal/agents/:id/messages`, `/internal/viewer-tokens/redeem`). Exposed as the `Internal`
 * RPC entrypoint of this Worker, reachable only through the gateway's service binding, never from
 * the internet.
 */
import { AgentFrame, NEVER_SLEEP_TIMEOUT_S, type GatewayToAgent, type ViewerTokenClaims } from '@cloudbrowser/contracts';
import { createDb, eventRow, schema, sha256Hex, unwrapArchiveKey, type Db } from '@cloudbrowser/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Env } from './env.js';
import { turnIceServers } from './turn.js';

const { placements, archiveKeys, agentCredentials, agentCommands, instanceHealth, browserInstances, operations, viewerSessions, viewerTokens, auditLog, events } = schema;

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
  const [inst] = await db.select({ status: browserInstances.status, desiredState: browserInstances.desiredState }).from(browserInstances).where(eq(browserInstances.id, input.instanceId));
  if (!row || !inst || inst.desiredState === 'deleted' || ['deleting', 'purged'].includes(inst.status)) return { ok: false, reason: 'unknown_instance' };

  if (input.credential) {
    return row.credentialHash && row.credentialHash === (await sha256Hex(input.credential))
      ? { ok: true, generation: row.generation }
      : { ok: false, reason: 'invalid_token' };
  }
  if (input.bootstrap) {
    if (!row.bootstrapHash || row.bootstrapHash !== (await sha256Hex(input.bootstrap))) return { ok: false, reason: 'invalid_token' };
    if (!row.bootstrapExpiresAt || row.bootstrapExpiresAt <= now) return { ok: false, reason: 'expired' };
    const credential = randomSecret();
    const activated = await db
      .update(agentCredentials)
      .set({ credentialHash: await sha256Hex(credential), bootstrapHash: null, activatedAt: now })
      .where(and(eq(agentCredentials.instanceId, input.instanceId), eq(agentCredentials.bootstrapHash, row.bootstrapHash)))
      .returning({ instanceId: agentCredentials.instanceId });
    // A deletion or another bootstrap activation may have won after the read above.
    if (!activated.length) return { ok: false, reason: 'invalid_token' };
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
  const [inst] = await db.select({ status: browserInstances.status, desiredState: browserInstances.desiredState, idleTimeoutS: browserInstances.idleTimeoutS }).from(browserInstances).where(eq(browserInstances.id, instanceId));
  if (!inst || inst.desiredState === 'deleted' || ['deleting', 'purged'].includes(inst.status)) return null;
  const [identity] = await db.select({ generation: agentCredentials.generation }).from(agentCredentials).where(eq(agentCredentials.instanceId, instanceId));
  if (!identity || identity.generation !== generation) return null;
  switch (frame.t) {
    case 'hello':
    case 'viewer':
    case 'viewer_error':
    case 'viewer_file':
      return null; // handled by the gateway
    case 'turn_request':
      // neko's own TURN allocation, refreshed by the agent at each wake (page 5).
      return { t: 'turn', iceServers: await turnIceServers(env, 24 * 3600) };
    case 'reply': {
      // A canceled operation cannot be revived by a command that was already in flight.
      // Operation commands use <operation id>:<step>; periodic ipcheck commands are independent.
      const prefix = frame.commandId.split(':')[0]!;
      const operationId = frame.commandId.includes(':') && prefix !== 'ipcheck' ? prefix : null;
      const recorded = await db
        .update(agentCommands)
        .set({
          status: frame.ok ? 'succeeded' : 'failed',
          reply: frame.ok ? (frame.result ?? {}) : { ...(frame.result ?? {}), error: frame.error ?? 'failed' },
          completedAt: now,
        })
        .where(and(
          eq(agentCommands.id, frame.commandId), eq(agentCommands.instanceId, instanceId),
          inArray(agentCommands.status, ['pending', 'delivered']), isNull(agentCommands.completedAt),
          operationId ? sql`EXISTS (SELECT 1 FROM ${operations}
            WHERE ${operations.id} = ${operationId} AND ${operations.instanceId} = ${instanceId}
              AND ${operations.finishedAt} IS NULL)` : undefined,
        ))
        .returning({ id: agentCommands.id });
      if (recorded.length) await kickOperation(env, db, instanceId);
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
          // Agents before 0.2.0 do not send their version (and cannot grow storage).
          agentVersion: typeof d.agentVersion === 'string' ? d.agentVersion.slice(0, 32) : null,
        };
        await db.insert(instanceHealth).values({ instanceId, ...set }).onConflictDoUpdate({ target: instanceHealth.instanceId, set });
        await kickOperation(env, db, instanceId);
      } else if (frame.kind === 'heartbeat') {
        const [health] = await db.select().from(instanceHealth).where(eq(instanceHealth.instanceId, instanceId));
        const lastInputAt = typeof d.lastInputAt === 'string' && !Number.isNaN(Date.parse(d.lastInputAt)) ? new Date(d.lastInputAt) : null;
        const viewers = typeof d.viewers === 'number' ? d.viewers : 0;
        const inputInterval = inst.idleTimeoutS === NEVER_SLEEP_TIMEOUT_S ? 60_000 : Math.min(60_000, inst.idleTimeoutS * 500);
        // Transport heartbeats remain frequent; persist only once a minute or on a viewer/input
        // transition. Short idle timeouts keep an appropriately shorter input reporting interval.
        const inputDue = lastInputAt && lastInputAt.getTime() - (health?.lastInputAt?.getTime() ?? 0) >= inputInterval;
        if (health?.lastHeartbeatAt && now.getTime() - health.lastHeartbeatAt.getTime() < 60_000
          && health.viewers === viewers && !inputDue) return null;
        const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
        const disk = d.disk && typeof d.disk === 'object' ? (d.disk as Record<string, unknown>) : null;
        const used = count(disk?.usedBytes);
        const total = count(disk?.totalBytes);
        const tx = count(d.netTxBytes);
        const set = {
          lastHeartbeatAt: now,
          viewers,
          ...(lastInputAt ? { lastInputAt: new Date(Math.max(lastInputAt.getTime(), health?.lastInputAt?.getTime() ?? 0)) } : {}),
          // Storage page (used / total) and data-transfer metering (page 6).
          ...(used !== null && total !== null ? { diskUsedBytes: used, diskTotalBytes: total, diskReportedAt: now } : {}),
          ...(tx !== null ? { netTxBytes: tx } : {}),
        };
        await db.insert(instanceHealth).values({ instanceId, ...set }).onConflictDoUpdate({ target: instanceHealth.instanceId, set });
      } else if (frame.kind === 'ip_check') {
        const observed = Array.isArray(d.observed) ? d.observed.filter((x): x is string => typeof x === 'string') : [];
        // The address websites must see is the placement's static IP, not whatever the agent expects.
        const [current] = await db
          .select({ ip: placements.ipAddress })
          .from(placements)
          .where(and(eq(placements.instanceId, instanceId), eq(placements.status, 'current')));
        const expected = current?.ip ?? (typeof d.expected === 'string' ? d.expected : null);
        const lastIpCheck = {
          ok: d.ok === true && !!expected && observed.length > 0 && observed.every((o) => o === expected),
          expected,
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
  // One atomic statement on the viewer's connect path: the session must be open and its browser
  // owned and not deleted, and each token id is inserted at most once (a second use returns no row).
  const eligible = sql`EXISTS (SELECT 1 FROM ${viewerSessions} WHERE ${viewerSessions.id} = ${claims.sid}
      AND ${viewerSessions.instanceId} = ${claims.iid} AND ${viewerSessions.userId} = ${claims.uid} AND ${viewerSessions.endedAt} IS NULL)
    AND EXISTS (SELECT 1 FROM ${browserInstances} WHERE ${browserInstances.id} = ${claims.iid} AND ${browserInstances.userId} = ${claims.uid}
      AND ${browserInstances.desiredState} <> 'deleted' AND ${browserInstances.status} NOT IN ('deleting', 'purged'))`;
  const redeemed = await db.insert(viewerTokens)
    .select(sql`SELECT ${claims.jti}, ${claims.sid}, ${now.getTime()} WHERE ${eligible}`)
    .onConflictDoNothing()
    .returning({ jti: viewerTokens.jti });
  return redeemed.length > 0;
}

/**
 * The instance's archive key in plain form, for the gateway to add to an archive or restore command
 * as it delivers it (page 4). Only the wrapped key is stored; null once the key is destroyed.
 */
export async function archiveKey(env: Env, db: Db, instanceId: string): Promise<string | null> {
  if (!env.ARCHIVE_MASTER_KEY) return null;
  const [inst] = await db.select({ status: browserInstances.status, desiredState: browserInstances.desiredState }).from(browserInstances).where(eq(browserInstances.id, instanceId));
  if (!inst || inst.desiredState === 'deleted' || ['deleting', 'purged'].includes(inst.status)) return null;
  const [row] = await db.select().from(archiveKeys).where(eq(archiveKeys.instanceId, instanceId));
  if (!row?.wrappedKey || row.destroyedAt) return null;
  return unwrapArchiveKey(env.ARCHIVE_MASTER_KEY, row.wrappedKey);
}

export function internalApi(env: Env) {
  const db = createDb(env.DB);
  return {
    authenticateAgent: (input: { instanceId: string; bootstrap?: string; credential?: string }) => authenticateAgent(db, input),
    agentMessage: (instanceId: string, generation: number, frame: unknown) => agentMessage(env, db, instanceId, generation, frame),
    redeemViewerToken: (claims: ViewerTokenClaims) => redeemViewerToken(db, claims),
    archiveKey: (instanceId: string) => archiveKey(env, db, instanceId),
  };
}
