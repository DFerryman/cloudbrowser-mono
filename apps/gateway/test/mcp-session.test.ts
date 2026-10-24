import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Internal } from '../src/index.js';
import { resetBlocks } from '../src/mcp/http.js';
import { AUTOMATION_LIMITS } from '@cloudbrowser/contracts';
import { VmLink } from '../src/mcp/vm-link.js';
import { FakeVm, gatewayFixture, OTHER_KEY, VIEW_KEY } from './fixture.js';
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

const internal = () => new Internal({} as never, fx.env);
const later = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms); };

describe('a coding agent\'s session in the Durable Object', () => {
  it('opens lazily on the first call and returns the screenshot reassembled from its blobs', async () => {
    const viewer = await fx.open('viewer');
    expect(viewer.socket.sent.at(-1)).toMatchObject({ t: 'automation_status', connected: false });
    expect(fx.env.API.openAutomationSession).not.toHaveBeenCalled();

    const shot = await fx.call('screenshot');
    expect(fx.env.API.openAutomationSession).toHaveBeenCalledWith('browser1', 'client1');
    expect(agent.sent).toContainEqual({ t: 'automation_open', sessionId: 'sess1', clientId: 'client1' });
    expect(vm.last('screenshot')).toMatchObject({ maxWidth: 1280, maxHeight: 800 });
    expect(shot.isError).toBe(false);
    expect(shot.image).toEqual({ type: 'image', data: 'SU1H1QUdF', mimeType: 'image/jpeg' });
    expect(shot.content[0]!.type).toBe('image');
    expect(shot.text).toContain('screenshot shot1: 1280x720 (scaled from the 1920x1080 screen)');
    expect(shot.text).toContain('status: executed');
    await fx.ctx.settle();
    expect(viewer.socket.sent).toContainEqual({ t: 'automation_status', connected: true, control: { controller: 'none', mode: 'agent', epoch: 0 } });

    await fx.call('screenshot', { size: 'native', quality: 50 });
    expect(vm.last('screenshot')).toEqual({ t: 'screenshot', id: expect.any(String), quality: 50 });
    expect(fx.env.API.openAutomationSession).toHaveBeenCalledTimes(1);
    expect(vm.opened).toEqual(['sess1']);
    expect(fx.d1.sqlite.prepare(`SELECT last_input_at FROM instance_health WHERE instance_id = 'browser1'`).get()).toBeUndefined();
  });

  it('maps image pixels to screen pixels, drag paths included, and sends the screenshot\'s basis', async () => {
    await fx.call('screenshot');
    const acted = await fx.call('act', { steps: [
      { type: 'click', x: 640, y: 360 },
      { type: 'drag', path: [{ x: 0, y: 0 }, { x: 1279, y: 719 }, { x: 2000, y: 2000 }] },
      { type: 'type', text: 'hello' },
    ] });
    expect(vm.last('act')).toMatchObject({
      screenshotId: 'shot1', screenVersion: 1, controlEpoch: 3, maxWidth: 1280, maxHeight: 800,
      steps: [
        { type: 'click', x: 960, y: 540, button: 'left', count: 1 },
        { type: 'drag', path: [{ x: 0, y: 0 }, { x: 1919, y: 1079 }, { x: 1919, y: 1079 }] },
        { type: 'type', text: 'hello' },
      ],
    });
    expect(acted.text).toContain('screenshot shot2');
    // The act's own screenshot is the basis of the next one.
    await fx.call('act', { steps: [{ type: 'move', x: 2, y: 2 }] });
    expect(vm.last('act')).toMatchObject({ screenshotId: 'shot2', steps: [{ type: 'move', x: 3, y: 3 }] });
    // An action is activity for auto-sleep.
    await fx.ctx.settle();
    expect(fx.d1.sqlite.prepare(`SELECT last_input_at FROM instance_health WHERE instance_id = 'browser1'`).get()).toMatchObject({ last_input_at: expect.any(Number) });
  });

  it('refuses coordinates without a known screenshot before the VM sees them', async () => {
    const first = await fx.call('act', { steps: [{ type: 'click', x: 5, y: 5 }] });
    expect(first).toMatchObject({ isError: true, text: expect.stringContaining('refused: stale_screenshot') });
    await fx.call('screenshot');
    const unknown = await fx.call('act', { steps: [{ type: 'click', x: 5, y: 5 }], screenshotId: 'shot-from-yesterday' });
    expect(unknown.text).toContain('refused: stale_screenshot');
    expect(vm.requests.filter((r) => r.t === 'act')).toHaveLength(0);
    // Keys alone need no screenshot.
    const keys = await fx.call('act', { steps: [{ type: 'key', keys: ['Control', 'l'] }], screenshot: false });
    expect(keys.isError).toBe(false);
    expect(vm.last('act')).not.toHaveProperty('screenVersion');
  });

  it('works with a protocol 1 VM: native screenshots, and desktop_unavailable asked again while it opens', async () => {
    vm.protocol = 1;
    vm.hold.add('screenshot');
    const pending = fx.call('screenshot');
    await vi.waitFor(() => expect(vm.held).toHaveLength(1));
    const first = vm.held[0]!;
    await vm.reply(vm.result(first.id, 'screenshot', { status: 'rejected', reason: 'desktop_unavailable' }));
    await vi.waitFor(() => expect(vm.held).toHaveLength(2), { timeout: 3000 });
    const retry = vm.held[1]!;
    expect(retry.id).not.toBe(first.id);
    await vm.shot(vm.sessionId!, retry.id, 'screenshot', retry as never);
    const shot = await pending;
    expect(shot.text).toContain('screenshot shot1: 1920x1080; coordinates');
    vm.hold.clear();
    await fx.call('act', { steps: [{ type: 'click', x: 100, y: 200 }] });
    expect(vm.last('act')).toMatchObject({ steps: [{ x: 100, y: 200 }] });
  });

  it('runs one call at a time, while get_status answers beside a running act', async () => {
    await fx.call('screenshot');
    vm.hold.add('act');
    const acting = fx.call('act', { steps: [{ type: 'click', x: 1, y: 1 }] });
    await vi.waitFor(() => expect(vm.held).toHaveLength(1));
    const queued = fx.call('screenshot');
    const status = await fx.call('get_status');
    expect(status.text).toContain('an act is running now');
    expect(status.text).toContain('session sess1');
    expect(vm.requests.filter((r) => r.t === 'screenshot')).toHaveLength(1);
    await vm.shot(vm.sessionId!, vm.held[0]!.id, 'act', vm.held[0] as never);
    expect((await acting).text).toContain('screenshot shot2');
    expect((await queued).text).toContain('screenshot shot3');
  });

  it('refuses by control mode and key capability before the VM sees anything', async () => {
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'user' WHERE id = 'browser1'`);
    expect((await fx.call('act', { steps: [{ type: 'wait', ms: 1 }] })).text).toContain('refused: control_user');
    expect((await fx.call('upload_file', { name: 'a.txt', text: 'a' })).text).toContain('refused: control_user');
    expect((await fx.call('attach_files', { handles: ['h1'], method: 'paste' })).text).toContain('refused: control_user');
    expect((await fx.call('screenshot')).isError).toBe(false);
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'privacy' WHERE id = 'browser1'`);
    expect((await fx.call('screenshot')).text).toContain('refused: control_privacy');
    expect(vm.requests.map((r) => r.t)).toEqual(['screenshot']);

    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'agent' WHERE id = 'browser1'`);
    await fx.call('end_session');
    expect((await fx.call('act', { steps: [{ type: 'wait', ms: 1 }] }, { key: VIEW_KEY })).text).toContain('refused: view_only');
    expect((await fx.call('upload_file', { name: 'a.txt', text: 'a' }, { key: VIEW_KEY })).text).toContain('refused: view_only');
    expect((await fx.call('attach_files', { handles: ['h1'], method: 'paste' }, { key: VIEW_KEY })).text).toContain('refused: view_only');
    const looked = await fx.call('screenshot', {}, { key: VIEW_KEY });
    expect(looked.isError).toBe(false);
    expect(fx.env.API.openAutomationSession).toHaveBeenLastCalledWith('browser1', 'client3');
  });

  it('keeps another key out for a minute after the session\'s last use, then hands it over', async () => {
    await fx.post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.0' } } });
    await fx.ctx.settle();
    await fx.call('screenshot');
    const busy = await fx.call('screenshot', {}, { key: OTHER_KEY });
    expect(busy).toMatchObject({ isError: true, text: expect.stringContaining('refused: busy_other_agent') });
    expect(busy.text).toContain('"laptop" (claude-code/2.1.0)');
    expect(vm.closed).toEqual([]);

    later(61_000);
    const took = await fx.call('screenshot', {}, { key: OTHER_KEY });
    expect(took.isError).toBe(false);
    expect(fx.env.API.endAutomationSession).toHaveBeenCalledWith('sess1', 'replaced');
    expect(vm.closed).toEqual(['sess1']);
    expect(vm.opened).toEqual(['sess1', 'sess2']);
    const status = await fx.call('get_status');
    expect(status.text).toContain('another key ("desktop"');
  });

  it('closes an idle session from the alarm; the next call opens a new one and says files are gone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const opened = Date.now();
    await fx.call('upload_file', { name: 'notes.txt', text: 'hello' });
    // With no viewer, the session's own deadline arms the alarm.
    expect(await fx.ctx.storage.getAlarm()).toBe(opened + AUTOMATION_LIMITS.idleSessionMs);
    vi.setSystemTime(opened + 10 * 60_000);
    await fx.gateway.alarm();
    expect(vm.closed).toEqual([]);
    expect(await fx.ctx.storage.getAlarm()).toBe(opened + AUTOMATION_LIMITS.idleSessionMs);
    // A viewer's re-check comes first; the session's deadline is not lost behind it.
    const viewer = await fx.open('viewer');
    expect(await fx.ctx.storage.getAlarm()).toBe(Date.now() + 10_000);

    vi.setSystemTime(opened + AUTOMATION_LIMITS.idleSessionMs + 1);
    await fx.gateway.alarm();
    await fx.ctx.settle();
    expect(vm.closed).toEqual(['sess1']);
    expect(fx.env.API.endAutomationSession).toHaveBeenCalledWith('sess1', 'idle');
    expect(await fx.ctx.storage.get('mcp')).toBeUndefined();
    expect(viewer.socket.sent.at(-1)).toMatchObject({ t: 'automation_status', connected: false });

    const next = await fx.call('screenshot');
    expect(vm.opened).toEqual(['sess1', 'sess2']);
    expect(next.text).toContain('the previous one ended (idle). File handles from it are gone');
  });

  it('closes a session at its hard limit, even one in use', async () => {
    await fx.call('screenshot');
    const rec = await fx.ctx.storage.get('mcp') as { startedAt: number };
    await fx.ctx.storage.put('mcp', { ...rec, startedAt: Date.now() - AUTOMATION_LIMITS.maxSessionMs - 1 });
    fx.evict();
    await fx.gateway.alarm();
    expect(fx.env.API.endAutomationSession).toHaveBeenCalledWith('sess1', 'session_expired');
    expect(vm.closed).toEqual(['sess1']);
  });

  it('survives an eviction: the same session and screenshots, no new session', async () => {
    await fx.call('screenshot');
    fx.evict();
    await fx.call('act', { steps: [{ type: 'click', x: 640, y: 360 }], screenshotId: 'shot1' });
    expect(vm.last('act')).toMatchObject({ screenshotId: 'shot1', steps: [{ x: 960, y: 540 }] });
    expect(fx.env.API.openAutomationSession).toHaveBeenCalledTimes(1);
    expect(agent.sent.filter((f) => (f as { t: string }).t === 'automation').every((f) => (f as { sessionId: string }).sessionId === 'sess1')).toBe(true);
  });

  it('fails what is in flight when the tunnel goes, and reopens the same session on the new one', async () => {
    await fx.call('screenshot');
    vm.hold.add('act');
    const acting = fx.call('act', { steps: [{ type: 'wait', ms: 10 }] });
    await vi.waitFor(() => expect(vm.held).toHaveLength(1));
    const reconnect = await fx.open('agent');
    expect(agent.closed?.code).toBe(4000);
    const failed = await acting;
    expect(failed).toMatchObject({ isError: true, text: expect.stringContaining('refused: relay_unavailable') });
    await fx.ctx.settle();
    expect(reconnect.socket.sent).toContainEqual({ t: 'automation_open', sessionId: 'sess1', clientId: 'client1' });

    const next = new FakeVm(fx, reconnect.socket);
    next.sessionId = 'sess1';
    expect((await fx.call('screenshot')).isError).toBe(false);
    expect(fx.env.API.openAutomationSession).toHaveBeenCalledTimes(1);

    next.hold.add('screenshot');
    const waiting = fx.call('screenshot');
    await vi.waitFor(() => expect(next.held).toHaveLength(1));
    await fx.gateway.webSocketClose(reconnect.socket as unknown as WebSocket, 1006, '', false);
    expect((await waiting).text).toContain('refused: relay_unavailable');
  });

  it('maps notifications/cancelled to the running act and lets its interrupted result through', async () => {
    vm.hold.add('act');
    const acting = fx.call('act', { steps: [{ type: 'wait', ms: 5000 }, { type: 'key', keys: ['Enter'] }] }, { id: 7 });
    await vi.waitFor(() => expect(vm.held).toHaveLength(1));
    const act = vm.held[0]!;
    const note = await fx.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 8 } });
    expect(note.status).toBe(202);
    await fx.ctx.settle();
    expect(vm.last('cancel')).toBeUndefined();
    await fx.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'user' } });
    await fx.ctx.settle();
    await vi.waitFor(() => expect(vm.last('cancel')).toMatchObject({ t: 'cancel', actionId: act.id }));
    await vm.reply(vm.result(act.id, 'act', { status: 'interrupted', reason: 'canceled', stoppedAt: 1 }));
    const result = await acting;
    expect(result.isError).toBe(false);
    expect(result.text).toContain('status: interrupted (canceled)');
    expect(result.text).toContain('stopped before step 1');
  });

  it('ends on request, idempotently, and on revocation, access off or deletion', async () => {
    await fx.call('screenshot');
    expect((await fx.call('end_session')).text).toContain('Session ended');
    expect(fx.env.API.endAutomationSession).toHaveBeenCalledWith('sess1', 'ended');
    expect((await fx.call('end_session')).text).toContain('nothing to end');

    await fx.call('screenshot');
    await internal().revokeAutomation('browser1', 'client2');
    expect(vm.closed).toEqual(['sess1']);
    await internal().revokeAutomation('browser1', 'client1');
    expect(vm.closed).toEqual(['sess1', 'sess2']);
    expect(fx.env.API.endAutomationSession).toHaveBeenCalledWith('sess2', 'client_revoked');

    await fx.call('screenshot');
    await internal().automationControl('browser1', 'agent', false);
    expect(vm.closed.at(-1)).toBe('sess3');
    expect(fx.env.API.endAutomationSession).toHaveBeenCalledWith('sess3', 'access_off');

    await fx.call('screenshot');
    await internal().revokeViewers('browser1');
    expect(fx.env.API.endAutomationSession).toHaveBeenCalledWith('sess4', 'browser_stopped');
    await fx.call('screenshot');
    await internal().revokeInstance('browser1');
    expect(fx.env.API.endAutomationSession).toHaveBeenCalledWith('sess5', 'browser_deleted');
  });

  it('get_status waits for the user to hand control back', async () => {
    await fx.call('screenshot');
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'user' WHERE id = 'browser1'`);
    const started = Date.now();
    const waiting = fx.call('get_status', { waitForControlMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'agent' WHERE id = 'browser1'`);
    await internal().automationControl('browser1', 'agent', true);
    const status = await waiting;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(status.text).toContain('mode agent');
    expect(status.text).toContain('capabilities: protocol 2');
    expect(status.text).toContain('screen: 1920x1080 (version 1)');
    const quick = await fx.call('get_status', { waitForControlMs: 0 });
    expect(quick.text).toContain('browser agent: online');
  });
});

describe('an agent asking for control while the user holds it', () => {
  const statuses = (viewer: Socket) => viewer.sent.filter((f): f is { t: 'automation_status'; request?: { remainingMs: number } } =>
    (f as { t?: string }).t === 'automation_status');

  it('tells viewers when an action is refused for the user\'s control, and stops once control is handed back', async () => {
    const viewer = (await fx.open('viewer')).socket;
    expect(statuses(viewer).at(-1)!.request).toBeUndefined();
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'user' WHERE id = 'browser1'`);

    const refused = await fx.call('act', { steps: [{ type: 'wait', ms: 1 }] });
    expect(refused.text).toContain('refused: control_user');
    expect(refused.text).toContain('the live view shows them that you are asking for it');
    await fx.ctx.settle();
    const asked = statuses(viewer).at(-1)!;
    expect(asked).toMatchObject({ connected: false, control: { mode: 'user' }, request: { remainingMs: expect.any(Number) } });
    expect(asked.request!.remainingMs).toBeGreaterThan(25_000);
    expect(asked.request!.remainingMs).toBeLessThanOrEqual(30_000);

    // Asked again at once: nothing new to tell.
    const before = statuses(viewer).length;
    await fx.call('upload_file', { name: 'a.txt', text: 'a' });
    await fx.ctx.settle();
    expect(statuses(viewer)).toHaveLength(before);

    // A viewer that connects now is told too.
    const second = (await fx.open('viewer')).socket;
    expect(statuses(second).at(-1)!.request).toMatchObject({ remainingMs: expect.any(Number) });

    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'agent' WHERE id = 'browser1'`);
    await internal().automationControl('browser1', 'agent', true);
    expect(statuses(second).at(-1)).toMatchObject({ control: { mode: 'agent' } });
    expect(statuses(second).at(-1)!.request).toBeUndefined();

    // A later takeover starts without the old ask.
    await fx.frame(agent, { t: 'control_state', control: { controller: 'user', mode: 'user', epoch: 5 }, reason: 'user_input' });
    expect(statuses(second).at(-1)!.request).toBeUndefined();
  });

  it('counts a get_status wait, for as long as it waits and a while after, but not a quick look or a view-only key', async () => {
    const viewer = (await fx.open('viewer')).socket;
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'user' WHERE id = 'browser1'`);
    await fx.call('get_status');
    await fx.call('get_status', { waitForControlMs: 50 }, { key: VIEW_KEY });
    await fx.call('screenshot');
    await fx.ctx.settle();
    expect(statuses(viewer).every((s) => !s.request)).toBe(true);

    const waiting = fx.call('get_status', { waitForControlMs: 20_000 });
    await vi.waitFor(() => expect(statuses(viewer).at(-1)!.request).toBeDefined());
    expect(statuses(viewer).at(-1)!.request!.remainingMs).toBeGreaterThan(45_000);
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'agent' WHERE id = 'browser1'`);
    await fx.frame(agent, { t: 'control_state', control: { controller: 'none', mode: 'agent', epoch: 6 }, reason: 'resumed' });
    expect((await waiting).text).toContain('mode agent');
    expect(statuses(viewer).at(-1)!.request).toBeUndefined();
  });

  it('counts a screenshot refused by a privacy pause, and forgets the ask when access is turned off', async () => {
    const viewer = (await fx.open('viewer')).socket;
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'privacy' WHERE id = 'browser1'`);
    expect((await fx.call('screenshot')).text).toContain('refused: control_privacy');
    await fx.ctx.settle();
    expect(statuses(viewer).at(-1)).toMatchObject({ control: { mode: 'privacy' }, request: { remainingMs: expect.any(Number) } });
    await internal().automationControl('browser1', 'privacy', false);
    await fx.ctx.settle();
    expect(statuses(viewer).at(-1)!.request).toBeUndefined();
  });

  it('ends a key\'s ask when that key is revoked, even without a session', async () => {
    const viewer = (await fx.open('viewer')).socket;
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'user' WHERE id = 'browser1'`);
    await fx.call('act', { steps: [{ type: 'wait', ms: 1 }] }, { key: OTHER_KEY });
    await fx.ctx.settle();
    expect(fx.env.API.openAutomationSession).not.toHaveBeenCalled();
    expect(statuses(viewer).at(-1)!.request).toBeDefined();
    await internal().revokeAutomation('browser1', 'client1');
    await fx.ctx.settle();
    expect(statuses(viewer).at(-1)!.request).toBeDefined();
    await internal().revokeAutomation('browser1', 'client2');
    await fx.ctx.settle();
    expect(statuses(viewer).at(-1)!.request).toBeUndefined();
  });

  it('lets the ask lapse when the agent stops asking', async () => {
    const viewer = (await fx.open('viewer')).socket;
    fx.d1.sqlite.exec(`UPDATE browser_instances SET agent_control = 'user' WHERE id = 'browser1'`);
    await fx.call('act', { steps: [{ type: 'wait', ms: 1 }] });
    await fx.ctx.settle();
    expect(statuses(viewer).at(-1)!.request).toBeDefined();
    later(31_000);
    const next = (await fx.open('viewer')).socket;
    expect(statuses(next).at(-1)!.request).toBeUndefined();
  });
});

describe('VmLink', () => {
  it('keeps two requests\' screenshot blobs apart by blob id, whatever order they arrive in', async () => {
    const sent: unknown[] = [];
    const link = new VmLink('s', (data) => { sent.push(data); return true; });
    const a = link.request({ t: 'screenshot', id: 'a' }, 10_000);
    const b = link.request({ t: 'screenshot', id: 'b' }, 10_000);
    const meta = (blobId: string) => ({ id: blobId, blobId, mime: 'image/jpeg', bytes: 1, width: 10, height: 10, capturedAt: '', screenVersion: 1, controlEpoch: 1 });
    const result = (id: string, blobId: string) => ({ t: 'result' as const, id, kind: 'screenshot' as const, status: 'executed' as const, control: { controller: 'none' as const, mode: 'agent' as const, epoch: 0 }, screen: { version: 1, width: 10, height: 10 }, screenshot: meta(blobId) });
    link.onFrame({ t: 'blob', id: 'B', seq: 0, last: false, data: 'b0' });
    link.onFrame({ t: 'blob', id: 'A', seq: 1, last: true, data: 'a1' });
    link.onFrame({ t: 'blob', id: 'A', seq: 0, last: false, data: 'a0' });
    link.onFrame({ t: 'blob', id: 'B', seq: 1, last: true, data: 'b1' });
    link.onFrame(result('b', 'B'));
    link.onFrame(result('a', 'A'));
    expect((await a).image).toBe('a0a1');
    expect((await b).image).toBe('b0b1');
    // An incomplete image is reported as missing, never as part of another.
    const c = link.request({ t: 'screenshot', id: 'c' }, 10_000);
    link.onFrame({ t: 'blob', id: 'C', seq: 1, last: true, data: 'c1' });
    link.onFrame(result('c', 'C'));
    expect((await c).image).toBeUndefined();
    // Orphans are dropped after a minute; an oversized backlog drops the oldest first.
    link.onFrame({ t: 'blob', id: 'D', seq: 0, last: true, data: 'd' }, 0);
    link.sweep(61_000);
    const d = link.request({ t: 'screenshot', id: 'd' }, 10_000);
    link.onFrame(result('d', 'D'));
    expect((await d).image).toBeUndefined();
  });
});
