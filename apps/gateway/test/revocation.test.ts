import { signViewerToken } from '@cloudbrowser/contracts';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { Internal } from '../src/index.js';
import { InstanceGateway } from '../src/instance-gateway.js';
import type { Env } from '../src/env.js';

class Socket {
  static OPEN = 1;
  readyState = 0;
  attachment: unknown = null;
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(frame: string) {
    if (this.readyState !== Socket.OPEN) throw new Error('socket closed');
    this.sent.push(JSON.parse(frame));
  }
  close(code?: number, reason?: string) { this.readyState = 3; this.closed = { code, reason }; }
  serializeAttachment(value: unknown) {
    if (this.readyState !== Socket.OPEN) throw new Error('accept the socket first');
    this.attachment = value;
  }
  deserializeAttachment() { return this.attachment; }
}

const NativeResponse = Response;
class UpgradeResponse extends NativeResponse {
  webSocket?: Socket;
  constructor(body: BodyInit | null, init: ResponseInit & { webSocket?: Socket } = {}) {
    super(body, { ...init, status: init.status === 101 ? 200 : init.status });
    if (init.status === 101) Object.defineProperty(this, 'status', { value: 101 });
    this.webSocket = init.webSocket;
  }
}

function state() {
  const storage = new Map<string, unknown>();
  const sockets: { ws: Socket; tags: string[] }[] = [];
  return {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
      setAlarm: async (at: number) => void storage.set('alarm', at),
    },
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws: Socket, tags: string[]) { ws.readyState = Socket.OPEN; sockets.push({ ws, tags }); },
    getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
  };
}

let d1: ReturnType<typeof createTestD1>;
let env: Env;
let ctx: ReturnType<typeof state>;
let gateway: InstanceGateway;

beforeEach(() => {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('WebSocketPair', class { 0 = new Socket(); 1 = new Socket(); });
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
  vi.stubGlobal('Response', UpgradeResponse);
  d1 = createTestD1();
  d1.sqlite.exec(`
    INSERT INTO control_flags (key,value,updated_at) VALUES ('billing_required','false',0)
      ON CONFLICT(key) DO UPDATE SET value='false';
    INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('owner1', 'Owner', 'owner@example.com', 0, 0);
    INSERT INTO browser_instances
      (id, user_id, name, region_id, status, desired_state, idle_timeout_s, locale, screen, fingerprint, created_at, updated_at)
      VALUES ('browser1', 'owner1', 'Browser', 'tyo1', 'running', 'running', 900, 'en-US', 'auto', '{}', 0, 0);
    INSERT INTO agent_credentials (instance_id, generation, created_at) VALUES ('browser1', 1, 0);
    INSERT INTO viewer_sessions (id, instance_id, user_id, started_at, last_seen_at) VALUES ('viewer1', 'browser1', 'owner1', 0, 0);
  `);
  ctx = state();
  env = {
    DB: d1,
    API: {
      authenticateAgent: vi.fn().mockResolvedValue({ ok: true, generation: 1 }),
      agentMessage: vi.fn().mockResolvedValue(null),
      redeemViewerToken: vi.fn().mockResolvedValue(true),
      archiveKey: vi.fn().mockResolvedValue('private-archive-key'),
    },
    INSTANCE_GATEWAY: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: (req: Request | string, init?: RequestInit) => gateway.fetch(req instanceof Request ? req : new Request(req, init)) }),
    } as unknown as DurableObjectNamespace,
  };
  gateway = new InstanceGateway(ctx as unknown as DurableObjectState, env);
});

afterEach(() => { d1.sqlite.close(); vi.unstubAllGlobals(); });

async function open(role: 'agent' | 'viewer', headers: Record<string, string> = {}) {
  const response = await gateway.fetch(new Request('https://gateway/socket', {
    headers: { upgrade: 'websocket', 'x-cb-instance': 'browser1', 'x-cb-role': role,
      ...(role === 'agent' ? { 'x-cb-generation': '1' } : { 'x-cb-session': 'viewer1' }), ...headers },
  }));
  return { response, socket: ctx.getWebSockets(role).at(-1)! };
}

const frame = (socket: Socket, payload: unknown) => gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(payload));

