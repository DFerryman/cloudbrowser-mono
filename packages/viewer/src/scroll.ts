/** Neko injects discrete X11 wheel clicks, rather than browser pixel deltas. */
// Chromium's X11 wheel click is 120 pixels (verified with XTest on a real Chrome window).
const PIXELS_PER_TICK = 120;
const GESTURE_GAP_MS = 250;

/** Keep precision-trackpad fractions between frames, with an immediate first wheel click. */
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
      const ticks = Math.trunc(sum / PIXELS_PER_TICK);
      if (!ticks && (first || changed)) return { remainder: 0, ticks: Math.sign(delta) };
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

  /** Commit the last partial click before the target, modifier, or input kind changes. */
  finish(): { x: number; y: number } {
    const result = { x: this.x ? -Math.sign(this.x) : 0, y: this.y ? -Math.sign(this.y) : 0 };
    this.reset();
    return result;
  }
}
