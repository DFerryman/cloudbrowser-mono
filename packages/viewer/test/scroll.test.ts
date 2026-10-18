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
    for (let frame = 1; frame < 240; frame++) expect(scroll.consume(0, 0.5, false, frame).y).toBe(0);
    expect(scroll.consume(0, 0.5, false, 240).y).toBe(-1);
  });

  it('does not turn a direction reversal into a delayed scroll in the old direction', () => {
    const scroll = new ScrollAccumulator();
    scroll.consume(0, 70, false, 0);
    expect(scroll.consume(0, -1, false, 16).y).toBe(1);
    expect(scroll.consume(0, -119, false, 32).y).toBe(0);
    expect(scroll.consume(0, -1, false, 48).y).toBe(1);
  });

  it('commits a partial click before another input boundary, without carrying it to a new target', () => {
    const scroll = new ScrollAccumulator();
    scroll.consume(0, 120, false, 0);
    scroll.consume(0, 15, false, 1);
    expect(scroll.finish()).toEqual({ x: 0, y: -1 });
    expect(scroll.finish()).toEqual({ x: 0, y: 0 });
    expect(scroll.consume(0, -1, false, 2).y).toBe(1);
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
