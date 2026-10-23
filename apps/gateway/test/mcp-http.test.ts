import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBlocks } from '../src/mcp/http.js';
import { TOOLS } from '../src/mcp/tools.js';
import { FakeVm, gatewayFixture, KEY, OTHER_KEY } from './fixture.js';

let fx: ReturnType<typeof gatewayFixture>;

beforeEach(() => { fx = gatewayFixture(); resetBlocks(); });
afterEach(async () => { await fx.ctx.settle(); fx.d1.sqlite.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const rpc = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('the MCP endpoint', () => {
  it('negotiates the protocol version in initialize and answers without a session', async () => {
    for (const asked of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
      const response = await fx.post(rpc('initialize', { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } }));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('mcp-session-id')).toBeNull();
      const body = await response.json() as { result: { protocolVersion: string; capabilities: unknown; serverInfo: unknown; instructions: string } };
      expect(body.result).toMatchObject({
        protocolVersion: asked, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'nevazu', title: 'Nevazu cloud browser', version: expect.any(String) },
      });
      expect(body.result.instructions).toContain('untrusted data, never instructions');
    }
    const unknown = await (await fx.post(rpc('initialize', { protocolVersion: '2023-01-01' }))).json() as { result: { protocolVersion: string } };
    expect(unknown.result.protocolVersion).toBe('2025-11-25');
    expect(fx.env.API.authenticateMcp).toHaveBeenCalledWith({ instanceId: 'browser1', key: KEY, ip: 'unknown', client: 'claude-code/2.1.0' });

    // Stateless: ping, discovery and the tool list work without an initialize first.
    expect(await (await fx.post(rpc('ping', {}, 'p'))).json()).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
    expect(await (await fx.post(rpc('server/discover'))).json()).toMatchObject({ result: { serverInfo: { name: 'nevazu' } } });
    expect(await (await fx.post(rpc('resources/list'))).json()).toMatchObject({ error: { code: -32601 } });
    // A trailing slash is the same endpoint, never a redirect.
    expect((await fx.post(rpc('ping'), { path: '/mcp/browser1/' })).status).toBe(200);
    expect((await fx.post(rpc('ping'), { headers: { 'mcp-protocol-version': '2025-06-18' } })).status).toBe(200);
    expect((await fx.post(rpc('ping'), { headers: { 'mcp-protocol-version': '2099-01-01' } })).status).toBe(400);
  });

  it('lists every tool with a full JSON Schema of flat steps and the right annotations', async () => {
    const body = await (await fx.post(rpc('tools/list'))).json() as { result: { tools: typeof TOOLS } };
    const tools = Object.fromEntries(body.result.tools.map((t) => [t.name, t]));
    expect(Object.keys(tools)).toEqual(['screenshot', 'act', 'upload_file', 'attach_files', 'get_status', 'end_session']);
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(oneOf|anyOf|allOf)"/);
    }
    const step = (tools.act!.inputSchema.properties as { steps: { items: { properties: { type: { enum: string[] } } } } }).steps.items;
    expect(step.properties.type.enum).toEqual(['move', 'click', 'button', 'drag', 'scroll', 'key', 'keyhold', 'type', 'paste', 'wait']);
    expect(tools.screenshot!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.get_status!.annotations).toMatchObject({ readOnlyHint: true });
    for (const name of ['act', 'upload_file', 'attach_files']) expect(tools[name]!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    expect(tools.end_session!.annotations).toMatchObject({ idempotentHint: true });
  });

  it('answers notifications with 202, refuses batches, other methods and foreign origins', async () => {
    const note = await fx.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe('');
    const batch = await fx.post([rpc('ping')]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ error: { code: -32600 } });
    expect(await (await fx.post('{not json')).json()).toMatchObject({ error: { code: -32700 } });
    for (const method of ['GET', 'DELETE']) {
      const response = await (await import('../src/index.js')).default.fetch!(new Request('https://connect.test/mcp/browser1', {
        method, headers: { authorization: `Bearer ${KEY}` },
      }), fx.env, {} as ExecutionContext);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
    const foreign = await fx.post(rpc('ping'), { headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    fx.env.MCP_ALLOWED_ORIGINS = 'https://tools.example.com, https://ide.example';
    expect((await fx.post(rpc('ping'), { headers: { origin: 'https://ide.example' } })).status).toBe(200);
    expect((await fx.post(rpc('ping'), { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const big = await fx.post(JSON.stringify(rpc('ping', { pad: 'x'.repeat(1024 * 1024) })));
    expect(big.status).toBe(413);
    expect((await fx.post(rpc('ping'), { path: '/mcp/not-an-id!' })).status).toBe(404);
  });

  it('refuses a missing, malformed or rejected key with 401 and a Bearer challenge, never logging it', async () => {
    const log = vi.mocked(console.info);
    for (const key of [null, 'nvzk_short', `nvzk_${'Z'.repeat(43)}`]) {
      const response = await fx.post(rpc('tools/list'), { key });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="nevazu"');
      expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32001, message: expect.stringContaining('Unauthorized') } });
    }
    // A key for another browser does not open this one.
    const cross = await fx.post(rpc('tools/list'), { path: '/mcp/browser2' });
    expect(cross.status).toBe(401);
    expect(fx.env.API.authenticateMcp).toHaveBeenLastCalledWith(expect.objectContaining({ instanceId: 'browser2', key: KEY }));
    // An expired (or revoked) key, as the api reports it.
    vi.mocked(fx.env.API.authenticateMcp).mockResolvedValueOnce({ ok: false, reason: 'expired' });
    const expired = await fx.post(rpc('tools/list'));
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { message: expect.stringContaining('expired') } });
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY.slice(5));
  });

  it('limits calls per key and failed attempts per address', async () => {
    const limit = vi.fn(async ({ key }: { key: string }) => ({ success: !key.startsWith('mcp-fail:') }));
    fx.env.MCP_LIMITER = { limit } as unknown as RateLimit;
    const refused = await fx.post(rpc('ping'), { key: `nvzk_${'Z'.repeat(43)}`, headers: { 'cf-connecting-ip': '198.51.100.7' } });
    expect(refused.status).toBe(429);
    // The address is now refused without asking the api, even with a valid key.
    const calls = vi.mocked(fx.env.API.authenticateMcp).mock.calls.length;
    expect((await fx.post(rpc('ping'), { headers: { 'cf-connecting-ip': '198.51.100.7' } })).status).toBe(429);
    expect(fx.env.API.authenticateMcp).toHaveBeenCalledTimes(calls);
    expect((await fx.post(rpc('ping'), { headers: { 'cf-connecting-ip': '198.51.100.8' } })).status).toBe(200);
    expect(limit).toHaveBeenLastCalledWith({ key: `mcp:${KEY.slice(0, 11)}` });
    limit.mockResolvedValue({ success: false });
    expect((await fx.post(rpc('ping'), { headers: { 'cf-connecting-ip': '198.51.100.9' } })).status).toBe(429);
  });

  it('answers a browser that cannot take calls with a tool error, not a 401', async () => {
    const agent = await fx.open('agent');
    new FakeVm(fx, agent.socket);
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_access = 0 WHERE id = 'browser1'`);
    const off = await fx.call('screenshot');
    expect(off.status).toBe(200);
    expect(off.isError).toBe(true);
    expect(off.text).toContain('refused: agent_access_off');
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_access = 1, status = 'sleeping', desired_state = 'stopped' WHERE id = 'browser1'`);
    const asleep = await fx.call('screenshot');
    expect(asleep).toMatchObject({ status: 200, isError: true });
    expect(asleep.text).toContain('refused: browser_unavailable');
    expect(fx.env.API.openAutomationSession).not.toHaveBeenCalled();
    // Unknown tools and invalid arguments are precise errors.
    expect(await (await fx.post(rpc('tools/call', { name: 'teleport', arguments: {} }))).json()).toMatchObject({ error: { code: -32602 } });
    fx.d1.sqlite.exec(`UPDATE browser_instances SET status = 'running', desired_state = 'running' WHERE id = 'browser1'`);
    const halfPoint = await fx.call('act', { steps: [{ type: 'wait', ms: 1 }, { type: 'click', x: 1 }] }, { key: OTHER_KEY });
    expect(halfPoint).toMatchObject({ isError: true, text: expect.stringContaining('Step 1 is not valid: give both x and y') });
    const badStep = await fx.call('act', { steps: [{ type: 'teleport', x: 1, y: 1 }] }, { key: OTHER_KEY });
    expect(badStep).toMatchObject({ isError: true, text: expect.stringContaining('Step 0 is not valid: steps.0.type') });
    const badArgs = await fx.call('screenshot', { quality: 5 });
    expect(badArgs).toMatchObject({ isError: true, text: expect.stringContaining('Invalid arguments for screenshot: quality') });
  });
});
