/**
 * Coding-agent access (docs/agent-access.md): pairing a local bridge with a browser, the owner's
 * control choices, and what the gateway asks on a bridge's connect. Pairing codes and bridge
 * credentials are stored as hashes only; a code works once and expires in ten minutes.
 */
import { AUTOMATION_LIMITS, AUTOMATION_PROTOCOL_VERSION, type AgentControlMode, type AgentControlState, type AutomationStatus, type Pairing, type PairingGrant } from '@cloudbrowser/contracts';
import { eventRow, newId, schema, sha256Hex, type Db } from '@cloudbrowser/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Env } from './env.js';
import { problem } from './problem.js';

const { browserInstances, automationClients, automationSessions, agentCredentials, auditLog, events } = schema;

export type AutomationAuth =
  | { ok: true; sessionId: string; clientId: string; userId: string; generation: number }
  | { ok: false; reason: 'invalid_token' | 'access_off' | 'not_running' | 'unknown_instance' };

type InstanceRow = typeof browserInstances.$inferSelect;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A 15-character code in three groups, 75 bits from the alphabet above; typed, so no 0/O/1/I. */
function pairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!);
  return `${chars.slice(0, 5).join('')}-${chars.slice(5, 10).join('')}-${chars.slice(10).join('')}`;
}

const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const codeHash = (code: string) => sha256Hex(`pairing:${normalizeCode(code)}`);
const credentialHash = (credential: string) => sha256Hex(`bridge:${credential}`);

function randomSecret() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const controlModeOf = (row: Pick<InstanceRow, 'agentControl'>): AgentControlMode =>
  row.agentControl === 'user' || row.agentControl === 'privacy' ? row.agentControl : 'agent';

/** The command the user runs locally to redeem a pairing code. */
export function bridgeCommand(env: Pick<Env, 'APP_URL'>, code: string) {
  return `cloudbrowser-bridge pair --app ${env.APP_URL} --code ${code}`;
}

export async function automationStatus(db: Db, row: InstanceRow): Promise<AutomationStatus> {
  const now = Date.now();
  const [clients, [session]] = await Promise.all([
    db.select().from(automationClients).where(and(eq(automationClients.instanceId, row.id), isNull(automationClients.revokedAt))).orderBy(desc(automationClients.createdAt)),
    db.select().from(automationSessions).where(and(eq(automationSessions.instanceId, row.id), isNull(automationSessions.endedAt))).orderBy(desc(automationSessions.startedAt)).limit(1),
  ]);
  return {
    enabled: row.agentAccess,
    mode: controlModeOf(row),
    clients: clients
      // An unredeemed pairing that expired is no longer shown (and can never be redeemed).
      .filter((c) => c.activatedAt || (c.pairingExpiresAt && c.pairingExpiresAt.getTime() > now))
      .map((c) => ({
        id: c.id, name: c.name, createdAt: c.createdAt.toISOString(),
        activatedAt: c.activatedAt?.toISOString() ?? null, lastSeenAt: c.lastSeenAt?.toISOString() ?? null,
        pairingExpiresAt: c.activatedAt ? null : c.pairingExpiresAt?.toISOString() ?? null,
      })),
    // A session the gateway could not end (a lost close) is not shown forever.
    session: session && now - session.lastSeenAt.getTime() < AUTOMATION_LIMITS.maxSessionMs
      ? { id: session.id, clientId: session.clientId, startedAt: session.startedAt.toISOString(), lastSeenAt: session.lastSeenAt.toISOString() }
      : null,
  };
}

/** A new pairing: the code is returned once; only its hash is kept. */
export async function createPairing(db: Db, env: Pick<Env, 'APP_URL'>, userId: string, row: InstanceRow, name: string, now = new Date()): Promise<Pairing> {
  if (!row.agentAccess) throw problem(409, 'agent_access_off', 'Coding agent access is turned off for this browser. Turn it on in Settings first.');
  const code = pairingCode();
  const clientId = newId(now.getTime());
  const expiresAt = new Date(now.getTime() + AUTOMATION_LIMITS.pairingCodeMs);
  await db.batch([
    db.insert(automationClients).values({ id: clientId, instanceId: row.id, userId, name, pairingHash: await codeHash(code), pairingExpiresAt: expiresAt, createdAt: now }),
    db.insert(auditLog).values({ actor: `user:${userId}`, action: 'automation.pairing_created', target: `instance:${row.id}`, detail: { clientId, name }, createdAt: now }),
  ]);
  return { clientId, code, expiresAt: expiresAt.toISOString(), command: bridgeCommand(env, code) };
}

/**
 * The bridge redeems a code (no user session: the code is the proof). One atomic update claims
 * it, so a code used twice fails the second time. The credential is returned once.
 */
