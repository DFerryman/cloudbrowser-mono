/** Neko injects discrete X11 wheel clicks, rather than browser pixel deltas. */
// Chromium's X11 wheel click is 120 pixels (verified with XTest on a real Chrome window).
const PIXELS_PER_TICK = 120;
const GESTURE_GAP_MS = 250;

/**
 * Keep precision-trackpad fractions between frames, with an immediate first wheel click that the
 * movement after it pays for: a gesture scrolls as far as it moved, within half a click.
 */
export class ScrollAccumulator {
  private x = 0;
  private y = 0;
  private lastAt: number | null = null;
  private control = false;
  private directionX = 0;
  private directionY = 0;

  /** Commit old fractions before a later gesture or reversed movement can replace them. */
  needsFinish(dx: number, dy: number, control: boolean, at = Date.now()): boolean {
    if (this.lastAt === null || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    return at - this.lastAt > GESTURE_GAP_MS || this.control !== control
      || (dx !== 0 && this.directionX !== 0 && this.directionX !== Math.sign(dx))
      || (dy !== 0 && this.directionY !== 0 && this.directionY !== Math.sign(dy));
  }

  consume(dx: number, dy: number, control: boolean, at = Date.now()): { x: number; y: number } {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { x: 0, y: 0 };
    const first = this.lastAt === null || at - this.lastAt > GESTURE_GAP_MS || this.control !== control;
    if (first) {
      this.x = this.y = 0;
      this.directionX = this.directionY = 0;
    }
    this.lastAt = at;
    this.control = control;
    const axis = (remainder: number, delta: number, direction: number) => {
      if (!delta) return { remainder, ticks: 0 };
      // Reversing direction must not first pay back a previous movement's remainder.
      const changed = direction !== 0 && direction !== Math.sign(delta);
      const sum = (changed ? 0 : remainder) + delta;
      let ticks = Math.trunc(sum / PIXELS_PER_TICK);
      // Sent at once, the first click is owed by the remainder: forgiving it gained every gesture a
      // click, and rounding the end up another (a 60 px swipe moved the page 240 px).
      if (!ticks && (first || changed)) ticks = Math.sign(delta);
      return { remainder: sum - ticks * PIXELS_PER_TICK, ticks };
    };
    const x = axis(this.x, dx, this.directionX);
    const y = axis(this.y, dy, this.directionY);
    this.x = x.remainder;
    this.y = y.remainder;
    if (dx) this.directionX = Math.sign(dx);
    if (dy) this.directionY = Math.sign(dy);
    // DOM positive deltas mean right/down; Neko positive deltas inject buttons 6/4 (left/up).
    return { x: x.ticks ? -x.ticks : 0, y: y.ticks ? -y.ticks : 0 };
  }

  reset(): void {
    this.x = this.y = 0;
    this.lastAt = null;
    this.control = false;
    this.directionX = this.directionY = 0;
  }

  /**
   * A pause: commit the partial click now, as finish does, but keep the gesture, so movement that
   * resumes soon pays for that click instead of starting with another free one.
   */
  settle(): { x: number; y: number } {
    // Half a click or more in the direction of travel is one click; less, or what the first
    // click still owes, none.
    const click = (remainder: number, direction: number) =>
      direction !== 0 && Math.sign(remainder) === direction && Math.abs(remainder) >= PIXELS_PER_TICK / 2 ? direction : 0;
    const x = click(this.x, this.directionX);
    const y = click(this.y, this.directionY);
    this.x -= x * PIXELS_PER_TICK;
    this.y -= y * PIXELS_PER_TICK;
    return { x: x ? -x : 0, y: y ? -y : 0 };
  }

  /** Commit the last partial click before the target, modifier, or input kind changes. */
  finish(): { x: number; y: number } {
    const result = this.settle();
    this.reset();
    return result;
  }
}
