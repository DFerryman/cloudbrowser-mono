import { AgentFrame, AutomationRequest, AUTOMATION_LIMITS, AUTOMATION_PROTOCOL_VERSION, ViewerFrame, type AgentControlMode, type ControlState, type GatewayToAgent, type GatewayToAutomation, type GatewayToViewer } from '@cloudbrowser/contracts';
import { createDb, prepaidAccess } from '@cloudbrowser/db';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';
import { connectionAttempt, connectionLog, type ConnectionIdentity } from './connection-log.js';

type Attachment = ({ instanceId?: string } & { role: 'agent'; generation: number })
  | ({ instanceId?: string; attemptId?: string; signalsSeen?: string[] } & { role: 'viewer'; sessionId: string; generation: number; relayId?: string })
  /** A coding agent's bridge (docs/agent-access.md); `startedAt` bounds the session's life. */
  | ({ instanceId?: string } & { role: 'automation'; sessionId: string; clientId: string; userId: string; generation: number; startedAt: number });
type CommandRow = { id: string; kind: string; payload: string };
type LiveInstance = { user_id: string; status: string; desired_state: string; generation: number | null; agent_access: number; agent_control: string };
type Role = Attachment['role'];
const ROLES: readonly Role[] = ['agent', 'viewer', 'automation'];
const controlMode = (row: LiveInstance): AgentControlMode => (row.agent_control === 'user' || row.agent_control === 'privacy' ? row.agent_control : 'agent');

/** Frames bigger than this are refused (page 2: message size limits). */
const MAX_FRAME_BYTES = 256 * 1024;
/** Bridge screenshots arrive as several blob frames at once; they are relayed, never held. */
const MAX_QUEUED_FRAME_BYTES = 4 * 1024 * 1024;
/** A bridge's actions count as activity for auto-sleep this often, like a viewer's input. */
const AUTOMATION_ACTIVITY_MS = 30_000;
const MAX_QUEUED_FRAMES = 4096;
/** All relay frames share a short authorization lease; stop/delete RPCs revoke it immediately. */
const INPUT_AUTH_LEASE_MS = 1000;
/**
 * A lease in use is re-checked this long before it lapses, in the background, so the ordered
 * relay (the WebRTC handshake, typing) does not stall on D1 every second. The checks and the
 * lease length are unchanged; a frame that finds an expired lease still waits for a fresh check.
 */
const RENEW_BEFORE_MS = 500;
/**
 * With no frames to re-check, the alarm re-checks open viewers this often (or at an earlier
 * credit deadline). Frames still use the one-second lease; stop and delete RPCs still
 * revoke at once. Re-reading D1 every second for an idle viewer only multiplied the chance that a
 * transient read error closed a healthy connection.
 */
const IDLE_RECHECK_MS = 10_000;
/** A failed D1 read is retried after these pauses before authorization fails closed. */
const READ_RETRY_MS = [100, 400];

