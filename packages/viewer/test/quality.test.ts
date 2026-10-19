import { describe, expect, it } from 'vitest';
import { QualityController, type QualitySample } from '../src/quality.js';

const good = (at: number, fps: number | null = 25): QualitySample => ({ at, stalled: false, fps, lossRate: 0, freezes: 0, rttMs: 40 });
const bad = (at: number): QualitySample => ({ at, stalled: false, fps: 6, lossRate: 0.12, freezes: 1, rttMs: 420 });

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
  it('stays at the sharpest level on a healthy connection', () => {
    const c = new QualityController('full', 0);
    expect(run(c, 0, 120, good)).toEqual([]);
    expect(c.quality).toBe('full');
  });

  it('steps down one level after about 4 s of trouble, and again if trouble continues', () => {
    const c = new QualityController('full', 0);
    expect(run(c, 10_000, 20, bad)).toEqual([[12, 'high'], [18, 'medium'], [24, 'low']]);
    expect(c.quality).toBe('low');
    // Never below the lowest level.
    expect(run(c, 30_000, 10, bad)).toEqual([]);
  });

  it('ignores a single bad reading and the settling time after a switch', () => {
    const c = new QualityController('full', 0);
    expect(c.observe(bad(2_000))).toBeNull(); // still settling after the start
    expect(c.observe(bad(6_000))).toBeNull();
    expect(c.observe(good(8_000))).toBeNull();
    expect(c.observe(bad(10_000))).toBeNull();
    expect(c.quality).toBe('full');
  });

  it('treats dropped frames or growing delay alone as trouble', () => {
    const slow = new QualityController('full', 0);
    expect(run(slow, 10_000, 4, (at) => good(at, 10))).toEqual([[12, 'high']]);
    const delayed = new QualityController('full', 0);
    expect(run(delayed, 10_000, 6, (at) => ({ ...good(at), rttMs: at < 12_000 ? 40 : 400 }))).toEqual([[14, 'high']]);
    // The low level runs at 15 fps on purpose.
    const low = new QualityController('low', 0);
    expect(run(low, 10_000, 20, (at) => good(at, 15))).toEqual([]);
  });

  it('treats a missing frame rate as unknown, but no packets at all as trouble', () => {
    const c = new QualityController('full', 0);
    expect(run(c, 10_000, 60, (at) => good(at, null))).toEqual([]);
    expect(run(c, 70_000, 6, (at) => ({ ...good(at, null), stalled: true }))).toEqual([[72_000 / 1000, 'high']]);
  });

  it('accepts a longer path as the new normal after a minute', () => {
    const c = new QualityController('full', 0);
    run(c, 10_000, 20, good);
    // The network changes to one with 330 ms round trips: one step down, then the baseline moves.
    const switches = run(c, 30_000, 240, (at) => ({ ...good(at), rttMs: 330 }));
    expect(switches[0]).toEqual([32, 'high']);
    expect(switches.at(-1)![1]).toBe('full');
  });

  it('returns one level at a time after a quiet period, never above the setting', () => {
    const c = new QualityController('high', 0, 'low');
    expect(c.quality).toBe('low');
    const switches = run(c, 10_000, 60, good);
    expect(switches.map(([, q]) => q)).toEqual(['medium', 'high']);
    expect(switches[0]![0]).toBeGreaterThanOrEqual(24);
    expect(c.quality).toBe('high');
  });

  it('waits longer before trying again when a step up fails at once', () => {
    const c = new QualityController('full', 0, 'high');
    let t = 10_000;
    const advance = (seconds: number, sample: (at: number) => QualitySample) => { const s = run(c, t, seconds, sample); t += seconds * 1000; return s; };
    expect(advance(20, good)).toEqual([[26, 'full']]);
    expect(advance(6, bad).map(([, q]) => q)).toEqual(['high']);
    // Twice the usual wait (30 s instead of 15 s) before the next try.
    const retry = advance(40, good);
    expect(retry).toHaveLength(1);
    expect(retry[0]![0] - 34).toBeGreaterThanOrEqual(30);
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
