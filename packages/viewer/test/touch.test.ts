import { describe, expect, it, vi } from 'vitest';
import { TouchGestureController, type TouchGestureOptions } from '../src/touch.js';

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

  it('never clicks a stationary two-finger gesture, and allows a new single-finger tap afterward', () => {
    const { gestures, button, scroll } = setup();
    gestures.pointerDown(pointer(1, 40, 100));
    gestures.pointerDown(pointer(2, 80, 100));
    gestures.pointerUp(pointer(1, 40, 100));
    gestures.pointerUp(pointer(2, 80, 100));
    expect(button).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();

    gestures.pointerDown(pointer(3, 30, 20));
    gestures.pointerUp(pointer(3, 30, 20));
    expect(button.mock.calls).toEqual([[true, 60, 40], [false, 60, 40]]);
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
    // A second finger of the same touch still makes it a two-finger gesture, never a tap.
    gestures.pointerDown({ ...pointer(3, 20, 20), isPrimary: true });
    gestures.pointerDown({ ...pointer(4, 60, 20), isPrimary: false });
    gestures.pointerUp(pointer(4, 60, 20));
    gestures.pointerUp(pointer(3, 20, 20));
    expect(button).toHaveBeenCalledTimes(2);
    expect(scroll).not.toHaveBeenCalled();
  });
});
