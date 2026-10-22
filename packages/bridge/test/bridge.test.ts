import { mkdtemp, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AllowedFiles } from '../src/files.js';
import { McpServer } from '../src/mcp.js';
import { BridgeClient } from '../src/client.js';
import { createTools } from '../src/tools.js';
import { redeem } from '../src/pair.js';

// --- a fake gateway socket that behaves like ws -----------------------------------------------

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  closed: number | null = null;
  static last: FakeSocket | null = null;
  constructor() {
    super();
    FakeSocket.last = this;
    // The gateway's welcome arrives right after connect.
    queueMicrotask(() => this.emit('open'));
    queueMicrotask(() => this.recv({ t: 'welcome', sessionId: 'auto1', instanceId: 'b1', clientId: 'c1', protocol: 1, mode: 'agent' }));
  }
  send(data: string) { this.sent.push(data); }
  close(code = 1000) { this.closed = code; this.emit('close', code); }
  recv(frame: unknown) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  lastRequest() { return JSON.parse(this.sent.at(-1)!); }
}

function fakeClient() {
  const client = new BridgeClient({ gatewayUrl: 'wss://gw/v1/automation/b1', credential: 'cred', WebSocketImpl: FakeSocket as never });
  return client;
}

afterEach(() => vi.restoreAllMocks());

describe('AllowedFiles', () => {
  it('reads files inside allowed dirs and refuses anything outside, including via a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-'));
    const secret = await mkdtemp(join(tmpdir(), 'secret-'));
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'a.txt'), 'hello');
    await writeFile(join(secret, 'passwords'), 'nope');
    await symlink(join(secret, 'passwords'), join(root, 'link'));
    const allowed = new AllowedFiles([root]);
    const info = await allowed.check(join(root, 'sub', 'a.txt'));
    expect(info).toMatchObject({ name: 'a.txt', size: 5, type: 'text/plain' });
    const chunks: string[] = [];
    for await (const c of allowed.chunks(info.path)) chunks.push(c);
    expect(Buffer.from(chunks.join(''), 'base64').toString()).toBe('hello');
    await expect(allowed.check(join(secret, 'passwords'))).rejects.toThrow(/outside the allowed/);
    await expect(allowed.check(join(root, 'link'))).rejects.toThrow(/outside the allowed/);
    await expect(allowed.check(join(root, 'missing'))).rejects.toThrow(/not found/);
  });
});

describe('McpServer', () => {
  it('handshakes, lists tools and runs a call, reporting tool failures as results', async () => {
    const input = new EventEmitter() as EventEmitter & { [Symbol.asyncIterator]?: unknown };
    const lines: string[] = [];
    const server = new McpServer({ name: 'test', version: '1' }, [{
      name: 'echo', description: 'echo', inputSchema: { type: 'object' },
      async call(args) { if (args.fail) throw new Error('boom'); return { content: [{ type: 'text', text: String(args.say ?? '') }] }; },
    }], { input: input as never, output: { write: (s: string) => lines.push(s.trim()) } });
    const reply = (msg: unknown) => { void server.handle(msg as never); };
    reply({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    reply({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    reply({ jsonrpc: '2.0', method: 'notifications/initialized' }); // no id: no reply
    reply({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { say: 'hi' } } });
    await new Promise((r) => setTimeout(r, 0));
    reply({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { fail: true } } });
    await new Promise((r) => setTimeout(r, 0));
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].result.serverInfo.name).toBe('test');
    expect(parsed[0].result.protocolVersion).toBe('2025-06-18');
    expect(parsed[1].result.tools.map((t: { name: string }) => t.name)).toEqual(['echo']);
    expect(parsed[2]).toMatchObject({ id: 3, result: { content: [{ type: 'text', text: 'hi' }] } });
    expect(parsed[3]).toMatchObject({ id: 4, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
    expect(parsed.find((p) => p.id === undefined)).toBeUndefined();
  });

  it('negotiates an older protocol and rejects unknown methods', async () => {
    const lines: string[] = [];
    const server = new McpServer({ name: 't', version: '1' }, [], { input: new EventEmitter() as never, output: { write: (s: string) => lines.push(s.trim()) } });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } } as never);
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'nope' } as never);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].result.protocolVersion).toBe('2024-11-05');
    expect(parsed[1].error.code).toBe(-32601);
  });
});