export async function redeemPairing(db: Db, env: Pick<Env, 'APP_URL' | 'GATEWAY_URL'>, code: string, clientInfo: string | undefined, now = new Date()): Promise<PairingGrant | null> {
  if (normalizeCode(code).length < 8) return null;
  const credential = randomSecret();
  const hash = await codeHash(code);
  const claimed = await db.update(automationClients)
    .set({ credentialHash: await credentialHash(credential), pairingHash: null, pairingExpiresAt: null, activatedAt: now, clientInfo: clientInfo?.slice(0, 120) ?? null })
    .where(and(eq(automationClients.pairingHash, hash), isNull(automationClients.revokedAt), isNull(automationClients.activatedAt),
      sql`${automationClients.pairingExpiresAt} > ${now.getTime()}`))
    .returning({ id: automationClients.id, instanceId: automationClients.instanceId, userId: automationClients.userId });
  const client = claimed[0];
  if (!client) return null;
  const [inst] = await db.select({ name: browserInstances.name }).from(browserInstances).where(eq(browserInstances.id, client.instanceId));
  await db.insert(auditLog).values({ actor: `user:${client.userId}`, action: 'automation.pairing_redeemed', target: `instance:${client.instanceId}`, detail: { clientId: client.id }, createdAt: now });
  return {
    clientId: client.id, instanceId: client.instanceId, instanceName: inst?.name ?? '', credential,
    gatewayUrl: `${(env.GATEWAY_URL ?? '').replace(/\/$/, '')}/v1/automation/${client.instanceId}`,
    protocol: AUTOMATION_PROTOCOL_VERSION,
  };
}

export async function revokeClient(db: Db, env: Pick<Env, 'GATEWAY'>, userId: string, row: InstanceRow, clientId: string, now = new Date()): Promise<boolean> {
  const revoked = await db.update(automationClients).set({ revokedAt: now, credentialHash: null, pairingHash: null })
    .where(and(eq(automationClients.id, clientId), eq(automationClients.instanceId, row.id), eq(automationClients.userId, userId), isNull(automationClients.revokedAt)))
    .returning({ id: automationClients.id });
  if (!revoked.length) return false;
  await db.batch([
    db.update(automationSessions).set({ endedAt: now, endReason: 'client_revoked' }).where(and(eq(automationSessions.clientId, clientId), isNull(automationSessions.endedAt))),
    db.insert(auditLog).values({ actor: `user:${userId}`, action: 'automation.client_revoked', target: `instance:${row.id}`, detail: { clientId }, createdAt: now }),
    db.insert(events).values(eventRow(userId, 'instance.updated', { instanceId: row.id }, now)),
  ]);
  await env.GATEWAY?.revokeAutomation?.(row.id, clientId).catch((e: unknown) => console.error('revoke bridge connection failed', row.id, e));
  return true;
}

/** The owner's control choice: hand back, keep control, or privacy pause. Persisted, then pushed to the VM. */
export async function setControl(db: Db, env: Pick<Env, 'GATEWAY'>, userId: string, row: InstanceRow, mode: AgentControlMode, now = new Date()) {
  await db.batch([
    db.update(browserInstances).set({ agentControl: mode, updatedAt: now }).where(eq(browserInstances.id, row.id)),
    db.insert(auditLog).values({ actor: `user:${userId}`, action: 'automation.control', target: `instance:${row.id}`, detail: { mode, from: controlModeOf(row) }, createdAt: now }),
    db.insert(events).values(eventRow(userId, 'instance.updated', { instanceId: row.id }, now)),
  ]);
  await env.GATEWAY?.automationControl?.(row.id, mode, row.agentAccess).catch((e: unknown) => console.error('push control choice failed', row.id, e));
}

/** Turning access off ends every bridge session at once; turning it on just allows new ones. */
export async function setAccess(db: Db, env: Pick<Env, 'GATEWAY'>, userId: string, row: InstanceRow, enabled: boolean, now = new Date()) {
  await db.batch([
    db.update(browserInstances).set({ agentAccess: enabled, updatedAt: now }).where(eq(browserInstances.id, row.id)),
    ...(enabled ? [] : [db.update(automationSessions).set({ endedAt: now, endReason: 'access_off' }).where(and(eq(automationSessions.instanceId, row.id), isNull(automationSessions.endedAt)))]),
    db.insert(auditLog).values({ actor: `user:${userId}`, action: enabled ? 'automation.access_on' : 'automation.access_off', target: `instance:${row.id}`, createdAt: now }),
  ]);
  await env.GATEWAY?.automationControl?.(row.id, controlModeOf(row), enabled).catch((e: unknown) => console.error('push access switch failed', row.id, e));
}

