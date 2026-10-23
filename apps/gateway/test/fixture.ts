/**
 * One browser behind the gateway, for the coding-agent tests: D1 with an owner, a running browser
 * and three access keys, the Worker and its Durable Object, and a fake VM that answers automation
 * requests the way services/agent does (blobs before the result that names them, a `file`
 * acknowledgement per chunk, scaled screenshots from protocol 2).
 */
import type { AutomationRequest } from '@cloudbrowser/contracts';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { vi } from 'vitest';
import worker from '../src/index.js';
import { InstanceGateway } from '../src/instance-gateway.js';
import type { Env, McpAuth } from '../src/env.js';
import { installDigestStream, Socket, UpgradeResponse, state } from './harness.js';

export const KEY = `nvzk_${'A'.repeat(43)}`;
export const OTHER_KEY = `nvzk_${'B'.repeat(43)}`;
export const VIEW_KEY = `nvzk_${'C'.repeat(43)}`;
const AUTH: Record<string, McpAuth> = {
  [KEY]: { ok: true, clientId: 'client1', userId: 'owner1', generation: 1, capability: 'control', name: 'laptop' },
  [OTHER_KEY]: { ok: true, clientId: 'client2', userId: 'owner1', generation: 1, capability: 'control', name: 'desktop' },
  [VIEW_KEY]: { ok: true, clientId: 'client3', userId: 'owner1', generation: 1, capability: 'view', name: 'watcher' },
};

type Fixture = ReturnType<typeof gatewayFixture>;

