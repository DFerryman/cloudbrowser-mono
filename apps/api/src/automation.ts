/**
 * Coding-agent access (docs/agent-access.md): per-browser access keys and OAuth sign-ins for the
 * gateway's remote MCP server, the owner's control choices, and what the gateway asks when an agent
 * calls. A key is shown once; only `sha256('bridge:' + key)` is stored, the scheme the retired
 * bridge's credentials used, so those keep working as keys. Sign-ins are issued in oauth.ts and
 * live on the same rows (`kind = 'oauth'`), so listing, last use and revocation are shared.
 */
import { AGENT_KEY_EXPIRY_DAYS, AUTOMATION_LIMITS, objectLocationHint, type AgentControlMode, type AgentControlState, type AgentKey, type AgentKeyCapability, type AutomationClient, type AutomationStatus, type CreateAgentKeyBody, type ObjectLocationHint } from '@cloudbrowser/contracts';
import { eventRow, newId, schema, sha256Hex, type Db } from '@cloudbrowser/db';
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Env } from './env.js';
import { agentKeyCreatedMessage } from './notifications/user.js';
import { sendToUser } from './notifications/send.js';
import { problem } from './problem.js';

const { browserInstances, automationClients, automationSessions, agentCredentials, auditLog, events, regions, oauthClients } = schema;

/** What the gateway learns about a key on an MCP request; no session is opened by it. */
export type McpAuth =
  /** `location`: where the browser's gateway object belongs (objectLocationHint), for a call that reaches it first. */
  | { ok: true; clientId: string; userId: string; generation: number; capability: AgentKeyCapability; name: string; location?: ObjectLocationHint }
  | { ok: false; reason: 'invalid_token' | 'expired' | 'unknown_instance' };

type InstanceRow = typeof browserInstances.$inferSelect;

/** Active keys per browser, and active sign-ins: enough for every agent and machine, few enough to keep track of. */
export const MAX_AGENT_KEYS = 10;
/** A key's last use (time, client, address) is written at most this often. */
const LAST_SEEN_MS = 60_000;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const KEY_PREFIX = 'nvzk_';
/** 43 base62 characters carry 256 bits. */
const KEY_CHARS = 43;
/** Access keys, and the 64 hex characters of a credential the retired bridge was issued. */
const KEY_FORMAT = /^(?:nvzk_[A-Za-z0-9]{43}|[0-9a-f]{64})$/;
/** A sign-in's access token (oauth.ts). */
const ACCESS_TOKEN_FORMAT = /^nvza_[A-Za-z0-9]{43}$/;

const credentialHash = (secret: string) => sha256Hex(`bridge:${secret}`);
/** Each kind of secret is hashed under its own label, so one can never be presented as another. */
export const accessTokenHash = (token: string) => sha256Hex(`oauth-access:${token}`);
export const refreshTokenHash = (token: string) => sha256Hex(`oauth-refresh:${token}`);

/**
 * A new secret: the prefix and `chars` base62 characters (43 carry 256 bits). Bytes from 248 up
 * are drawn again, so every character is equally likely (248 = 4 × 62).
 */
export function newSecret(prefix: string, chars = KEY_CHARS): string {
  let out = prefix;
  while (out.length < prefix.length + chars) {
    for (const b of crypto.getRandomValues(new Uint8Array(64))) {
      if (b < 248 && out.length < prefix.length + chars) out += BASE62[b % 62];
    }
  }
  return out;
}

export const isKeyFormat = (key: string) => KEY_FORMAT.test(key) || ACCESS_TOKEN_FORMAT.test(key);

/** What a revoked key or sign-in keeps: no secret of any kind still matches it. */
const revokedFields = (now: Date) => ({ revokedAt: now, credentialHash: null, pairingHash: null, refreshHash: null, prevRefreshHash: null });

/** An ended sign-in is listed for this long after its end, then only in the audit log. */
const ENDED_SIGN_IN_LISTED_MS = 86_400_000;

/** A sign-in's verified domain: the host of its metadata document. */
export const verifiedHostOf = (client: { id: string; kind: string } | null) =>
  client?.kind === 'cimd' ? new URL(client.id).host : null;