/** The gateway's check on a bridge's connect: the credential, the browser and the setting. */
export async function authenticateAutomation(db: Db, input: { instanceId: string; credential: string }, now = new Date()): Promise<AutomationAuth> {
  if (!input.credential || input.credential.length > 256) return { ok: false, reason: 'invalid_token' };
  const [client] = await db.select().from(automationClients)
    .where(and(eq(automationClients.instanceId, input.instanceId), eq(automationClients.credentialHash, await credentialHash(input.credential)), isNull(automationClients.revokedAt)));
  if (!client) return { ok: false, reason: 'invalid_token' };
  const [inst] = await db.select().from(browserInstances).where(and(eq(browserInstances.id, input.instanceId), eq(browserInstances.userId, client.userId)));
  if (!inst || inst.desiredState === 'deleted' || ['deleting', 'purged', 'failed'].includes(inst.status)) return { ok: false, reason: 'unknown_instance' };
  if (!inst.agentAccess) return { ok: false, reason: 'access_off' };
  if (inst.status !== 'running' || inst.desiredState !== 'running') return { ok: false, reason: 'not_running' };
  const [identity] = await db.select({ generation: agentCredentials.generation }).from(agentCredentials).where(eq(agentCredentials.instanceId, inst.id));
  if (!identity) return { ok: false, reason: 'not_running' };
  const sessionId = newId(now.getTime());
  await db.batch([
    // One session per client: the gateway replaces the connection; the record follows.
    db.update(automationSessions).set({ endedAt: now, endReason: 'replaced' }).where(and(eq(automationSessions.clientId, client.id), isNull(automationSessions.endedAt))),
    db.insert(automationSessions).values({ id: sessionId, instanceId: inst.id, clientId: client.id, userId: client.userId, generation: identity.generation, startedAt: now, lastSeenAt: now }),
    db.update(automationClients).set({ lastSeenAt: now }).where(eq(automationClients.id, client.id)),
    db.insert(auditLog).values({ actor: `bridge:${client.id}`, action: 'automation.session_opened', target: `instance:${inst.id}`, detail: { sessionId }, createdAt: now }),
    db.insert(events).values(eventRow(client.userId, 'instance.updated', { instanceId: inst.id }, now)),
  ]);
  return { ok: true, sessionId, clientId: client.id, userId: client.userId, generation: identity.generation };
}

export async function endAutomationSession(db: Db, sessionId: string, reason: string, now = new Date()) {
  const ended = await db.update(automationSessions).set({ endedAt: now, endReason: reason.slice(0, 32) })
    .where(and(eq(automationSessions.id, sessionId), isNull(automationSessions.endedAt)))
    .returning({ instanceId: automationSessions.instanceId, userId: automationSessions.userId, clientId: automationSessions.clientId });
  const s = ended[0];
  if (!s) return;
  await db.batch([
    db.update(automationClients).set({ lastSeenAt: now }).where(eq(automationClients.id, s.clientId)),
    db.insert(auditLog).values({ actor: `bridge:${s.clientId}`, action: 'automation.session_ended', target: `instance:${s.instanceId}`, detail: { sessionId, reason }, createdAt: now }),
    db.insert(events).values(eventRow(s.userId, 'instance.updated', { instanceId: s.instanceId }, now)),
  ]);
}

/**
 * The VM reported a change of control. A takeover by the user's own input becomes the persisted
 * mode, so it survives reconnects and restarts; a privacy pause the api set is never weakened by
 * a later report. Every change is audited without any input content.
 */
export async function recordControlState(db: Db, instanceId: string, frame: AgentControlState, now = new Date()) {
  const [inst] = await db.select({ userId: browserInstances.userId, agentControl: browserInstances.agentControl }).from(browserInstances).where(eq(browserInstances.id, instanceId));
  if (!inst) return;
  const takeover = frame.reason === 'user_input' && frame.control.mode === 'user' && inst.agentControl === 'agent';
  await db.batch([
    db.insert(auditLog).values({ actor: `agent:${instanceId}`, action: 'automation.control_changed', target: `instance:${instanceId}`,
      detail: { controller: frame.control.controller, mode: frame.control.mode, epoch: frame.control.epoch, reason: frame.reason }, createdAt: now }),
    ...(takeover ? [
      db.update(browserInstances).set({ agentControl: 'user', updatedAt: now }).where(and(eq(browserInstances.id, instanceId), eq(browserInstances.agentControl, 'agent'))),
      db.insert(events).values(eventRow(inst.userId, 'instance.updated', { instanceId }, now)),
    ] : []),
  ]);
}
