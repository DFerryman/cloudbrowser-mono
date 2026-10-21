import { describe, expect, it } from 'vitest';
import { STREAM } from '@cloudbrowser/contracts';
import { QualityController, type QualitySample } from '../src/quality.js';

const good = (at: number, fps: number | null = 25): QualitySample => ({ at, stalled: false, fps, lossRate: 0, freezes: 0, rttMs: 40 });
const bad = (at: number): QualitySample => ({ at, stalled: false, fps: 6, lossRate: 0.12, freezes: 1, rttMs: 40 });
const rtt = (ms: number) => (at: number): QualitySample => ({ ...good(at), rttMs: ms });

/** Feeds a reading every 2 s from `from` (ms) and returns every switch made. */
function run(c: QualityController, from: number, seconds: number, sample: (at: number) => QualitySample) {
  const switches: [number, string][] = [];
  for (let at = from; at < from + seconds * 1000; at += 2000) {
    const next = c.observe(sample(at));
    if (next) switches.push([at / 1000, next]);
  }
  return switches;
}

describe('picture quality controller', () => {
  it('uses one stream for every browser: the levels of images/browser/neko.yaml', () => {
    expect(STREAM.fps).toEqual({ full: 30, high: 30, medium: 15, low: 10 });
    expect(STREAM.kbps).toEqual({ full: 3000, high: 1800, medium: 1200, low: 800 });
  });

  it('goes straight to the level that fits what a congested path carries', () => {
    // Losing packets while about 1.2 Mbit/s arrives: 1.8 does not fit, 1.2 does not fit in 90%, low (0.8) does.
    const c = new QualityController('full', 0);
    expect(run(c, 10_000, 6, (at) => ({ ...good(at), lossRate: 0.1, kbps: 1200 }))).toEqual([[14, 'low']]);
    // About 2.1 Mbit/s arriving: high (1.8) fits.
    const d = new QualityController('full', 0);
    expect(run(d, 10_000, 6, (at) => ({ ...good(at), lossRate: 0.1, kbps: 2100 }))).toEqual([[14, 'high']]);
    // Freezes or dropped frames without congestion say nothing about the path: one level.
    const e = new QualityController('full', 0);
    expect(run(e, 10_000, 6, (at) => ({ ...good(at), freezes: 1, kbps: 500 }))).toEqual([[14, 'high']]);
  });

  it('stays at the sharpest level on a healthy connection', () => {
    const c = new QualityController('full', 0);
    expect(run(c, 0, 120, good)).toEqual([]);
    expect(c.quality).toBe('full');
  });

  it('steps down one level after about 6 s of trouble, and again if trouble continues', () => {
    const c = new QualityController('full', 0);
    expect(run(c, 10_000, 24, bad)).toEqual([[14, 'high'], [22, 'medium'], [30, 'low']]);
    expect(c.quality).toBe('low');
    // Never below the lowest level.
    expect(run(c, 34_000, 10, bad)).toEqual([]);
  });

  it('ignores short bursts of trouble and the settling time after a switch', () => {
    const c = new QualityController('full', 0);
    expect(c.observe(bad(2_000))).toBeNull(); // still settling after the start
    expect(c.observe(bad(6_000))).toBeNull();
    expect(c.observe(bad(8_000))).toBeNull();
    expect(c.observe(good(10_000))).toBeNull();
    expect(c.observe(bad(12_000))).toBeNull();
    expect(c.quality).toBe('full');
  });

  it('treats badly dropped frames or growing delay alone as trouble', () => {
    const slow = new QualityController('full', 0);
    expect(run(slow, 10_000, 6, (at) => good(at, 10))).toEqual([[14, 'high']]);
    // A few dropped frames are not trouble.
    const fine = new QualityController('full', 0);
    expect(run(fine, 10_000, 30, (at) => good(at, 18))).toEqual([]);
    // Delay growing well past the path's usual round trip, below the level that path allows.
    const delayed = new QualityController('full', 0);
    expect(run(delayed, 0, 20, rtt(400))).toEqual([[4, 'high']]);
    expect(run(delayed, 20_000, 8, rtt(800))).toEqual([[24, 'medium']]);
  });

  it('treats a missing frame rate as unknown, but no packets at all as trouble', () => {
    const c = new QualityController('full', 0);
    expect(run(c, 10_000, 60, (at) => good(at, null))).toEqual([]);
    // Nothing arriving at all is severe: two readings, not three.
    expect(run(c, 70_000, 8, (at) => ({ ...good(at, null), stalled: true }))).toEqual([[72, 'high']]);
  });

  it('steps down after two readings when no frame is decoded or a fifth of the packets are lost', () => {
    const frozen = new QualityController('full', 0);
    expect(run(frozen, 10_000, 6, (at) => ({ ...good(at, 0), lossRate: 0.03 }))).toEqual([[12, 'high']]);
    const lossy = new QualityController('full', 0);
    expect(run(lossy, 10_000, 6, (at) => ({ ...good(at), lossRate: 0.25 }))).toEqual([[12, 'high']]);
  });

  it('goes back at the first bad reading when a step up turns out too much', () => {
    const c = new QualityController('full', 0, 'high');
    expect(run(c, 10_000, 14, good)).toEqual([[22, 'full']]);
    // Settled 4 s after the switch, the first bad reading undoes it.
    expect(run(c, 24_000, 4, (at) => ({ ...good(at), lossRate: 0.1 }))).toEqual([[26, 'high']]);
    // Later trouble, past the probation, needs the usual three readings.
    const later = new QualityController('full', 0, 'high');
    run(later, 10_000, 14, good);
    expect(run(later, 24_000, 30, good)).toEqual([]);
    expect(run(later, 54_000, 6, (at) => ({ ...good(at), lossRate: 0.1 }))).toEqual([[58, 'high']]);
  });

  it('keeps full quality on ordinary paths and caps only clearly long ones', () => {
    const near = new QualityController('full', 0);
    expect(run(near, 0, 120, rtt(160))).toEqual([]);
    // Above about 180 ms the lighter level: still 30 fps, under a lower bitrate cap.
    const far = new QualityController('full', 0);
    expect(run(far, 0, 120, rtt(200))).toEqual([[4, 'high']]);
    // A long round trip alone never costs frame rate: a steady 500 ms path keeps 30 fps.
    const farther = new QualityController('full', 0);
    expect(run(farther, 0, 120, rtt(500))).toEqual([[4, 'high']]);
  });

  it('settles a longer path at the level it allows, and returns to full when the path shortens', () => {
    const c = new QualityController('full', 0);
    run(c, 10_000, 20, good);
    // The network changes to one with 360 ms round trips: the lighter 30 fps level, no lower.
    expect(run(c, 30_000, 240, rtt(360))).toEqual([[34, 'high']]);
    // Back on a short path the picture returns to full.
    expect(run(c, 270_000, 60, good).map(([, q]) => q)).toEqual(['full']);
  });

  it('does not flap on a path near a threshold, and ignores a single slow reading', () => {
    const c = new QualityController('full', 0);
    expect(run(c, 0, 30, rtt(200))).toEqual([[4, 'high']]);
    // 165 ms is below the 180 ms threshold but not clearly: the cap stays.
    expect(run(c, 30_000, 60, rtt(165))).toEqual([]);
    expect(run(c, 90_000, 30, rtt(100)).map(([, q]) => q)).toEqual(['full']);
    // One slow reading on a short path is not a long path.
    const spike = new QualityController('full', 0);
    expect(run(spike, 0, 60, (at) => rtt(at === 20_000 ? 340 : 60)(at))).toEqual([]);
  });

  it('never adapts to a downscaled picture that would blur text', () => {
    // An older image whose lower levels are 75% and 50% pictures of the desktop.
    const scales: Record<string, number> = { full: 1, high: 0.75, medium: 0.5, low: 0.5 };
    const c = new QualityController('full', 0);
    const sample = (at: number): QualitySample => ({ ...bad(at), scale: scales[c.quality]! });
    // Down to high, found too soft, back to full, and held there however bad it gets.
    expect(run(c, 10_000, 60, sample).map(([, q]) => q)).toEqual(['high', 'full']);
    expect(c.quality).toBe('full');
    // The current ladder is full size at every level, so it adapts all the way down.
    const current = new QualityController('full', 0);
    expect(run(current, 10_000, 40, (at) => ({ ...bad(at), scale: 1 })).map(([, q]) => q)).toEqual(['high', 'medium', 'low']);
  });

  it('runs low at 10 fps on purpose', () => {
    const low = new QualityController('low', 0);
    expect(run(low, 10_000, 30, (at) => good(at, 10))).toEqual([]);
  });

  it('returns one level at a time after a quiet period, never above the preferred level', () => {
    const c = new QualityController('high', 0, 'low');
    expect(c.quality).toBe('low');
    const switches = run(c, 10_000, 60, good);
    expect(switches.map(([, q]) => q)).toEqual(['medium', 'high']);
    expect(switches[0]![0]).toBeGreaterThanOrEqual(22);
    expect(c.quality).toBe('high');
  });

  it('waits longer before trying again when a step up fails at once', () => {
    const c = new QualityController('full', 0, 'high');
    let t = 10_000;
    const advance = (seconds: number, sample: (at: number) => QualitySample) => { const s = run(c, t, seconds, sample); t += seconds * 1000; return s; };
    expect(advance(20, good)).toEqual([[22, 'full']]);
    expect(advance(8, bad).map(([, q]) => q)).toEqual(['high']);
    // Twice the usual wait (24 s instead of 12 s) before the next try.
    const retry = advance(40, good);
    expect(retry).toHaveLength(1);
    expect(retry[0]![0] - 34).toBeGreaterThanOrEqual(24);
  });
});

