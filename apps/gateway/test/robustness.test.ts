import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { Internal } from '../src/index.js';
import { resetBlocks } from '../src/mcp/http.js';
import { FakeVm, gatewayFixture } from './fixture.js';
import { Socket } from './harness.js';

let fx: ReturnType<typeof gatewayFixture>;

beforeEach(() => { fx = gatewayFixture(); resetBlocks(); });
afterEach(async () => { await fx.ctx.settle(); fx.d1.sqlite.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const logged = (stage: string) => vi.mocked(console.info).mock.calls.some(([, fields]) => (fields as { stage?: string }).stage === stage);
const raw = (socket: Socket, text: string) => fx.gateway.webSocketMessage(socket as unknown as WebSocket, text);

describe('gateway robustness', () => {
  it('closes only the socket that overran its own queue', async () => {
    const agent = await fx.open('agent');
    const viewer = await fx.open('viewer');
    const frame = JSON.stringify({ t: 'neko', data: { event: 'x', pad: 'p'.repeat(250_000) } });
    const queued: Promise<void>[] = [];
    for (let i = 0; i < 17 && !viewer.socket.closed; i++) queued.push(raw(viewer.socket, frame));
    expect(viewer.socket.closed?.code).toBe(1013);
    await Promise.all(queued);
    expect(agent.socket.closed).toBeNull();
    await fx.frame(agent.socket, { t: 'event', kind: 'heartbeat', data: {} });
    expect(agent.socket.closed).toBeNull();
  });

  it('closes only the sender when processing its frame fails, and keeps the tunnel through api failures', async () => {
    const agent = await fx.open('agent');
    const viewer = await fx.open('viewer');
    const other = await fx.open('viewer', { 'x-cb-session': 'viewer1' });
    vi.spyOn(fx.ctx.storage, 'get').mockRejectedValueOnce(new Error('storage unavailable'));
    await fx.frame(other.socket, { t: 'ime', text: 'x' });
    expect(other.socket.closed?.code).toBe(1011);
    expect(agent.socket.closed).toBeNull();
    expect(viewer.socket.closed?.code).toBe(4000); // replaced by `other` before, not by the failure

    vi.mocked(fx.env.API.agentMessage).mockRejectedValue(new Error('api unavailable'));
    await fx.frame(agent.socket, { t: 'event', kind: 'heartbeat', data: {} });
    expect(fx.env.API.agentMessage).toHaveBeenCalledTimes(3);
    expect(agent.socket.closed).toBeNull();
    expect(logged('agent_message_dropped')).toBe(true);
  });

  it('refuses only the new socket when its admission cannot read the database', async () => {
    const agent = await fx.open('agent');
    const viewer = await fx.open('viewer');
    vi.spyOn(fx.d1, 'prepare').mockImplementation(() => { throw new Error('database unavailable'); });
    const refused = await fx.open('viewer');
    expect(refused.response.status).toBe(403);
    expect(agent.socket.closed).toBeNull();
    expect(viewer.socket.closed).toBeNull();
  });

  it('accepts the agent even when command delivery fails right after', async () => {
    fx.d1.sqlite.exec(`INSERT INTO agent_commands (id, instance_id, kind, payload, status, created_at)
      VALUES ('cmd1', 'browser1', 'prepare_shutdown', '{"archive":{"bucket":"b"}}', 'pending', 0)`);
    vi.mocked(fx.env.API.archiveKey).mockRejectedValue(new Error('api unavailable'));
    const agent = await fx.open('agent');
    expect(agent.response.status).toBe(101);
    expect(agent.socket.sent[0]).toMatchObject({ t: 'welcome' });
    await fx.ctx.settle();
    expect(logged('command_delivery_failed')).toBe(true);
    expect(agent.socket.closed).toBeNull();
  });

  it('drops an oversized agent frame instead of closing the tunnel, telling only the viewer it was for', async () => {
    const agent = await fx.open('agent');
    const viewer = await fx.open('viewer');
    const relayId = (viewer.socket.attachment as { relayId: string }).relayId;
    await raw(agent.socket, JSON.stringify({ t: 'viewer', sessionId: 'viewer1', relayId, data: { event: 'clipboard/updated', text: 'x'.repeat(300_000) } }));
    expect(agent.socket.closed).toBeNull();
    expect(viewer.socket.sent).toContainEqual({ t: 'input_error', reason: 'frame_too_large' });
    await raw(agent.socket, JSON.stringify({ t: 'automation_result', sessionId: 's', data: { t: 'blob', data: 'x'.repeat(300_000) } }));
    await raw(agent.socket, new ArrayBuffer(8) as unknown as string);
    expect(agent.socket.closed).toBeNull();
    expect(logged('agent_frame_dropped')).toBe(true);
  });

  it('relays the agent\'s viewer_file frames under the viewer\'s lease', async () => {
    const agent = await fx.open('agent');
    const viewer = await fx.open('viewer');
    await fx.frame(viewer.socket, { t: 'ime', text: 'warm' });
    const reads = vi.spyOn(fx.d1, 'prepare');
    await fx.frame(agent.socket, { t: 'viewer_file', sessionId: 'viewer1', id: 'f1', status: 'progress', received: 10 });
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'file', id: 'f1', status: 'progress', received: 10 });
    expect(reads).not.toHaveBeenCalled();
  });

  it('lets sleep revoke viewers without aborting an agent connecting at the same time', async () => {
    let entered!: () => void;
    let resume!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    const prepare = fx.d1.prepare.bind(fx.d1);
    vi.spyOn(fx.d1, 'prepare').mockImplementationOnce((sql: string) => {
      const statement = prepare(sql);
      return { bind: (...args: unknown[]) => ({ first: async () => { entered(); await blocked; return statement.bind(...args).first(); } }) } as never;
    });
    const connecting = fx.open('agent');
    await reading;
    await new Internal({} as never, fx.env).revokeViewers('browser1');
    resume();
    expect((await connecting).response.status).toBe(101);
  });

  it('takes the control state from the database after an eviction, never a default', async () => {
    const agent = await fx.open('agent');
    new FakeVm(fx, agent.socket);
    await fx.call('screenshot');
    await fx.frame(agent.socket, { t: 'control_state', control: { controller: 'user', mode: 'user', epoch: 9 }, reason: 'user_input' });
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'user' WHERE id = 'browser1'`);
    fx.evict();
    const viewer = await fx.open('viewer');
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'automation_status', connected: true, control: { controller: 'none', mode: 'user', epoch: 0 } });
    await new Internal({} as never, fx.env).revokeAutomation('browser1');
    await fx.ctx.settle();
    expect(viewer.socket.sent.at(-1)).toEqual({ t: 'automation_status', connected: false, control: { controller: 'none', mode: 'user', epoch: 0 } });
  });

  it('refuses malformed instance ids and secrets before any api call', async () => {
    const upgrade = (path: string, headers: Record<string, string>) =>
      worker.fetch!(new Request(`https://connect.test${path}`, { headers: { upgrade: 'websocket', ...headers } }), fx.env, {} as ExecutionContext);
    expect((await upgrade('/v1/agent', { 'x-instance-id': 'browser 1', authorization: `Bearer ${'a'.repeat(64)}` })).status).toBe(401);
    expect((await upgrade('/v1/agent', { 'x-instance-id': 'browser1', authorization: 'Bearer not-a-credential' })).status).toBe(401);
    expect((await upgrade('/v1/agent', { 'x-instance-id': 'browser1', authorization: `Basic ${'a'.repeat(64)}` })).status).toBe(401);
    expect(fx.env.API.authenticateAgent).not.toHaveBeenCalled();
    fx.env.VIEWER_TOKEN_PUBLIC_KEY = '{"kty":"OKP","crv":"Ed25519","x":"9Qt3463-fc1wkrbVJ3I1AuwwLmyp_27PuwkJJpM3ras"}';
    expect((await upgrade('/v1/stream/browser1?token=garbage', {})).status).toBe(401);
    expect((await upgrade(`/v1/stream/${'x'.repeat(65)}?token=${'a'.repeat(20)}.${'b'.repeat(86)}`, {})).status).toBe(401);
    expect(fx.env.API.redeemViewerToken).not.toHaveBeenCalled();
  });

  it('closes a socket of the retired bridge role on its next frame', async () => {
    const agent = await fx.open('agent');
    const bridge = new Socket();
    fx.ctx.acceptWebSocket(bridge, ['automation']);
    bridge.serializeAttachment({ role: 'automation', sessionId: 'old', clientId: 'c', userId: 'owner1', generation: 1, startedAt: 0, instanceId: 'browser1' });
    await fx.frame(bridge, { t: 'screenshot', id: 'r1' });
    expect(bridge.closed?.code).toBe(4003);
    expect(agent.socket.closed).toBeNull();
  });
});