async function withRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const wait = READ_RETRY_MS[attempt];
      if (wait === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
/** `until` ends the lease for frames; `recheckAt` is when the alarm re-checks it without one. */
type InputGrant = { instanceId: string; row: LiveInstance; until: number; recheckAt: number };

// Operation commands use <operation id>:<step>. Legacy commands without a prefix and
// independent periodic IP checks remain compatible, but canceled work cannot be delivered.
const COMMAND_ACTIVE = `(instr(c.id, ':') = 0 OR substr(c.id, 1, 8) = 'ipcheck:' OR EXISTS (
  SELECT 1 FROM operations o WHERE o.id = substr(c.id, 1, instr(c.id, ':') - 1)
    AND o.instance_id = c.instance_id AND o.finished_at IS NULL))`;

/**
 * One Durable Object per browser instance: the meeting point of that instance's agent tunnel and
 * its viewer (page 2, `services/gateway`). It replaces the plan's Go gateway and its
 * `agent_sessions` registry, because routing by instance id is what a Durable Object gives for
 * free. Uses the WebSocket hibernation API, so idle connections cost nothing between frames.
 */
export class InstanceGateway extends DurableObject<Env> {
  // Prevent an upgrade already awaiting a DB read from surviving a concurrent revoke RPC.
  private revocationEpoch = 0;
  private messageTail: Promise<void> = Promise.resolve();
  private queuedFrames = 0;
  private queuedFrameBytes = 0;
  private inputGrants = new Map<string, InputGrant>();
  private sessionChecks = new Map<string, Promise<boolean>>();
  private renewal: Promise<void> | null = null;
  /** The VM's last reported control state; the mode is also persisted by the api. */
  private control: ControlState | null = null;
  private automationActivityAt = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  private async instanceId(): Promise<string> {
    return (await this.ctx.storage.get<string>('instanceId')) ?? '';
  }

  private sockets(role: Role) {
    return this.ctx.getWebSockets(role).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private identity(ws: WebSocket, instanceId?: string): ConnectionIdentity & { role?: Role } {
    const att = ws.deserializeAttachment() as Attachment | null;
    return {
      instanceId: att?.instanceId ?? instanceId,
      generation: att?.generation,
      role: att?.role,
      ...(att?.role === 'viewer' ? { sessionId: att.sessionId, relayId: att.relayId, attemptId: att.attemptId } : {}),
      ...(att?.role === 'automation' ? { sessionId: att.sessionId } : {}),
    };
  }

  // --- coding-agent bridges (docs/agent-access.md) -------------------------------------------

  private controlState(row: LiveInstance): ControlState {
    const mode = controlMode(row);
    // The VM's report is authoritative while it agrees with the persisted mode; the api's own
    // writes (hand-back, pause) reach the VM through this object, which updates both.
    return this.control && this.control.mode === mode ? this.control : { controller: 'none', mode, epoch: this.control?.epoch ?? 0 };
  }

  private sendAutomation(ws: WebSocket, frame: GatewayToAutomation) {
    return this.send(ws, frame as never);
  }

  /** Tells viewers whether a bridge is connected and who may drive the browser. */
  private broadcastAutomationStatus(row: LiveInstance) {
    const connected = this.sockets('automation').length > 0;
    const control = this.controlState(row);
    for (const v of this.sockets('viewer')) this.send(v, { t: 'automation_status', connected, control });
  }

  private openAutomationRelay(agent: WebSocket, bridge: WebSocket) {
    const att = bridge.deserializeAttachment() as Attachment | null;
    if (att?.role !== 'automation') return;
    if (!this.send(agent, { t: 'automation_open', sessionId: att.sessionId, clientId: att.clientId })) {
      this.sendAutomation(bridge, { t: 'agent_offline' });
    }
  }

  private closeAutomation(ws: WebSocket, reason: 'access_off' | 'client_revoked' | 'session_expired' | 'browser_unavailable', code = 4003) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role !== 'automation') { ws.close(code, reason); return; }
    connectionLog('automation_revoked', { ...this.identity(ws), closeCode: code, code: reason });
    this.inputGrants.delete(`automation:${att.sessionId}`);
    this.sendAutomation(ws, { t: 'revoked', reason });
    for (const agent of this.sockets('agent')) this.send(agent, { t: 'automation_close', sessionId: att.sessionId });
    ws.close(code, reason);
    this.ctx.waitUntil(this.env.API.endAutomationSession(att.sessionId, reason).catch(() => {}));
  }

  /** A bridge's session must still be open, its client paired, agent access on and credit available. */
  private async validAutomation(att: Extract<Attachment, { role: 'automation' }>, row: LiveInstance, instanceId: string, allowCached: boolean): Promise<boolean> {
    if (row.desired_state !== 'running' || row.status !== 'running' || !row.agent_access) return false;
    if (Date.now() - att.startedAt > AUTOMATION_LIMITS.maxSessionMs) return false;
    const key = `automation:${att.sessionId}`;
    const cached = this.inputGrants.get(key);
    if (allowCached && cached && cached.instanceId === instanceId && cached.row.user_id === row.user_id
      && cached.row.generation === row.generation && cached.until > Date.now()) return true;
    const checkKey = `${this.revocationEpoch}:${instanceId}:${row.user_id}:${row.generation}:${key}`;
    const checking = this.sessionChecks.get(checkKey);
    if (checking) return checking;
    const check = this.refreshAutomation(att, row, instanceId, key);
    this.sessionChecks.set(checkKey, check);
    try { return await check; }
    finally { if (this.sessionChecks.get(checkKey) === check) this.sessionChecks.delete(checkKey); }
  }

  private async refreshAutomation(att: Extract<Attachment, { role: 'automation' }>, row: LiveInstance, instanceId: string, key: string): Promise<boolean> {
    const epoch = this.revocationEpoch;
    try {
      const [session, access] = await withRetry(() => Promise.all([
        this.env.DB.prepare(`SELECT s.id FROM automation_sessions s JOIN automation_clients c ON c.id = s.client_id
          WHERE s.id = ? AND s.instance_id = ? AND s.user_id = ? AND s.ended_at IS NULL
            AND c.revoked_at IS NULL AND c.instance_id = s.instance_id`)
          .bind(att.sessionId, instanceId, row.user_id).first(),
        prepaidAccess(createDb(this.env.DB), row.user_id, instanceId),
      ]));
      if (!session) {
        connectionLog('automation_authorization_rejected', { instanceId, generation: row.generation, sessionId: att.sessionId, code: 'session_ended' });
        return false;
      }
      if (!access.allowed || epoch !== this.revocationEpoch) {
        connectionLog('automation_authorization_rejected', { instanceId, generation: row.generation, sessionId: att.sessionId, code: access.allowed ? 'revoked' : 'billing_denied' });
        return false;
      }
      const until = Math.min(Date.now() + INPUT_AUTH_LEASE_MS, access.deadlineAt?.getTime() ?? Infinity);
      if (until <= Date.now()) return false;
      const recheckAt = Math.min(Date.now() + IDLE_RECHECK_MS, access.deadlineAt?.getTime() ?? Infinity);
      const grant = { instanceId, row, until, recheckAt };
      this.inputGrants.set(key, grant);
      await this.ctx.storage.setAlarm(recheckAt);
      if (epoch !== this.revocationEpoch || until <= Date.now()) {
        if (this.inputGrants.get(key) === grant) this.inputGrants.delete(key);
        return false;
      }
      return true;
    } catch {
      connectionLog('automation_authorization_failed', { instanceId, generation: row.generation, sessionId: att.sessionId, code: 'authorization_unavailable' });
      this.closeAll('authorization unavailable');
      return false;
    }
  }

  /** A bridge's action is activity for auto-sleep and the Settings page, recorded at most every 30 s. */
  private async touchAutomationActivity(instanceId: string, sessionId: string) {
    const now = Date.now();
    if (now - this.automationActivityAt < AUTOMATION_ACTIVITY_MS) return;
    this.automationActivityAt = now;
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(`INSERT INTO instance_health (instance_id, last_input_at) VALUES (?, ?)
          ON CONFLICT (instance_id) DO UPDATE SET last_input_at = max(coalesce(instance_health.last_input_at, 0), excluded.last_input_at)`).bind(instanceId, now),
        this.env.DB.prepare(`UPDATE automation_sessions SET last_seen_at = ? WHERE id = ? AND instance_id = ? AND ended_at IS NULL`).bind(now, sessionId, instanceId),
      ]);
    } catch {
      this.automationActivityAt = 0; // next action tries again; activity is best effort
    }
  }

  private openViewerRelay(agent: WebSocket, viewer: WebSocket): void {
    const att = viewer.deserializeAttachment() as Attachment | null;
    if (att?.role !== 'viewer') return;
    const sent = this.send(agent, { t: 'viewer_open', sessionId: att.sessionId, relayId: att.relayId });
    connectionLog(sent ? 'viewer_open_sent' : 'viewer_open_failed', { ...this.identity(viewer), code: sent ? undefined : 'relay_unavailable' });
    if (!sent) this.inputFailure(att.sessionId, 'relay_unavailable', att.relayId);
  }

  private send(ws: WebSocket, frame: GatewayToAgent | GatewayToViewer) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private closeViewer(ws: WebSocket, sessionId: string, code = 4003, reason = 'session revoked') {
    connectionLog('viewer_revoked', { ...this.identity(ws), closeCode: code, code: reason.replaceAll(' ', '_') });
    this.inputGrants.delete(sessionId);
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const relayId = attachment?.role === 'viewer' ? attachment.relayId : undefined;
    for (const agent of this.sockets('agent')) this.send(agent, { t: 'viewer_close', sessionId, relayId });
    ws.close(code, reason);
  }

  private closeAll(reason: string, code = 4003) {
    this.inputGrants.clear();
    for (const viewer of this.sockets('viewer')) {
      const attachment = viewer.deserializeAttachment() as Attachment | null;
      if (attachment?.role === 'viewer') this.closeViewer(viewer, attachment.sessionId, code, reason);
      else viewer.close(code, reason);
    }
    for (const bridge of this.sockets('automation')) this.closeAutomation(bridge, 'browser_unavailable', code);
    for (const agent of this.sockets('agent')) {
      connectionLog('agent_revoked', { ...this.identity(agent), closeCode: code, code: reason.replaceAll(' ', '_') });
      agent.close(code, reason);
    }
  }

  /** D1 is authoritative; upgrades and expired authorization leases read current state. */
  private async liveInstance(instanceId: string): Promise<LiveInstance | null> {
    try {
      const row = await withRetry(() => this.env.DB.prepare(`SELECT b.user_id, b.status, b.desired_state, a.generation, b.agent_access, b.agent_control
        FROM browser_instances b LEFT JOIN agent_credentials a ON a.instance_id = b.id WHERE b.id = ?`)
        .bind(instanceId).first<LiveInstance>());
      if (!row || row.desired_state === 'deleted' || ['deleting', 'purged', 'failed'].includes(row.status)) {
        this.closeAll('browser unavailable');
        return null;
      }
      return row;
    } catch {
      connectionLog('instance_lookup_failed', { instanceId, code: 'authorization_unavailable' });
      this.closeAll('authorization unavailable');
      return null;
    }
  }

  private async validSocket(ws: WebSocket, row: LiveInstance, instanceId: string, allowCached = false): Promise<boolean> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment || !ROLES.includes(attachment.role) || !row.generation || attachment.generation !== row.generation) {
      connectionLog('socket_rejected', { ...this.identity(ws, instanceId), code: 'generation_revoked', closeCode: 4003 });
      ws.close(4003, 'generation revoked');
      return false;
    }
    if (attachment.role === 'viewer') {
      if (!(await this.validSession(attachment.sessionId, row, instanceId, allowCached))) {
        this.closeViewer(ws, attachment.sessionId);
        return false;
      }
    }
    if (attachment.role === 'automation') {
      if (!(await this.validAutomation(attachment, row, instanceId, allowCached))) {
        const reason = !row.agent_access ? 'access_off' : Date.now() - attachment.startedAt > AUTOMATION_LIMITS.maxSessionMs ? 'session_expired' : 'client_revoked';
        this.closeAutomation(ws, reason);
        this.broadcastAutomationStatus(row);
        return false;
      }
    }
    return ws.readyState === WebSocket.OPEN;
  }

  private async validSession(sessionId: string, row: LiveInstance, instanceId: string, allowCached = false): Promise<boolean> {
    if (row.desired_state !== 'running' || row.status !== 'running') return false;
    const cached = this.inputGrants.get(sessionId);
    if (allowCached && cached && cached.instanceId === instanceId && cached.row.user_id === row.user_id
      && cached.row.generation === row.generation && cached.until > Date.now()) return true;
    // An alarm, upgrade and the FIFO relay can await the same check. Never launch duplicate
    // cross-region billing reads for a single authorization decision.
    const key = `${this.revocationEpoch}:${instanceId}:${row.user_id}:${row.generation}:${sessionId}`;
    const checking = this.sessionChecks.get(key);
    if (checking) return checking;
    const check = this.refreshSession(sessionId, row, instanceId);
    this.sessionChecks.set(key, check);
    try { return await check; }
    finally { if (this.sessionChecks.get(key) === check) this.sessionChecks.delete(key); }
  }

  private async refreshSession(sessionId: string, row: LiveInstance, instanceId: string): Promise<boolean> {
    const epoch = this.revocationEpoch;
    try {
      // Both reads are independent; one round trip instead of two on the connect path.
      const [session, access] = await withRetry(() => Promise.all([
        this.env.DB.prepare(`SELECT id FROM viewer_sessions
          WHERE id = ? AND instance_id = ? AND user_id = ? AND ended_at IS NULL`)
          .bind(sessionId, instanceId, row.user_id).first(),
        prepaidAccess(createDb(this.env.DB), row.user_id, instanceId),
      ]));
      if (!session) {
        connectionLog('viewer_authorization_rejected', { instanceId, generation: row.generation, sessionId, code: 'session_ended' });
        return false;
      }
      if (!access.allowed || epoch !== this.revocationEpoch) {
        connectionLog('viewer_authorization_rejected', { instanceId, generation: row.generation, sessionId, code: access.allowed ? 'revoked' : 'billing_denied' });
        return false;
      }
      const until = Math.min(Date.now() + INPUT_AUTH_LEASE_MS, access.deadlineAt?.getTime() ?? Infinity);
      if (until <= Date.now()) return false;
      const recheckAt = Math.min(Date.now() + IDLE_RECHECK_MS, access.deadlineAt?.getTime() ?? Infinity);
      const grant = { instanceId, row, until, recheckAt };
      this.inputGrants.set(sessionId, grant);
      // A depleted balance is revoked even if the viewer sends no more input frames.
      await this.ctx.storage.setAlarm(recheckAt);
      if (epoch !== this.revocationEpoch || until <= Date.now()) {
        if (this.inputGrants.get(sessionId) === grant) this.inputGrants.delete(sessionId);
        return false;
      }
      return true;
    } catch {
      connectionLog('viewer_authorization_failed', { instanceId, generation: row.generation, sessionId, code: 'authorization_unavailable' });
      this.closeAll('authorization unavailable');
      return false;
    }
  }

  private async pruneSockets(row: LiveInstance, instanceId: string, allowCached = false) {
    for (const role of ROLES) for (const ws of this.sockets(role)) await this.validSocket(ws, row, instanceId, allowCached);
  }

  /** Re-checks a lease that is about to lapse, off the relay path; failures close it as usual. */
  private renewSoon(grantKey: string, instanceId: string) {
    const grant = this.inputGrants.get(grantKey);
    if (this.renewal || !grant || grant.instanceId !== instanceId || grant.until - Date.now() > RENEW_BEFORE_MS) return;
    this.renewal = (async () => {
      const row = await this.liveInstance(instanceId);
      if (row) await this.pruneSockets(row, instanceId);
    })().catch(() => {}).finally(() => { this.renewal = null; });
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Only the gateway's trusted service entrypoint reaches this Durable Object route.
    if (url.pathname === '/revoke' && req.method === 'POST') {
      this.revocationEpoch++;
      this.closeAll('browser deleted');
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/automation-control' && req.method === 'POST') {
      // The user's choice from the api, already persisted: tell the VM, the bridges and the viewers.
      const body = await req.json<{ mode: AgentControlMode; access: boolean }>();
      const mode: AgentControlMode = body.mode === 'user' || body.mode === 'privacy' ? body.mode : 'agent';
      const access = body.access !== false;
      this.control = { controller: mode === 'agent' ? 'none' : 'user', mode, epoch: (this.control?.epoch ?? 0) + 1 };
      for (const agent of this.sockets('agent')) this.send(agent, { t: 'automation_control', mode, access });
      if (!access) for (const bridge of this.sockets('automation')) this.closeAutomation(bridge, 'access_off');
      else for (const bridge of this.sockets('automation')) this.sendAutomation(bridge, { t: 'control', control: this.control, reason: mode === 'agent' ? 'resumed' : mode === 'privacy' ? 'privacy' : 'paused' });
      const connected = this.sockets('automation').length > 0;
      for (const v of this.sockets('viewer')) this.send(v, { t: 'automation_status', connected, control: this.control });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/revoke-automation' && req.method === 'POST') {
      const body = await req.json<{ clientId: string | null }>();
      const instanceId = req.headers.get('x-cb-instance') ?? '';
      for (const bridge of this.sockets('automation')) {
        const att = bridge.deserializeAttachment() as Attachment | null;
        if (att?.role === 'automation' && (!body.clientId || att.clientId === body.clientId)) this.closeAutomation(bridge, 'client_revoked');
      }
      const row = instanceId ? await this.liveInstance(instanceId).catch(() => null) : null;
      if (row) this.broadcastAutomationStatus(row);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/revoke-viewers' && req.method === 'POST') {
      this.revocationEpoch++;
      this.inputGrants.clear();
      for (const viewer of this.sockets('viewer')) {
        const attachment = viewer.deserializeAttachment() as Attachment | null;
        if (attachment?.role === 'viewer') this.closeViewer(viewer, attachment.sessionId);
        else viewer.close(4003, 'session revoked');
      }
      return new Response(null, { status: 204 });
    }
    const epoch = this.revocationEpoch;
    const instanceId = req.headers.get('x-cb-instance') ?? '';
    const role = req.headers.get('x-cb-role');
    const admission: ConnectionIdentity & { role?: Role } = {
      instanceId, sessionId: role === 'viewer' || role === 'automation' ? req.headers.get('x-cb-session') ?? undefined : undefined,
      attemptId: role === 'viewer' ? connectionAttempt(req.headers.get('x-cb-attempt')) : undefined,
      role: role === 'agent' || role === 'viewer' || role === 'automation' ? role : undefined,
    };
    if (role === 'viewer') connectionLog('viewer_admission_started', admission);
    if (instanceId) await this.ctx.storage.put('instanceId', instanceId);

    if (url.pathname === '/deliver') {
      await this.deliverPending();
      return new Response(null, { status: 204 });
    }
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    const row = await this.liveInstance(instanceId);
    if (!row || epoch !== this.revocationEpoch) {
      connectionLog('upgrade_rejected', { ...admission, code: 'instance_unavailable', status: 403 });
      return new Response('browser unavailable', { status: 403 });
    }
    await this.pruneSockets(row, instanceId, true);
    if (epoch !== this.revocationEpoch) {
      connectionLog('upgrade_rejected', { ...admission, generation: row.generation, code: 'revoked', status: 403 });
      return new Response('browser unavailable', { status: 403 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    if (role === 'agent') {
      const generation = Number(req.headers.get('x-cb-generation') ?? 0);
      if (!row.generation || generation !== row.generation) {
        connectionLog('agent_upgrade_rejected', { ...admission, generation, code: 'generation_revoked', status: 403 });
        return new Response('generation revoked', { status: 403 });
      }
      // A reconnecting agent replaces the old tunnel.
      for (const old of this.sockets('agent')) {
        connectionLog('agent_replaced', { ...this.identity(old, instanceId), closeCode: 4000 });
        old.close(4000, 'replaced');
      }
      const att: Attachment = { role: 'agent', generation, instanceId };
      this.ctx.acceptWebSocket(server, ['agent']);
      server.serializeAttachment(att);
      connectionLog('agent_tunnel_accepted', this.identity(server));
      const credential = req.headers.get('x-cb-credential');
      const automation = { mode: controlMode(row), access: !!row.agent_access };
      this.send(server, credential ? { t: 'welcome', credential, viewerStages: true, automation } : { t: 'welcome', viewerStages: true, automation });
      for (const v of this.sockets('viewer')) {
        this.send(v, { t: 'agent_online' });
        this.openViewerRelay(server, v);
      }
      for (const b of this.sockets('automation')) {
        this.sendAutomation(b, { t: 'agent_online' });
        this.openAutomationRelay(server, b);
      }
      await this.deliverPending();
    } else if (role === 'viewer') {
      const sessionId = req.headers.get('x-cb-session') ?? '';
      const attachment: Attachment = { role: 'viewer', sessionId, generation: row.generation ?? 0, relayId: crypto.randomUUID(), instanceId, attemptId: admission.attemptId };
      if (!row.generation || !(await this.validSession(sessionId, row, instanceId)) || epoch !== this.revocationEpoch) {
        connectionLog('viewer_admission_rejected', { ...admission, generation: row.generation, relayId: attachment.relayId, code: 'authorization_rejected', status: 403 });
        return new Response('session revoked', { status: 403 });
      }
      // One controller at a time: the newest viewer takes over (page 5).
      for (const old of this.sockets('viewer')) {
        const prior = old.deserializeAttachment() as Attachment | null;
        if (prior?.role === 'viewer' && prior.sessionId === sessionId) old.close(4000, 'reconnected');
        else { this.send(old, { t: 'taken_over' }); old.close(4001, 'taken over'); }
      }
      this.ctx.acceptWebSocket(server, ['viewer', `session:${sessionId}`]);
      server.serializeAttachment(attachment);
      connectionLog('viewer_gateway_accepted', this.identity(server));
      this.send(server, { t: 'connection_stage', stage: 'gateway_accepted', relayId: attachment.relayId });
      const agent = this.sockets('agent')[0];
      this.send(server, agent ? { t: 'agent_online' } : { t: 'agent_offline' });
      if (agent) this.openViewerRelay(agent, server);
      else connectionLog('viewer_agent_offline', { ...this.identity(server), code: 'relay_unavailable' });
      this.send(server, { t: 'automation_status', connected: this.sockets('automation').length > 0, control: this.controlState(row) });
    } else if (role === 'automation') {
      const sessionId = req.headers.get('x-cb-session') ?? '';
      const attachment: Attachment = {
        role: 'automation', sessionId, clientId: req.headers.get('x-cb-client') ?? '', userId: req.headers.get('x-cb-user') ?? '',
        generation: Number(req.headers.get('x-cb-generation') ?? 0), instanceId, startedAt: Date.now(),
      };
      if (!row.generation || attachment.generation !== row.generation || !row.agent_access || attachment.userId !== row.user_id
        || !(await this.validAutomation(attachment, row, instanceId, false)) || epoch !== this.revocationEpoch) {
        connectionLog('automation_admission_rejected', { ...admission, generation: row.generation, code: !row.agent_access ? 'access_off' : 'authorization_rejected', status: 403 });
        return new Response('automation refused', { status: 403 });
      }
      // One bridge at a time: a newer connection from the same or another client replaces it.
      for (const old of this.sockets('automation')) this.closeAutomation(old, 'client_revoked', 4001);
      this.ctx.acceptWebSocket(server, ['automation', `automation:${sessionId}`]);
      server.serializeAttachment(attachment);
      connectionLog('automation_gateway_accepted', this.identity(server));
      this.sendAutomation(server, { t: 'welcome', sessionId, instanceId, clientId: attachment.clientId, protocol: AUTOMATION_PROTOCOL_VERSION, mode: controlMode(row) });
      const agent = this.sockets('agent')[0];
      this.sendAutomation(server, agent ? { t: 'agent_online' } : { t: 'agent_offline' });
      if (agent) this.openAutomationRelay(agent, server);
      this.broadcastAutomationStatus(row);
    } else {
      return new Response('forbidden', { status: 403 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (typeof message !== 'string' || bytes > MAX_FRAME_BYTES) {
      ws.close(1009, 'frame too large or not text');
      return Promise.resolve();
    }
    if (this.queuedFrames >= MAX_QUEUED_FRAMES || this.queuedFrameBytes + bytes > MAX_QUEUED_FRAME_BYTES) {
      // Make failure visible instead of silently dropping an input or growing memory forever.
      this.closeAll('input queue overloaded', 1013);
      return Promise.resolve();
    }
    this.queuedFrames++;
    this.queuedFrameBytes += bytes;
    // D1/RPC awaits can otherwise let a later WebSocket event overtake this one.
    const next = this.messageTail.then(() => this.processWebSocketMessage(ws, message))
      .catch(() => { this.closeAll('input processing failed', 1011); })
      .finally(() => { this.queuedFrames--; this.queuedFrameBytes -= bytes; });
    this.messageTail = next;
    return next;
  }

  private async processWebSocketMessage(ws: WebSocket, message: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const epoch = this.revocationEpoch;
    const instanceId = await this.instanceId();
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      ws.close(1007, 'invalid json');
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const frameType = raw && typeof raw === 'object' && 't' in raw ? String(raw.t) : '';
    const frameSession = raw && typeof raw === 'object' && 'sessionId' in raw && typeof raw.sessionId === 'string' ? raw.sessionId : null;
    const relayedSession = attachment?.role === 'viewer' ? attachment.sessionId
      : attachment?.role === 'automation' ? `automation:${attachment.sessionId}`
        : ['viewer', 'viewer_error', 'viewer_stage'].includes(frameType) ? frameSession
          : frameType === 'automation_result' && frameSession ? `automation:${frameSession}` : null;
    const cached = relayedSession ? this.inputGrants.get(relayedSession) : null;
    // SDP and system/init are on the same authorized channel as input. Reading the instance,
    // session and billing multiple times per signal can stall the entire ordered handshake.
    const row = cached && cached.instanceId === instanceId && cached.until > Date.now()
      ? cached.row : await this.liveInstance(instanceId);
    if (!row || epoch !== this.revocationEpoch) return;
    await this.pruneSockets(row, instanceId, true);
    if (!(await this.validSocket(ws, row, instanceId, true)) || epoch !== this.revocationEpoch) return;
    if (relayedSession) this.renewSoon(relayedSession, instanceId);
    const att = ws.deserializeAttachment() as Attachment;
    if (att.role === 'agent') await this.fromAgent(ws, att, raw);
    else if (att.role === 'viewer') this.fromViewer(ws, att, raw);
    else await this.fromAutomation(ws, att, raw, row, instanceId);
  }

  override async alarm() {
    const instanceId = await this.instanceId();
    const viewers = [...this.sockets('viewer'), ...this.sockets('automation')];
    if (!instanceId || !viewers.length) return;
    // A frame may have renewed an expiring lease before this alarm was delivered. Preserve the
    // renewed grant; it already scheduled its own bounded deadline. Expired grants are rechecked.
    const grants = viewers.map(viewer => {
      const att = viewer.deserializeAttachment() as Attachment | null;
      return att?.role === 'viewer' ? this.inputGrants.get(att.sessionId)
        : att?.role === 'automation' ? this.inputGrants.get(`automation:${att.sessionId}`) : null;
    });
    if (grants.every(grant => grant && grant.instanceId === instanceId && grant.until > Date.now())) {
      await this.ctx.storage.setAlarm(Math.min(...grants.map(grant => grant!.recheckAt)));
      return;
    }
    const row = await this.liveInstance(instanceId);
    if (row) await this.pruneSockets(row, instanceId, true);
  }

  private async fromAgent(ws: WebSocket, att: Extract<Attachment, { role: 'agent' }>, raw: unknown) {
    const parsed = AgentFrame.safeParse(raw);
    if (!parsed.success) {
      connectionLog('agent_frame_rejected', { ...this.identity(ws), code: 'invalid_frame', closeCode: 1007 });
      ws.close(1007, 'invalid frame');
      return;
    }
    const frame = parsed.data;
    if (frame.t === 'viewer_stage') {
      let matched = false;
      for (const viewer of this.sockets('viewer')) {
        const attachment = viewer.deserializeAttachment() as Attachment | null;
        if (attachment?.role !== 'viewer' || attachment.sessionId !== frame.sessionId || attachment.relayId !== frame.relayId) continue;
        matched = true;
        connectionLog(`agent_${frame.stage}`, { ...this.identity(viewer), role: 'agent', code: frame.code, elapsedMs: frame.elapsedMs });
        this.send(viewer, { t: 'connection_stage', stage: frame.stage, relayId: attachment.relayId, ...(frame.code ? { code: frame.code } : {}) });
      }
      // A viewer may have timed out and retried before a late agent failure arrives. Keep the
      // original failure evidence joinable by relayId without advancing the replacement UI.
      if (!matched) connectionLog(`agent_${frame.stage}`, {
        ...this.identity(ws), sessionId: frame.sessionId, relayId: frame.relayId,
        code: frame.code, elapsedMs: frame.elapsedMs, ignored: true, discardReason: 'stale_relay',
      });
      return;
    }
    if (frame.t === 'viewer_error') {
      this.inputFailure(frame.sessionId, frame.reason, frame.relayId);
      return;
    }
    if (frame.t === 'viewer') {
      for (const v of this.ctx.getWebSockets(`session:${frame.sessionId}`)) {
        if (v.readyState !== WebSocket.OPEN) continue;
        const attachment = v.deserializeAttachment() as Attachment | null;
        if (frame.relayId && (attachment?.role !== 'viewer' || attachment.relayId !== frame.relayId)) continue;
        this.traceSignal(v, 'agent', frame.data);
        this.send(v, { t: 'neko', data: frame.data });
      }
      return;
    }
    if (frame.t === 'viewer_file') {
      for (const v of this.ctx.getWebSockets(`session:${frame.sessionId}`)) {
        const attachment = v.deserializeAttachment() as Attachment | null;
        if (frame.relayId && (attachment?.role !== 'viewer' || attachment.relayId !== frame.relayId)) continue;
        this.send(v, { t: 'file', id: frame.id, status: frame.status, received: frame.received, reason: frame.reason });
      }
      return;
    }
    if (frame.t === 'automation_result') {
      for (const b of this.ctx.getWebSockets(`automation:${frame.sessionId}`)) {
        if (b.readyState === WebSocket.OPEN) this.sendAutomation(b, frame.data);
      }
      return;
    }
    if (frame.t === 'control_state') {
      // Who may drive the browser changed inside the VM (a takeover, a hand-back it applied).
      this.control = frame.control;
      connectionLog('control_changed', { ...this.identity(ws), code: frame.reason });
      const connected = this.sockets('automation').length > 0;
      for (const v of this.sockets('viewer')) this.send(v, { t: 'automation_status', connected, control: frame.control });
      await this.env.API.agentMessage(await this.instanceId(), att.generation, frame);
      return;
    }
    if (frame.t === 'hello') return;
    // Events, replies and TURN requests go to the api, which owns those records.
    const answer = await this.env.API.agentMessage(await this.instanceId(), att.generation, frame);
    if (answer) this.send(ws, answer);
    // Backstop for a lost queue poke: every heartbeat (15 s) also delivers pending commands.
    if (frame.t === 'event' && frame.kind === 'heartbeat') await this.deliverPending();
  }

  private fromViewer(ws: WebSocket, att: Extract<Attachment, { role: 'viewer' }>, raw: unknown) {
    const parsed = ViewerFrame.safeParse(raw);
    const agent = this.sockets('agent')[0];
    if (!parsed.success) { this.inputFailure(att.sessionId, 'invalid_input'); return; }
    if (!agent) { this.inputFailure(att.sessionId, 'relay_unavailable'); return; }
    if (parsed.data.t === 'neko') this.traceSignal(ws, 'viewer', parsed.data.data);
    if (!this.send(agent, { t: 'viewer', sessionId: att.sessionId, relayId: att.relayId, data: parsed.data })) {
      this.inputFailure(att.sessionId, 'relay_failed');
    }
  }

  /** A bridge's request: checked against the persisted mode here, then by the VM again when it runs. */
  private async fromAutomation(ws: WebSocket, att: Extract<Attachment, { role: 'automation' }>, raw: unknown, row: LiveInstance, instanceId: string) {
    const parsed = AutomationRequest.safeParse(raw);
    if (!parsed.success) {
      connectionLog('automation_frame_rejected', { ...this.identity(ws), code: 'invalid_frame', closeCode: 1007 });
      ws.close(1007, 'invalid frame');
      return;
    }
    const data = parsed.data;
    const mode = controlMode(row);
    const changesBrowser = data.t === 'act' || data.t === 'attach';
    if (changesBrowser && mode !== 'agent') {
      this.sendAutomation(ws, { t: 'refused', id: data.id, reason: mode === 'privacy' ? 'control_privacy' : 'control_user' });
      return;
    }
    if (data.t === 'screenshot' && mode === 'privacy') {
      this.sendAutomation(ws, { t: 'refused', id: data.id, reason: 'control_privacy' });
      return;
    }
    const agent = this.sockets('agent')[0];
    if (!agent || !this.send(agent, { t: 'automation', sessionId: att.sessionId, data })) {
      this.sendAutomation(ws, { t: 'refused', id: data.id, reason: 'relay_unavailable' });
      return;
    }
    if (changesBrowser) await this.touchAutomationActivity(instanceId, att.sessionId);
  }

  private inputFailure(sessionId: string, reason: string, relayId?: string) {
    for (const viewer of this.ctx.getWebSockets(`session:${sessionId}`)) {
      if (viewer.readyState !== WebSocket.OPEN) continue;
      const attachment = viewer.deserializeAttachment() as Attachment | null;
      if (relayId && (attachment?.role !== 'viewer' || attachment.relayId !== relayId)) continue;
      connectionLog('viewer_error', { ...this.identity(viewer), code: reason });
      this.send(viewer, { t: 'input_error', reason });
      this.closeViewer(viewer, sessionId, 1011, 'remote input unavailable');
    }
  }

  /** Signal names help diagnose stalled handshakes without logging SDP, tokens or input. */
  private traceSignal(viewer: WebSocket, role: 'agent' | 'viewer', data: unknown) {
    const event = data && typeof data === 'object' && 'event' in data ? data.event : undefined;
    const allowed = ['system/init', 'signal/request', 'signal/provide', 'signal/answer', 'signal/candidate', 'signal/video', 'signal/audio'];
    if (typeof event !== 'string' || !allowed.includes(event)) return;
    const att = viewer.deserializeAttachment() as Attachment | null;
    if (att?.role !== 'viewer') return;
    const key = `${role}:${event}`;
    if (att.signalsSeen?.includes(key)) return;
    att.signalsSeen = [...(att.signalsSeen ?? []), key];
    viewer.serializeAttachment(att);
    connectionLog('signaling', { ...this.identity(viewer), role, event });
  }

  override async webSocketClose(ws: WebSocket, code?: number, _reason?: string, wasClean?: boolean) {
    const att = ws.deserializeAttachment() as Attachment | null;
    // Logging must never require storage availability before relay cleanup can run. New
    // attachments retain their instance ID across hibernation; legacy IDs may be absent.
    connectionLog(att?.role === 'agent' ? 'agent_tunnel_closed' : 'viewer_socket_closed', { ...this.identity(ws), closeCode: code, wasClean });
    if (att?.role === 'agent') {
      if (this.sockets('agent').every((s) => s === ws)) for (const v of this.sockets('viewer')) this.send(v, { t: 'agent_offline' });
    } else if (att?.role === 'viewer') {
      // A reconnect can accept/open the same session before the replaced socket's close callback.
      // Its relay now belongs to the replacement; the old close must not tear that relay down.
      const replacement = this.ctx.getWebSockets(`session:${att.sessionId}`)
        .some((s) => s !== ws && s.readyState === WebSocket.OPEN);
      if (replacement) return;
      const agent = this.sockets('agent')[0];
      if (agent) this.send(agent, { t: 'viewer_close', sessionId: att.sessionId, relayId: att.relayId });
    } else if (att?.role === 'automation') {
      this.inputGrants.delete(`automation:${att.sessionId}`);
      const agent = this.sockets('agent')[0];
      if (agent) this.send(agent, { t: 'automation_close', sessionId: att.sessionId });
      this.ctx.waitUntil(this.env.API.endAutomationSession(att.sessionId, 'closed').catch(() => {}));
      const connected = this.sockets('automation').length > 0;
      const control = this.control ?? { controller: 'none' as const, mode: 'agent' as const, epoch: 0 };
      for (const v of this.sockets('viewer')) this.send(v, { t: 'automation_status', connected, control });
    }
  }

  override async webSocketError(ws: WebSocket) {
    connectionLog('socket_error', { ...this.identity(ws), code: 'transport_error' });
    await this.webSocketClose(ws);
  }

  /** Sends every pending command to the connected agent and marks it delivered (page 2: `agent_commands`). */
  private async deliverPending() {
    const epoch = this.revocationEpoch;
    const instanceId = await this.instanceId();
    if (!instanceId) return;
    const row = await this.liveInstance(instanceId);
    if (!row) return;
    await this.pruneSockets(row, instanceId, true);
    const agent = this.sockets('agent')[0];
    if (!agent || epoch !== this.revocationEpoch) return;
    const { results } = await this.env.DB.prepare(
      `SELECT c.id, c.kind, c.payload FROM agent_commands c
       WHERE c.instance_id = ? AND c.status = 'pending' AND ${COMMAND_ACTIVE} ORDER BY c.created_at`,
    )
      .bind(instanceId)
      .all<CommandRow>();
    for (const c of results) {
      if (epoch !== this.revocationEpoch || agent.readyState !== WebSocket.OPEN) return;
      const payload = JSON.parse(c.payload) as Record<string, unknown>;
      // The archive key is added on delivery and lives only in this frame, never in D1 (page 4).
      const archive = payload.archive as Record<string, unknown> | undefined;
      if (archive && typeof archive === 'object') {
        const key = await this.env.API.archiveKey(instanceId);
        payload.archive = key ? { ...archive, key } : null;
      }
      if (epoch !== this.revocationEpoch || agent.readyState !== WebSocket.OPEN) return;
      // Claim immediately before send, after any awaited key lookup. Cancellation and this
      // transition are serialized by D1, so a stale pending row cannot resurrect old work.
      const claimed = await this.env.DB.prepare(`UPDATE agent_commands AS c
        SET status = 'delivered', delivered_at = ?
        WHERE c.id = ? AND c.instance_id = ? AND c.status = 'pending'
          AND c.completed_at IS NULL AND ${COMMAND_ACTIVE} RETURNING id`)
        .bind(Date.now(), c.id, instanceId).first<{ id: string }>();
      if (claimed && epoch === this.revocationEpoch && !this.send(agent, { t: 'command', id: c.id, kind: c.kind as never, payload })) {
        await this.env.DB.prepare(`UPDATE agent_commands AS c SET status = 'pending', delivered_at = NULL
          WHERE c.id = ? AND c.instance_id = ? AND c.status = 'delivered'
            AND c.completed_at IS NULL AND ${COMMAND_ACTIVE}`).bind(c.id, instanceId).run();
      }
    }
  }
}
