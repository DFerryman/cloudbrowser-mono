import { describe, expect, it } from 'vitest';
import { elementPoint, pictureRect, remoteSpace, toRemotePoint } from '../src/mapping.js';

describe('the iPad report: box 1366×829, frame and screen 1280×800, a tap at box point 561,60', () => {
  const box = { left: 0, top: 0, width: 1366, height: 829 };
  const frame = { width: 1280, height: 800 };

  it('maps the tap as the diagnostics showed', () => {
    const point = toRemotePoint(561, 60, box, frame, frame)!;
    expect([Math.round(point.x), Math.round(point.y)]).toEqual([522, 58]);
  });

  it('was painted 11:10 inside the rectangle input used, as measured in the screenshot', () => {
    // object-fit: contain sized the layer from videoWidth×videoHeight; Safari's display layer then
    // fitted the frame again at its tagged display aspect, 1408×800.
    const painted = pictureRect(pictureRect(box, frame), { width: 1408, height: 800 });
    expect(painted.width).toBeCloseTo(1326.4, 1); // measured 1325
    expect(painted.height).toBeCloseTo(753.6, 1); // measured 752.5, bars of the page's own colour
    expect(painted.top).toBeCloseTo(37.7, 1); // measured 38.3; a 1280×720 frame would give 41.4
    // The finger touched remote y ≈ 24 (the tab strip); input went to y = 58 (the address bar).
    expect(((60 - painted.top) / painted.height) * 800).toBeCloseTo(23.7, 0);
  });
});

describe('remoteSpace', () => {
  it('maps to neko\'s screen when the frame has its shape, and to the frame otherwise', () => {
    expect(remoteSpace({ width: 960, height: 540 }, { width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080, source: 'screen' });
    expect(remoteSpace({ width: 1280, height: 720 }, { width: 1280, height: 800 })).toEqual({ width: 1280, height: 720, source: 'frame' });
    expect(remoteSpace({ width: 1280, height: 720 }, null)).toEqual({ width: 1280, height: 720, source: 'frame' });
  });
});

describe('picture layout and input share the same rectangle', () => {
  it.each([
    { width: 1280, height: 720 },
    { width: 1280, height: 800 },
    { width: 800, height: 1280 },
    { width: 640, height: 400 },
  ])('maps the painted corners and center after a resize to $width×$height', (video) => {
    const box = { left: 0, top: 39, width: 1366, height: 829 };
    const painted = pictureRect(box, video);
    for (const fraction of [0, 0.25, 0.5, 0.99]) {
      const point = toRemotePoint(painted.left + painted.width * fraction, painted.top + painted.height * fraction, box, video, null)!;
      expect(point.x).toBeCloseTo(video.width * fraction);
      expect(point.y).toBeCloseTo(video.height * fraction);
    }
    expect(toRemotePoint(painted.left - 1, painted.top, box, video, null)).toBeNull();
    expect(toRemotePoint(painted.left, painted.top - 1, box, video, null)).toBeNull();
  });

  it('handles missing metadata and an unlaid-out box', () => {
    const box = { left: 0, top: 39, width: 1366, height: 829 };
    expect(pictureRect(box, { width: 0, height: 0 })).toEqual(box);
    expect(toRemotePoint(0, 0, { ...box, width: 0, height: 0 }, { width: 0, height: 0 }, null)).toBeNull();
  });
});

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