/** A key or sign-in as the owner sees it in a list. */
export function toAutomationClient(c: typeof automationClients.$inferSelect, app: { id: string; kind: string } | null): AutomationClient {
  return {
    id: c.id, name: c.name, kind: c.kind === 'key' || c.kind === 'oauth' ? c.kind : 'bridge', keyPrefix: c.keyPrefix,
    capability: c.capability === 'view' ? 'view' : 'control',
    createdAt: c.createdAt.toISOString(), expiresAt: c.expiresAt?.toISOString() ?? null,
    lastSeenAt: c.lastSeenAt?.toISOString() ?? null, lastClient: c.lastClient, verifiedHost: verifiedHostOf(app),
  };
}

/** Keys and sign-ins still worth listing: not revoked, and a sign-in not ended for more than a day. */
export const listed = (c: typeof automationClients.$inferSelect, now: number) =>
  c.kind !== 'oauth' || !c.expiresAt || c.expiresAt.getTime() > now - ENDED_SIGN_IN_LISTED_MS;

export const controlModeOf = (row: Pick<InstanceRow, 'agentControl'>): AgentControlMode =>
  row.agentControl === 'user' || row.agentControl === 'privacy' ? row.agentControl : 'agent';

/** The remote MCP server URL of a browser: the gateway's WebSocket origin, as HTTPS. */
export function mcpUrl(env: Pick<Env, 'GATEWAY_URL'>, instanceId: string): string {
  if (!env.GATEWAY_URL) return '';
  const base = env.GATEWAY_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  return `${base}/mcp/${instanceId}`;
}

/** A browser the owner deleted no longer has coding-agent access of any kind. */
export const unavailable = (row: Pick<InstanceRow, 'desiredState' | 'status'>) => row.desiredState === 'deleted' || ['deleting', 'purged'].includes(row.status);

export async function automationStatus(db: Db, env: Pick<Env, 'GATEWAY_URL'>, row: InstanceRow): Promise<AutomationStatus> {
  const now = Date.now();
  const [clients, [session]] = await Promise.all([
    db.select({ client: automationClients, app: { id: oauthClients.id, kind: oauthClients.kind } }).from(automationClients)
      .leftJoin(oauthClients, eq(oauthClients.id, automationClients.oauthClientId))
      .where(and(eq(automationClients.instanceId, row.id), isNull(automationClients.revokedAt), isNotNull(automationClients.credentialHash)))
      .orderBy(desc(automationClients.createdAt)),
    db.select().from(automationSessions).where(and(eq(automationSessions.instanceId, row.id), isNull(automationSessions.endedAt))).orderBy(desc(automationSessions.startedAt)).limit(1),
  ]);
  return {
    enabled: row.agentAccess,
    mode: controlModeOf(row),
    mcpUrl: mcpUrl(env, row.id),
    clients: clients.filter((c) => listed(c.client, now)).map((c) => toAutomationClient(c.client, c.app)),
    // A session the gateway could not end (a lost close) is not shown forever.
    session: session && now - session.lastSeenAt.getTime() < AUTOMATION_LIMITS.maxSessionMs
      ? { id: session.id, clientId: session.clientId, startedAt: session.startedAt.toISOString(), lastSeenAt: session.lastSeenAt.toISOString() }
      : null,
  };
}

/**
 * A new access key for one browser. The key is returned once; only its hash and a short prefix
 * are kept. The owner is emailed, so a key created from a stolen session does not go unnoticed.
 */
