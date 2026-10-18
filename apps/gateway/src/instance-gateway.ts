import { AgentFrame, ViewerFrame, type GatewayToAgent, type GatewayToViewer } from '@cloudbrowser/contracts';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';

type Attachment = { role: 'agent'; generation: number } | { role: 'viewer'; sessionId: string; generation: number };
type CommandRow = { id: string; kind: string; payload: string };
type LiveInstance = { user_id: string; status: string; desired_state: string; generation: number | null };

/** Frames bigger than this are refused (page 2: message size limits). */
const MAX_FRAME_BYTES = 256 * 1024;

/**
 * One Durable Object per browser instance: the meeting point of that instance's agent tunnel and
 * its viewer (page 2, `services/gateway`). It replaces the plan's Go gateway and its
 * `agent_sessions` registry, because routing by instance id is what a Durable Object gives for
 * free. Uses the WebSocket hibernation API, so idle connections cost nothing between frames.
 */
export class InstanceGateway extends DurableObject<Env> {
  // Prevent an upgrade already awaiting a DB read from surviving a concurrent revoke RPC.
  private revocationEpoch = 0;
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
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Closed socket; its close handler cleans up.
    }
  }

  private closeViewer(ws: WebSocket, sessionId: string) {
    for (const agent of this.sockets('agent')) this.send(agent, { t: 'viewer_close', sessionId });
    ws.close(4003, 'session revoked');
  }

  private closeAll(reason: string) {
    for (const viewer of this.sockets('viewer')) {
      const attachment = viewer.deserializeAttachment() as Attachment | null;
      if (attachment?.role === 'viewer') this.closeViewer(viewer, attachment.sessionId);
      else viewer.close(4003, reason);
    }
    for (const agent of this.sockets('agent')) agent.close(4003, reason);
  }

  /** D1 is authoritative; there is no cached authorization that can outlive a deletion. */
  private async liveInstance(instanceId: string): Promise<LiveInstance | null> {
    try {
      const row = await this.env.DB.prepare(`SELECT b.user_id, b.status, b.desired_state, a.generation
        FROM browser_instances b LEFT JOIN agent_credentials a ON a.instance_id = b.id WHERE b.id = ?`)
        .bind(instanceId).first<LiveInstance>();
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

  private async validSocket(ws: WebSocket, row: LiveInstance, instanceId: string): Promise<boolean> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment || !['agent', 'viewer'].includes(attachment.role) || !row.generation || attachment.generation !== row.generation) {
      ws.close(4003, 'generation revoked');
      return false;
    }
    if (attachment.role === 'viewer') {
      if (!(await this.validSession(attachment.sessionId, row, instanceId))) {
        this.closeViewer(ws, attachment.sessionId);
        return false;
      }
    }
    return ws.readyState === WebSocket.OPEN;
  }

  private async validSession(sessionId: string, row: LiveInstance, instanceId: string): Promise<boolean> {
    try {
      return !!(await this.env.DB.prepare(`SELECT id FROM viewer_sessions
        WHERE id = ? AND instance_id = ? AND user_id = ? AND ended_at IS NULL`)
        .bind(sessionId, instanceId, row.user_id).first());
    } catch {
      this.closeAll('authorization unavailable');
      return false;
    }
  }

  private async pruneSockets(row: LiveInstance, instanceId: string) {
    for (const role of ['agent', 'viewer'] as const) for (const ws of this.sockets(role)) await this.validSocket(ws, row, instanceId);
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Only the gateway's trusted service entrypoint reaches this Durable Object route.
    if (url.pathname === '/revoke' && req.method === 'POST') {
      this.revocationEpoch++;
      this.closeAll('browser deleted');
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
    await this.pruneSockets(row, instanceId);
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
        if (a.role === 'viewer') this.send(server, { t: 'viewer_open', sessionId: a.sessionId });
      }
      await this.deliverPending();
    } else if (role === 'viewer') {
      const sessionId = req.headers.get('x-cb-session') ?? '';
      const attachment: Attachment = { role: 'viewer', sessionId, generation: row.generation ?? 0 };
      if (!row.generation || !(await this.validSession(sessionId, row, instanceId)) || epoch !== this.revocationEpoch) return new Response('session revoked', { status: 403 });
      // One controller at a time: the newest viewer takes over (page 5).
      for (const old of this.sockets('viewer')) {
        this.send(old, { t: 'taken_over' });
        old.close(4001, 'taken over');
      }
      this.ctx.acceptWebSocket(server, ['viewer', `session:${sessionId}`]);
      server.serializeAttachment(attachment);
      const agent = this.sockets('agent')[0];
      this.send(server, agent ? { t: 'agent_online' } : { t: 'agent_offline' });
      if (agent) this.send(agent, { t: 'viewer_open', sessionId });
    } else {
      return new Response('forbidden', { status: 403 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const epoch = this.revocationEpoch;
    const instanceId = await this.instanceId();
    const row = await this.liveInstance(instanceId);
    if (!row || epoch !== this.revocationEpoch) return;
    await this.pruneSockets(row, instanceId);
    if (!(await this.validSocket(ws, row, instanceId)) || epoch !== this.revocationEpoch) return;
    if (typeof message !== 'string' || message.length > MAX_FRAME_BYTES) {
      ws.close(1009, 'frame too large or not text');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      ws.close(1007, 'invalid json');
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    if (att.role === 'agent') await this.fromAgent(ws, att, raw);
    else this.fromViewer(att, raw);
  }

  private async fromAgent(ws: WebSocket, att: Extract<Attachment, { role: 'agent' }>, raw: unknown) {
    const parsed = AgentFrame.safeParse(raw);
    if (!parsed.success) {
      ws.close(1007, 'invalid frame');
      return;
    }
    const frame = parsed.data;
    if (frame.t === 'viewer') {
      this.traceSignal('agent', frame.sessionId, frame.data);
      for (const v of this.ctx.getWebSockets(`session:${frame.sessionId}`)) this.send(v, { t: 'neko', data: frame.data });
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
    if (!parsed.success || !agent) return;
    if (parsed.data.t === 'neko') this.traceSignal('viewer', att.sessionId, parsed.data.data);
    this.send(agent, { t: 'viewer', sessionId: att.sessionId, data: parsed.data });
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
      if (agent) this.send(agent, { t: 'viewer_close', sessionId: att.sessionId });
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
    await this.pruneSockets(row, instanceId);
    const agent = this.sockets('agent')[0];
    if (!agent || epoch !== this.revocationEpoch) return;
    const { results } = await this.env.DB.prepare(
      `SELECT id, kind, payload FROM agent_commands WHERE instance_id = ? AND status = 'pending' ORDER BY created_at`,
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
      this.send(agent, { t: 'command', id: c.id, kind: c.kind as never, payload });
      await this.env.DB.prepare(`UPDATE agent_commands SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(Date.now(), c.id)
        .run();
    }
  }
}
