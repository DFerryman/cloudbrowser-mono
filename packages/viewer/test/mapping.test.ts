import { describe, expect, it } from 'vitest';
import { elementPoint } from '../src/mapping.js';

describe('elementPoint', () => {
  const element = { getBoundingClientRect: () => ({ left: 10, top: 44, width: 800, height: 600 }), clientLeft: 0, clientTop: 0 };

  it("uses the browser's own offsets for an event the element received", () => {
    // iOS Safari with the keyboard panning the page: client coordinates and the rectangle disagree
    // by the pan; offsetX/Y come from the hit test itself.
    expect(elementPoint({ clientX: 110, clientY: 300, offsetX: 100, offsetY: 200, target: element }, element)).toEqual({ x: 100, y: 200 });
  });

  it('falls back to the rectangle for events delivered to another element or without offsets', () => {
    const child = {};
    expect(elementPoint({ clientX: 110, clientY: 300, offsetX: 5, offsetY: 6, target: child }, element)).toEqual({ x: 100, y: 256 });
    expect(elementPoint({ clientX: 110, clientY: 300, target: element }, element)).toEqual({ x: 100, y: 256 });
    expect(elementPoint({ clientX: 110, clientY: 300, offsetX: Number.NaN, offsetY: 1, target: element }, element)).toEqual({ x: 100, y: 256 });
  });

  it('measures from the padding edge when the element has a border', () => {
    const bordered = { ...element, clientLeft: 2, clientTop: 3 };
    expect(elementPoint({ clientX: 110, clientY: 300 }, bordered)).toEqual({ x: 98, y: 253 });
  });
});
