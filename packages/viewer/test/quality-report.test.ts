import { describe, expect, it } from 'vitest';
import { QualityWindow, type QualityCounters } from '../src/quality-report.js';
import type { ViewerStats } from '../src/stats.js';

const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const stats = (over: Partial<ViewerStats> = {}): ViewerStats => ({
  rttMs: null, fps: null, loss: null, bitrateKbps: null, codec: null, transport: null, width: null, height: null, ...over,
});
/** A browser that reports only the basic counters (no freeze durations, jitter buffer or decode times). */
const basic = (received: number, frames = Number.NaN): QualityCounters => ({
  lost: 0, received, freezes: 0, frames,
  freezeSeconds: Number.NaN, jitterBufferDelay: Number.NaN, jitterBufferEmitted: Number.NaN, jitterBufferTarget: Number.NaN, decodeSeconds: Number.NaN, dropped: Number.NaN,
  nacks: Number.NaN, retransmits: Number.NaN, plis: Number.NaN, keyframes: Number.NaN,
});

describe('quality report window', () => {
  it('says nothing for what the browser does not report, rather than zero', () => {
    const w = new QualityWindow();
    w.add(ATTEMPT, 0, stats(), basic(0), { inboundVideo: true });
    w.add(ATTEMPT, 30_000, stats({ rttMs: 100 }), basic(1000), { inboundVideo: true });
    expect(w.take(10_000, null)).toEqual({
      attemptId: ATTEMPT, durationMs: 30_000, readings: 1, rttMs: 100, gatewayRttMs: null, fps: null, kbps: null,
      loss: 0, freezes: 0, freezeMs: null, jitterBufferMs: null, decodeMs: null, framesDropped: null,
      quality: null, width: null, height: null, nacks: null, retransmits: null, plis: null, keyframes: null, levelChanges: 0,
      jitterBufferTargetMs: null,
    });
  });

  it('counts repairs and level changes in the interval only', () => {
    const w = new QualityWindow();
    const repairs = (received: number, nacks: number, retransmits: number, plis: number, keyframes: number): QualityCounters =>
      ({ ...basic(received), nacks, retransmits, plis, keyframes });
    // A change before the window opens belongs to no report.
    w.levelChanged();
    w.add(ATTEMPT, 0, stats(), repairs(0, 40, 35, 1, 2), { inboundVideo: true });
    w.levelChanged();
    w.add(ATTEMPT, 30_000, stats(), repairs(9000, 640, 610, 4, 5), { inboundVideo: true });
    w.levelChanged();
    expect(w.take(10_000, 'medium')).toMatchObject({ nacks: 600, retransmits: 575, plis: 3, keyframes: 3, levelChanges: 2 });
    w.add(ATTEMPT, 60_000, stats(), repairs(18_000, 640, 610, 4, 5), { inboundVideo: true });
    expect(w.take(10_000, 'medium')).toMatchObject({ nacks: 0, retransmits: 0, plis: 0, keyframes: 0, levelChanges: 0 });
  });

  it('splits how long frames waited into what the browser aimed for and the rest', () => {
    const w = new QualityWindow();
    const buffer = (received: number, delay: number, target: number, emitted: number): QualityCounters =>
      ({ ...basic(received), jitterBufferDelay: delay, jitterBufferTarget: target, jitterBufferEmitted: emitted });
    // 300 frames held 0.3 s on average, of which the browser aimed for 0.06 s: the rest waited for packets.
    w.add(ATTEMPT, 0, stats(), buffer(0, 10, 2, 1000), { inboundVideo: true });
    w.add(ATTEMPT, 30_000, stats(), buffer(9000, 100, 20, 1300), { inboundVideo: true });
    expect(w.take(10_000, 'low')).toMatchObject({ jitterBufferMs: 300, jitterBufferTargetMs: 60 });
  });

  it('takes medians, continues from the last reading, and starts over for another attempt', () => {
    const w = new QualityWindow();
    w.add(ATTEMPT, 0, stats(), basic(0, 0), { inboundVideo: true });
    for (const [at, rtt] of [[2000, 80], [4000, 400], [6000, 90]] as const) w.add(ATTEMPT, at, stats({ rttMs: rtt }), basic(at, at / 100), { inboundVideo: true });
    w.gatewayRtt(30);
    w.gatewayRtt(31);
    w.gatewayRtt(900);
    expect(w.take(5_000, 'full')).toMatchObject({ durationMs: 6000, readings: 3, rttMs: 90, gatewayRttMs: 31, fps: 10, quality: 'full' });
    // Too short to report; the window keeps going from the reading at 6 s.
    w.add(ATTEMPT, 8000, stats({ rttMs: 70 }), basic(8000, 80), { inboundVideo: true });
    expect(w.take(5_000, 'full')).toBeNull();
    w.add(ATTEMPT, 12_000, stats({ rttMs: 70 }), basic(12_000, 120), { inboundVideo: true });
    expect(w.take(5_000, 'full')).toMatchObject({ durationMs: 6000, readings: 2, rttMs: 70, gatewayRttMs: null });
    // A reading from another attempt is the new baseline, never a delta against the old peer.
    w.add('00000000-0000-4000-8000-000000000002', 14_000, stats({ rttMs: 50 }), basic(0, 0), { inboundVideo: true });
    expect(w.take(0, 'full')).toBeNull();
  });
});