export async function createAgentKey(
  db: Db, env: Env, waitUntil: (p: Promise<unknown>) => void, userId: string, row: InstanceRow, body: CreateAgentKeyBody, now = new Date(),
): Promise<AgentKey> {
  if (unavailable(row)) throw problem(409, 'invalid_state', 'This browser has been deleted.');
  if (!row.agentAccess) throw problem(409, 'agent_access_off', 'Coding agent access is turned off for this browser. Turn it on in Settings first.');
  // Sign-ins have their own limit (oauth.ts), so neither kind crowds out the other.
  const [active] = await db.select({ n: sql<number>`count(*)` }).from(automationClients).where(and(
    eq(automationClients.instanceId, row.id), isNull(automationClients.revokedAt), isNotNull(automationClients.credentialHash),
    or(isNull(automationClients.expiresAt), gt(automationClients.expiresAt, now)), ne(automationClients.kind, 'oauth'),
  ));
  if ((active?.n ?? 0) >= MAX_AGENT_KEYS) {
    throw problem(409, 'agent_key_limit', `A browser can have at most ${MAX_AGENT_KEYS} active keys. Revoke one you no longer use first.`);
  }
  const key = newSecret(KEY_PREFIX);
  const keyPrefix = key.slice(0, KEY_PREFIX.length + 6);
  const clientId = newId(now.getTime());
  const days = body.expiresInDays === null ? null : (AGENT_KEY_EXPIRY_DAYS as readonly number[]).includes(body.expiresInDays) ? body.expiresInDays : 90;
  const expiresAt = days === null ? null : new Date(now.getTime() + days * 86_400_000);
  await db.batch([
    db.insert(automationClients).values({
      id: clientId, instanceId: row.id, userId, name: body.name, kind: 'key', keyPrefix, capability: body.capability,
      credentialHash: await credentialHash(key), expiresAt, createdAt: now, activatedAt: now,
    }),
    db.insert(auditLog).values({ actor: `user:${userId}`, action: 'automation.key_created', target: `instance:${row.id}`,
      detail: { clientId, name: body.name, keyPrefix, capability: body.capability, expiresAt: expiresAt?.toISOString() ?? null }, createdAt: now }),
    db.insert(events).values(eventRow(userId, 'instance.updated', { instanceId: row.id }, now)),
  ]);
  waitUntil(sendToUser(env, db, userId, agentKeyCreatedMessage(body.name, row.name, `${env.APP_URL}/browsers/${row.id}/settings`)));
  return { clientId, name: body.name, key, keyPrefix, expiresAt: expiresAt?.toISOString() ?? null, capability: body.capability, mcpUrl: mcpUrl(env, row.id) };
}

/** Revokes one key, sign-in or legacy bridge of a browser: it stops working at once and its session is closed. */
export async function revokeClient(db: Db, env: Pick<Env, 'GATEWAY'>, userId: string, row: Pick<InstanceRow, 'id'>, clientId: string, now = new Date()): Promise<boolean> {
  return revokeClientWhere(db, env, `user:${userId}`, {}, and(eq(automationClients.id, clientId), eq(automationClients.instanceId, row.id), eq(automationClients.userId, userId)), now);
}

/** Revokes one key or sign-in of any of the user's browsers (the account page's Connected agents). */
export async function revokeUserClient(db: Db, env: Pick<Env, 'GATEWAY'>, userId: string, clientId: string, now = new Date()): Promise<boolean> {
  return revokeClientWhere(db, env, `user:${userId}`, {}, and(eq(automationClients.id, clientId), eq(automationClients.userId, userId)), now);
}

/**
 * Revokes a sign-in for a reason of its own (the app's logout, a reused code or refresh token),
 * with the same effect as the owner's revoke.
 */
export async function revokeClientById(db: Db, env: Pick<Env, 'GATEWAY'>, clientId: string, actor: string, reason: string, now = new Date()): Promise<boolean> {
  return revokeClientWhere(db, env, actor, { reason }, eq(automationClients.id, clientId), now);
}

async function revokeClientWhere(db: Db, env: Pick<Env, 'GATEWAY'>, actor: string, detail: Record<string, string>, where: ReturnType<typeof and>, now: Date): Promise<boolean> {
  const [revoked] = await db.update(automationClients).set(revokedFields(now))
    .where(and(where, isNull(automationClients.revokedAt)))
    .returning({ id: automationClients.id, instanceId: automationClients.instanceId, userId: automationClients.userId });
  if (!revoked) return false;
  await db.batch([
    db.update(automationSessions).set({ endedAt: now, endReason: 'client_revoked' }).where(and(eq(automationSessions.clientId, revoked.id), isNull(automationSessions.endedAt))),
    db.insert(auditLog).values({ actor, action: 'automation.client_revoked', target: `instance:${revoked.instanceId}`, detail: { clientId: revoked.id, ...detail }, createdAt: now }),
    db.insert(events).values(eventRow(revoked.userId, 'instance.updated', { instanceId: revoked.instanceId }, now)),
  ]);
  await env.GATEWAY?.revokeAutomation?.(revoked.instanceId, revoked.id).catch((e: unknown) => console.error('revoke agent session failed', revoked.instanceId, e));
  return true;
}