describe('gateway revocation', () => {
  it('keeps normal viewer signaling, agent heartbeat and command delivery working', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    expect(agent.response.status).toBe(101);
    expect(viewer.response.status).toBe(101);
    await frame(viewer.socket, { t: 'ime', text: 'hello' });
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'viewer', sessionId: 'viewer1', relayId: expect.any(String), data: { t: 'ime', text: 'hello' } });
    await frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', data: { event: 'normal' } });
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'neko', data: { event: 'normal' } });
    d1.sqlite.exec(`INSERT INTO agent_commands (id, instance_id, kind, payload, status, created_at)
      VALUES ('cmd1', 'browser1', 'ip_check', '{}', 'pending', 0)`);
    await frame(agent.socket, { t: 'event', kind: 'heartbeat', data: {} });
    expect(env.API.agentMessage).toHaveBeenCalledWith('browser1', 1, { t: 'event', kind: 'heartbeat', data: {} });
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'command', id: 'cmd1' });
    expect(d1.sqlite.prepare(`SELECT status FROM agent_commands WHERE id = 'cmd1'`).get()).toEqual({ status: 'delivered' });
  });

  it('immediately closes both tunnels through trusted RPC and never exposes a public revoke URL', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    await new Internal({} as never, env).revokeInstance('browser1');
    expect(agent.socket.closed?.code).toBe(4003);
    expect(viewer.socket.closed?.code).toBe(4003);
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'viewer_close', sessionId: 'viewer1', relayId: expect.any(String) });
    const forwarded = agent.socket.sent.length;
    await frame(viewer.socket, { t: 'ime', text: 'late input' });
    expect(agent.socket.sent).toHaveLength(forwarded);
    expect((await worker.fetch!(new Request('https://connect.test/revoke', { method: 'POST' }), env, {} as ExecutionContext)).status).toBe(426);
    expect((await worker.fetch!(new Request('https://connect.test/revoke', { headers: { upgrade: 'websocket' } }), env, {} as ExecutionContext)).status).toBe(404);
  });

  it('revokes viewers immediately for sleep while keeping the agent available for shutdown', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    d1.sqlite.exec(`UPDATE viewer_sessions SET ended_at = 1 WHERE id = 'viewer1'`);
    await new Internal({} as never, env).revokeViewers('browser1');
    expect(viewer.socket.closed?.code).toBe(4003);
    expect(agent.socket.closed).toBeNull();
    expect(agent.socket.sent.at(-1)).toMatchObject({t:'viewer_close',sessionId:'viewer1',relayId:expect.any(String)});
    expect((await worker.fetch!(new Request('https://connect.test/revoke-viewers',{method:'POST'}),env,{} as ExecutionContext)).status).toBe(426);
    expect((await worker.fetch!(new Request('https://connect.test/revoke-viewers',{headers:{upgrade:'websocket'}}),env,{} as ExecutionContext)).status).toBe(404);
  });

  it('does not deliver a command belonging to a superseded operation', async () => {
    const agent = await open('agent');
    d1.sqlite.exec(`INSERT INTO operations (id,instance_id,kind,status,deadline_at,created_at,updated_at,finished_at)
      VALUES ('superseded','browser1','restore','canceled',9999999999999,0,1,1);
      INSERT INTO agent_commands (id,instance_id,kind,payload,status,created_at)
      VALUES ('superseded:restore:1','browser1','restore_archive','{}','pending',0)`);
    await gateway.fetch(new Request('https://gateway/deliver',{method:'POST'}));
    expect(agent.socket.sent.some((f:any)=>f.t==='command')).toBe(false);
    expect(d1.sqlite.prepare(`SELECT status FROM agent_commands`).get()).toEqual({status:'pending'});
  });

  it('rechecks cancellation after waiting for an archive key before sending a command', async () => {
    const agent = await open('agent');
    d1.sqlite.exec(`INSERT INTO operations (id,instance_id,kind,status,deadline_at,created_at,updated_at)
      VALUES ('restoring','browser1','restore','waiting',9999999999999,0,0);
      INSERT INTO agent_commands (id,instance_id,kind,payload,status,created_at)
      VALUES ('restoring:restore:1','browser1','restore_archive','{"archive":{"bucket":"private"}}','pending',0)`);
    env.API.archiveKey = async () => {
      d1.sqlite.exec(`UPDATE operations SET status='canceled',finished_at=1 WHERE id='restoring'`);
      return 'private-key';
    };
    await gateway.fetch(new Request('https://gateway/deliver',{method:'POST'}));
    expect(agent.socket.sent.some((f:any)=>f.t==='command')).toBe(false);
    expect(d1.sqlite.prepare(`SELECT status FROM agent_commands`).get()).toEqual({status:'pending'});
  });

  it('preserves input order when the first authorization read is delayed', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    let entered!:()=>void;
    let resume!:()=>void;
    const reading = new Promise<void>(resolve=>{entered=resolve;});
    const blocked = new Promise<void>(resolve=>{resume=resolve;});
    const internals = gateway as unknown as {liveInstance(id:string):Promise<unknown>;inputGrants:Map<string,unknown>};
    internals.inputGrants.clear();
    const read = internals.liveInstance.bind(gateway);
    vi.spyOn(internals,'liveInstance').mockImplementationOnce(async id=>{entered();await blocked;return read(id);});
    const first = frame(viewer.socket,{t:'neko',data:{event:'control/keydown',payload:{keysym:97}}});
    await reading;
    const second = frame(viewer.socket,{t:'neko',data:{event:'control/keyup',payload:{keysym:97}}});
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(agent.socket.sent.filter((f:any)=>f.t==='viewer')).toHaveLength(0);
    resume();
    await Promise.all([first,second]);
    expect(agent.socket.sent.filter((f:any)=>f.t==='viewer').map((f:any)=>f.data.data.event))
      .toEqual(['control/keydown','control/keyup']);
  });

  it('makes remote input relay failures visible and ends the viewer without losing the agent', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    await frame(agent.socket,{t:'viewer_error',sessionId:'viewer1',reason:'input_failed'});
    expect(viewer.socket.sent.at(-1)).toEqual({t:'input_error',reason:'input_failed'});
    expect(viewer.socket.closed).toEqual({code:1011,reason:'remote input unavailable'});
    expect(agent.socket.closed).toBeNull();
  });

  it('refuses an unpaid viewer while allowing the agent to connect for cleanup', async () => {
    d1.sqlite.exec(`UPDATE control_flags SET value='true' WHERE key='billing_required'`);
    expect((await open('agent')).response.status).toBe(101);
    expect((await open('viewer')).response.status).toBe(403);
  });

  it('ends an exhausted trial on its deadline without requiring another input event', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
      d1.sqlite.prepare(`UPDATE browser_instances SET trial_state='active',trial_used_s=599,last_active_at=?`).run(Date.now());
      const agent = await open('agent');
      const viewer = await open('viewer');
      expect(viewer.response.status).toBe(101);
      expect(await ctx.storage.get('alarm')).toBe(Date.now()+1000);
      vi.advanceTimersByTime(1000);
      await gateway.alarm();
      expect(viewer.socket.closed?.code).toBe(4003);
      expect(agent.socket.closed).toBeNull();
      expect((await open('viewer')).response.status).toBe(403);
    } finally { vi.useRealTimers(); }
  });

  it('uses available credit rather than a positive total balance to retain viewer access', async () => {
    d1.sqlite.exec(`
      UPDATE control_flags SET value='true' WHERE key='billing_required';
      INSERT INTO provider_prices (region_id,executor,provider_region,sheet,fetched_at)
        VALUES ('tyo1','fake','ap-northeast-1','{"source":"simulated","instanceType":"fake.large","vmHour":0.1,"instanceTypes":{"fake.large":0.1},"volumeGbMonth":0.08,"snapshotGbMonth":0.05,"ipHour":0.005,"transferOutGb":0.09,"rootVolumeGb":16,"effectiveDate":null}',0);
      INSERT INTO billing_accounts (user_id,balance_micros,updated_at) VALUES ('owner1',2000000,0);
      INSERT INTO browser_reservations (instance_id,user_id,required_micros,reserved_micros,fixed_hour_micros,rates,updated_at)
        VALUES ('browser1','owner1',1000000,1000000,1000,'{"compute":120000,"ip":6000,"storage":96000,"snapshot":60000,"transfer":108000}',0);
    `);
    const agent = await open('agent');
    const viewer = await open('viewer');
    expect(viewer.response.status).toBe(101);
    d1.sqlite.exec(`UPDATE billing_accounts SET balance_micros=1000000`);
    await gateway.alarm();
    expect(viewer.socket.closed?.code).toBe(4003);
    expect(agent.socket.closed).toBeNull();
    expect((await open('viewer')).response.status).toBe(403);
  });

  it('reports a failed agent socket send instead of silently discarding an input', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    vi.spyOn(agent.socket,'send').mockImplementation(()=>{throw new Error('socket send failed');});
    await frame(viewer.socket,{t:'neko',data:{event:'control/keydown',payload:{keysym:97}}});
    expect(viewer.socket.sent.at(-1)).toEqual({t:'input_error',reason:'relay_failed'});
    expect(viewer.socket.closed?.code).toBe(1011);
  });

  it('isolates late errors and signaling from an older relay of the same viewer session', async () => {
    const agent = await open('agent');
    const old = await open('viewer');
    const oldId = (old.socket.attachment as {relayId:string}).relayId;
    const current = await open('viewer');
    const currentId = (current.socket.attachment as {relayId:string}).relayId;
    expect(currentId).not.toBe(oldId);
    const before = current.socket.sent.length;
    await frame(agent.socket,{t:'viewer_error',sessionId:'viewer1',relayId:oldId,reason:'relay_failed'});
    await frame(agent.socket,{t:'viewer',sessionId:'viewer1',relayId:oldId,data:{event:'old signal'}});
    expect(current.socket.closed).toBeNull();
    expect(current.socket.sent).toHaveLength(before);
    await frame(agent.socket,{t:'viewer',sessionId:'viewer1',relayId:currentId,data:{event:'current signal'}});
    expect(current.socket.sent.at(-1)).toEqual({t:'neko',data:{event:'current signal'}});
    await frame(agent.socket,{t:'viewer_error',sessionId:'viewer1',relayId:currentId,reason:'relay_failed'});
    expect(current.socket.closed?.code).toBe(1011);
  });

  it('keeps the current relay identity when an agent reconnects', async () => {
    await open('agent');
    const viewer = await open('viewer');
    const relayId=(viewer.socket.attachment as {relayId:string}).relayId;
    const replacement=await open('agent');
    expect(replacement.socket.sent).toContainEqual({t:'viewer_open',sessionId:'viewer1',relayId});
  });

  it('requeues an active command when its claimed socket send failed', async () => {
    const agent=await open('agent');
    d1.sqlite.exec(`INSERT INTO agent_commands (id,instance_id,kind,payload,status,created_at)
      VALUES ('retry-command','browser1','ip_check','{}','pending',0)`);
    const send=vi.spyOn(agent.socket,'send').mockImplementation(()=>{throw new Error('send failed');});
    await gateway.fetch(new Request('https://gateway/deliver',{method:'POST'}));
    expect(d1.sqlite.prepare(`SELECT status,delivered_at FROM agent_commands`).get()).toEqual({status:'pending',delivered_at:null});
    send.mockRestore();
    await gateway.fetch(new Request('https://gateway/deliver',{method:'POST'}));
    expect(d1.sqlite.prepare(`SELECT status FROM agent_commands`).get()).toEqual({status:'delivered'});
    expect(agent.socket.sent.at(-1)).toMatchObject({t:'command',id:'retry-command'});
  });

  it.each(['intent', 'deleting', 'purged', 'missing'] as const)('stops existing signaling after deletion state %s even if RPC was lost', async (change) => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    if (change === 'intent') d1.sqlite.exec(`UPDATE browser_instances SET desired_state = 'deleted' WHERE id = 'browser1'`);
    else if (change === 'missing') { d1.sqlite.exec('PRAGMA foreign_keys = OFF'); d1.sqlite.exec(`DELETE FROM browser_instances WHERE id = 'browser1'`); }
    else d1.sqlite.prepare(`UPDATE browser_instances SET status = ? WHERE id = 'browser1'`).run(change);
    const before = agent.socket.sent.filter((f: any) => f.t === 'viewer').length;
    await frame(viewer.socket, { t: 'ime', text: 'private text' });
    expect(agent.socket.sent.filter((f: any) => f.t === 'viewer')).toHaveLength(before);
    expect(agent.socket.closed).not.toBeNull();
    expect(viewer.socket.closed).not.toBeNull();
    expect((await open('agent')).response.status).toBe(403);
    expect((await open('viewer')).response.status).toBe(403);
  });

  it('ends both directions of an old viewer session without interrupting the valid agent', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    d1.sqlite.exec(`UPDATE viewer_sessions SET ended_at = 10 WHERE id = 'viewer1'`);
    const before = viewer.socket.sent.length;
    await frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', data: { event: 'sensitive' } });
    expect(viewer.socket.sent).toHaveLength(before);
    expect(viewer.socket.closed?.code).toBe(4003);
    expect(agent.socket.closed).toBeNull();
    expect((await open('viewer')).response.status).toBe(403);
  });

  it('rejects another owner session and drops old agent generations before forwarding or delivering', async () => {
    expect((await open('viewer', { 'x-cb-session': 'unknown' })).response.status).toBe(403);
    d1.sqlite.exec(`UPDATE viewer_sessions SET user_id = 'another-owner' WHERE id = 'viewer1'`);
    expect((await open('viewer')).response.status).toBe(403);
    d1.sqlite.exec(`UPDATE viewer_sessions SET user_id = 'owner1' WHERE id = 'viewer1'`);
    const agent = await open('agent');
    const viewer = await open('viewer');
    d1.sqlite.exec(`UPDATE agent_credentials SET generation = 2 WHERE instance_id = 'browser1'`);
    const before = viewer.socket.sent.length;
    await frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', data: 'secret' });
    expect(agent.socket.closed?.code).toBe(4003);
    expect(viewer.socket.closed?.code).toBe(4003);
    expect(viewer.socket.sent).toHaveLength(before);
    expect((await open('agent')).response.status).toBe(403);
    expect((await open('agent', { 'x-cb-generation': '2' })).response.status).toBe(101);
  });

  it('does not deliver pending commands or fetch archive keys once deletion is requested', async () => {
    const agent = await open('agent');
    d1.sqlite.exec(`INSERT INTO agent_commands (id, instance_id, kind, payload, status, created_at)
      VALUES ('cmd1', 'browser1', 'prepare_shutdown', '{"archive":{"bucket":"private"}}', 'pending', 0);
      UPDATE browser_instances SET desired_state = 'deleted' WHERE id = 'browser1'`);
    await gateway.fetch(new Request('https://gateway/deliver', { method: 'POST' }));
    expect(agent.socket.closed?.code).toBe(4003);
    expect(env.API.archiveKey).not.toHaveBeenCalled();
    expect(d1.sqlite.prepare(`SELECT status FROM agent_commands WHERE id = 'cmd1'`).get()).toEqual({ status: 'pending' });
  });

  it('fails closed on a database error rather than continuing an existing relay', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    vi.spyOn(d1, 'prepare').mockImplementation(() => { throw new Error('database unavailable'); });
    await frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', data: 'secret' });
    expect(agent.socket.closed).not.toBeNull();
    expect(viewer.socket.closed).not.toBeNull();
    expect((await open('agent')).response.status).toBe(403);
  });

  it('does not accept an upgrade whose earlier database read completes after a revoke RPC', async () => {
    let entered!: () => void;
    let resume!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    env.DB = { prepare: () => ({ bind: () => ({ first: async () => {
      entered();
      await blocked;
      return { user_id: 'owner1', status: 'running', desired_state: 'running', generation: 1 };
    } }) }) } as unknown as D1Database;
    const upgrading = open('viewer');
    await reading;
    await new Internal({} as never, env).revokeInstance('browser1');
    resume();
    expect((await upgrading).response.status).toBe(403);
    expect(ctx.getWebSockets()).toHaveLength(0);
  });

  it('rejects valid old credentials and freshly signed viewer tokens after deletion', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
    env.VIEWER_TOKEN_PUBLIC_KEY = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey));
    const signed = await signViewerToken(privateKey, { iid: 'browser1', uid: 'owner1', sid: 'viewer1', jti: 'newtoken', exp: Math.floor(Date.now() / 1000) + 60 });
    const agentRequest = new Request('https://connect.test/v1/agent', { headers: { upgrade: 'websocket', 'x-instance-id': 'browser1', authorization: 'Bearer old-credential' } });
    expect((await worker.fetch!(agentRequest, env, {} as ExecutionContext)).status).toBe(101);
    expect((await worker.fetch!(new Request(`https://connect.test/v1/stream/browser1?token=${signed}`, { headers: { upgrade: 'websocket' } }), env, {} as ExecutionContext)).status).toBe(101);
    d1.sqlite.exec(`UPDATE browser_instances SET desired_state = 'deleted' WHERE id = 'browser1'`);
    expect((await worker.fetch!(agentRequest, env, {} as ExecutionContext)).status).toBe(403);
    expect((await worker.fetch!(new Request(`https://connect.test/v1/stream/browser1?token=${signed}`, { headers: { upgrade: 'websocket' } }), env, {} as ExecutionContext)).status).toBe(403);
  });
});
