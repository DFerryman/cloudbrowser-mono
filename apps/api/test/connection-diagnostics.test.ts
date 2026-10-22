import { createDb } from '@cloudbrowser/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentMessage } from '../src/internal.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let instanceId: string;
let sessionId: string;
const report = {
  attemptId: 'b7580036-cd1e-4d81-96dc-7d0bd550a6e4',
  relayId: '98937d61-f25e-46bb-a72e-b4c0042206ef',
  stage: 'failed', elapsedMs: 20_000, code: 'connection_timeout',
};
const endpoint = () => `/api/v1/sessions/${sessionId}/diagnostics`;
const logs = () => vi.spyOn(console, 'info').mockImplementation(() => {});

beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec("INSERT INTO invites(email) VALUES('diagnostic@example.com'),('other-diagnostic@example.com')");
  await signIn(t, 'diagnostic@example.com');
  const prices = await t.call('GET', '/api/v1/pricing');
  const priceVersion = prices.body.find((p: { regionId: string }) => p.regionId === 'tyo1').version;
  const created = await t.call('POST', '/api/v1/instances',
    { name: 'Diagnostic', regionId: 'tyo1', storageGb: 10, priceVersion }, { 'idempotency-key': 'diagnostic' });
  expect(created.status).toBe(202);
  await t.settle();
  instanceId = created.body.instanceId;
  const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
  expect(opened.status).toBe(201);
  sessionId = opened.body.session.id;
});
afterEach(() => vi.restoreAllMocks());

describe('connection evidence', () => {
  it('logs an owned attempt without renewing activity, billing or an ended session', async () => {
    const log = logs();
    expect((await t.call('POST', `/api/v1/sessions/${sessionId}/end`)).status).toBe(204);
    const activity = t.d1.sqlite.prepare('SELECT last_input_at,last_heartbeat_at,metered_at FROM instance_health WHERE instance_id=?').get(instanceId);
    const session = t.d1.sqlite.prepare('SELECT * FROM viewer_sessions WHERE id=?').get(sessionId);
    const before = t.d1.sqlite.prepare('SELECT total_changes() AS n').get();
    expect((await t.call('POST', endpoint(), report)).status).toBe(204);
    expect(t.d1.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(t.d1.sqlite.prepare('SELECT last_input_at,last_heartbeat_at,metered_at FROM instance_health WHERE instance_id=?').get(instanceId)).toEqual(activity);
    expect(t.d1.sqlite.prepare('SELECT * FROM viewer_sessions WHERE id=?').get(sessionId)).toEqual(session);
    expect(log).toHaveBeenCalledWith('viewer connection', expect.objectContaining({
      source: 'viewer', instanceId, sessionId, ...report,
    }));
  });

  it('rejects content-bearing fields, arbitrary reasons and invalid correlation identifiers before logging', async () => {
    const log = logs();
    for (const body of [
      { ...report, token: 'secret-viewer-token', sdp: 'private-offer', text: 'typed-secret' },
      { ...report, code: 'failed at ws://127.0.0.1/api/ws?token=secret' },
      { ...report, attemptId: 'token=secret' },
      { ...report, elapsedMs: -1 },
    ]) expect((await t.call('POST', endpoint(), body)).status).toBe(400);
    expect(log).not.toHaveBeenCalled();
  });

  it('does not accept a report from a different owner', async () => {
    const log = logs();
    await signIn(t, 'other-diagnostic@example.com');
    expect((await t.call('POST', endpoint(), report)).status).toBe(404);
    expect(log).not.toHaveBeenCalled();
  });

  it('limits diagnostic writes separately from session/lifecycle writes', async () => {
    logs();
    for (let i = 0; i < 60; i++) expect((await t.call('POST', endpoint(), report)).status).toBe(204);
    expect((await t.call('POST', endpoint(), report)).status).toBe(429);
    expect((await t.call('POST', `/api/v1/sessions/${sessionId}/heartbeat`, { input: false })).status).toBe(200);
  });
});

describe('desktop readiness', () => {
  it.each(['ready', 'heartbeat'] as const)('fences a %s that becomes obsolete between its identity read and health write', async (kind) => {
    const log = logs();
    const now = Date.now();
    t.d1.sqlite.prepare('UPDATE instance_health SET agent_ready_generation=1,agent_ready_at=?,last_heartbeat_at=? WHERE instance_id=?').run(now, now, instanceId);
    const prepare = t.d1.prepare.bind(t.d1);
    let rotated = false;
    vi.spyOn(t.d1, 'prepare').mockImplementation((query) => {
      if (!rotated && /^insert into "instance_health"/i.test(query)) {
        rotated = true;
        t.d1.sqlite.prepare('UPDATE agent_credentials SET generation=2 WHERE instance_id=?').run(instanceId);
        t.d1.sqlite.prepare('UPDATE instance_health SET agent_ready_generation=2,agent_ready_at=? WHERE instance_id=?').run(now + 1000, instanceId);
      }
      return prepare(query);
    });
    await agentMessage(t.env as never, createDb(t.d1), instanceId, 1,
      { t: 'event', kind, data: { viewers: 0, desktopReady: false, desktopChecked: true, chromeMajor: 156 } }, new Date(now + 2000));
    expect(rotated).toBe(true);
    expect(t.d1.sqlite.prepare('SELECT agent_ready_generation,agent_ready_at FROM instance_health WHERE instance_id=?').get(instanceId))
      .toEqual({ agent_ready_generation: 2, agent_ready_at: now + 1000 });
    expect(log).not.toHaveBeenCalled();
  });

  it('clears false readiness immediately, restores it after a successful probe, and rejects old generations', async () => {
    logs();
    const now = new Date();
    const db = createDb(t.d1);
    const send = (generation: number, data: Record<string, unknown>, seconds: number) =>
      agentMessage(t.env as never, db, instanceId, generation, { t: 'event', kind: 'heartbeat', data }, new Date(now.getTime() + seconds * 1000));
    const health = () => t.d1.sqlite.prepare('SELECT agent_ready_generation,agent_ready_at FROM instance_health WHERE instance_id=?').get(instanceId);
    await agentMessage(t.env as never, db, instanceId, 1,
      { t: 'event', kind: 'ready', data: { chromeMajor: 156, desktopChecked: true } }, now);
    await send(1, { viewers: 0, desktopReady: false, desktopFailureCode: 'desktop_timeout' }, 1);
    expect(health()).toEqual({ agent_ready_generation: null, agent_ready_at: null });
    await send(1, { viewers: 0, desktopReady: true }, 2);
    expect(health()).toEqual({ agent_ready_generation: 1, agent_ready_at: now.getTime() + 2000 });
    await send(0, { viewers: 0, desktopReady: false }, 3);
    expect(health()).toEqual({ agent_ready_generation: 1, agent_ready_at: now.getTime() + 2000 });
    await send(1, { viewers: 0 }, 4); // Existing agents do not invalidate readiness.
    expect(health()).toEqual({ agent_ready_generation: 1, agent_ready_at: now.getTime() + 2000 });
  });
});