/**
 * Statements that revoke every key of a browser and end its sessions, for the deletion
 * transaction: a deleted browser keeps no coding-agent access, even through the restore window.
 */
export function revokeInstanceClientsStatements(db: Db, instanceId: string, now: Date) {
  return [
    db.update(automationClients).set(revokedFields(now))
      .where(and(eq(automationClients.instanceId, instanceId), isNull(automationClients.revokedAt))),
    db.update(automationSessions).set({ endedAt: now, endReason: 'browser_deleted' })
      .where(and(eq(automationSessions.instanceId, instanceId), isNull(automationSessions.endedAt))),
  ] as const;
}

/**
 * "Sign out everywhere" also revokes the user's coding-agent keys and sign-ins: whoever had a
 * session may have created one. So does "Disconnect all" on the account page. The browsers'
 * gateways close the open agent sessions at once.
 */
export async function revokeUserClients(db: Db, env: Pick<Env, 'GATEWAY'>, userId: string, now = new Date(), reason: 'sign_out_everywhere' | 'disconnect_all' = 'sign_out_everywhere'): Promise<number> {
  const revoked = await db.update(automationClients).set(revokedFields(now))
    .where(and(eq(automationClients.userId, userId), isNull(automationClients.revokedAt)))
    .returning({ id: automationClients.id, instanceId: automationClients.instanceId });
  if (!revoked.length) return 0;
  const instances = [...new Set(revoked.map((r) => r.instanceId))];
  await db.batch([
    db.update(automationSessions).set({ endedAt: now, endReason: 'client_revoked' })
      .where(and(inArray(automationSessions.clientId, revoked.map((r) => r.id)), isNull(automationSessions.endedAt))),
    ...instances.map((id) => db.insert(auditLog).values({ actor: `user:${userId}`, action: 'automation.clients_revoked', target: `instance:${id}`,
      detail: { clients: revoked.filter((r) => r.instanceId === id).map((r) => r.id), reason }, createdAt: now })),
    ...instances.map((id) => db.insert(events).values(eventRow(userId, 'instance.updated', { instanceId: id }, now))),
  ]);
  await Promise.all(instances.map((id) => env.GATEWAY?.revokeAutomation?.(id).catch((e: unknown) => console.error('revoke agent session failed', id, e))));
  return revoked.length;
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

/** Turning access off ends the agent's session at once; turning it on just allows new ones. Keys are kept. */
export async function setAccess(db: Db, env: Pick<Env, 'GATEWAY'>, userId: string, row: InstanceRow, enabled: boolean, now = new Date()) {
  await db.batch([
    db.update(browserInstances).set({ agentAccess: enabled, updatedAt: now }).where(eq(browserInstances.id, row.id)),
    ...(enabled ? [] : [db.update(automationSessions).set({ endedAt: now, endReason: 'access_off' }).where(and(eq(automationSessions.instanceId, row.id), isNull(automationSessions.endedAt)))]),
    db.insert(auditLog).values({ actor: `user:${userId}`, action: enabled ? 'automation.access_on' : 'automation.access_off', target: `instance:${row.id}`, createdAt: now }),
  ]);
  await env.GATEWAY?.automationControl?.(row.id, controlModeOf(row), enabled).catch((e: unknown) => console.error('push access switch failed', row.id, e));
}

/**
 * The gateway's check of an MCP request's key or sign-in access token. It must belong to the
 * browser in the URL (a credential for one browser never reaches another), be neither revoked nor
 * expired (a sign-in's access token lasts an hour, the sign-in until the end the owner chose), and
 * its browser must still be the owner's and not deleted. Whether the browser is running, access is on and
 * credit is available is the gateway's to report as a tool error, so clients do not mistake it
 * for bad credentials and ask the user to sign in again. No session is opened here.
 */
export async function authenticateMcp(db: Db, input: { instanceId: string; key: string; ip?: string; client?: string }, now = new Date()): Promise<McpAuth> {
  if (!input.key || !isKeyFormat(input.key)) return { ok: false, reason: 'invalid_token' };
  const oauth = ACCESS_TOKEN_FORMAT.test(input.key);
  const [client] = await db.select().from(automationClients)
    .where(and(eq(automationClients.credentialHash, oauth ? await accessTokenHash(input.key) : await credentialHash(input.key)), isNull(automationClients.revokedAt)));
  if (!client || client.instanceId !== input.instanceId || (client.kind === 'oauth') !== oauth) return { ok: false, reason: 'invalid_token' };
  if (client.expiresAt && client.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (oauth && (!client.accessExpiresAt || client.accessExpiresAt <= now)) return { ok: false, reason: 'expired' };
  const [inst] = await db.select({ status: browserInstances.status, desiredState: browserInstances.desiredState, generation: agentCredentials.generation, providerRegion: regions.providerRegion })
    .from(browserInstances).leftJoin(agentCredentials, eq(agentCredentials.instanceId, browserInstances.id))
    .leftJoin(regions, eq(regions.id, browserInstances.regionId))
    .where(and(eq(browserInstances.id, client.instanceId), eq(browserInstances.userId, client.userId)));
  if (!inst || unavailable(inst)) return { ok: false, reason: 'unknown_instance' };
  const lastClient = input.client?.trim().slice(0, 120) || null;
  if (!client.lastSeenAt || now.getTime() - client.lastSeenAt.getTime() >= LAST_SEEN_MS || (lastClient && lastClient !== client.lastClient)) {
    await db.update(automationClients).set({
      lastSeenAt: now, lastIp: input.ip?.slice(0, 64) ?? client.lastIp, ...(lastClient ? { lastClient } : {}),
    }).where(eq(automationClients.id, client.id));
  }
  const location = objectLocationHint(inst.providerRegion);
  return {
    ok: true, clientId: client.id, userId: client.userId, generation: inst.generation ?? 0,
    capability: client.capability === 'view' ? 'view' : 'control', name: client.name, ...(location ? { location } : {}),
  };
}

/**
 * The gateway opens a session on an agent's first tool call. One session per browser: any other
 * still open (a replaced agent, a close the gateway lost) ends as `replaced`.
 */
export async function openAutomationSession(db: Db, instanceId: string, clientId: string, now = new Date()): Promise<{ sessionId: string }> {
  const [client] = await db.select({ id: automationClients.id, userId: automationClients.userId, generation: agentCredentials.generation })
    .from(automationClients).leftJoin(agentCredentials, eq(agentCredentials.instanceId, automationClients.instanceId))
    .where(and(eq(automationClients.id, clientId), eq(automationClients.instanceId, instanceId), isNull(automationClients.revokedAt)));
  if (!client) throw new Error('automation client unavailable');
  const sessionId = newId(now.getTime());
  await db.batch([
    db.update(automationSessions).set({ endedAt: now, endReason: 'replaced' }).where(and(eq(automationSessions.instanceId, instanceId), isNull(automationSessions.endedAt))),
    db.insert(automationSessions).values({ id: sessionId, instanceId, clientId, userId: client.userId, generation: client.generation ?? 0, startedAt: now, lastSeenAt: now }),
    db.update(automationClients).set({ lastSeenAt: now }).where(eq(automationClients.id, clientId)),
    db.insert(auditLog).values({ actor: `automation:${clientId}`, action: 'automation.session_opened', target: `instance:${instanceId}`, detail: { sessionId }, createdAt: now }),
    db.insert(events).values(eventRow(client.userId, 'instance.updated', { instanceId }, now)),
  ]);
  return { sessionId };
}

export async function endAutomationSession(db: Db, sessionId: string, reason: string, now = new Date()) {
  const ended = await db.update(automationSessions).set({ endedAt: now, endReason: reason.slice(0, 32) })
    .where(and(eq(automationSessions.id, sessionId), isNull(automationSessions.endedAt)))
    .returning({ instanceId: automationSessions.instanceId, userId: automationSessions.userId, clientId: automationSessions.clientId });
  const s = ended[0];
  if (!s) return;
  await db.batch([
    db.update(automationClients).set({ lastSeenAt: now }).where(eq(automationClients.id, s.clientId)),
    db.insert(auditLog).values({ actor: `automation:${s.clientId}`, action: 'automation.session_ended', target: `instance:${s.instanceId}`, detail: { sessionId, reason }, createdAt: now }),
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
