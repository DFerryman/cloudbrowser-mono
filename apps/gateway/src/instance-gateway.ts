import { AgentFrame, ViewerFrame, type AgentControlMode, type ControlState, type GatewayToAgent, type GatewayToViewer } from '@cloudbrowser/contracts';
import { createDb, prepaidAccess } from '@cloudbrowser/db';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';
import { connectionAttempt, connectionLog, type ConnectionIdentity } from './connection-log.js';
import { browserGone, controlMode, withRetry, type LiveInstance } from './instance-row.js';
import { CodingAgentSession } from './mcp/coding-agent.js';

/**
 * Sockets accepted before coding agents moved to the MCP endpoint may still carry the retired
 * `automation` role. It is no role any more, so their next frame closes them.
 * `closing`: this object closed the socket (shut). `since`/`heardAt`: when the VM's tunnel was
 * accepted and when a frame last arrived on it (agentSilent).
 */
type Attachment = ({ instanceId?: string; closing?: true } & { role: 'agent'; generation: number; since?: number; heardAt?: number })
  | ({ instanceId?: string; attemptId?: string; signalsSeen?: string[]; closing?: true } & { role: 'viewer'; sessionId: string; generation: number; relayId?: string });
type CommandRow = { id: string; kind: string; payload: string };
type Role = Attachment['role'];
const ROLES: readonly Role[] = ['agent', 'viewer'];

const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';
/** Frames bigger than this are refused (page 2: message size limits). */
const MAX_FRAME_BYTES = 256 * 1024;
/**
 * Each socket's frames wait in that socket's own queue, within its own budget: a viewer's input
 * burst, the VM's screenshot blobs. A socket over its budget is closed; the others are untouched.
 */
const MAX_QUEUED_FRAMES = 4096;
const MAX_QUEUED_FRAME_BYTES = 4 * 1024 * 1024;
/** A coding agent's actions count as activity for auto-sleep this often, like a viewer's input. */
const AUTOMATION_ACTIVITY_MS = 30_000;
/**
 * All relay frames share an authorization lease; stop/delete RPCs and a takeover revoke it at
 * once, and a credit deadline ends it early. Each check reads D1 in eastern North America, about
 * 330 ms from a gateway object in Asia: a one-second lease put those reads, and the frames held
 * up when one fell behind, into every second of use. What only a check notices (a session ended
 * without a takeover, a browser the engine stopped) is noticed within this long.
 */
export const INPUT_AUTH_LEASE_MS = 10_000;
/**
 * A lease in use is re-checked this long before it lapses, in the background, so the ordered
 * relay (the WebRTC handshake, typing) does not stall on D1: long enough for a cross-region read
 * and a retry. A frame that finds an expired lease still waits for a fresh check.
 */
export const RENEW_BEFORE_MS = 2_000;
/**
 * With no frames to re-check, the alarm re-checks open viewers this often (or at an earlier
 * credit deadline), as their leases lapse: an idle viewer's next tap finds a valid lease. It must
 * not be shorter than the lease, or the alarm would find every lease still valid and fire again
 * at once. Re-reading D1 every second for an idle viewer only multiplied the chance that a
 * transient read error closed a healthy connection.
 */
const IDLE_RECHECK_MS = INPUT_AUTH_LEASE_MS;
/**
 * A viewer that sent a frame this recently has its lease renewed ahead of time, as a moving mouse
 * keeps renewing it with frames inside the lease's last two seconds. A touch screen sends nothing
 * between taps, so each tap after a pause waited for authorization reads from D1, in another
 * region, before it was relayed: half a second or more per tap. Idle viewers are re-checked by the
 * alarm only, so this costs reads only while someone is using the browser.
 */
const ACTIVE_VIEWER_MS = 30_000;
/**
 * The VM sends a heartbeat every 15 s, and agents from 0.6.0 a ping when the gateway has been
 * quiet; a tunnel nothing arrived on for this long is dead, whatever the runtime reports. A VM
 * whose connection vanished without a close (a route change, a frozen VM) left its tunnel looking
 * open for up to 15 minutes, until TCP gave up, and viewers were relayed into it meanwhile.
 */
const AGENT_SILENT_MS = 45_000;
/** How often a frame on the VM's tunnel is recorded in its attachment. */
const AGENT_HEARD_EVERY_MS = 5_000;
/** Agent frames that belong to one viewer's relay: that viewer's lease authorizes them. */
const VIEWER_RELAY_FRAMES = ['viewer', 'viewer_error', 'viewer_stage', 'viewer_file'];
/**
 * The VM's answers for the coding agent's session reuse a fresh read of the browser's row for
 * the length of a lease, under this grant key. They carry no input, so no credit check applies.
 */
const MCP_GRANT = 'mcp';

