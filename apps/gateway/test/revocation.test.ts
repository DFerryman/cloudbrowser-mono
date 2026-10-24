import { signViewerToken } from '@cloudbrowser/contracts';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { Internal } from '../src/index.js';
import { InstanceGateway } from '../src/instance-gateway.js';
import type { Env } from '../src/env.js';
import { Socket, UpgradeResponse, state } from './harness.js';

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
      authenticateMcp: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid_token' }),
      openAutomationSession: vi.fn().mockResolvedValue({ sessionId: 'mcp1' }),
      endAutomationSession: vi.fn().mockResolvedValue(undefined),
    },
    INSTANCE_GATEWAY: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: (req: Request | string, init?: RequestInit) => gateway.fetch(req instanceof Request ? req : new Request(req, init)) }),
    } as unknown as DurableObjectNamespace,
  };
  gateway = new InstanceGateway(ctx as unknown as DurableObjectState, env);
});

afterEach(() => { d1.sqlite.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function open(role: 'agent' | 'viewer', headers: Record<string, string> = {}) {
  const response = await gateway.fetch(new Request('https://gateway/socket', {
    headers: { upgrade: 'websocket', 'x-cb-instance': 'browser1', 'x-cb-role': role,
      ...(role === 'agent' ? { 'x-cb-generation': '1' } : { 'x-cb-session': 'viewer1' }), ...headers },
  }));
  return { response, socket: ctx.getWebSockets(role).at(-1)! };
}

/** Inside the last half of the one-second lease, where a frame triggers a background re-check. */
const INPUT_RENEW_AT = 600;
const ATTEMPT_ID = '5eac2d85-529c-4eec-8398-dd2d25bda1f3';

const frame = (socket: Socket, payload: unknown) => gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(payload));

function expireAuthorizationLease() {
  // A lost RPC is caught at the existing one-second authorization boundary. This applies to
  // signaling as well as input; explicit stop/delete RPCs above still revoke synchronously.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 1001);
}

describe('gateway revocation', () => {
  it('advertises viewer-stage capability in both credential and reconnect welcomes', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const reconnect = await open('agent');
    expect(reconnect.socket.sent[0]).toEqual({ t: 'welcome', viewerStages: true, automation: { mode: 'agent', access: true } });
    const bootstrap = await open('agent', { 'x-cb-credential': 'PRIVATE-ISSUED-CREDENTIAL' });
    expect(bootstrap.socket.sent[0]).toEqual({ t: 'welcome', credential: 'PRIVATE-ISSUED-CREDENTIAL', viewerStages: true, automation: { mode: 'agent', access: true } });
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE-ISSUED-CREDENTIAL');
  });

  it('keeps close and error relay cleanup independent of storage needed only for diagnostics', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const agent = await open('agent');
    const viewer = await open('viewer');
    const relayId = (viewer.socket.attachment as { relayId: string }).relayId;
    const lookup = vi.spyOn(ctx.storage, 'get').mockRejectedValue(new Error('storage unavailable'));
    await gateway.webSocketClose(viewer.socket as unknown as WebSocket, 1000, '', true);
    expect(agent.socket.sent.at(-1)).toEqual({ t: 'viewer_close', sessionId: 'viewer1', relayId });
    await gateway.webSocketError(agent.socket as unknown as WebSocket);
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'agent_offline' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('correlates admission and agent stages across a hibernation with the current viewer attempt', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const agent = await open('agent');
    const viewer = await open('viewer', { 'x-cb-attempt': ATTEMPT_ID });
    const relayId = (viewer.socket.attachment as { relayId: string }).relayId;
    expect(viewer.socket.sent[0]).toEqual({ t: 'connection_stage', stage: 'gateway_accepted', relayId });
    expect(viewer.socket.attachment).toMatchObject({ instanceId: 'browser1', generation: 1, sessionId: 'viewer1', attemptId: ATTEMPT_ID });
    expect(log).toHaveBeenCalledWith('connection stage', expect.objectContaining({
      stage: 'viewer_open_sent', instanceId: 'browser1', generation: 1, sessionId: 'viewer1', relayId, attemptId: ATTEMPT_ID,
    }));
    gateway = new InstanceGateway(ctx as unknown as DurableObjectState, env);
    await frame(agent.socket, { t: 'viewer_stage', sessionId: 'viewer1', relayId, stage: 'websocket_start', elapsedMs: 24 });
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'connection_stage', stage: 'websocket_start', relayId });
    expect(log).toHaveBeenCalledWith('connection stage', expect.objectContaining({
      stage: 'agent_websocket_start', instanceId: 'browser1', generation: 1, sessionId: 'viewer1', relayId, attemptId: ATTEMPT_ID, elapsedMs: 24,
    }));
    expect(env.API.agentMessage).not.toHaveBeenCalledWith('browser1', 1, expect.objectContaining({ t: 'viewer_stage' }));
  });

  it('drops stale or unscoped stage acknowledgments rather than advancing a replacement relay', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const agent = await open('agent');
    const previous = await open('viewer');
    const previousRelay = (previous.socket.attachment as { relayId: string }).relayId;
    const current = await open('viewer', { 'x-cb-attempt': ATTEMPT_ID });
    const relayId = (current.socket.attachment as { relayId: string }).relayId;
    const before = current.socket.sent.length;
    await frame(agent.socket, { t: 'viewer_stage', sessionId: 'viewer1', relayId: previousRelay, stage: 'desktop_ready' });
    await frame(agent.socket, { t: 'viewer_stage', sessionId: 'viewer1', stage: 'desktop_ready' });
    expect(current.socket.sent).toHaveLength(before);
    expect(log).not.toHaveBeenCalledWith('connection stage', expect.objectContaining({ stage: 'agent_desktop_ready', relayId }));
    await frame(agent.socket, { t: 'viewer_stage', sessionId: 'viewer1', relayId, stage: 'failed', code: 'websocket_timeout' });
    expect(current.socket.sent.at(-1)).toEqual({ t: 'connection_stage', stage: 'failed', relayId, code: 'websocket_timeout' });
    expect(current.socket.closed).toBeNull();
  });

  it('rejects stage acknowledgments from a revoked agent generation before forwarding them', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const agent = await open('agent');
    const viewer = await open('viewer');
    const relayId = (viewer.socket.attachment as { relayId: string }).relayId;
    d1.sqlite.exec(`UPDATE agent_credentials SET generation = 2 WHERE instance_id = 'browser1'`);
    expireAuthorizationLease();
    const before = viewer.socket.sent.length;
    await frame(agent.socket, { t: 'viewer_stage', sessionId: 'viewer1', relayId, stage: 'desktop_ready' });
    expect(viewer.socket.sent).toHaveLength(before);
    expect(agent.socket.closed?.code).toBe(4003);
    expect(log).not.toHaveBeenCalledWith('connection stage', expect.objectContaining({ stage: 'agent_desktop_ready' }));
  });

  it('retains the original failure cause when a late agent stage belongs to a timed-out relay', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const agent = await open('agent');
    const previous = await open('viewer');
    const oldRelay = (previous.socket.attachment as { relayId: string }).relayId;
    const current = await open('viewer', { 'x-cb-attempt': ATTEMPT_ID });
    const before = current.socket.sent.length;
    await frame(agent.socket, {
      t: 'viewer_stage', sessionId: 'viewer1', relayId: oldRelay,
      stage: 'failed', code: 'desktop_timeout', elapsedMs: 31_000,
    });
    expect(current.socket.sent).toHaveLength(before);
    expect(log).toHaveBeenCalledWith('connection stage', expect.objectContaining({
      stage: 'agent_failed', role: 'agent', instanceId: 'browser1', generation: 1,
      sessionId: 'viewer1', relayId: oldRelay, code: 'desktop_timeout', elapsedMs: 31_000,
      ignored: true, discardReason: 'stale_relay',
    }));
  });

  it('logs only fixed signaling names and sanitized identifiers, never SDP, input or close reasons', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const agent = await open('agent');
    const viewer = await open('viewer', { 'x-cb-attempt': 'private-invalid-attempt' });
    const relayId = (viewer.socket.attachment as { relayId: string }).relayId;
    const privateValue = 'PRIVATE-URL-TOKEN-SDP-INPUT';
    await frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', relayId, data: { event: 'system/init', payload: { sdp: privateValue } } });
    await frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', relayId, data: { event: 'system/init', payload: { token: privateValue } } });
    await frame(viewer.socket, { t: 'neko', data: { event: 'signal/answer', payload: { sdp: privateValue } } });
    await frame(viewer.socket, { t: 'neko', data: { event: 'signal/' + privateValue } });
    await frame(viewer.socket, { t: 'ime', text: privateValue });
    await gateway.webSocketClose(viewer.socket as unknown as WebSocket, 1006, 'https://private.example/?token=' + privateValue, false);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(privateValue);
    expect(logged).not.toContain('private-invalid-attempt');
    expect(logged).not.toContain('private.example');
    expect(log.mock.calls.filter(([, fields]) => fields.stage === 'signaling' && fields.event === 'system/init')).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('connection stage', expect.objectContaining({ stage: 'viewer_socket_closed', closeCode: 1006, wasClean: false }));
  });

  it('validates public attempt IDs, ignores spoofed correlation headers and never logs credentials', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
    env.VIEWER_TOKEN_PUBLIC_KEY = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey));
    const signed = await signViewerToken(privateKey, { iid: 'browser1', uid: 'owner1', sid: 'viewer1', jti: 'private-token-id', exp: Math.floor(Date.now() / 1000) + 60 });
    const response = await worker.fetch!(new Request(`https://connect.test/v1/stream/browser1?token=${signed}&attemptId=${ATTEMPT_ID}&private=PRIVATE-QUERY`, {
      headers: { upgrade: 'websocket', 'x-cb-attempt': 'f6fcba3c-0af0-490f-b226-5df8b82ffbe8' },
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(101);
    expect(ctx.getWebSockets('viewer').at(-1)!.attachment).toMatchObject({ attemptId: ATTEMPT_ID });
    await worker.fetch!(new Request('https://connect.test/v1/stream/browser1?token=PRIVATE-TOKEN&attemptId=PRIVATE-INVALID-ATTEMPT', {
      headers: { upgrade: 'websocket' },
    }), env, {} as ExecutionContext);
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of [signed, 'private-token-id', 'PRIVATE-QUERY', 'PRIVATE-TOKEN', 'PRIVATE-INVALID-ATTEMPT']) expect(logged).not.toContain(secret);
    expect(log).toHaveBeenCalledWith('connection stage', expect.objectContaining({ stage: 'viewer_upgrade_rejected', code: 'invalid_token', status: 401 }));
  });

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
    // Delivery runs beside the agent's frames, not in their queue.
    await ctx.settle();
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'command', id: 'cmd1' });
    expect(d1.sqlite.prepare(`SELECT status FROM agent_commands WHERE id = 'cmd1'`).get()).toEqual({ status: 'delivered' });
  });

  it('forwards a complete ordered handshake and input burst without repeated remote authorization reads', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    const prepare = d1.prepare.bind(d1);
    const reads = vi.spyOn(d1, 'prepare');
    // An established authorization lease must work even while D1 has cross-region latency.
    // A single attempted extra read is blocked until all frames have had a chance to queue.
    let release!: () => void;
    const remote = new Promise<void>(resolve => { release = resolve; });
    reads.mockImplementation(sql => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
        get(target, key) {
          if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          if (key === 'first' || key === 'all' || key === 'raw' || key === 'run') return async (...args: unknown[]) => {
            await remote;
            return (target[key] as (...args: unknown[]) => Promise<unknown>).apply(target, args);
          };
          return Reflect.get(target, key);
        },
      });
      return wrap(prepare(sql));
    });
    const burst = [
      frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', data: { event: 'system/init' } }),
      frame(viewer.socket, { t: 'neko', data: { event: 'signal/request' } }),
      frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', data: { event: 'signal/provide' } }),
      frame(viewer.socket, { t: 'neko', data: { event: 'signal/answer' } }),
      frame(viewer.socket, { t: 'neko', data: { event: 'control/keydown', payload: { keysym: 97 } } }),
      frame(viewer.socket, { t: 'neko', data: { event: 'control/keyup', payload: { keysym: 97 } } }),
    ];
    // Bounded turns instead of a timing assertion: a DB read would keep this burst blocked.
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    const readCount = reads.mock.calls.length;
    release();
    await Promise.all(burst);
    expect({ blockedQueries: readCount, totalQueries: reads.mock.calls.length }).toEqual({ blockedQueries: 0, totalQueries: 0 });
    expect(viewer.socket.sent.filter((f: any) => f.t === 'neko').map((f: any) => f.data.event))
      .toEqual(['system/init', 'signal/provide']);
    expect(agent.socket.sent.filter((f: any) => f.t === 'viewer').map((f: any) => f.data.data.event))
      .toEqual(['signal/request', 'signal/answer', 'control/keydown', 'control/keyup']);
  });

  it('renews a lease about to lapse in the background, without holding up the relay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const agent = await open('agent');
    const viewer = await open('viewer');
    vi.setSystemTime(start + INPUT_RENEW_AT);
    const prepare = d1.prepare.bind(d1);
    let release!: () => void;
    const remote = new Promise<void>(resolve => { release = resolve; });
    const reads = vi.spyOn(d1, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      const wrap = (target: D1PreparedStatement): D1PreparedStatement => new Proxy(target, {
        get(t, key) {
          if (key === 'bind') return (...values: unknown[]) => wrap(t.bind(...values));
          if (key === 'first' || key === 'all' || key === 'raw' || key === 'run') return async (...args: unknown[]) => {
            await remote;
            return (t[key] as (...args: unknown[]) => Promise<unknown>).apply(t, args);
          };
          return Reflect.get(t, key);
        },
      });
      return wrap(statement);
    });
    // The lease is still valid: the frame goes through at once while the re-check waits on D1.
    await frame(viewer.socket, { t: 'neko', data: { event: 'signal/answer' } });
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'viewer', data: { t: 'neko', data: { event: 'signal/answer' } } });
    expect(reads).toHaveBeenCalled();
    release();
    for (let turn = 0; turn < 50; turn++) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    // Past the original lease (start + 1000), the renewed one (until start + 1600) still covers the relay with no new read.
    vi.setSystemTime(start + 1050);
    const before = reads.mock.calls.length;
    await frame(viewer.socket, { t: 'neko', data: { event: 'signal/candidate' } });
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'viewer', data: { t: 'neko', data: { event: 'signal/candidate' } } });
    expect(reads.mock.calls.length).toBe(before);
    expect(viewer.socket.closed).toBeNull();
  });

  it('keeps an active viewer\'s lease renewed between taps, so a tap after a pause waits for no D1 read', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const agent = await open('agent');
    const viewer = await open('viewer');
    await frame(viewer.socket, { t: 'neko', data: { event: 'control/buttondown', payload: { code: 1 } } });
    await frame(viewer.socket, { t: 'neko', data: { event: 'control/buttonup', payload: { code: 1 } } });
    // A touch screen sends nothing between taps; a mouse would have kept the lease renewed by moving.
    await vi.advanceTimersByTimeAsync(5_000);
    const reads = vi.spyOn(d1, 'prepare');
    const batches = vi.spyOn(d1, 'batch');
    await frame(viewer.socket, { t: 'neko', data: { event: 'control/buttondown', payload: { code: 1 } } });
    expect(reads).not.toHaveBeenCalled();
    expect(batches).not.toHaveBeenCalled();
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'viewer', data: { t: 'neko', data: { event: 'control/buttondown' } } });
    // Renewed ahead of time only while the viewer is in use: an idle one is left to the alarm.
    await vi.advanceTimersByTimeAsync(40_000);
    reads.mockClear();
    batches.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).not.toHaveBeenCalled();
    expect(batches).not.toHaveBeenCalled();
    expect(viewer.socket.closed).toBeNull();
  });

  it('answers a keepalive that reaches the object instead of refusing it as input', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    await gateway.webSocketMessage(viewer.socket as unknown as WebSocket, '{"t":"ping"}');
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'pong' });
    expect(viewer.socket.closed).toBeNull();
    expect(agent.socket.sent.some((f: any) => f.t === 'viewer')).toBe(false);
  });

  it('closes the viewer when a background renewal finds the session ended', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const agent = await open('agent');
    const viewer = await open('viewer');
    d1.sqlite.exec(`UPDATE viewer_sessions SET ended_at = 1 WHERE id = 'viewer1'`);
    vi.setSystemTime(start + INPUT_RENEW_AT);
    await frame(viewer.socket, { t: 'neko', data: { event: 'control/move', payload: { x: 1, y: 1 } } });
    for (let turn = 0; turn < 50; turn++) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(viewer.socket.closed?.code).toBe(4003);
    expect(agent.socket.closed).toBeNull();
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'viewer_close', sessionId: 'viewer1' });
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
    expireAuthorizationLease();
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

  it('replaces the same session without a false takeover or closing the new relay', async () => {
    const agent = await open('agent');
    const previous = await open('viewer');
    const current = await open('viewer');
    const relayId = (current.socket.attachment as { relayId: string }).relayId;
    expect(previous.socket.sent).not.toContainEqual({ t: 'taken_over' });
    expect(previous.socket.closed).toEqual({ code: 4000, reason: 'reconnected' });
    const before = agent.socket.sent.length;
    await gateway.webSocketClose(previous.socket as unknown as WebSocket);
    expect(agent.socket.sent).toHaveLength(before);
    await frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', relayId, data: { event: 'system/init' } });
    expect(current.socket.closed).toBeNull();
    expect(current.socket.sent.at(-1)).toEqual({ t: 'neko', data: { event: 'system/init' } });
  });

  it('still immediately takes over a genuinely different session', async () => {
    await open('agent');
    const previous = await open('viewer');
    d1.sqlite.exec(`INSERT INTO viewer_sessions (id,instance_id,user_id,started_at,last_seen_at)
      VALUES ('viewer2','browser1','owner1',0,0)`);
    const current = await open('viewer', { 'x-cb-session': 'viewer2' });
    expect(current.response.status).toBe(101);
    expect(previous.socket.sent.at(-1)).toEqual({ t: 'taken_over' });
    expect(previous.socket.closed).toEqual({ code: 4001, reason: 'taken over' });
    expect(current.socket.closed).toBeNull();
  });

  it('caps a paid authorization by its remaining funded time after a slow DB response', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    d1.sqlite.exec(`
      UPDATE control_flags SET value='true' WHERE key='billing_required';
      INSERT INTO provider_prices (region_id,executor,provider_region,sheet,fetched_at)
        VALUES ('tyo1','fake','ap-northeast-1','{"source":"simulated","instanceType":"fake.large","vmHour":0.1,"instanceTypes":{"fake.large":0.1},"volumeGbMonth":0.08,"snapshotGbMonth":0.05,"ipHour":0.005,"transferOutGb":0.09,"rootVolumeGb":16,"effectiveDate":null}',0);
      INSERT INTO billing_accounts (user_id,balance_micros,updated_at) VALUES ('owner1',2000000,0);
      INSERT INTO browser_reservations (instance_id,user_id,required_micros,reserved_micros,fixed_hour_micros,rates,updated_at)
        VALUES ('browser1','owner1',1000000,1000000,1000,'{"compute":120000,"ip":6000,"storage":96000,"snapshot":60000,"transfer":108000}',0);
      UPDATE billing_accounts SET balance_micros=1000050 WHERE user_id='owner1';
    `);
    d1.sqlite.prepare(`UPDATE browser_instances SET last_active_at=?`).run(Date.now());
    const agent = await open('agent');
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, 'batch').mockImplementationOnce(async statements => {
      const result = await batch(statements);
      vi.setSystemTime(Date.now() + 700);
      return result;
    });
    const viewer = await open('viewer');
    expect(viewer.response.status).toBe(101);
    const deadline = await ctx.storage.get('alarm') as number;
    expect(deadline - Date.now()).toBeGreaterThan(0);
    expect(deadline - Date.now()).toBeLessThan(1000);
    vi.setSystemTime(deadline);
    await gateway.alarm();
    expect(viewer.socket.closed?.code).toBe(4003);
    expect(agent.socket.closed).toBeNull();
  });

  it('shares one fresh session authorization between an expired alarm and queued signaling', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    expireAuthorizationLease();
    const batch = d1.batch.bind(d1);
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const remote = new Promise<void>(resolve => { release = resolve; });
    const reads = vi.spyOn(d1, 'batch').mockImplementationOnce(async statements => {
      entered();
      await remote;
      return batch(statements);
    });
    const alarm = gateway.alarm();
    await reading;
    const signal = frame(viewer.socket, { t: 'neko', data: { event: 'signal/request' } });
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    release();
    await Promise.all([alarm, signal]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'viewer', data: { t: 'neko', data: { event: 'signal/request' } } });
    expect(viewer.socket.closed).toBeNull();
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
    expireAuthorizationLease();
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
    expireAuthorizationLease();
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
    expireAuthorizationLease();
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
    expireAuthorizationLease();
    vi.spyOn(d1, 'prepare').mockImplementation(() => { throw new Error('database unavailable'); });
    await frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', data: 'secret' });
    expect(agent.socket.closed).not.toBeNull();
    expect(viewer.socket.closed).not.toBeNull();
    expect((await open('agent')).response.status).toBe(403);
  });

  it('rides out a single transient database error without closing a healthy connection', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    expireAuthorizationLease();
    const prepare = d1.prepare.bind(d1);
    vi.spyOn(d1, 'prepare').mockImplementationOnce(() => { throw new Error('D1_ERROR: Network connection lost'); }).mockImplementation(prepare);
    await frame(agent.socket, { t: 'viewer', sessionId: 'viewer1', data: { event: 'system/heartbeat' } });
    expect(agent.socket.closed).toBeNull();
    expect(viewer.socket.closed).toBeNull();
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'neko', data: { event: 'system/heartbeat' } });
  });

  it('re-checks an idle viewer every ten seconds rather than every second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    await open('agent');
    const viewer = await open('viewer');
    expect(viewer.response.status).toBe(101);
    expect(await ctx.storage.get('alarm')).toBe(Date.now() + 10_000);
    vi.setSystemTime(Date.now() + 10_000);
    await gateway.alarm();
    expect(viewer.socket.closed).toBeNull();
    expect(await ctx.storage.get('alarm')).toBe(Date.now() + 10_000);
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
    const agentRequest = new Request('https://connect.test/v1/agent', { headers: { upgrade: 'websocket', 'x-instance-id': 'browser1', authorization: `Bearer ${'c'.repeat(64)}` } });
    expect((await worker.fetch!(agentRequest, env, {} as ExecutionContext)).status).toBe(101);
    expect((await worker.fetch!(new Request(`https://connect.test/v1/stream/browser1?token=${signed}`, { headers: { upgrade: 'websocket' } }), env, {} as ExecutionContext)).status).toBe(101);
    d1.sqlite.exec(`UPDATE browser_instances SET desired_state = 'deleted' WHERE id = 'browser1'`);
    expect((await worker.fetch!(agentRequest, env, {} as ExecutionContext)).status).toBe(403);
    expect((await worker.fetch!(new Request(`https://connect.test/v1/stream/browser1?token=${signed}`, { headers: { upgrade: 'websocket' } }), env, {} as ExecutionContext)).status).toBe(403);
  });
});