export function gatewayFixture() {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('WebSocketPair', class { 0 = new Socket(); 1 = new Socket(); });
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
  vi.stubGlobal('Response', UpgradeResponse);
  installDigestStream();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const d1 = createTestD1();
  d1.sqlite.exec(`
    INSERT INTO control_flags (key,value,updated_at) VALUES ('billing_required','false',0)
      ON CONFLICT(key) DO UPDATE SET value='false';
    INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('owner1', 'Owner', 'owner@example.com', 0, 0);
    INSERT INTO browser_instances
      (id, user_id, name, region_id, status, desired_state, idle_timeout_s, locale, screen, fingerprint, created_at, updated_at)
      VALUES ('browser1', 'owner1', 'Browser', 'tyo1', 'running', 'running', 900, 'en-US', 'auto', '{}', 0, 0);
    INSERT INTO agent_credentials (instance_id, generation, created_at) VALUES ('browser1', 1, 0);
    INSERT INTO viewer_sessions (id, instance_id, user_id, started_at, last_seen_at) VALUES ('viewer1', 'browser1', 'owner1', 0, 0);
    INSERT INTO automation_clients (id, instance_id, user_id, name, kind, credential_hash, created_at, activated_at, capability)
      VALUES ('client1', 'browser1', 'owner1', 'laptop', 'key', 'h1', 0, 0, 'control'),
             ('client2', 'browser1', 'owner1', 'desktop', 'key', 'h2', 0, 0, 'control'),
             ('client3', 'browser1', 'owner1', 'watcher', 'key', 'h3', 0, 0, 'view');
  `);
  const ctx = state();
  let sessions = 0;
  const env: Env = {
    DB: d1,
    API: {
      authenticateAgent: vi.fn().mockResolvedValue({ ok: true, generation: 1 }),
      agentMessage: vi.fn().mockResolvedValue(null),
      redeemViewerToken: vi.fn().mockResolvedValue(true),
      archiveKey: vi.fn().mockResolvedValue(null),
      authenticateMcp: vi.fn(async ({ instanceId, key }: { instanceId: string; key: string }) =>
        (instanceId === 'browser1' && AUTH[key]) || { ok: false as const, reason: 'invalid_token' as const }),
      // As the api does: one open session per browser, any other ends as replaced.
      openAutomationSession: vi.fn(async (instanceId: string, clientId: string) => {
        const sessionId = `sess${++sessions}`;
        d1.sqlite.prepare(`UPDATE automation_sessions SET ended_at = ?, end_reason = 'replaced' WHERE instance_id = ? AND ended_at IS NULL`).run(Date.now(), instanceId);
        d1.sqlite.prepare(`INSERT INTO automation_sessions (id, instance_id, client_id, user_id, generation, started_at, last_seen_at)
          VALUES (?, ?, ?, 'owner1', 1, ?, ?)`).run(sessionId, instanceId, clientId, Date.now(), Date.now());
        return { sessionId };
      }),
      endAutomationSession: vi.fn(async (sessionId: string, reason: string) => {
        d1.sqlite.prepare(`UPDATE automation_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`).run(Date.now(), reason, sessionId);
      }),
    },
    INSTANCE_GATEWAY: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: (req: Request | string, init?: RequestInit) => fx.gateway.fetch(req instanceof Request ? req : new Request(req, init)) }),
    } as unknown as DurableObjectNamespace,
  };
  const execution = { waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p), passThroughOnException() {} } as unknown as ExecutionContext;

  const fx = {
    d1, env, ctx,
    gateway: new InstanceGateway(ctx as unknown as DurableObjectState, env),
    /** A new object over the same storage and sockets, as after an eviction. */
    evict() { fx.gateway = new InstanceGateway(ctx as unknown as DurableObjectState, env); },
    async open(role: 'agent' | 'viewer', headers: Record<string, string> = {}) {
      const response = await fx.gateway.fetch(new Request('https://gateway/socket', {
        headers: { upgrade: 'websocket', 'x-cb-instance': 'browser1', 'x-cb-role': role,
          ...(role === 'agent' ? { 'x-cb-generation': '1' } : { 'x-cb-session': 'viewer1' }), ...headers },
      }));
      return { response, socket: ctx.getWebSockets(role).at(-1)! };
    },
    frame: (socket: Socket, payload: unknown) => fx.gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(payload)),
    /** One MCP request through the Worker. */
    post(body: unknown, { key = KEY, headers = {}, path = '/mcp/browser1' }: { key?: string | null; headers?: Record<string, string>; path?: string } = {}) {
      return worker.fetch!(new Request(`https://connect.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }), env, execution);
    },
    /** A tool call; its content split into the text and the image, if any. */
    async call(name: string, args: Record<string, unknown> = {}, options: { key?: string; id?: number | string } = {}) {
      const response = await fx.post({ jsonrpc: '2.0', id: options.id ?? 1, method: 'tools/call', params: { name, arguments: args } }, options);
      const body = await response.json() as { result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean } };
      const content = body.result.content;
      return {
        status: response.status, isError: !!body.result.isError, content,
        text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
        image: content.find((c) => c.type === 'image'),
      };
    },
    put(url: string, body: Uint8Array | null, headers: Record<string, string> = {}) {
      return worker.fetch!(new Request(url, {
        method: 'PUT', headers, body, ...({ duplex: 'half' } as RequestInit),
      }), env, execution);
    },
  };
  return fx;
}

type Req = AutomationRequest;
type Shot = { width: number; height: number };

/**
 * The VM's side of a coding agent's session. Every request is answered on the next turn of the
 * event loop unless its type is held; held requests wait in `held` for the test to answer.
 */
export class FakeVm {
  readonly requests: Req[] = [];
  readonly held: Req[] = [];
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  /** Requests a result was sent for; a held act without one is running. */
  readonly answered = new Set<string>();
  readonly hold = new Set<string>();
  sessionId: string | null = null;
  protocol = 2;
  screen = { version: 1, width: 1920, height: 1080 };
  control = { controller: 'agent' as const, mode: 'agent' as const, epoch: 3 };
  /** Chunks of the current transfer sent ahead of an acknowledgement, and the most ever. */
  outstanding = 0;
  maxOutstanding = 0;
  /** Acknowledges each chunk after this long, so the sender has to respect its window. */
  ackDelayMs = 0;
  private shots = 0;
  private files = 0;
  private transfer: { id: string; name: string; type: string; size: number; received: number } | null = null;

  constructor(private readonly fx: Fixture, readonly socket: Socket) {
    const send = socket.send.bind(socket);
    socket.send = (text: string) => {
      send(text);
      const frame = JSON.parse(text) as { t: string; sessionId?: string; data?: Req };
      if (frame.t === 'automation_open') { this.opened.push(frame.sessionId!); this.sessionId = frame.sessionId!; }
      if (frame.t === 'automation_close') this.closed.push(frame.sessionId!);
      if (frame.t === 'automation' && frame.data) {
        this.requests.push(frame.data);
        if (this.hold.has(frame.data.t)) this.held.push(frame.data);
        else setTimeout(() => void this.answer(frame.sessionId!, frame.data!), 0);
      }
    };
  }

  get running() {
    return this.held.find((r) => r.t === 'act' && !this.answered.has(r.id));
  }

  /** The last request of a type, once it arrived. */
  last<T extends Req['t']>(t: T): Extract<Req, { t: T }> | undefined {
    return this.requests.filter((r) => r.t === t).at(-1) as Extract<Req, { t: T }> | undefined;
  }

  reply(data: unknown, sessionId = this.sessionId) {
    if ((data as { t: string }).t === 'result') this.answered.add((data as { id: string }).id);
    return this.fx.frame(this.socket, { t: 'automation_result', sessionId, data });
  }

  result(id: string, kind: string, extra: Record<string, unknown> = {}) {
    return { t: 'result', id, kind, status: 'executed', control: this.control, screen: this.screen, ...extra };
  }

  /** A screenshot as services/agent sends it: the bytes in two blob frames, then the result naming them. */
  async shot(sessionId: string, id: string, kind: string, req: { maxWidth?: number; maxHeight?: number }, extra: Record<string, unknown> = {}) {
    const n = ++this.shots;
    const size: Shot = this.protocol >= 2 && req.maxWidth && req.maxHeight
      ? (() => {
        const scale = Math.min(req.maxWidth / this.screen.width, req.maxHeight / this.screen.height, 1);
        return { width: Math.round(this.screen.width * scale), height: Math.round(this.screen.height * scale) };
      })()
      : { width: this.screen.width, height: this.screen.height };
    const blobId = `blob${n}`;
    await this.reply({ t: 'blob', id: blobId, seq: 0, last: false, data: `SU1H${n}` }, sessionId);
    await this.reply({ t: 'blob', id: blobId, seq: 1, last: true, data: 'QUdF' }, sessionId);
    await this.reply(this.result(id, kind, {
      screenshot: {
        id: `shot${n}`, blobId, mime: 'image/jpeg', bytes: 6, ...size,
        ...(this.protocol >= 2 ? { screenWidth: this.screen.width, screenHeight: this.screen.height } : {}),
        capturedAt: '2026-10-23T00:00:00Z', screenVersion: this.screen.version, controlEpoch: this.control.epoch,
      },
      ...extra,
    }), sessionId);
  }

  async answer(sessionId: string, req: Req) {
    switch (req.t) {
      case 'screenshot': return this.shot(sessionId, req.id, 'screenshot', req);
      case 'act':
      case 'attach':
        return req.screenshot === false ? this.reply(this.result(req.id, req.t), sessionId) : this.shot(sessionId, req.id, req.t, req);
      case 'status':
        return this.reply(this.result(req.id, 'status', {
          capabilities: { protocol: this.protocol, agentVersion: '0.5.0', screenshot: true, files: true, picker: true, paste: true, drop: true, touch: false },
          ...(this.running ? { activeActionId: this.running.id } : {}),
        }), sessionId);
      case 'cancel': return this.reply(this.result(req.id, 'cancel'), sessionId);
      case 'file_begin': {
        const file = req.files[0]!;
        this.transfer = { id: req.id, ...file, received: 0 };
        return;
      }
      case 'file_chunk': {
        this.outstanding++;
        this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
        const t = this.transfer!;
        t.received += Buffer.from(req.chunk, 'base64').length;
        await new Promise((resolve) => setTimeout(resolve, this.ackDelayMs));
        this.outstanding--;
        return this.reply({ t: 'file', id: req.id, status: 'progress', received: t.received }, sessionId);
      }
      case 'file_end': {
        const t = this.transfer!;
        this.transfer = null;
        const handle = `h${++this.files}`;
        return this.reply({ t: 'file', id: req.id, status: 'done', received: t.received, handles: [{ handle, name: t.name, size: t.received, type: t.type }] }, sessionId);
      }
      default: return;
    }
  }
}