describe('pointer mapping', () => {
  const box = { left: 0, top: 100, width: 1600, height: 900 };
  it('maps to the remote screen even when the picture is a downscaled video of it', async () => {
    const { toRemotePoint } = await import('../src/mapping.js');
    const screen = { width: 1920, height: 1080 };
    // Full level: video and screen are the same size.
    expect(toRemotePoint(800, 550, box, { width: 1920, height: 1080 }, screen)).toEqual({ x: 960, y: 540 });
    // Medium level: a 960×540 picture of the same 1920×1080 desktop maps to the same point.
    expect(toRemotePoint(800, 550, box, { width: 960, height: 540 }, screen)).toEqual({ x: 960, y: 540 });
    expect(toRemotePoint(0, 100, box, { width: 960, height: 540 }, screen)).toEqual({ x: 0, y: 0 });
    expect(toRemotePoint(1599.9, 999.9, box, { width: 960, height: 540 }, screen)).toEqual({ x: 1919, y: 1079 });
    // Outside the letterboxed picture.
    expect(toRemotePoint(800, 50, box, { width: 960, height: 540 }, screen)).toBeNull();
    // Before neko reports its screen, the video's own pixels are used.
    expect(toRemotePoint(800, 550, box, { width: 1920, height: 1080 }, null)).toEqual({ x: 960, y: 540 });
  });
});

describe('pointer mapping during a resize', () => {
  it('maps to the frames on screen while they still have the old shape', async () => {
    const { toRemotePoint } = await import('../src/mapping.js');
    const box = { left: 0, top: 0, width: 1600, height: 900 };
    // neko already reports 1280×1024 while 1920×1080 frames are still shown.
    expect(toRemotePoint(800, 450, box, { width: 1920, height: 1080 }, { width: 1280, height: 1024 })).toEqual({ x: 960, y: 540 });
  });
});
