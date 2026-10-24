import type { LiveQualityReport } from '@cloudbrowser/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.js';
import { ORIGIN, setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let instanceId: string;
let sessionId: string;
let writeDataPoint: ReturnType<typeof vi.fn>;
const report: LiveQualityReport = {
  attemptId: 'b7580036-cd1e-4d81-96dc-7d0bd550a6e4',
  durationMs: 60_000, readings: 30, rttMs: 290, gatewayRttMs: 41, fps: 24.5, kbps: 2400, loss: 0.0099,
  freezes: 3, freezeMs: 300, jitterBufferMs: 50, decodeMs: 5, framesDropped: 15,
  quality: 'high', width: 1920, height: 1080, localCandidateType: 'relay', relayProtocol: 'udp',
};
const endpoint = () => `/api/v1/sessions/${sessionId}/quality`;

/** A request as it arrives through Cloudflare, which describes the visitor's edge in `cf`. */
async function fromEdge(body: unknown, cf: Record<string, unknown>) {
  const url = new URL(endpoint(), ORIGIN);
  const req = new Request(url, {
    method: 'POST', body: JSON.stringify(body),
    headers: { origin: url.origin, cookie: t.cookie(), 'content-type': 'application/json' },
  });
  Object.defineProperty(req, 'cf', { value: cf });
  return (await app.fetch(req, t.env as never, t.ctx)).status;
}

beforeEach(async () => {
  t = setup();
  writeDataPoint = vi.fn();
  Object.assign(t.env, { LIVE_QUALITY: { writeDataPoint } });
  t.d1.sqlite.exec("INSERT INTO invites(email) VALUES('quality@example.com'),('other-quality@example.com')");
  await signIn(t, 'quality@example.com');
  const prices = await t.call('GET', '/api/v1/pricing');
  const priceVersion = prices.body.find((p: { regionId: string }) => p.regionId === 'tyo1').version;
  const created = await t.call('POST', '/api/v1/instances',
    { name: 'Quality', regionId: 'tyo1', storageGb: 10, priceVersion }, { 'idempotency-key': 'quality' });
  expect(created.status).toBe(202);
  await t.settle();
  instanceId = created.body.instanceId;
  const opened = await t.call('POST', `/api/v1/instances/${instanceId}/sessions`);
  sessionId = opened.body.session.id;
});

describe('live quality reports', () => {
  it('writes one data point by browser region and viewer edge, without touching the database', async () => {
    const activity = t.d1.sqlite.prepare('SELECT last_input_at,last_heartbeat_at,metered_at FROM instance_health WHERE instance_id=?').get(instanceId);
    const before = t.d1.sqlite.prepare('SELECT total_changes() AS n').get();
    expect(await fromEdge(report, { country: 'TH', colo: 'BKK', asn: 23969 })).toBe(204);
    expect(t.d1.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(t.d1.sqlite.prepare('SELECT last_input_at,last_heartbeat_at,metered_at FROM instance_health WHERE instance_id=?').get(instanceId)).toEqual(activity);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['tyo1'],
      blobs: ['tyo1', 'TH', 'BKK', '23969', 'high', 'relay', 'udp', instanceId, sessionId, report.attemptId, ''],
      doubles: [60_000, 30, 290, 41, 24.5, 2400, 0.0099, 3, 300, 50, 5, 15, 1920, 1080, -1, -1, -1, -1, -1, -1, -1],
    });
  });

  it('records what the browser did not report as -1, and an unknown edge as empty', async () => {
    const { localCandidateType: _type, relayProtocol: _protocol, ...rest } = report;
    const sparse = { ...rest, rttMs: null, gatewayRttMs: null, fps: null, kbps: null, loss: null, freezes: 0,
      freezeMs: null, jitterBufferMs: null, decodeMs: null, framesDropped: null, quality: null, width: null, height: null };
    expect((await t.call('POST', endpoint(), sparse)).status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['tyo1'],
      blobs: ['tyo1', '', '', '', '', '', '', instanceId, sessionId, report.attemptId, ''],
      doubles: [60_000, 30, -1, -1, -1, -1, -1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
    });
  });

  it('appends repairs, level changes and the reporting build after the original fields', async () => {
    const repaired = { ...report, nacks: 600, retransmits: 575, plis: 3, keyframes: 4, levelChanges: 2, jitterBufferTargetMs: 20, jitterBufferMinimumMs: 8 };
    expect((await t.call('POST', endpoint(), repaired, { 'x-client-build': '4070ce5a1b2c' })).status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['tyo1'],
      blobs: ['tyo1', '', '', '', 'high', 'relay', 'udp', instanceId, sessionId, report.attemptId, '4070ce5a1b2c'],
      doubles: [60_000, 30, 290, 41, 24.5, 2400, 0.0099, 3, 300, 50, 5, 15, 1920, 1080, 600, 575, 3, 4, 2, 20, 8],
    });
    // Unknown counts are -1, as for the original fields.
    expect((await t.call('POST', endpoint(), { ...repaired, nacks: null, plis: null })).status).toBe(204);
    expect(writeDataPoint.mock.calls.at(-1)![0].doubles.slice(14)).toEqual([-1, 575, -1, 4, 2, 20, 8]);
  });

  it('rejects unknown fields and out-of-range values before writing', async () => {
    for (const body of [
      { ...report, address: '203.0.113.7' },
      { ...report, sdp: 'private-offer' },
      { ...report, attemptId: 'token=secret' },
      { ...report, durationMs: 999 },
      { ...report, readings: 0 },
      { ...report, rttMs: -1 },
      { ...report, loss: 1.5 },
      { ...report, freezes: 0.5 },
      { ...report, quality: 'ultra' },
      { ...report, localCandidateType: '203.0.113.7' },
      { ...report, nacks: -1 },
      { ...report, levelChanges: 0.5 },
      { ...report, jitterBufferTargetMs: -5 },
      { ...report, jitterBufferMinimumMs: -5 },
    ]) expect((await t.call('POST', endpoint(), body)).status).toBe(400);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('does not accept a report from a different owner', async () => {
    await signIn(t, 'other-quality@example.com');
    expect((await t.call('POST', endpoint(), report)).status).toBe(404);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('accepts reports where the dataset is not bound', async () => {
    Object.assign(t.env, { LIVE_QUALITY: undefined });
    expect((await t.call('POST', endpoint(), report)).status).toBe(204);
  });

  it('shares the diagnostic write budget, not the session one', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const diagnostic = { attemptId: report.attemptId, stage: 'closed', elapsedMs: 1000 };
    for (let i = 0; i < 30; i++) expect((await t.call('POST', `/api/v1/sessions/${sessionId}/diagnostics`, diagnostic)).status).toBe(204);
    for (let i = 0; i < 30; i++) expect((await t.call('POST', endpoint(), report)).status).toBe(204);
    expect((await t.call('POST', endpoint(), report)).status).toBe(429);
    expect((await t.call('POST', `/api/v1/sessions/${sessionId}/heartbeat`, { input: false })).status).toBe(200);
    vi.restoreAllMocks();
  });
});
