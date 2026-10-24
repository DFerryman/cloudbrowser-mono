import { describe, expect, it } from 'vitest';
import { remotePerPixel, rotate, unrotate } from '../src/mapping.js';
import { MAX_ZOOM, PictureZoom } from '../src/zoom.js';

const frame = { width: 400, height: 800 };

describe('PictureZoom', () => {
  it('keeps what was under the fingers under them as they pinch and move', () => {
    const zoom = new PictureZoom();
    const before = { x: 120, y: 300 };
    zoom.pinch(2, 130, 320, 10, 20, frame);
    expect(zoom.scale).toBe(2);
    expect(zoom.unzoom(130, 320)).toEqual(before);
    zoom.pinch(1.5, 150, 300, 20, -20, frame);
    expect(zoom.scale).toBe(3);
    expect(zoom.unzoom(150, 300)).toEqual(before);
    expect(zoom.transform).toBe(`translate(${zoom.x}px, ${zoom.y}px) scale(3)`);
  });

  it('never zooms out past the whole picture or in past the limit, nor moves it off an edge', () => {
    const zoom = new PictureZoom();
    zoom.pinch(0.5, 200, 400, 0, 0, frame);
    expect([zoom.scale, zoom.x, zoom.y, zoom.zoomed, zoom.transform]).toEqual([1, 0, 0, false, '']);
    zoom.pinch(10, 0, 0, 0, 0, frame);
    expect(zoom.scale).toBe(MAX_ZOOM);
    // Panned far to the right and down: the picture's top-left corner stays in the frame's.
    zoom.pinch(1, 0, 0, 5000, 5000, frame);
    expect([zoom.x, zoom.y]).toEqual([0, 0]);
    zoom.pinch(1, 0, 0, -5000, -5000, frame);
    expect([zoom.x, zoom.y]).toEqual([400 * (1 - MAX_ZOOM), 800 * (1 - MAX_ZOOM)]);
    expect(zoom.unzoom(400, 800)).toEqual({ x: 400, y: 800 });
    zoom.pinch(Number.NaN, 0, 0, 0, 0, frame);
    expect(zoom.scale).toBe(MAX_ZOOM);
  });

  it('returns to the whole picture when a pinch ends barely zoomed, and re-fits a smaller frame', () => {
    const zoom = new PictureZoom();
    zoom.pinch(1.05, 200, 400, 0, 0, frame);
    zoom.settle();
    expect([zoom.scale, zoom.x, zoom.y]).toEqual([1, 0, 0]);
    zoom.pinch(2, 400, 800, 0, 0, frame);
    expect([zoom.x, zoom.y]).toEqual([-400, -800]);
    zoom.settle();
    expect(zoom.scale).toBe(2);
    zoom.clamp({ width: 300, height: 600 });
    expect([zoom.x, zoom.y]).toEqual([-300, -600]);
  });
});

describe('remotePerPixel', () => {
  it('is how many remote pixels one painted pixel covers', () => {
    // A 1280-wide desktop painted 393 px wide on a phone.
    expect(remotePerPixel({ left: 0, top: 0, width: 393, height: 700 }, { width: 1280, height: 720 }, { width: 1280, height: 720 })).toBeCloseTo(1280 / 393);
    // A lower picture level of a 1920×1080 desktop, painted 960 wide.
    expect(remotePerPixel({ left: 0, top: 0, width: 960, height: 600 }, { width: 960, height: 540 }, { width: 1920, height: 1080 })).toBe(2);
    expect(remotePerPixel({ left: 0, top: 0, width: 0, height: 0 }, { width: 0, height: 0 }, null)).toBe(1);
  });
});

describe('rotate', () => {
  it('carries a point in the unturned frame back to where it is on the box', () => {
    const box = { left: 0, top: 0, width: 400, height: 800 };
    for (const [x, y] of [[399, 0], [1, 799], [200, 400], [37, 512]] as const) {
      const local = unrotate(x, y, box);
      const back = rotate(local.x, local.y, box);
      expect([back.x, back.y]).toEqual([x, y]);
    }
  });
});
