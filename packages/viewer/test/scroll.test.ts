import { describe, expect, it } from 'vitest';
import { ScrollAccumulator } from '../src/scroll.js';

describe('Neko wheel conversion', () => {
  it('converts mouse pixels to a few wheel clicks with the remote right/down signs', () => {
    const scroll = new ScrollAccumulator();
    expect(scroll.consume(0, 120, false, 0)).toEqual({ x: 0, y: -1 });
    expect(scroll.consume(120, 0, false, 16)).toEqual({ x: -1, y: 0 });
    expect(scroll.consume(0, -120, false, 32)).toEqual({ x: 0, y: 1 });
  });

  it('responds immediately, then preserves fractional trackpad movements across frames', () => {
    const scroll = new ScrollAccumulator();
    expect(scroll.consume(0, 0.5, false, 0).y).toBe(-1);
    // The first click covered the first 120 px; the next comes at 240 px.
    for (let frame = 1; frame < 479; frame++) expect(scroll.consume(0, 0.5, false, frame).y).toBe(0);
    expect(scroll.consume(0, 0.5, false, 479).y).toBe(-1);
  });

  it('scrolls a swipe as far as it moved, within half a click', () => {
    // A finger or trackpad moving 10 px a frame, then lifting.
    for (const [distance, expected] of [[10, 1], [60, 1], [120, 1], [200, 2], [300, 3], [600, 5]]) {
      const scroll = new ScrollAccumulator();
      let clicks = 0;
      for (let moved = 10; moved <= distance; moved += 10) clicks -= scroll.consume(0, 10, false, moved).y;
      clicks -= scroll.finish().y;
      expect([distance, clicks]).toEqual([distance, expected]);
    }
  });

  it('commits a partial click at a pause, and lets movement that resumes soon pay for it', () => {
    const scroll = new ScrollAccumulator();
    expect(scroll.consume(0, 10, false, 0).y).toBe(-1);
    scroll.consume(0, 50, false, 16);
    // 60 px moved: the first click still owes 60, so a pause commits nothing.
    expect(scroll.settle()).toEqual({ x: 0, y: 0 });
    expect(scroll.consume(0, 60, false, 200).y).toBe(0);
    scroll.consume(0, 70, false, 216);
    expect(scroll.settle()).toEqual({ x: 0, y: -1 });
    // Resumed 150 ms later: the settled click covered the next 50 px.
    expect(scroll.consume(0, 50, false, 366).y).toBe(0);
    expect(scroll.consume(0, 120, false, 382).y).toBe(-1);
    expect(scroll.finish()).toEqual({ x: 0, y: 0 });
  });

  it('does not turn a direction reversal into a delayed scroll in the old direction', () => {
    const scroll = new ScrollAccumulator();
    scroll.consume(0, 70, false, 0);
    expect(scroll.consume(0, -1, false, 16).y).toBe(1);
    expect(scroll.consume(0, -119, false, 32).y).toBe(0);
    expect(scroll.consume(0, -119, false, 48).y).toBe(0);
    expect(scroll.consume(0, -1, false, 64).y).toBe(1);
    expect(scroll.finish()).toEqual({ x: 0, y: 0 });
  });

  it('commits a partial click before another input boundary, without carrying it to a new target', () => {
    const scroll = new ScrollAccumulator();
    scroll.consume(0, 120, false, 0);
    scroll.consume(0, 60, false, 1);
    expect(scroll.finish()).toEqual({ x: 0, y: -1 });
    expect(scroll.finish()).toEqual({ x: 0, y: 0 });
    expect(scroll.consume(0, -1, false, 2).y).toBe(1);
    // Less than half a click, or what the first click still owes, commits nothing.
    scroll.consume(0, -59, false, 3);
    expect(scroll.finish()).toEqual({ x: 0, y: 0 });
    scroll.consume(120, 0, false, 4);
    scroll.consume(59, 0, false, 5);
    expect(scroll.finish()).toEqual({ x: 0, y: 0 });
  });

  it('starts a fresh gesture after idle, modifier changes, or reconnection', () => {
    const scroll = new ScrollAccumulator();
    scroll.consume(0, 80, false, 0);
    expect(scroll.consume(0, 1, false, 300).y).toBe(-1);
    expect(scroll.consume(0, 1, true, 301).y).toBe(-1);
    scroll.reset();
    expect(scroll.consume(1, 1, false, 302)).toEqual({ x: -1, y: -1 });
    expect(scroll.consume(Number.NaN, 1, false, 303)).toEqual({ x: 0, y: 0 });
  });
});
