import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_LIMITS, FILE_TRANSFER } from '@cloudbrowser/contracts';
import { resetBlocks } from '../src/mcp/http.js';
import { FakeVm, gatewayFixture } from './fixture.js';
import type { Socket } from './harness.js';

let fx: ReturnType<typeof gatewayFixture>;
let agent: Socket;
let vm: FakeVm;

beforeEach(async () => {
  fx = gatewayFixture();
  resetBlocks();
  agent = (await fx.open('agent')).socket;
  vm = new FakeVm(fx, agent);
});
afterEach(async () => { await fx.ctx.settle(); fx.d1.sqlite.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const urlIn = (text: string) => text.match(/https:\/\/connect\.test\/u\/[A-Za-z0-9._-]+/)![0];
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);

describe('files for a coding agent', () => {
  it('stores small inline content at once and attaches it by handle', async () => {
    const stored = await fx.call('upload_file', { name: 'notes.txt', text: 'hello' });
    expect(stored.isError).toBe(false);
    expect(JSON.parse(stored.text.split('\n')[0]!)).toEqual({ handle: 'h1', name: 'notes.txt', size: 5 });
    expect(vm.requests.filter((r) => r.t.startsWith('file_'))).toEqual([
      { t: 'file_begin', id: expect.any(String), action: 'store', files: [{ name: 'notes.txt', type: 'text/plain', size: 5 }] },
      { t: 'file_chunk', id: expect.any(String), file: 0, chunk: 'aGVsbG8=' },
      { t: 'file_end', id: expect.any(String) },
    ]);
    const image = await fx.call('upload_file', { name: 'pixel', base64: 'iVBORw0KGgo=', mimeType: 'image/png' });
    expect(JSON.parse(image.text.split('\n')[0]!)).toMatchObject({ handle: 'h2', size: 8 });

    expect((await fx.call('attach_files', { handles: ['h9'], method: 'paste' })).text).toContain('refused: not_found');
    expect((await fx.call('attach_files', { handles: ['h1', 'h2'], method: 'picker' })).text).toContain('one file per call');
    expect((await fx.call('attach_files', { handles: ['h1'], method: 'drop' })).text).toContain('drop needs x and y');
    expect(vm.requests.filter((r) => r.t === 'attach')).toHaveLength(0);

    const pasted = await fx.call('attach_files', { handles: ['h1', 'h2'], method: 'paste' });
    expect(pasted.isError).toBe(false);
    expect(vm.last('attach')).toMatchObject({ handles: ['h1', 'h2'], method: 'paste' });
    // A drop point is a pixel of the screenshot, like any other coordinate.
    await fx.call('attach_files', { handles: ['h1'], method: 'drop', x: 640, y: 360 });
    expect(vm.last('attach')).toMatchObject({ method: 'drop', x: 960, y: 540, screenshotId: 'shot1' });
    const status = await fx.call('get_status');
    expect(status.text).toContain('stored files: h1 (notes.txt, 5 bytes); h2 (pixel, 8 bytes)');
  });

  it('refuses inline content over 512 KiB, or both kinds, before the VM sees it', async () => {
    const large = Buffer.from(bytes(AUTOMATION_LIMITS.inlineUploadBytes + 1)).toString('base64');
    const refused = await fx.call('upload_file', { name: 'big.bin', base64: large });
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining('limited to 512 KiB') });
    expect((await fx.call('upload_file', { name: 'a', text: 'a', base64: 'YQ==' })).text).toContain('not both');
    expect((await fx.call('upload_file', { name: 'a', base64: '***' })).text).toContain('not valid base64');
    expect((await fx.call('upload_file', { name: 'a', text: 'abc', size: 2 })).text).toContain('size is 2 but the content is 3 bytes');
    expect((await fx.call('upload_file', { name: '../etc/passwd', text: 'x' })).text).toContain('without directories');
    expect(vm.requests.filter((r) => r.t === 'file_begin')).toHaveLength(0);
  });

  it('streams a file sent to its upload URL within the acknowledgement window, once', async () => {
    const data = bytes(FILE_TRANSFER.chunkBytes * 3 + 1000);
    const created = await fx.call('upload_file', { name: 'report.pdf', size: data.length });
    expect(created.isError).toBe(false);
    const url = urlIn(created.text);
    expect(url).toMatch(/^https:\/\/connect\.test\/u\/browser1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(created.text).toContain(`curl -fsS -T './report.pdf' '${url}'`);
    expect(created.text).toContain(`curl.exe -fsS -T ".\\report.pdf" "${url}"`);
    const slot = Object.values((await fx.ctx.storage.get('mcp') as { uploads: Record<string, { secretHash: string }> }).uploads)[0]!;
    expect(slot.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await fx.ctx.storage.get('mcp'))).not.toContain(url.split('.').at(-1));

    expect((await fx.put(url, data)).status).toBe(411);
    const wrong = await fx.put(url, data.subarray(1), { 'content-length': String(data.length - 1) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'length_mismatch' });
    expect((await fx.put(url.replace(/.$/, url.endsWith('A') ? 'B' : 'A'), data, { 'content-length': String(data.length) })).status).toBe(404);

    vm.ackDelayMs = 5;
    const response = await fx.put(url, data, { 'content-length': String(data.length) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handle: 'h1', name: 'report.pdf', size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    expect(vm.requests.filter((r) => r.t === 'file_chunk')).toHaveLength(4);
    expect(vm.maxOutstanding).toBeLessThanOrEqual(FILE_TRANSFER.window);
    expect(vm.maxOutstanding).toBeGreaterThan(1);
    expect(vm.last('file_begin')).toMatchObject({ files: [{ name: 'report.pdf', type: 'application/pdf', size: data.length }] });

    const again = await fx.put(url, data, { 'content-length': String(data.length) });
    expect(again.status).toBe(409);
    expect((await fx.call('attach_files', { handles: ['h1'], method: 'paste' })).isError).toBe(false);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(url.split('.').at(-1));
  });

  it('refuses a lapsed URL with 410 and an unreachable browser without using the URL up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = urlIn((await fx.call('upload_file', { name: 'a.bin', size: 3 })).text);
    vi.setSystemTime(Date.now() + AUTOMATION_LIMITS.uploadSlotMs + 1);
    expect((await fx.put(first, bytes(3), { 'content-length': '3' })).status).toBe(410);

    const second = urlIn((await fx.call('upload_file', { name: 'b.bin', size: 3 })).text);
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'user' WHERE id = 'browser1'`);
    const paused = await fx.put(second, bytes(3), { 'content-length': '3' });
    expect(paused.status).toBe(403);
    expect(await paused.json()).toMatchObject({ error: 'control_user' });
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'agent' WHERE id = 'browser1'`);
    expect((await fx.put(second, bytes(3), { 'content-length': '3' })).status).toBe(200);
  });

  it('answers 502 and cancels the transfer when the VM fails it', async () => {
    const url = urlIn((await fx.call('upload_file', { name: 'a.bin', size: 10 })).text);
    vm.hold.add('file_chunk');
    const uploading = fx.put(url, bytes(10), { 'content-length': '10' });
    await vi.waitFor(() => expect(vm.held).toHaveLength(1));
    await vm.reply({ t: 'file', id: vm.held[0]!.id, status: 'error', reason: 'too_large' });
    const response = await uploading;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'too_large' });
    expect(vm.last('file_cancel')).toEqual({ t: 'file_cancel', id: vm.held[0]!.id });
    expect((await fx.put(url, bytes(10), { 'content-length': '10' })).status).toBe(409);
  });

  it('forgets upload URLs and files when the session ends', async () => {
    const url = urlIn((await fx.call('upload_file', { name: 'a.bin', size: 3 })).text);
    await fx.call('end_session');
    expect((await fx.put(url, bytes(3), { 'content-length': '3' })).status).toBe(404);
    expect((await fx.put('https://connect.test/u/not-a-token', bytes(3), { 'content-length': '3' })).status).toBe(404);
  });
});
