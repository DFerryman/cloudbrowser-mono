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
  vi.spyOn(console, 'info').mockImplementation(() => {});
  d1 = createTestD1();
  d1.sqlite.exec(`
    INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('owner1', 'Owner', 'owner@example.com', 0, 0);
    INSERT INTO browser_instances
      (id, user_id, name, region_id, status, desired_state, idle_timeout_s, locale, screen, fingerprint, created_at, updated_at)
      VALUES ('browser1', 'owner1', 'Browser', 'tyo1', 'running', 'running', 900, 'en-US', 'auto', '{}', 0, 0);
    INSERT INTO agent_credentials (instance_id, generation, created_at) VALUES ('browser1', 1, 0);
    INSERT INTO viewer_sessions (id, instance_id, user_id, started_at, last_seen_at) VALUES ('viewer1', 'browser1', 'owner1', 0, 0);
    INSERT INTO automation_clients (id, instance_id, user_id, name, credential_hash, created_at, activated_at) VALUES ('client1', 'browser1', 'owner1', 'laptop', 'hash', 0, 0);
    INSERT INTO automation_sessions (id, instance_id, client_id, user_id, generation, started_at, last_seen_at) VALUES ('auto1', 'browser1', 'client1', 'owner1', 1, 0, 0);
    INSERT INTO automation_sessions (id, instance_id, client_id, user_id, generation, started_at, last_seen_at) VALUES ('auto2', 'browser1', 'client1', 'owner1', 1, 0, 0);
  `);
  ctx = state();
  env = {
    DB: d1,
    API: {
      authenticateAgent: vi.fn().mockResolvedValue({ ok: true, generation: 1 }),
      agentMessage: vi.fn().mockResolvedValue(null),
      redeemViewerToken: vi.fn().mockResolvedValue(true),
      archiveKey: vi.fn().mockResolvedValue(null),
      authenticateAutomation: vi.fn().mockResolvedValue({ ok: true, sessionId: 'auto1', clientId: 'client1', userId: 'owner1', generation: 1 }),
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

async function open(role: 'agent' | 'viewer' | 'automation', headers: Record<string, string> = {}) {
  const byRole = role === 'agent' ? { 'x-cb-generation': '1' }
    : role === 'viewer' ? { 'x-cb-session': 'viewer1' }
      : { 'x-cb-session': 'auto1', 'x-cb-client': 'client1', 'x-cb-user': 'owner1', 'x-cb-generation': '1' };
  const response = await gateway.fetch(new Request('https://gateway/socket', {
    headers: { upgrade: 'websocket', 'x-cb-instance': 'browser1', 'x-cb-role': role, ...byRole, ...headers },
  }));
  return { response, socket: ctx.getWebSockets(role).at(-1)! };
}

const frame = (socket: Socket, payload: unknown) => gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(payload));
const internal = () => new Internal({} as never, env);

describe('coding-agent bridges', () => {
  it('admits a bridge through the Worker with its credential and opens its relay in the VM', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    const response = await worker.fetch!(new Request('https://connect.test/v1/automation/browser1', {
      headers: { upgrade: 'websocket', authorization: 'Bearer PRIVATE-BRIDGE-CREDENTIAL' },
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(101);
    expect(env.API.authenticateAutomation).toHaveBeenCalledWith({ instanceId: 'browser1', credential: 'PRIVATE-BRIDGE-CREDENTIAL' });
    const bridge = ctx.getWebSockets('automation').at(-1)!;
    expect(bridge.sent[0]).toEqual({ t: 'welcome', sessionId: 'auto1', instanceId: 'browser1', clientId: 'client1', protocol: 1, mode: 'agent' });
    expect(bridge.sent[1]).toEqual({ t: 'agent_online' });
    expect(agent.socket.sent.at(-1)).toEqual({ t: 'automation_open', sessionId: 'auto1', clientId: 'client1' });
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'automation_status', connected: true, control: { controller: 'none', mode: 'agent', epoch: 0 } });
    expect(JSON.stringify((console.info as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('PRIVATE-BRIDGE-CREDENTIAL');

    const refused = await worker.fetch!(new Request('https://connect.test/v1/automation/browser1', { headers: { upgrade: 'websocket' } }), env, {} as ExecutionContext);
    expect(refused.status).toBe(401);
  });

  it('relays requests to the VM and results, screenshots and control changes back', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    const bridge = await open('automation');
    await frame(bridge.socket, { t: 'screenshot', id: 'r1' });
    expect(agent.socket.sent.at(-1)).toEqual({ t: 'automation', sessionId: 'auto1', data: { t: 'screenshot', id: 'r1' } });
    const control = { controller: 'agent', mode: 'agent', epoch: 3 };
    const screen = { version: 1, width: 1280, height: 720 };
    await frame(agent.socket, { t: 'automation_result', sessionId: 'auto1', data: { t: 'blob', id: 'b1', seq: 0, last: true, data: 'AAAA' } });
    await frame(agent.socket, { t: 'automation_result', sessionId: 'auto1', data: {
      t: 'result', id: 'r1', kind: 'screenshot', status: 'executed', control, screen,
      screenshot: { id: 's1', blobId: 'b1', mime: 'image/jpeg', bytes: 3, width: 1280, height: 720, capturedAt: '2026-10-22T00:00:00Z', screenVersion: 1, controlEpoch: 3 },
    } });
    expect(bridge.socket.sent.at(-2)).toEqual({ t: 'blob', id: 'b1', seq: 0, last: true, data: 'AAAA' });
    expect(bridge.socket.sent.at(-1)).toMatchObject({ t: 'result', id: 'r1', screenshot: { blobId: 'b1' } });
    expect(env.API.agentMessage).not.toHaveBeenCalledWith('browser1', 1, expect.objectContaining({ t: 'automation_result' }));

    // An action counts as activity for auto-sleep.
    await frame(bridge.socket, { t: 'act', id: 'r2', steps: [{ type: 'click', x: 10, y: 10 }] });
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'automation', sessionId: 'auto1', data: { t: 'act', id: 'r2' } });
    expect(d1.sqlite.prepare(`SELECT last_input_at FROM instance_health WHERE instance_id = 'browser1'`).get()).toMatchObject({ last_input_at: expect.any(Number) });

    // A takeover reported by the VM reaches viewers and the api.
    await frame(agent.socket, { t: 'control_state', control: { controller: 'user', mode: 'user', epoch: 4 }, reason: 'user_input' });
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'automation_status', connected: true, control: { controller: 'user', mode: 'user', epoch: 4 } });
    expect(env.API.agentMessage).toHaveBeenCalledWith('browser1', 1, { t: 'control_state', control: { controller: 'user', mode: 'user', epoch: 4 }, reason: 'user_input' });
    expect(bridge.socket.closed).toBeNull();
    expect(viewer.socket.closed).toBeNull();
  });

  it('refuses browser-changing requests under user control and screenshots under privacy pause before the VM sees them', async () => {
    const agent = await open('agent');
    const bridge = await open('automation');
    d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'user' WHERE id = 'browser1'`);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1001);
    const before = agent.socket.sent.length;
    await frame(bridge.socket, { t: 'act', id: 'a1', steps: [{ type: 'click', x: 1, y: 1 }] });
    expect(bridge.socket.sent.at(-1)).toEqual({ t: 'refused', id: 'a1', reason: 'control_user' });
    await frame(bridge.socket, { t: 'attach', id: 'a2', handles: ['h1'], method: 'picker' });
    expect(bridge.socket.sent.at(-1)).toEqual({ t: 'refused', id: 'a2', reason: 'control_user' });
    expect(agent.socket.sent).toHaveLength(before);
    await frame(bridge.socket, { t: 'screenshot', id: 's1' });
    expect(agent.socket.sent.at(-1)).toMatchObject({ t: 'automation', data: { t: 'screenshot', id: 's1' } });

    d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'privacy' WHERE id = 'browser1'`);
    vi.setSystemTime(Date.now() + 1001);
    await frame(bridge.socket, { t: 'screenshot', id: 's2' });
    expect(bridge.socket.sent.at(-1)).toEqual({ t: 'refused', id: 's2', reason: 'control_privacy' });
    expect(bridge.socket.closed).toBeNull();
  });

  it('pushes the user\'s control choice to the VM and closes bridges when access is switched off or a client revoked', async () => {
    const agent = await open('agent');
    const viewer = await open('viewer');
    const bridge = await open('automation');
    await internal().automationControl('browser1', 'privacy', true);
    expect(agent.socket.sent.at(-1)).toEqual({ t: 'automation_control', mode: 'privacy', access: true });
    expect(bridge.socket.sent.at(-1)).toMatchObject({ t: 'control', control: { mode: 'privacy', controller: 'user' }, reason: 'privacy' });
    expect(viewer.socket.sent.at(-1)).toMatchObject({ t: 'automation_status', connected: true, control: { mode: 'privacy' } });

    await internal().revokeAutomation('browser1', 'other-client');
    expect(bridge.socket.closed).toBeNull();
    await internal().revokeAutomation('browser1', 'client1');
    expect(bridge.socket.sent.at(-1)).toEqual({ t: 'revoked', reason: 'client_revoked' });
    expect(bridge.socket.closed?.code).toBe(4003);
    expect(agent.socket.sent.at(-1)).toEqual({ t: 'automation_close', sessionId: 'auto1' });
    await ctx.settle();
    expect(env.API.endAutomationSession).toHaveBeenCalledWith('auto1', 'client_revoked');
    expect(viewer.socket.sent.at(-1)).toMatchObject({ t: 'automation_status', connected: false });

    const again = await open('automation', { 'x-cb-session': 'auto2' });
    expect(again.response.status).toBe(101);
    await internal().automationControl('browser1', 'agent', false);
    expect(again.socket.sent.at(-1)).toEqual({ t: 'revoked', reason: 'access_off' });
    expect(agent.socket.sent).toContainEqual({ t: 'automation_control', mode: 'agent', access: false });
    expect(agent.socket.sent.at(-1)).toEqual({ t: 'automation_close', sessionId: 'auto2' });
  });

  it('ends a bridge whose access was switched off or session ended in the database at the lease boundary', async () => {
    const agent = await open('agent');
    const bridge = await open('automation');
    d1.sqlite.exec(`UPDATE browser_instances SET agent_access = 0 WHERE id = 'browser1'`);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1001);
    await frame(bridge.socket, { t: 'status', id: 'st' });
    expect(bridge.socket.closed?.code).toBe(4003);
    expect(bridge.socket.sent.at(-1)).toEqual({ t: 'revoked', reason: 'access_off' });
    expect(agent.socket.closed).toBeNull();

    d1.sqlite.exec(`UPDATE browser_instances SET agent_access = 1 WHERE id = 'browser1'`);
    const refused = await open('automation', { 'x-cb-session': 'ended' });
    expect(refused.response.status).toBe(403);
    d1.sqlite.exec(`UPDATE automation_clients SET revoked_at = 1 WHERE id = 'client1'`);
    const revoked = await open('automation', { 'x-cb-session': 'auto2' });
    expect(revoked.response.status).toBe(403);
  });

  it('keeps one bridge at a time and tells the VM when it goes away', async () => {
    const agent = await open('agent');
    const first = await open('automation');
    const second = await open('automation', { 'x-cb-session': 'auto2' });
    expect(first.socket.closed?.code).toBe(4001);
    expect(second.socket.closed).toBeNull();
    expect(agent.socket.sent.filter((f: any) => f.t === 'automation_close')).toEqual([{ t: 'automation_close', sessionId: 'auto1' }]);
    expect(agent.socket.sent.at(-1)).toEqual({ t: 'automation_open', sessionId: 'auto2', clientId: 'client1' });
    await gateway.webSocketClose(second.socket as unknown as WebSocket, 1000, '', true);
    expect(agent.socket.sent.at(-1)).toEqual({ t: 'automation_close', sessionId: 'auto2' });
    await ctx.settle();
    expect(env.API.endAutomationSession).toHaveBeenCalledWith('auto2', 'closed');
  });

  it('rejects malformed bridge frames and a bridge on a revoked agent generation', async () => {
    await open('agent');
    const bridge = await open('automation');
    await frame(bridge.socket, { t: 'act', id: 'bad', steps: [{ type: 'teleport' }] });
    expect(bridge.socket.closed?.code).toBe(1007);
    d1.sqlite.exec(`UPDATE agent_credentials SET generation = 2 WHERE instance_id = 'browser1'`);
    const stale = await open('automation', { 'x-cb-session': 'auto2' });
    expect(stale.response.status).toBe(403);
    expect(ctx.getWebSockets('automation')).toHaveLength(1);
  });
});
