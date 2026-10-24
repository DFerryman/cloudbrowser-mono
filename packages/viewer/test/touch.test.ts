import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOUBLE_TAP_MS, HOLD_MS, TouchGestureController, TWO_FINGER_TAP_MS, type TouchGestureOptions } from '../src/touch.js';

const pointer = (pointerId: number, clientX: number, clientY: number) => ({ pointerId, clientX, clientY });

function setup(overrides: Partial<TouchGestureOptions> = {}) {
  const callbacks = {
    mapPoint: vi.fn((x: number, y: number) => x < 0 || y < 0 ? null : { x: x * 2, y: y * 2 }),
    move: vi.fn(),
    button: vi.fn(),
    scroll: vi.fn(),
    activity: vi.fn(),
  };
  const gestures = new TouchGestureController({ ...callbacks, ...overrides });
  return { gestures, ...callbacks };
}

describe('TouchGestureController', () => {
  it('clicks a mapped remote position only when a tap is released', () => {
    const { gestures, move, button, scroll, activity } = setup();
    expect(gestures.pointerDown(pointer(1, 20, 30))).toBe(true);
    gestures.pointerMove(pointer(1, 22, 32));
    expect(move).not.toHaveBeenCalled();
    expect(button).not.toHaveBeenCalled();
    gestures.pointerUp(pointer(1, 22, 32));

    expect(move).toHaveBeenCalledExactlyOnceWith(44, 64);
    expect(button.mock.calls).toEqual([[true, 44, 64], [false, 44, 64]]);
    expect(scroll).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(2);
  });

  it('turns a one-finger drag into scrolling without pressing or clicking the mouse', () => {
    const { gestures, move, button, scroll } = setup();
    gestures.pointerDown(pointer(1, 100, 100));
    gestures.pointerMove(pointer(1, 103, 97));
    expect(scroll).not.toHaveBeenCalled();
    gestures.pointerMove(pointer(1, 100, 80));
    gestures.pointerMove(pointer(1, 90, 70));
    gestures.pointerUp(pointer(1, 90, 70));

    // Wheel deltas stay in CSS pixels even though mapPoint doubles remote coordinates.
    expect(scroll.mock.calls).toEqual([[0, 20], [10, 10]]);
    expect(move.mock.calls).toEqual([[200, 200], [200, 200]]);
    expect(button).not.toHaveBeenCalled();
  });

  it('does not turn a scroll back into a tap when a finger returns to its starting point', () => {
    const { gestures, button, scroll } = setup();
    gestures.pointerDown(pointer(1, 20, 50));
    gestures.pointerMove(pointer(1, 20, 30));
    gestures.pointerMove(pointer(1, 20, 50));
    gestures.pointerUp(pointer(1, 20, 50));

    expect(scroll.mock.calls).toEqual([[0, 20], [0, -20]]);
    expect(button).not.toHaveBeenCalled();
  });

  it('recognizes a scroll whose final movement arrives only with pointerup', () => {
    const { gestures, button, scroll } = setup();
    gestures.pointerDown(pointer(1, 20, 50));
    gestures.pointerUp(pointer(1, 20, 25));

    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 25);
    expect(button).not.toHaveBeenCalled();
  });

  it('scrolls by the two-finger centroid and continues smoothly after one finger lifts', () => {
    const { gestures, move, button, scroll } = setup();
    gestures.pointerDown(pointer(1, 40, 100));
    gestures.pointerDown(pointer(2, 80, 100));
    expect(scroll).not.toHaveBeenCalled();
    gestures.pointerMove(pointer(1, 40, 80));
    gestures.pointerMove(pointer(2, 80, 80));
    gestures.pointerUp(pointer(1, 40, 80));
    gestures.pointerMove(pointer(2, 80, 60));
    gestures.pointerUp(pointer(2, 80, 60));

    expect(scroll.mock.calls).toEqual([[0, 10], [0, 10], [0, 20]]);
    expect(move.mock.calls).toEqual([[120, 200], [120, 200], [120, 200]]);
    expect(button).not.toHaveBeenCalled();
  });

  it('right-clicks between two fingers tapped together, and allows a new single-finger tap afterward', () => {
    const { gestures, move, button, scroll } = setup();
    gestures.pointerDown(pointer(1, 40, 100));
    gestures.pointerDown(pointer(2, 80, 100));
    gestures.pointerUp(pointer(1, 40, 100));
    expect(button).not.toHaveBeenCalled();
    gestures.pointerUp(pointer(2, 80, 100));
    expect(move).toHaveBeenCalledExactlyOnceWith(120, 200);
    expect(button.mock.calls).toEqual([[true, 120, 200, 2], [false, 120, 200, 2]]);
    expect(scroll).not.toHaveBeenCalled();

    gestures.pointerDown(pointer(3, 30, 20));
    gestures.pointerUp(pointer(3, 30, 20));
    expect(button.mock.calls.slice(2)).toEqual([[true, 60, 40], [false, 60, 40]]);
  });

  it('cancels pointers without clicking and resets the remaining finger\'s scroll origin', () => {
    const { gestures, button, scroll } = setup();
    gestures.pointerDown(pointer(1, 20, 50));
    gestures.pointerDown(pointer(2, 60, 50));
    gestures.pointerCancel(pointer(1, 20, 50));
    gestures.pointerMove(pointer(2, 60, 30));
    gestures.pointerCancel(pointer(2, 60, 30));
    gestures.pointerUp(pointer(2, 60, 30));

    expect(scroll.mock.calls).toEqual([[0, 20]]);
    expect(button).not.toHaveBeenCalled();
    gestures.pointerDown(pointer(3, 20, 20));
    gestures.pointerUp(pointer(3, 20, 20));
    expect(button.mock.calls).toEqual([[true, 40, 40], [false, 40, 40]]);
  });

  it('discards an in-progress gesture on reset and ignores late events from its pointers', () => {
    const { gestures, button, scroll } = setup();
    gestures.pointerDown(pointer(1, 20, 50));
    gestures.pointerMove(pointer(1, 20, 30));
    gestures.reset();
    gestures.pointerMove(pointer(1, 20, 10));
    gestures.pointerUp(pointer(1, 20, 10));

    expect(scroll.mock.calls).toEqual([[0, 20]]);
    expect(button).not.toHaveBeenCalled();
    gestures.pointerDown(pointer(2, 10, 20));
    gestures.pointerUp(pointer(2, 10, 20));
    expect(button.mock.calls).toEqual([[true, 20, 40], [false, 20, 40]]);
  });

  it('does not capture touches that begin outside the desktop or click a tap released outside it', () => {
    const { gestures, button, scroll, activity } = setup();
    expect(gestures.pointerDown(pointer(1, -10, 20))).toBe(false);
    gestures.pointerMove(pointer(1, 10, 20));
    gestures.pointerUp(pointer(1, 10, 20));
    expect(activity).not.toHaveBeenCalled();
    expect(gestures.pointerDown(pointer(2, 2, 20))).toBe(true);
    gestures.pointerUp(pointer(2, -2, 20));

    expect(button).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('ignores duplicate downs and unrelated pointer events', () => {
    const { gestures, button, scroll } = setup();
    expect(gestures.pointerDown(pointer(1, 20, 30))).toBe(true);
    expect(gestures.pointerDown(pointer(1, 200, 300))).toBe(false);
    gestures.pointerMove(pointer(99, 100, 100));
    gestures.pointerUp(pointer(99, 100, 100));
    gestures.pointerCancel(pointer(99, 100, 100));
    gestures.pointerUp(pointer(1, 20, 30));

    expect(button.mock.calls).toEqual([[true, 40, 60], [false, 40, 60]]);
    expect(scroll).not.toHaveBeenCalled();
  });

  it('uses a configurable movement threshold', () => {
    const { gestures, button, scroll } = setup({ thresholdPx: 15 });
    gestures.pointerDown(pointer(1, 20, 50));
    gestures.pointerMove(pointer(1, 20, 40));
    expect(scroll).not.toHaveBeenCalled();
    gestures.pointerUp(pointer(1, 20, 40));
    expect(button.mock.calls).toEqual([[true, 40, 80], [false, 40, 80]]);
  });

  it('clicks where the finger rested when it only shifted as it lifted', () => {
    const { gestures, button, scroll } = setup();
    gestures.pointerDown(pointer(1, 100, 100));
    gestures.pointerMove(pointer(1, 103, 102));
    // The contact point jumps 11 px with the lift: beyond the threshold, within the slack.
    gestures.pointerUp(pointer(1, 111, 100));
    expect(scroll).not.toHaveBeenCalled();
    expect(button.mock.calls).toEqual([[true, 206, 204], [false, 206, 204]]);
  });

  it('forgets a finger whose pointerup never came once a new touch begins', () => {
    const { gestures, button, scroll } = setup();
    gestures.pointerDown({ ...pointer(1, 20, 20), isPrimary: true });
    // A system gesture took the touch over without a pointerup or pointercancel.
    gestures.pointerDown({ ...pointer(2, 60, 60), isPrimary: true });
    gestures.pointerUp(pointer(2, 60, 60));
    expect(button.mock.calls).toEqual([[true, 120, 120], [false, 120, 120]]);
    // A second finger of the same touch still makes it a two-finger gesture, never a left tap.
    gestures.pointerDown({ ...pointer(3, 20, 20), isPrimary: true });
    gestures.pointerDown({ ...pointer(4, 60, 20), isPrimary: false });
    gestures.pointerUp(pointer(4, 60, 20));
    gestures.pointerUp(pointer(3, 20, 20));
    expect(button.mock.calls.slice(2)).toEqual([[true, 80, 40, 2], [false, 80, 40, 2]]);
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe('TouchGestureController with time', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('right-clicks where a finger was held still, once it lifts', () => {
    const held = vi.fn();
    const { gestures, move, button } = setup({ held });
    gestures.pointerDown(pointer(1, 20, 30));
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(held).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(held).toHaveBeenCalledExactlyOnceWith(20, 30);
    expect(button).not.toHaveBeenCalled();
    // The finger shifts as it lifts: still a right-click where it was held.
    gestures.pointerUp(pointer(1, 31, 30));
    expect(move).toHaveBeenCalledExactlyOnceWith(40, 60);
    expect(button.mock.calls).toEqual([[true, 40, 60, 2], [false, 40, 60, 2]]);
  });

  it('drags with the left button from where a finger was held, once it moves', () => {
    const { gestures, move, button, scroll } = setup({ held: vi.fn() });
    gestures.pointerDown(pointer(1, 100, 100));
    vi.advanceTimersByTime(HOLD_MS);
    gestures.pointerMove(pointer(1, 100, 104));
    expect(button).not.toHaveBeenCalled();
    gestures.pointerMove(pointer(1, 100, 120));
    expect(button.mock.calls).toEqual([[true, 200, 200]]);
    gestures.pointerMove(pointer(1, 130, 140));
    // Off the picture the button stays down where the finger last was on it.
    gestures.pointerMove(pointer(1, -5, 140));
    gestures.pointerUp(pointer(1, -5, 140));
    expect(move.mock.calls).toEqual([[200, 200], [200, 240], [260, 280]]);
    expect(button.mock.calls).toEqual([[true, 200, 200], [false, 260, 280]]);
    expect(scroll).not.toHaveBeenCalled();
  });

  it('holds neither a finger that moved first nor one that lifted, and keeps other fingers out of a hold', () => {
    const held = vi.fn();
    const { gestures, button, scroll } = setup({ held });
    gestures.pointerDown(pointer(1, 100, 100));
    gestures.pointerMove(pointer(1, 100, 80));
    vi.advanceTimersByTime(HOLD_MS);
    gestures.pointerUp(pointer(1, 100, 80));
    gestures.pointerDown(pointer(2, 100, 100));
    gestures.pointerUp(pointer(2, 100, 100));
    vi.advanceTimersByTime(HOLD_MS);
    expect(held).not.toHaveBeenCalled();
    expect(scroll.mock.calls).toEqual([[0, 20]]);
    expect(button.mock.calls).toEqual([[true, 200, 200], [false, 200, 200]]);

    gestures.pointerDown(pointer(3, 10, 10));
    vi.advanceTimersByTime(HOLD_MS);
    expect(gestures.pointerDown(pointer(4, 50, 50))).toBe(false);
  });

  it('lets go of a drag that is canceled or reset', () => {
    const { gestures, button } = setup();
    gestures.pointerDown(pointer(1, 100, 100));
    vi.advanceTimersByTime(HOLD_MS);
    gestures.pointerMove(pointer(1, 100, 120));
    gestures.pointerCancel(pointer(1, 100, 120));
    expect(button.mock.calls).toEqual([[true, 200, 200], [false, 200, 240]]);

    gestures.pointerDown(pointer(2, 100, 100));
    vi.advanceTimersByTime(HOLD_MS);
    gestures.pointerMove(pointer(2, 120, 100));
    gestures.reset();
    expect(button.mock.calls.slice(2)).toEqual([[true, 200, 200], [false, 240, 200]]);
    gestures.pointerUp(pointer(2, 120, 100));
    expect(button).toHaveBeenCalledTimes(4);
  });

  it('double-clicks where the first tap landed when a second one follows close by', () => {
    const { gestures, button } = setup();
    const tap = (id: number, x: number, y: number) => {
      gestures.pointerDown(pointer(id, x, y));
      gestures.pointerUp(pointer(id, x, y));
    };
    tap(1, 100, 100);
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 100);
    tap(2, 110, 104);
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 100);
    // A third tap continues the run: a triple-click selects the paragraph.
    tap(3, 96, 108);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    tap(4, 110, 104);
    tap(5, 300, 100);
    const downs = button.mock.calls.filter(([down]) => down).map(([, x, y]) => [x, y]);
    expect(downs).toEqual([[200, 200], [200, 200], [200, 200], [220, 208], [600, 200]]);
  });

  it('does not right-click two fingers that stayed down long or moved', () => {
    const { gestures, button } = setup();
    gestures.pointerDown(pointer(1, 40, 100));
    gestures.pointerDown(pointer(2, 80, 100));
    vi.advanceTimersByTime(TWO_FINGER_TAP_MS + 1);
    gestures.pointerUp(pointer(1, 40, 100));
    gestures.pointerUp(pointer(2, 80, 100));

    gestures.pointerDown(pointer(3, 40, 100));
    gestures.pointerDown(pointer(4, 80, 100));
    gestures.pointerMove(pointer(3, 40, 90));
    gestures.pointerMove(pointer(4, 80, 90));
    gestures.pointerUp(pointer(3, 40, 90));
    gestures.pointerUp(pointer(4, 80, 90));
    expect(button).not.toHaveBeenCalled();
  });
});

describe('TouchGestureController with pinch zoom', () => {
  function zoomable(zoomedIn = false) {
    const zoom = vi.fn();
    const zoomEnd = vi.fn();
    const result = setup({ zoom, zoomEnd, zoomed: () => zoomedIn });
    return { ...result, zoom, zoomEnd };
  }

  it('zooms about the fingers\' centre when they move apart, without scrolling or clicking', () => {
    const { gestures, zoom, zoomEnd, scroll, button } = zoomable();
    gestures.pointerDown(pointer(1, 100, 100));
    gestures.pointerDown(pointer(2, 200, 100));
    gestures.pointerMove(pointer(2, 220, 100));
    expect(zoom).not.toHaveBeenCalled();
    gestures.pointerMove(pointer(2, 260, 100));
    expect(zoom).toHaveBeenCalledExactlyOnceWith(1.6, 180, 100, 30, 0);
    gestures.pointerMove(pointer(1, 20, 100));
    expect(zoom.mock.calls[1]).toEqual([1.5, 140, 100, -40, 0]);
    gestures.pointerUp(pointer(1, 20, 100));
    expect(zoomEnd).not.toHaveBeenCalled();
    // The finger left pans without scaling.
    gestures.pointerMove(pointer(2, 260, 80));
    expect(zoom.mock.calls[2]).toEqual([1, 260, 80, 0, -20]);
    gestures.pointerUp(pointer(2, 260, 80));
    expect(zoomEnd).toHaveBeenCalledOnce();
    expect(scroll).not.toHaveBeenCalled();
    expect(button).not.toHaveBeenCalled();
  });

  it('scrolls two fingers moving together at full size, and pans the picture with them once zoomed in', () => {
    const plain = zoomable(false);
    plain.gestures.pointerDown(pointer(1, 100, 100));
    plain.gestures.pointerDown(pointer(2, 200, 100));
    plain.gestures.pointerMove(pointer(1, 100, 80));
    plain.gestures.pointerMove(pointer(2, 200, 80));
    expect(plain.scroll.mock.calls).toEqual([[0, 10], [0, 10]]);
    expect(plain.zoom).not.toHaveBeenCalled();

    const zoomed = zoomable(true);
    zoomed.gestures.pointerDown(pointer(1, 100, 100));
    zoomed.gestures.pointerDown(pointer(2, 200, 100));
    zoomed.gestures.pointerMove(pointer(1, 100, 80));
    zoomed.gestures.pointerMove(pointer(2, 200, 80));
    expect(zoomed.scroll).not.toHaveBeenCalled();
    expect(zoomed.zoom.mock.calls.map(([factor, x, y, dx, dy]) => [Number(factor.toFixed(3)), x, y, dx, dy])).toEqual([[1.02, 150, 90, 0, -10], [0.981, 150, 80, 0, -10]]);
  });

  it('still taps, holds and two-finger taps while zoomed in', () => {
    const { gestures, button } = zoomable(true);
    gestures.pointerDown(pointer(1, 20, 30));
    gestures.pointerUp(pointer(1, 20, 30));
    gestures.pointerDown(pointer(2, 40, 100));
    gestures.pointerDown(pointer(3, 80, 100));
    gestures.pointerUp(pointer(2, 40, 100));
    gestures.pointerUp(pointer(3, 80, 100));
    expect(button.mock.calls).toEqual([[true, 40, 60], [false, 40, 60], [true, 120, 200, 2], [false, 120, 200, 2]]);
  });
});
