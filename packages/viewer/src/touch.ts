export interface TouchPoint {
  x: number;
  y: number;
}

/** The pointer coordinates used by touch gestures; a DOM PointerEvent satisfies this interface. */
export interface TouchPointerEvent {
  pointerId: number;
  clientX: number;
  clientY: number;
  /** The first finger of a new touch: no other finger is down. */
  isPrimary?: boolean;
}

/**
 * A finger shifts as it lifts. Within this many times the threshold, a tap's last position does
 * not turn it into a scroll: the lift alone used to cancel taps that never moved before it.
 */
const LIFT_SLACK = 2;

export interface TouchGestureOptions {
  /** Maps a client position to the remote desktop; null excludes letterboxing. */
  mapPoint(clientX: number, clientY: number): TouchPoint | null;
  move(x: number, y: number): void;
  /** A left-button transition at the supplied remote coordinates. */
  button(down: boolean, x: number, y: number): void;
  /** Wheel deltas in CSS pixels: dragging a finger upward scrolls downward. */
  scroll(deltaX: number, deltaY: number): void;
  activity?(): void;
  /** Movement needed to distinguish a one-finger scroll from a tap. Defaults to 8 CSS pixels. */
  thresholdPx?: number;
}

/**
 * Touch input has tap and scroll gestures, independently of mouse input. A touch never holds a
 * mouse button while its intent is still unknown, and a gesture involving two fingers cannot tap.
 * The caller owns preventDefault and pointer capture, and should reset on blur or page hiding.
 */
export class TouchGestureController {
  private readonly pointers = new Map<number, TouchPoint>();
  private readonly threshold: number;
  private mode: 'tap' | 'scroll' | null = null;
  private anchor: TouchPoint | null = null;
  private scrollPoint: TouchPoint | null = null;
  private hasScrolled = false;

  constructor(private readonly options: TouchGestureOptions) {
    const threshold = options.thresholdPx ?? 8;
    this.threshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : 8;
  }

  /** Returns whether this pointer began on the remote desktop and can be captured. */
  pointerDown(event: TouchPointerEvent): boolean {
    if (this.pointers.has(event.pointerId)) return false;
    // A primary touch means no other finger is down: any still tracked lost its pointerup or
    // pointercancel (a system gesture took over), and would turn every later tap into a
    // two-finger scroll until the page lost focus.
    if (event.isPrimary && this.pointers.size > 0) this.reset();
    const remote = this.options.mapPoint(event.clientX, event.clientY);
    if (!remote) return false;
    this.pointers.set(event.pointerId, this.position(event));
    this.mode = this.pointers.size === 1 ? 'tap' : 'scroll';
    // Adding a finger changes the centroid, but must not itself scroll the page.
    this.anchor = this.centroid();
    if (!this.hasScrolled) {
      this.scrollPoint = this.pointers.size === 1
        ? remote
        : this.options.mapPoint(this.anchor.x, this.anchor.y) ?? remote;
    }
    this.options.activity?.();
    return true;
  }

  pointerMove(event: TouchPointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, this.position(event));
    const point = this.centroid();
    const anchor = this.anchor;
    if (!anchor) return;
    const deltaX = anchor.x - point.x;
    const deltaY = anchor.y - point.y;
    if (this.mode === 'tap') {
      if (Math.hypot(deltaX, deltaY) <= this.threshold) return;
      this.mode = 'scroll';
    }
    this.anchor = point;
    if (deltaX || deltaY) {
      // Wheel events act at the remote pointer. Keep them over the gesture's original target,
      // so dragging across a page does not switch between adjacent scrollable elements.
      if (this.scrollPoint) this.options.move(this.scrollPoint.x, this.scrollPoint.y);
      this.options.scroll(deltaX, deltaY);
      this.hasScrolled = true;
      this.options.activity?.();
    }
  }

  pointerUp(event: TouchPointerEvent): void {
    const last = this.pointers.get(event.pointerId);
    if (!last) return;
    // Include the final coordinates even if the platform coalesced the last pointermove, unless
    // a tap only shifted as the finger lifted: it clicks where the finger rested.
    const anchor = this.anchor;
    const lifted = this.mode === 'tap' && this.pointers.size === 1 && !!anchor
      && Math.hypot(anchor.x - event.clientX, anchor.y - event.clientY) <= this.threshold * LIFT_SLACK;
    if (!lifted) this.pointerMove(event);
    // A tap released outside the desktop clicks nothing.
    const released = this.mode === 'tap' && this.pointers.size === 1 ? this.options.mapPoint(event.clientX, event.clientY) : null;
    const tap = released && lifted ? this.options.mapPoint(last.x, last.y) : released;
    this.remove(event.pointerId);
    if (tap) {
      this.options.move(tap.x, tap.y);
      try {
        this.options.button(true, tap.x, tap.y);
      } finally {
        this.options.button(false, tap.x, tap.y);
      }
      this.options.activity?.();
    }
  }

  pointerCancel(event: TouchPointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    // A remaining finger can continue scrolling, but a canceled gesture must never become a tap.
    this.mode = 'scroll';
    this.remove(event.pointerId);
  }

  reset(): void {
    this.pointers.clear();
    this.mode = null;
    this.anchor = null;
    this.scrollPoint = null;
    this.hasScrolled = false;
  }

  private position(event: TouchPointerEvent): TouchPoint {
    return { x: event.clientX, y: event.clientY };
  }

  private centroid(): TouchPoint {
    let x = 0;
    let y = 0;
    for (const point of this.pointers.values()) {
      x += point.x;
      y += point.y;
    }
    return { x: x / this.pointers.size, y: y / this.pointers.size };
  }

  private remove(pointerId: number): void {
    this.pointers.delete(pointerId);
    if (this.pointers.size === 0) this.reset();
    else this.anchor = this.centroid();
  }
}