describe('BridgeClient and tools', () => {
  it('reassembles a screenshot and exposes it to the screenshot tool', async () => {
    const client = fakeClient();
    await client.connect();
    const allowed = new AllowedFiles([process.cwd()]);
    const tools = createTools(client, allowed);
    const png = Buffer.from('a jpeg').toString('base64');
    const shot = tools.find((t) => t.name === 'screenshot')!;
    const call = shot.call({ quality: 80 });
    await new Promise((r) => setTimeout(r, 0));
    const req = FakeSocket.last!.lastRequest();
    expect(req).toMatchObject({ t: 'screenshot', quality: 80 });
    FakeSocket.last!.recv({ t: 'blob', id: 'shot1', seq: 0, last: false, data: png.slice(0, 4) });
    FakeSocket.last!.recv({ t: 'blob', id: 'shot1', seq: 1, last: true, data: png.slice(4) });
    FakeSocket.last!.recv({ t: 'result', id: req.id, kind: 'screenshot', status: 'executed', control: { controller: 'agent', mode: 'agent', epoch: 1 }, screen: { version: 1, width: 1280, height: 720 }, screenshot: { id: 'shot1', blobId: 'shot1', mime: 'image/jpeg', bytes: 7, width: 1280, height: 720, capturedAt: '2026-10-22T00:00:00Z', screenVersion: 1, controlEpoch: 1 } });
    const result = await call;
    expect(result.isError).toBeFalsy();
    const image = result.content.find((c) => c.type === 'image');
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/jpeg', data: png });
    client.close();
  });

  it('refuses an act whose steps are malformed before sending anything', async () => {
    const client = fakeClient();
    await client.connect();
    const tools = createTools(client, new AllowedFiles([process.cwd()]));
    const before = FakeSocket.last!.sent.length;
    const result = await tools.find((t) => t.name === 'act')!.call({ steps: [{ type: 'teleport' }] });
    expect(result.isError).toBe(true);
    expect(FakeSocket.last!.sent.length).toBe(before);
    client.close();
  });

  it('surfaces a refusal as a tool error and reports control in get_status', async () => {
    const client = fakeClient();
    await client.connect();
    const tools = createTools(client, new AllowedFiles([process.cwd()]));
    const call = tools.find((t) => t.name === 'act')!.call({ steps: [{ type: 'click', x: 1, y: 1 }] });
    await new Promise((r) => setTimeout(r, 0));
    FakeSocket.last!.recv({ t: 'refused', id: FakeSocket.last!.lastRequest().id, reason: 'control_user' });
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('control_user') });

    const statusCall = tools.find((t) => t.name === 'get_status')!.call({});
    await new Promise((r) => setTimeout(r, 0));
    FakeSocket.last!.recv({ t: 'control', control: { controller: 'user', mode: 'user', epoch: 2 }, reason: 'paused' });
    FakeSocket.last!.recv({ t: 'result', id: FakeSocket.last!.lastRequest().id, kind: 'status', status: 'executed', control: { controller: 'user', mode: 'user', epoch: 2 }, screen: { version: 1, width: 1280, height: 720 }, capabilities: { protocol: 1, agentVersion: '0.4.0', screenshot: true, files: true, picker: true, paste: true, drop: true, touch: false } });
    const status = await statusCall;
    expect(status.content[0]).toMatchObject({ text: expect.stringContaining('mode user') });
    client.close();
  });

  it('uploads a file in order and returns its handle, then attaches only a known handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-up-'));
    await writeFile(join(root, 'report.pdf'), 'content');
    const client = fakeClient();
    await client.connect();
    const tools = createTools(client, new AllowedFiles([root]));
    const upload = tools.find((t) => t.name === 'upload_files')!;
    const attach = tools.find((t) => t.name === 'attach_files')!;
    const unknown = await attach.call({ handles: ['h-nope'], method: 'picker' });
    expect(unknown.isError).toBe(true);

    const call = upload.call({ paths: [join(root, 'report.pdf')] });
    await new Promise((r) => setTimeout(r, 5));
    const begin = JSON.parse(FakeSocket.last!.sent[0]!);
    expect(begin).toMatchObject({ t: 'file_begin', action: 'store', files: [{ name: 'report.pdf', type: 'application/pdf' }] });
    const chunks = FakeSocket.last!.sent.filter((s) => JSON.parse(s).t === 'file_chunk');
    expect(Buffer.from(JSON.parse(chunks[0]!).chunk, 'base64').toString()).toBe('content');
    FakeSocket.last!.recv({ t: 'file', id: begin.id, status: 'done', handles: [{ handle: 'a-1', name: 'report.pdf', size: 7, type: 'application/pdf' }] });
    const result = await call;
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('a-1') });

    const attachCall = attach.call({ handles: ['a-1'], method: 'picker', screenshot: false });
    await new Promise((r) => setTimeout(r, 0));
    const req = FakeSocket.last!.lastRequest();
    expect(req).toMatchObject({ t: 'attach', handles: ['a-1'], method: 'picker' });
    FakeSocket.last!.recv({ t: 'result', id: req.id, kind: 'attach', status: 'executed', control: { controller: 'agent', mode: 'agent', epoch: 1 }, screen: { version: 1, width: 1280, height: 720 } });
    expect((await attachCall).isError).toBeFalsy();
    client.close();
  });

  it('stops reconnecting and fails pending requests when the gateway revokes the session', async () => {
    const client = fakeClient();
    await client.connect();
    const tools = createTools(client, new AllowedFiles([process.cwd()]));
    const call = tools.find((t) => t.name === 'screenshot')!.call({});
    await new Promise((r) => setTimeout(r, 0));
    FakeSocket.last!.close(4003);
    const result = await call;
    expect(result.isError).toBe(true);
    // A later request does not reconnect; it fails fast.
    const after = await tools.find((t) => t.name === 'screenshot')!.call({});
    expect(after.isError).toBe(true);
    client.close();
  });
});

describe('redeem', () => {
  it('posts the code and maps the grant; a 401 is a clear message', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://app.test/api/automation/pair');
      expect(JSON.parse(String(init!.body))).toEqual({ code: 'ABC', client: 'laptop' });
      return new Response(JSON.stringify({ clientId: 'c1', instanceId: 'b1', instanceName: 'Box', credential: 'secret', gatewayUrl: 'wss://gw/v1/automation/b1', protocol: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const stored = await redeem('https://app.test/', 'ABC', 'laptop', fetchImpl);
    expect(stored).toMatchObject({ instanceName: 'Box', credential: 'secret', gatewayUrl: 'wss://gw/v1/automation/b1', app: 'https://app.test' });

    const rejecting = vi.fn(async () => new Response(JSON.stringify({ type: 'pairing_invalid' }), { status: 401 })) as unknown as typeof fetch;
    await expect(redeem('https://app.test', 'BAD', 'laptop', rejecting)).rejects.toThrow(/invalid, expired or already used/);
  });
});
