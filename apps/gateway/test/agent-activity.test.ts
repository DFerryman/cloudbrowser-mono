/**
 * Auto-sleep with a coding agent and nobody watching, end to end: MCP requests through the
 * gateway Worker and the browser's Durable Object, and the engine's once-a-minute idle check on the
 * same D1. The agent's requests count as activity; once it stops making them the browser sleeps on
 * its timeout, even with its session still open and its client still sending keepalives.
 */
import { createDb } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineDeps } from '../../engine/src/context.js';
import { idleStops } from '../../engine/src/scheduler.js';
import { resetBlocks } from '../src/mcp/http.js';
import { FakeVm, gatewayFixture } from './fixture.js';

const MIN = 60_000;
/** The browser's sleep setting: 10 minutes. */
const IDLE_MS = 10 * MIN;
const START = Date.parse('2026-10-24T09:00:00Z');

let fx: ReturnType<typeof gatewayFixture>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  fx = gatewayFixture();
  resetBlocks();
  new FakeVm(fx, (await fx.open('agent')).socket);
  // Running since START with a 10-minute sleep setting, and the page is not open anywhere.
  fx.d1.sqlite.prepare(`UPDATE browser_instances SET idle_timeout_s = ?, last_active_at = ? WHERE id = 'browser1'`).run(IDLE_MS / 1000, START);
  fx.d1.sqlite.prepare(`UPDATE viewer_sessions SET ended_at = ?`).run(START);
});
afterEach(async () => { await fx.ctx.settle(); fx.d1.sqlite.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const at = (ms: number) => vi.setSystemTime(START + ms);
const engine = () => ({ db: createDb(fx.d1), now: () => new Date(), notify: () => {} }) as unknown as EngineDeps;
/** The engine's idle check, as its cron runs it; true when it put the browser to sleep. */
const sleeps = async () => (await idleStops(engine())).includes('browser1');

const CALLS: [string, Record<string, unknown>][] = [
  ['screenshot', {}],
  ['act', { steps: [{ type: 'key', keys: ['Control', 'l'] }], screenshot: false }],
  ['upload_file', { name: 'notes.txt', text: 'hello' }],
  ['get_status', {}],
];

describe('auto-sleep while a coding agent uses the browser and nobody watches', () => {
  it.each(CALLS)('keeps resetting the countdown while the agent calls %s every 2 minutes, and sleeps 10 minutes after the last', async (tool, args) => {
    for (let minute = 0; minute <= 30; minute++) {
      at(minute * MIN);
      if (minute % 2 === 0) expect((await fx.call(tool, args)).isError).toBe(false);
      await fx.ctx.settle();
      expect(await sleeps(), `asleep at minute ${minute}`).toBe(false);
    }
    // The agent stops: the countdown runs from its last request at minute 30.
    at(30 * MIN + IDLE_MS - 1000);
    expect(await sleeps()).toBe(false);
    at(30 * MIN + IDLE_MS);
    expect(await sleeps()).toBe(true);
  });

  it('counts a file sent to an upload URL as the agent\'s request', async () => {
    const slot = await fx.call('upload_file', { name: 'video.mp4', size: 3 });
    const url = slot.text.match(/https:\/\/connect\.test\/u\/[A-Za-z0-9._-]+/)![0];
    at(9 * MIN);
    expect((await fx.put(url, Uint8Array.of(1, 2, 3), { 'content-length': '3' })).status).toBe(200);
    await fx.ctx.settle();
    at(9 * MIN + IDLE_MS - 1000);
    expect(await sleeps()).toBe(false);
    at(9 * MIN + IDLE_MS);
    expect(await sleeps()).toBe(true);
  });

  it('sleeps on time when the agent stops making requests, its session open and its client sending keepalives', async () => {
    expect((await fx.call('screenshot')).isError).toBe(false);
    for (let minute = 1; minute < 10; minute++) {
      at(minute * MIN);
      // What an MCP client sends on its own while its model makes no tool call.
      await fx.post({ jsonrpc: '2.0', id: `init${minute}`, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.0.0' } } });
      await fx.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await fx.post({ jsonrpc: '2.0', id: `ping${minute}`, method: 'ping' });
      await fx.post({ jsonrpc: '2.0', id: `list${minute}`, method: 'tools/list' });
      await fx.ctx.settle();
      expect(await sleeps(), `asleep at minute ${minute}`).toBe(false);
    }
    at(IDLE_MS);
    expect(await fx.ctx.storage.get('mcp'), 'the session is still open').toMatchObject({ sessionId: 'sess1' });
    expect(await sleeps()).toBe(true);
  });
});