function parseLoosely(message: string): { t?: unknown; sessionId?: unknown; relayId?: unknown } | null {
  try {
    const value: unknown = JSON.parse(message);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
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
 * its viewer (page 2, `services/gateway`), and the home of a coding agent's session. It replaces
 * the plan's Go gateway and its `agent_sessions` registry, because routing by instance id is what
 * a Durable Object gives for free. Uses the WebSocket hibernation API, so idle connections cost
 * nothing between frames.
 */
export class InstanceGateway extends DurableObject<Env> {
  // Prevent an upgrade or a check already awaiting a DB read from surviving a concurrent revoke
  // RPC. Deletion bumps both epochs; sleep revokes only the viewers, and the agent's work goes on.
  private revocationEpoch = 0;
  private viewerEpoch = 0;
  /** Each socket's frames, in order, behind each other and never behind another socket's. */
  private queues = new WeakMap<WebSocket, { tail: Promise<void>; frames: number; bytes: number }>();
  private inputGrants = new Map<string, InputGrant>();
  private sessionChecks = new Map<string, Promise<boolean>>();
  private renewal: Promise<void> | null = null;
  /** When each viewer session last sent a frame, and the ahead-of-time renewal waiting for it (ACTIVE_VIEWER_MS). */
  private viewerActiveAt = new Map<string, number>();
  private warmLease: { sessionId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The VM's last reported control state; the mode is also persisted by the api. */
  private control: ControlState | null = null;
  private automationActivityAt = 0;
  private storedInstanceId: string | null = null;
  /** The coding agent's session (docs/agent-access.md), driven through the MCP endpoint. */
  private readonly mcp: CodingAgentSession;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered without waking the object. The viewer's pong also confirms, in
    // order, every frame the gateway received before its ping (packages/viewer InputQueue).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.mcp = new CodingAgentSession({
      ctx, env,
      agent: () => this.agent(),
      sendToAgent: (frame) => {
        const agent = this.agent();
        return !!agent && this.send(agent, frame);
      },
      readInstance: (instanceId) => this.readInstance(instanceId),
      controlState: (row) => this.controlState(row),
      statusChanged: (row) => this.ctx.waitUntil(this.broadcastAutomationStatus(row).catch(() => {})),
      scheduleAlarm: (at) => this.scheduleAlarm(at),
      epoch: () => this.revocationEpoch,
      touchActivity: (instanceId, sessionId) => this.touchAutomationActivity(instanceId, sessionId),
    });
  }

  private async instanceId(): Promise<string> {
    return (await this.ctx.storage.get<string>('instanceId')) ?? '';
  }

  /**
   * The alarm needs the instance id after a wake; it is written once, not on every request. After
   * a wake it is read, not written again: every write waits for durable storage, which is what
   * failed when Cloudflare's storage reset objects (each reset closed every socket).
   */
  private async rememberInstance(instanceId: string) {
    if (this.storedInstanceId === instanceId) return;
    if ((await this.ctx.storage.get<string>('instanceId')) !== instanceId) await this.ctx.storage.put('instanceId', instanceId);
    this.storedInstanceId = instanceId;
  }

  /** Viewer re-checks and the coding agent's session deadlines share the object's one alarm: the earliest wins. */
  private async scheduleAlarm(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current <= Date.now() || at < current) await this.ctx.storage.setAlarm(at);
  }

  /** Open, and not closed by this object (shut). */
  private isOpen(ws: WebSocket) {
    return ws.readyState === WebSocket.OPEN && !(ws.deserializeAttachment() as Attachment | null)?.closing;
  }

  private sockets(role: Role) {
    return this.ctx.getWebSockets(role).filter((ws) => this.isOpen(ws));
  }

  /**
   * Closes a socket for good. The runtime has reported a socket this object closed as open again
   * once the object had hibernated, and listed it first: a replaced VM tunnel then took the next
   * viewers' relays and commands, which the VM, connected on its new tunnel, never received. The
   * attachment remembers the close.
   */
  private shut(ws: WebSocket, code: number, reason: string) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att && !att.closing) ws.serializeAttachment({ ...att, closing: true });
    ws.close(code, reason);
  }

  /**
   * The VM's tunnel: the newest open one. One nothing has arrived on for AGENT_SILENT_MS is closed
   * as dead, and viewers are told the VM is offline instead of waiting on a relay it never gets.
   */
  private agent(): WebSocket | undefined {
    let newest: WebSocket | undefined;
    let newestSince = -Infinity;
    for (const ws of this.sockets('agent')) {
      const since = (ws.deserializeAttachment() as Extract<Attachment, { role: 'agent' }>).since ?? 0;
      if (since >= newestSince) [newest, newestSince] = [ws, since];
    }
    if (!newest || !this.agentSilent(newest)) return newest;
    this.closeAgent(newest, 4008, 'tunnel silent', 'agent_tunnel_silent');
    return undefined;
  }

  /** Neither a frame (heardAt) nor a keepalive the runtime answered for AGENT_SILENT_MS. */
  private agentSilent(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Extract<Attachment, { role: 'agent' }>;
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    const heard = att.heardAt ?? att.since;
    return heard !== undefined && Date.now() - Math.max(heard, pinged) > AGENT_SILENT_MS;
  }

  /** A frame arrived on the VM's tunnel; recorded at most every AGENT_HEARD_EVERY_MS. */
  private heard(ws: WebSocket, att: Extract<Attachment, { role: 'agent' }>) {
    const now = Date.now();
    if (!att.closing && now - (att.heardAt ?? 0) >= AGENT_HEARD_EVERY_MS) ws.serializeAttachment({ ...att, heardAt: now });
  }

  /** Closes the VM's tunnel. If it was the last, viewers and the coding agent hear now that the VM is offline. */
  private closeAgent(ws: WebSocket, code: number, reason: string, stage: string) {
    connectionLog(stage, { ...this.identity(ws), closeCode: code, code: reason.replaceAll(' ', '_') });
    this.shut(ws, code, reason);
    if (this.sockets('agent').length) return;
    for (const v of this.sockets('viewer')) this.send(v, { t: 'agent_offline' });
    this.mcp.agentOffline();
  }

  private identity(ws: WebSocket, instanceId?: string): ConnectionIdentity & { role?: Role } {
    const att = ws.deserializeAttachment() as Attachment | null;
    return {
      instanceId: att?.instanceId ?? instanceId,
      generation: att?.generation,
      role: ROLES.includes(att?.role as Role) ? att?.role : undefined,
      ...(att?.role === 'viewer' ? { sessionId: att.sessionId, relayId: att.relayId, attemptId: att.attemptId } : {}),
    };
  }

  // --- the coding agent's session (docs/agent-access.md) --------------------------------------

  private controlState(row: LiveInstance): ControlState {
    const mode = controlMode(row);
    // The VM's report is authoritative while it agrees with the persisted mode; the api's own
    // writes (hand-back, pause) reach the VM through this object, which updates both. After an
    // eviction the report is gone, and the persisted mode decides.
    return this.control && this.control.mode === mode ? this.control : { controller: 'none', mode, epoch: this.control?.epoch ?? 0 };
  }

  /** Tells viewers whether a coding agent's session is open and who may drive the browser. */
  private async broadcastAutomationStatus(row?: LiveInstance) {
    const viewers = this.sockets('viewer');
    if (!viewers.length) return;
    const live = row ?? (await this.readInstance(await this.instanceId()));
    if (!live) return;
    await this.mcp.load();
    for (const v of viewers) this.send(v, { t: 'automation_status', connected: this.mcp.open, control: this.controlState(live) });
  }

  /** A coding agent's action is activity for auto-sleep and the Settings page, recorded at most every 30 s. */
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
    if (!this.isOpen(ws)) return false;
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
    this.shut(ws, code, reason);
  }

  private closeAll(reason: string, code = 4003) {
    this.inputGrants.clear();
    for (const viewer of this.sockets('viewer')) {
      const attachment = viewer.deserializeAttachment() as Attachment | null;
      if (attachment?.role === 'viewer') this.closeViewer(viewer, attachment.sessionId, code, reason);
      else this.shut(viewer, code, reason);
    }
    for (const agent of this.sockets('agent')) {
      connectionLog('agent_revoked', { ...this.identity(agent), closeCode: code, code: reason.replaceAll(' ', '_') });
      this.shut(agent, code, reason);
    }
    // A closed tunnel answers nothing more; the coding agent hears so now, not at its timeout.
    this.mcp.agentOffline();
  }

  /** The browser's row: null when it is gone, undefined when D1 could not be read. Closes nothing. */
  private async readInstance(instanceId: string): Promise<LiveInstance | null | undefined> {
    try {
      const row = await withRetry(() => this.env.DB.prepare(`SELECT b.user_id, b.status, b.desired_state, a.generation, b.agent_access, b.agent_control
        FROM browser_instances b LEFT JOIN agent_credentials a ON a.instance_id = b.id WHERE b.id = ?`)
        .bind(instanceId).first<LiveInstance>());
      return row && !browserGone(row) ? row : null;
    } catch {
      connectionLog('instance_lookup_failed', { instanceId, code: 'authorization_unavailable' });
      return undefined;
    }
  }

  /** D1 is authoritative; expired authorization leases read current state and fail closed. */
  private async liveInstance(instanceId: string): Promise<LiveInstance | null> {
    const row = await this.readInstance(instanceId);
    if (row) return row;
    if (row === undefined) {
      this.closeAll('authorization unavailable');
      return null;
    }
    this.closeAll('browser unavailable');
    await this.mcp.close('browser_unavailable').catch(() => {});
    return null;
  }

  private async validSocket(ws: WebSocket, row: LiveInstance, instanceId: string, allowCached = false): Promise<boolean> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment || !ROLES.includes(attachment.role) || !row.generation || attachment.generation !== row.generation) {
      if (attachment?.role === 'agent') this.closeAgent(ws, 4003, 'generation revoked', 'socket_rejected');
      else {
        connectionLog('socket_rejected', { ...this.identity(ws, instanceId), code: 'generation_revoked', closeCode: 4003 });
        this.shut(ws, 4003, 'generation revoked');
      }
      return false;
    }
    if (attachment.role === 'viewer') {
      if (!(await this.validSession(attachment.sessionId, row, instanceId, allowCached))) {
        this.closeViewer(ws, attachment.sessionId);
        return false;
      }
    }
    return this.isOpen(ws);
  }

  private async validSession(sessionId: string, row: LiveInstance, instanceId: string, allowCached = false): Promise<boolean> {
    if (row.desired_state !== 'running' || row.status !== 'running') return false;
    const cached = this.inputGrants.get(sessionId);
    if (allowCached && cached && cached.instanceId === instanceId && cached.row.user_id === row.user_id
      && cached.row.generation === row.generation && cached.until > Date.now()) return true;
    // An alarm, upgrade and the FIFO relay can await the same check. Never launch duplicate
    // cross-region billing reads for a single authorization decision.
    const key = `${this.viewerEpoch}:${instanceId}:${row.user_id}:${row.generation}:${sessionId}`;
    const checking = this.sessionChecks.get(key);
    if (checking) return checking;
    const check = this.refreshSession(sessionId, row, instanceId);
    this.sessionChecks.set(key, check);
    try { return await check; }
    finally { if (this.sessionChecks.get(key) === check) this.sessionChecks.delete(key); }
  }

  private async refreshSession(sessionId: string, row: LiveInstance, instanceId: string): Promise<boolean> {
    const epoch = this.viewerEpoch;
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
      if (!access.allowed || epoch !== this.viewerEpoch) {
        connectionLog('viewer_authorization_rejected', { instanceId, generation: row.generation, sessionId, code: access.allowed ? 'revoked' : 'billing_denied' });
        return false;
      }
      const until = Math.min(Date.now() + INPUT_AUTH_LEASE_MS, access.deadlineAt?.getTime() ?? Infinity);
      if (until <= Date.now()) return false;
      const recheckAt = Math.min(Date.now() + IDLE_RECHECK_MS, access.deadlineAt?.getTime() ?? Infinity);
      const grant = { instanceId, row, until, recheckAt };
      this.inputGrants.set(sessionId, grant);
      // A depleted balance is revoked even if the viewer sends no more input frames.
      await this.scheduleAlarm(recheckAt);
      if (epoch !== this.viewerEpoch || until <= Date.now()) {
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

  /**
   * An active viewer's lease is renewed when it is about to lapse even with no frame to trigger
   * it (ACTIVE_VIEWER_MS). The lease and its checks are unchanged; only their timing is.
   */
  private keepLeaseWarm(sessionId: string, instanceId: string) {
    if (this.warmLease?.sessionId === sessionId) return;
    if (this.warmLease) clearTimeout(this.warmLease.timer);
    this.warmLease = null;
    const grant = this.inputGrants.get(sessionId);
    if (!grant || grant.instanceId !== instanceId) return;
    const timer = setTimeout(() => {
      if (this.warmLease?.timer !== timer) return;
      this.warmLease = null;
      const active = Date.now() - (this.viewerActiveAt.get(sessionId) ?? -Infinity) < ACTIVE_VIEWER_MS;
      const open = this.ctx.getWebSockets(`session:${sessionId}`).some((ws) => this.isOpen(ws));
      if (!active || !open) {
        this.viewerActiveAt.delete(sessionId);
        return;
      }
      this.renewSoon(sessionId, instanceId);
      void (this.renewal ?? Promise.resolve()).then(() => this.keepLeaseWarm(sessionId, instanceId));
    }, Math.max(0, grant.until - RENEW_BEFORE_MS - Date.now()));
    this.warmLease = { sessionId, timer };
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Only the gateway's trusted service entrypoint reaches this Durable Object route.
    if (url.pathname === '/revoke' && req.method === 'POST') {
      this.revocationEpoch++;
      this.viewerEpoch++;
      this.closeAll('browser deleted');
      await this.mcp.close('browser_deleted');
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/automation-control' && req.method === 'POST') {
      // The user's choice from the api, already persisted: tell the VM, the agent's session and the viewers.
      const body = await req.json<{ mode: AgentControlMode; access: boolean }>();
      const mode: AgentControlMode = body.mode === 'user' || body.mode === 'privacy' ? body.mode : 'agent';
      const access = body.access !== false;
      this.control = { controller: mode === 'agent' ? 'none' : 'user', mode, epoch: (this.control?.epoch ?? 0) + 1 };
      for (const agent of this.sockets('agent')) this.send(agent, { t: 'automation_control', mode, access });
      if (!access) await this.mcp.close('access_off');
      this.mcp.controlChanged();
      await this.mcp.load();
      for (const v of this.sockets('viewer')) this.send(v, { t: 'automation_status', connected: this.mcp.open, control: this.control });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/revoke-automation' && req.method === 'POST') {
      const body = await req.json<{ clientId: string | null }>();
      await this.mcp.revoke(body.clientId);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/revoke-viewers' && req.method === 'POST') {
      this.viewerEpoch++;
      this.inputGrants.clear();
      for (const viewer of this.sockets('viewer')) {
        const attachment = viewer.deserializeAttachment() as Attachment | null;
        if (attachment?.role === 'viewer') this.closeViewer(viewer, attachment.sessionId);
        else this.shut(viewer, 4003, 'session revoked');
      }
      // The browser is going to sleep: its VM keeps no coding-agent session either.
      await this.mcp.close('browser_stopped');
      return new Response(null, { status: 204 });
    }
    const epoch = this.revocationEpoch;
    const viewerEpoch = this.viewerEpoch;
    const instanceId = req.headers.get('x-cb-instance') ?? '';
    const role = req.headers.get('x-cb-role');
    const admission: ConnectionIdentity & { role?: Role } = {
      instanceId, sessionId: role === 'viewer' ? req.headers.get('x-cb-session') ?? undefined : undefined,
      attemptId: role === 'viewer' ? connectionAttempt(req.headers.get('x-cb-attempt')) : undefined,
      role: role === 'agent' || role === 'viewer' ? role : undefined,
    };
    if (role === 'viewer') connectionLog('viewer_admission_started', admission);
    if (instanceId) await this.rememberInstance(instanceId);

    // A coding agent's tool calls, cancellations and uploads (docs/agent-access.md).
    if (url.pathname.startsWith('/mcp/') && (req.method === 'POST' || req.method === 'PUT')) return this.mcp.fetch(req, url.pathname, instanceId);
    if (url.pathname === '/deliver') {
      await this.deliverPending();
      return new Response(null, { status: 204 });
    }
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    // A failed read refuses this socket alone: the connections already admitted keep their leases.
    const row = await this.readInstance(instanceId);
    if (row === null) {
      this.closeAll('browser unavailable');
      await this.mcp.close('browser_unavailable').catch(() => {});
    }
    if (!row || epoch !== this.revocationEpoch || (role === 'viewer' && viewerEpoch !== this.viewerEpoch)) {
      connectionLog('upgrade_rejected', { ...admission, code: row === undefined ? 'authorization_unavailable' : 'instance_unavailable', status: 403 });
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
      // A reconnecting agent replaces the old tunnel; what was in flight on it is never answered.
      const replaced = this.sockets('agent');
      for (const old of replaced) {
        connectionLog('agent_replaced', { ...this.identity(old, instanceId), closeCode: 4000 });
        this.shut(old, 4000, 'replaced');
      }
      if (replaced.length) this.mcp.agentOffline();
      const att: Attachment = { role: 'agent', generation, instanceId, since: Date.now() };
      this.ctx.acceptWebSocket(server, ['agent']);
      server.serializeAttachment(att);
      connectionLog('agent_tunnel_accepted', this.identity(server));
      const credential = req.headers.get('x-cb-credential');
      const automation = { mode: controlMode(row), access: !!row.agent_access };
      // keepalive: the runtime answers the VM's {"t":"ping"} (setWebSocketAutoResponse), so agents
      // from 0.6.0 ping a quiet tunnel and replace one that answers nothing.
      const welcome = { t: 'welcome', viewerStages: true, keepalive: true, automation } as const;
      this.send(server, credential ? { ...welcome, credential } : welcome);
      for (const v of this.sockets('viewer')) {
        this.send(v, { t: 'agent_online' });
        this.openViewerRelay(server, v);
      }
      // Nothing that can fail is awaited once the tunnel is accepted: the 101 must still go out.
      // The coding agent's session reopens and pending commands are delivered in the background.
      this.ctx.waitUntil(this.mcp.agentOnline().catch(() => connectionLog('mcp_resume_failed', { ...this.identity(server), code: 'storage_unavailable' })));
      this.ctx.waitUntil(this.deliverPending().catch(() => connectionLog('command_delivery_failed', { ...this.identity(server), code: 'delivery_unavailable' })));
    } else if (role === 'viewer') {
      const sessionId = req.headers.get('x-cb-session') ?? '';
      const attachment: Attachment = { role: 'viewer', sessionId, generation: row.generation ?? 0, relayId: crypto.randomUUID(), instanceId, attemptId: admission.attemptId };
      if (!row.generation || !(await this.validSession(sessionId, row, instanceId)) || viewerEpoch !== this.viewerEpoch) {
        connectionLog('viewer_admission_rejected', { ...admission, generation: row.generation, relayId: attachment.relayId, code: 'authorization_rejected', status: 403 });
        return new Response('session revoked', { status: 403 });
      }
      const agentSession = await this.mcp.load().then((rec) => !!rec, () => false);
      // One controller at a time: the newest viewer takes over (page 5).
      for (const old of this.sockets('viewer')) {
        const prior = old.deserializeAttachment() as Attachment | null;
        if (prior?.role === 'viewer' && prior.sessionId === sessionId) this.shut(old, 4000, 'reconnected');
        else { this.send(old, { t: 'taken_over' }); this.shut(old, 4001, 'taken over'); }
      }
      this.ctx.acceptWebSocket(server, ['viewer', `session:${sessionId}`]);
      server.serializeAttachment(attachment);
      connectionLog('viewer_gateway_accepted', this.identity(server));
      this.send(server, { t: 'connection_stage', stage: 'gateway_accepted', relayId: attachment.relayId });
      const agent = this.agent();
      this.send(server, agent ? { t: 'agent_online' } : { t: 'agent_offline' });
      if (agent) this.openViewerRelay(agent, server);
      else connectionLog('viewer_agent_offline', { ...this.identity(server), code: 'relay_unavailable' });
      this.send(server, { t: 'automation_status', connected: agentSession, control: this.controlState(row) });
    } else {
      return new Response('forbidden', { status: 403 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The runtime answers keepalives (setWebSocketAutoResponse); one that reaches the object
    // anyway is answered too, never taken for a viewer frame and refused as invalid input.
    if (message === PING) {
      try { ws.send(PONG); } catch { /* A closing socket reports itself. */ }
      return Promise.resolve();
    }
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const role = attachment?.role;
    if (attachment?.role === 'agent') this.heard(ws, attachment);
    if (typeof message !== 'string' || bytes > MAX_FRAME_BYTES) {
      if (role === 'agent') this.dropAgentFrame(ws, message);
      else this.shut(ws, 1009, 'frame too large or not text');
      return Promise.resolve();
    }
    let queue = this.queues.get(ws);
    if (!queue) this.queues.set(ws, queue = { tail: Promise.resolve(), frames: 0, bytes: 0 });
    if (queue.frames >= MAX_QUEUED_FRAMES || queue.bytes + bytes > MAX_QUEUED_FRAME_BYTES) {
      // Make failure visible instead of silently dropping an input or growing memory forever,
      // and only for the socket that outran its own budget.
      this.closeSocket(ws, 1013, 'input queue overloaded');
      return Promise.resolve();
    }
    queue.frames++;
    queue.bytes += bytes;
    const q = queue;
    // D1/RPC awaits can otherwise let a later frame of this socket overtake this one.
    const next = q.tail.then(() => this.processWebSocketMessage(ws, message))
      .catch(() => { this.closeSocket(ws, 1011, 'input processing failed'); })
      .finally(() => { q.frames--; q.bytes -= bytes; });
    q.tail = next;
    return next;
  }

  /** Closes one socket for its own failure; the tunnel and the other viewers are not affected. */
  private closeSocket(ws: WebSocket, code: number, reason: string) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === 'viewer') {
      this.closeViewer(ws, att.sessionId, code, reason);
      return;
    }
    if (att?.role === 'agent') {
      this.closeAgent(ws, code, reason, 'agent_tunnel_failed');
      return;
    }
    connectionLog('socket_failed', { ...this.identity(ws), closeCode: code, code: reason.replaceAll(' ', '_') });
    this.shut(ws, code, reason);
  }

  /**
   * The VM's tunnel carries every viewer's relay and the coding agent's session, so one oversized
   * frame (a huge clipboard, say) is dropped rather than closing it. A viewer whose relay lost a
   * frame is told, since its stream may now be incomplete.
   */
  private dropAgentFrame(ws: WebSocket, message: string | ArrayBuffer) {
    const frame = typeof message === 'string' ? parseLoosely(message) : null;
    const type = typeof frame?.t === 'string' ? frame.t : undefined;
    connectionLog('agent_frame_dropped', { ...this.identity(ws), code: 'frame_too_large', event: type });
    if (type && VIEWER_RELAY_FRAMES.includes(type) && typeof frame?.sessionId === 'string') {
      this.inputFailure(frame.sessionId, 'frame_too_large', typeof frame.relayId === 'string' ? frame.relayId : undefined);
    }
  }

  private async processWebSocketMessage(ws: WebSocket, message: string) {
    if (!this.isOpen(ws)) return;
    const epoch = this.revocationEpoch;
    const viewerEpoch = this.viewerEpoch;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    // The socket's attachment names its browser across hibernation: no storage read per frame.
    const instanceId = attachment?.instanceId ?? await this.instanceId();
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      if (attachment?.role === 'agent') this.closeAgent(ws, 1007, 'invalid json', 'agent_frame_rejected');
      else this.shut(ws, 1007, 'invalid json');
      return;
    }
    const frameType = raw && typeof raw === 'object' && 't' in raw ? String(raw.t) : '';
    const frameSession = raw && typeof raw === 'object' && 'sessionId' in raw && typeof raw.sessionId === 'string' ? raw.sessionId : null;
    const relayedSession = attachment?.role === 'viewer' ? attachment.sessionId
      : VIEWER_RELAY_FRAMES.includes(frameType) ? frameSession
        : frameType === 'automation_result' ? MCP_GRANT : null;
    const cached = relayedSession ? this.inputGrants.get(relayedSession) : null;
    const fresh = !!cached && cached.instanceId === instanceId && cached.until > Date.now();
    // SDP and system/init are on the same authorized channel as input. Reading the instance,
    // session and billing multiple times per signal can stall the entire ordered handshake.
    const row = fresh ? cached.row : await this.liveInstance(instanceId);
    if (!row || epoch !== this.revocationEpoch || (attachment?.role === 'viewer' && viewerEpoch !== this.viewerEpoch)) return;
    if (!fresh && relayedSession === MCP_GRANT) {
      this.inputGrants.set(MCP_GRANT, { instanceId, row, until: Date.now() + INPUT_AUTH_LEASE_MS, recheckAt: Date.now() + IDLE_RECHECK_MS });
    }
    await this.pruneSockets(row, instanceId, true);
    if (!(await this.validSocket(ws, row, instanceId, true)) || epoch !== this.revocationEpoch) return;
    if (relayedSession && relayedSession !== MCP_GRANT) this.renewSoon(relayedSession, instanceId);
    const att = ws.deserializeAttachment() as Attachment;
    if (att.role === 'agent') await this.fromAgent(ws, att, raw);
    else {
      this.viewerActiveAt.set(att.sessionId, Date.now());
      this.keepLeaseWarm(att.sessionId, instanceId);
      this.fromViewer(ws, att, raw);
    }
  }

  override async alarm() {
    const instanceId = await this.instanceId();
    if (!instanceId) return;
    // The coding agent's session has deadlines of its own (idle, expiry, upload URLs), with or
    // without any socket open; they share this alarm with the viewers' re-checks.
    const sessionDeadline = await this.mcp.expire();
    let viewerDeadline = Infinity;
    const viewers = this.sockets('viewer');
    if (viewers.length) {
      // A frame may have renewed an expiring lease before this alarm was delivered. Preserve the
      // renewed grant; it already scheduled its own bounded deadline. Expired grants are rechecked.
      const grants = viewers.map((viewer) => {
        const att = viewer.deserializeAttachment() as Attachment | null;
        return att?.role === 'viewer' ? this.inputGrants.get(att.sessionId) : null;
      });
      if (grants.every((grant) => grant && grant.instanceId === instanceId && grant.until > Date.now())) {
        viewerDeadline = Math.min(...grants.map((grant) => grant!.recheckAt));
      } else {
        const row = await this.liveInstance(instanceId);
        if (row) await this.pruneSockets(row, instanceId, true);
      }
    }
    const next = Math.min(viewerDeadline, sessionDeadline ?? Infinity);
    if (next < Infinity) await this.scheduleAlarm(next);
  }

  /** The api's answer to an agent frame. A failed call is retried, then the frame is dropped and logged; the tunnel stays. */
  private async agentRpc(ws: WebSocket, att: Extract<Attachment, { role: 'agent' }>, frame: AgentFrame): Promise<GatewayToAgent | null> {
    try {
      return await withRetry(async () => this.env.API.agentMessage(await this.instanceId(), att.generation, frame));
    } catch {
      connectionLog('agent_message_dropped', { ...this.identity(ws), code: 'api_unavailable', event: frame.t });
      return null;
    }
  }

  private async fromAgent(ws: WebSocket, att: Extract<Attachment, { role: 'agent' }>, raw: unknown) {
    const parsed = AgentFrame.safeParse(raw);
    if (!parsed.success) {
      this.closeAgent(ws, 1007, 'invalid frame', 'agent_frame_rejected');
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
        if (!this.isOpen(v)) continue;
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
      await this.mcp.fromAgent(frame);
      return;
    }
    if (frame.t === 'control_state') {
      // Who may drive the browser changed inside the VM (a takeover, a hand-back it applied).
      this.control = frame.control;
      connectionLog('control_changed', { ...this.identity(ws), code: frame.reason });
      await this.mcp.load();
      for (const v of this.sockets('viewer')) this.send(v, { t: 'automation_status', connected: this.mcp.open, control: frame.control });
      this.mcp.controlChanged();
      await this.agentRpc(ws, att, frame);
      return;
    }
    if (frame.t === 'hello') {
      // Why the VM's previous tunnel ended, as the VM saw it (agent 0.6.0).
      const previous = frame.previous;
      if (previous) connectionLog('agent_reconnected', {
        ...this.identity(ws), code: previous.reason, closeCode: previous.closeCode, event: previous.dialError,
        elapsedMs: previous.downMs, upMs: previous.upMs, attempts: previous.dialFailures,
      });
      return;
    }
    // Events, replies and TURN requests go to the api, which owns those records.
    const answer = await this.agentRpc(ws, att, frame);
    if (answer) this.send(ws, answer);
    // Backstop for a lost queue poke: every heartbeat (15 s) also delivers pending commands.
    if (frame.t === 'event' && frame.kind === 'heartbeat') {
      this.ctx.waitUntil(this.deliverPending().catch(() => connectionLog('command_delivery_failed', { ...this.identity(ws), code: 'delivery_unavailable' })));
    }
  }

  private fromViewer(ws: WebSocket, att: Extract<Attachment, { role: 'viewer' }>, raw: unknown) {
    const parsed = ViewerFrame.safeParse(raw);
    const agent = this.agent();
    if (!parsed.success) { this.inputFailure(att.sessionId, 'invalid_input'); return; }
    if (!agent) { this.inputFailure(att.sessionId, 'relay_unavailable'); return; }
    if (parsed.data.t === 'neko') this.traceSignal(ws, 'viewer', parsed.data.data);
    if (!this.send(agent, { t: 'viewer', sessionId: att.sessionId, relayId: att.relayId, data: parsed.data })) {
      this.inputFailure(att.sessionId, 'relay_failed');
    }
  }

  private inputFailure(sessionId: string, reason: string, relayId?: string) {
    for (const viewer of this.ctx.getWebSockets(`session:${sessionId}`)) {
      if (!this.isOpen(viewer)) continue;
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
    // A tunnel this object closed (shut) was dealt with then. A replaced one whose path had died
    // reports its close only when TCP gives up, often 15 minutes later: no new drop.
    const stage = att?.role === 'agent' ? (att.closing ? 'agent_tunnel_released' : 'agent_tunnel_closed') : 'viewer_socket_closed';
    connectionLog(stage, { ...this.identity(ws), closeCode: code, wasClean });
    if (att?.role === 'agent') {
      if (att.closing) return;
      if (this.sockets('agent').every((s) => s === ws)) {
        for (const v of this.sockets('viewer')) this.send(v, { t: 'agent_offline' });
        // The coding agent's calls in flight fail now with relay_unavailable, not at their timeout.
        this.mcp.agentOffline();
      }
    } else if (att?.role === 'viewer') {
      // A reconnect can accept/open the same session before the replaced socket's close callback.
      // Its relay now belongs to the replacement; the old close must not tear that relay down.
      const replacement = this.ctx.getWebSockets(`session:${att.sessionId}`)
        .some((s) => s !== ws && this.isOpen(s));
      if (replacement) return;
      const agent = this.agent();
      if (agent) this.send(agent, { t: 'viewer_close', sessionId: att.sessionId, relayId: att.relayId });
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
    const agent = this.agent();
    if (!agent || epoch !== this.revocationEpoch) return;
    const { results } = await this.env.DB.prepare(
      `SELECT c.id, c.kind, c.payload FROM agent_commands c
       WHERE c.instance_id = ? AND c.status = 'pending' AND ${COMMAND_ACTIVE} ORDER BY c.created_at`,
    )
      .bind(instanceId)
      .all<CommandRow>();
    for (const c of results) {
      if (epoch !== this.revocationEpoch || !this.isOpen(agent)) return;
      const payload = JSON.parse(c.payload) as Record<string, unknown>;
      // The archive key is added on delivery and lives only in this frame, never in D1 (page 4).
      const archive = payload.archive as Record<string, unknown> | undefined;
      if (archive && typeof archive === 'object') {
        const key = await this.env.API.archiveKey(instanceId);
        payload.archive = key ? { ...archive, key } : null;
      }
      if (epoch !== this.revocationEpoch || !this.isOpen(agent)) return;
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
