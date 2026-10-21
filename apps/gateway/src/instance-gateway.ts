import { AgentFrame, ViewerFrame, type GatewayToAgent, type GatewayToViewer } from '@cloudbrowser/contracts';
import { createDb, prepaidAccess } from '@cloudbrowser/db';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';

type Attachment = { role: 'agent'; generation: number } | { role: 'viewer'; sessionId: string; generation: number; relayId?: string };
type CommandRow = { id: string; kind: string; payload: string };
type LiveInstance = { user_id: string; status: string; desired_state: string; generation: number | null };

/** Frames bigger than this are refused (page 2: message size limits). */
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_QUEUED_FRAME_BYTES = 1024 * 1024;
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  private async instanceId(): Promise<string> {
    return (await this.ctx.storage.get<string>('instanceId')) ?? '';
  }

  private sockets(role: 'agent' | 'viewer') {
    return this.ctx.getWebSockets(role).filter((ws) => ws.readyState === WebSocket.OPEN);
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
    for (const agent of this.sockets('agent')) agent.close(code, reason);
  }

  /** D1 is authoritative; upgrades and expired authorization leases read current state. */
  private async liveInstance(instanceId: string): Promise<LiveInstance | null> {
    try {
      const row = await withRetry(() => this.env.DB.prepare(`SELECT b.user_id, b.status, b.desired_state, a.generation
        FROM browser_instances b LEFT JOIN agent_credentials a ON a.instance_id = b.id WHERE b.id = ?`)
        .bind(instanceId).first<LiveInstance>());
      if (!row || row.desired_state === 'deleted' || ['deleting', 'purged', 'failed'].includes(row.status)) {
        this.closeAll('browser unavailable');
        return null;
      }
      return row;
    } catch {
      this.closeAll('authorization unavailable');
      return null;
    }
  }

  private async validSocket(ws: WebSocket, row: LiveInstance, instanceId: string, allowCached = false): Promise<boolean> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment || !['agent', 'viewer'].includes(attachment.role) || !row.generation || attachment.generation !== row.generation) {
      ws.close(4003, 'generation revoked');
      return false;
    }
    if (attachment.role === 'viewer') {
      if (!(await this.validSession(attachment.sessionId, row, instanceId, allowCached))) {
        this.closeViewer(ws, attachment.sessionId);
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
      if (!session) return false;
      if (!access.allowed || epoch !== this.revocationEpoch) return false;
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
      this.closeAll('authorization unavailable');
      return false;
    }
  }

  private async pruneSockets(row: LiveInstance, instanceId: string, allowCached = false) {
    for (const role of ['agent', 'viewer'] as const) for (const ws of this.sockets(role)) await this.validSocket(ws, row, instanceId, allowCached);
  }

  /** Re-checks a lease that is about to lapse, off the relay path; failures close it as usual. */
  private renewSoon(sessionId: string, instanceId: string) {
    const grant = this.inputGrants.get(sessionId);
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
    if (instanceId) await this.ctx.storage.put('instanceId', instanceId);

    if (url.pathname === '/deliver') {
      await this.deliverPending();
      return new Response(null, { status: 204 });
    }
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    const row = await this.liveInstance(instanceId);
    if (!row || epoch !== this.revocationEpoch) return new Response('browser unavailable', { status: 403 });
    await this.pruneSockets(row, instanceId, true);
    if (epoch !== this.revocationEpoch) return new Response('browser unavailable', { status: 403 });

    const { 0: client, 1: server } = new WebSocketPair();
    const role = req.headers.get('x-cb-role');
    if (role === 'agent') {
      const generation = Number(req.headers.get('x-cb-generation') ?? 0);
      if (!row.generation || generation !== row.generation) return new Response('generation revoked', { status: 403 });
      // A reconnecting agent replaces the old tunnel.
      for (const old of this.sockets('agent')) old.close(4000, 'replaced');
      const att: Attachment = { role: 'agent', generation };
      this.ctx.acceptWebSocket(server, ['agent']);
      server.serializeAttachment(att);
      const credential = req.headers.get('x-cb-credential');
      this.send(server, credential ? { t: 'welcome', credential } : { t: 'welcome' });
      for (const v of this.sockets('viewer')) {
        this.send(v, { t: 'agent_online' });
        const a = v.deserializeAttachment() as Attachment;
        if (a.role === 'viewer') this.send(server, { t: 'viewer_open', sessionId: a.sessionId, relayId: a.relayId });
      }
      await this.deliverPending();
    } else if (role === 'viewer') {
      const sessionId = req.headers.get('x-cb-session') ?? '';
      const attachment: Attachment = { role: 'viewer', sessionId, generation: row.generation ?? 0, relayId: crypto.randomUUID() };
      if (!row.generation || !(await this.validSession(sessionId, row, instanceId)) || epoch !== this.revocationEpoch) return new Response('session revoked', { status: 403 });
      // One controller at a time: the newest viewer takes over (page 5).
      for (const old of this.sockets('viewer')) {
        const prior = old.deserializeAttachment() as Attachment | null;
        if (prior?.role === 'viewer' && prior.sessionId === sessionId) old.close(4000, 'reconnected');
        else { this.send(old, { t: 'taken_over' }); old.close(4001, 'taken over'); }
      }
      this.ctx.acceptWebSocket(server, ['viewer', `session:${sessionId}`]);
      server.serializeAttachment(attachment);
      const agent = this.sockets('agent')[0];
      this.send(server, agent ? { t: 'agent_online' } : { t: 'agent_offline' });
      if (agent) this.send(agent, { t: 'viewer_open', sessionId, relayId: attachment.relayId });
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
    const relayedSession = attachment?.role === 'viewer' ? attachment.sessionId
      : raw && typeof raw === 'object' && 't' in raw && ['viewer', 'viewer_error'].includes(String(raw.t))
        && 'sessionId' in raw && typeof raw.sessionId === 'string' ? raw.sessionId : null;
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
    else this.fromViewer(att, raw);
  }

  override async alarm() {
    const instanceId = await this.instanceId();
    const viewers = this.sockets('viewer');
    if (!instanceId || !viewers.length) return;
    // A frame may have renewed an expiring lease before this alarm was delivered. Preserve the
    // renewed grant; it already scheduled its own bounded deadline. Expired grants are rechecked.
    const grants = viewers.map(viewer => {
      const att = viewer.deserializeAttachment() as Attachment | null;
      return att?.role === 'viewer' ? this.inputGrants.get(att.sessionId) : null;
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
      ws.close(1007, 'invalid frame');
      return;
    }
    const frame = parsed.data;
    if (frame.t === 'viewer_error') {
      this.inputFailure(frame.sessionId, frame.reason, frame.relayId);
      return;
    }
    if (frame.t === 'viewer') {
      this.traceSignal('agent', frame.sessionId, frame.data);
      for (const v of this.ctx.getWebSockets(`session:${frame.sessionId}`)) {
        const attachment = v.deserializeAttachment() as Attachment | null;
        if (frame.relayId && (attachment?.role !== 'viewer' || attachment.relayId !== frame.relayId)) continue;
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
    if (frame.t === 'hello') return;
    // Events, replies and TURN requests go to the api, which owns those records.
    const answer = await this.env.API.agentMessage(await this.instanceId(), att.generation, frame);
    if (answer) this.send(ws, answer);
    // Backstop for a lost queue poke: every heartbeat (15 s) also delivers pending commands.
    if (frame.t === 'event' && frame.kind === 'heartbeat') await this.deliverPending();
  }

  private fromViewer(att: Extract<Attachment, { role: 'viewer' }>, raw: unknown) {
    const parsed = ViewerFrame.safeParse(raw);
    const agent = this.sockets('agent')[0];
    if (!parsed.success) { this.inputFailure(att.sessionId, 'invalid_input'); return; }
    if (!agent) { this.inputFailure(att.sessionId, 'relay_unavailable'); return; }
    if (parsed.data.t === 'neko') this.traceSignal('viewer', att.sessionId, parsed.data.data);
    if (!this.send(agent, { t: 'viewer', sessionId: att.sessionId, relayId: att.relayId, data: parsed.data })) {
      this.inputFailure(att.sessionId, 'relay_failed');
    }
  }

  private inputFailure(sessionId: string, reason: string, relayId?: string) {
    for (const viewer of this.ctx.getWebSockets(`session:${sessionId}`)) {
      if (viewer.readyState !== WebSocket.OPEN) continue;
      const attachment = viewer.deserializeAttachment() as Attachment | null;
      if (relayId && (attachment?.role !== 'viewer' || attachment.relayId !== relayId)) continue;
      this.send(viewer, { t: 'input_error', reason });
      this.closeViewer(viewer, sessionId, 1011, 'remote input unavailable');
    }
  }

  /** Signal names help diagnose stalled handshakes without logging SDP, tokens or input. */
  private traceSignal(role: 'agent' | 'viewer', sessionId: string, data: unknown) {
    const event = data && typeof data === 'object' && 'event' in data ? data.event : undefined;
    if (typeof event === 'string' && (event.startsWith('signal/') || event === 'system/init')) {
      console.info('viewer signaling', { role, sessionId, event });
    }
  }

  override async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
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
    }
  }

  override async webSocketError(ws: WebSocket) {
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
