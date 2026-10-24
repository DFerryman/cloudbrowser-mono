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
/** A finger held still this long is pressed for the context menu: lifted, it right-clicks; moved, it drags. */
export const HOLD_MS = 500;
/**
 * A tap this soon after another, and this close to it, clicks exactly where the first one did:
 * Chrome counts a double-click only within 4 remote pixels and 500 ms, and two taps rarely land
 * that close.
 */
export const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_SLOP = 24;
/** Two fingers that lift this soon after the first touched, without moving, right-click. */
export const TWO_FINGER_TAP_MS = 500;
/**
 * How far two fingers must move apart or together, in multiples of the threshold, before they
 * zoom rather than scroll. One finger's move is reported before the other's, so two fingers
 * scrolling side by side briefly look like a small pinch.
 */
const PINCH_SLACK = 3;

export interface TouchGestureOptions {
  /** Maps a client position to the remote desktop; null excludes letterboxing. */
  mapPoint(clientX: number, clientY: number): TouchPoint | null;
  move(x: number, y: number): void;
  /** A button transition at the supplied remote coordinates: the left button, or the right (DOM button 2). */
  button(down: boolean, x: number, y: number, domButton?: 2): void;
  /** Wheel deltas in CSS pixels: dragging a finger upward scrolls downward. */
  scroll(deltaX: number, deltaY: number): void;
  /**
   * Two fingers pinched or, while zoomed in, moved: scale the picture by `factor` about the
   * fingers' centre (x, y), which moved by (dx, dy) since the last call. Without it, two fingers
   * only scroll.
   */
  zoom?(factor: number, x: number, y: number, dx: number, dy: number): void;
  /** The fingers that zoomed have all lifted. */
  zoomEnd?(): void;
  /** Whether the picture is zoomed in: two fingers then pan it instead of scrolling the page. */
  zoomed?(): boolean;
  /** A finger has been held long enough to right-click or drag, at the position the events carry. */
  held?(x: number, y: number): void;
  activity?(): void;
  /** Movement needed to distinguish a one-finger scroll from a tap. Defaults to 8 CSS pixels. */
  thresholdPx?: number;
}

/**
 * Touch gestures, independently of mouse input:
 * - a tap clicks, and a second tap close to it double-clicks where the first one did;
 * - a finger held still right-clicks when it lifts, or drags with the left button once it moves
 *   (selecting text, moving a slider);
 * - a finger or two moved scroll the page; two fingers tapped together right-click;
 * - two fingers pinched zoom the picture (when `zoom` is given), and pan it while it is zoomed in.
 * A touch never holds a mouse button while its intent is still unknown. The caller owns
 * preventDefault and pointer capture, and should reset on blur or page hiding.
 */
export class TouchGestureController {
  private readonly pointers = new Map<number, TouchPoint>();
  private readonly threshold: number;
  private mode: 'tap' | 'held' | 'drag' | 'two' | 'scroll' | 'zoom' | null = null;
  private anchor: TouchPoint | null = null;
  /** The fingers' distance apart (the anchor's spread), for pinches. */
  private spread = 0;
  private scrollPoint: TouchPoint | null = null;
  private hasScrolled = false;
  private startedAt = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where a held finger presses, and where a drag's button is down now. */
  private pressAt: TouchPoint | null = null;
  /** Where two fingers that tap together right-click. */
  private twoAt: TouchPoint | null = null;
  /** Two fingers moved before deciding what to do, so they no longer tap. */
  private twoMoved = false;
  private lastTap: { local: TouchPoint; remote: TouchPoint; at: number } | null = null;

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
    // A held or dragging finger keeps the gesture to itself.
    if (this.mode === 'held' || this.mode === 'drag') return false;
    const remote = this.options.mapPoint(event.clientX, event.clientY);
    if (!remote) return false;
    this.pointers.set(event.pointerId, this.position(event));
    if (this.pointers.size === 1) {
      this.mode = 'tap';
      this.startedAt = Date.now();
      this.startHold();
    } else {
      this.cancelHold();
      if (this.mode === 'tap' || this.mode === null) this.mode = this.pointers.size === 2 ? 'two' : 'scroll';
      else if (this.mode === 'two') this.mode = 'scroll';
    }
    // Adding a finger changes the centroid, but must not itself scroll the page.
    this.anchor = this.centroid();
    this.spread = this.currentSpread();
    if (this.mode === 'two') this.twoAt = this.options.mapPoint(this.anchor.x, this.anchor.y);
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
    const moved = Math.hypot(deltaX, deltaY);
    if (this.mode === 'tap') {
      if (moved <= this.threshold) return;
      this.cancelHold();
      this.mode = 'scroll';
    } else if (this.mode === 'held') {
      if (moved <= this.threshold) return;
      // The button goes down where the finger was held, so a selection starts there.
      const press = this.pressAt!;
      this.mode = 'drag';
      this.options.move(press.x, press.y);
      this.options.button(true, press.x, press.y);
    } else if (this.mode === 'two') {
      const pinched = Math.abs(this.currentSpread() - this.spread);
      if (moved > this.threshold || pinched > this.threshold) this.twoMoved = true;
      if (this.options.zoom && (pinched > this.threshold * PINCH_SLACK || (this.options.zoomed?.() && moved > this.threshold))) {
        this.mode = 'zoom';
        // Zooming maps the same spot on the screen elsewhere: the next tap is a new one.
        this.lastTap = null;
      } else if (moved > this.threshold && (!this.options.zoom || pinched < moved)) {
        this.mode = 'scroll';
      } else {
        return;
      }
    }
    if (this.mode === 'drag') {
      const remote = this.options.mapPoint(point.x, point.y);
      // Beyond the picture's edge the button stays down at the last point on it.
      if (remote) {
        this.pressAt = remote;
        this.options.move(remote.x, remote.y);
      }
      this.anchor = point;
      this.options.activity?.();
      return;
    }
    if (this.mode === 'zoom') {
      const spread = this.currentSpread();
      // One finger left of a pinch pans the picture without scaling it.
      const factor = this.pointers.size > 1 && this.spread > 0 && spread > 0 ? spread / this.spread : 1;
      this.anchor = point;
      this.spread = spread;
      if (factor !== 1 || deltaX || deltaY) {
        this.options.zoom?.(factor, point.x, point.y, point.x - anchor.x, point.y - anchor.y);
        this.options.activity?.();
      }
      return;
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
    // a tap or a hold only shifted as the finger lifted: it clicks where the finger rested.
    const anchor = this.anchor;
    const resting = (this.mode === 'tap' || this.mode === 'held') && this.pointers.size === 1 && !!anchor
      && Math.hypot(anchor.x - event.clientX, anchor.y - event.clientY) <= this.threshold * LIFT_SLACK;
    if (!resting) this.pointerMove(event);
    const lastFinger = this.pointers.size === 1;
    if (this.mode === 'tap' && lastFinger) {
      // A tap released outside the desktop clicks nothing.
      const released = this.options.mapPoint(event.clientX, event.clientY);
      const local = resting ? last : this.position(event);
      let tap = released && resting ? this.options.mapPoint(last.x, last.y) : released;
      if (tap) {
        const now = Date.now();
        const previous = this.lastTap;
        if (previous && now - previous.at <= DOUBLE_TAP_MS && Math.hypot(previous.local.x - local.x, previous.local.y - local.y) <= DOUBLE_TAP_SLOP) {
          tap = previous.remote;
          this.lastTap = { ...previous, at: now };
        } else {
          this.lastTap = { local, remote: tap, at: now };
        }
        this.click(tap);
      }
    } else if (this.mode === 'held' && lastFinger && this.pressAt) {
      this.lastTap = null;
      this.click(this.pressAt, 2);
    } else if (this.mode === 'drag' && this.pressAt) {
      this.options.button(false, this.pressAt.x, this.pressAt.y);
      this.pressAt = null;
      this.options.activity?.();
    } else if (this.mode === 'two' && lastFinger && this.twoAt && !this.twoMoved && Date.now() - this.startedAt <= TWO_FINGER_TAP_MS) {
      this.lastTap = null;
      this.click(this.twoAt, 2);
    }
    this.remove(event.pointerId);
  }

  pointerCancel(event: TouchPointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    this.cancelHold();
    if (this.mode === 'drag') this.release();
    // A remaining finger can continue scrolling, but a canceled gesture must never become a tap.
    if (this.mode !== 'zoom') this.mode = 'scroll';
    this.remove(event.pointerId);
  }

  reset(): void {
    this.release();
    this.lastTap = null;
    this.clear();
  }

  private click(at: TouchPoint, domButton?: 2): void {
    const press = (down: boolean) => domButton ? this.options.button(down, at.x, at.y, domButton) : this.options.button(down, at.x, at.y);
    this.options.move(at.x, at.y);
    try {
      press(true);
    } finally {
      press(false);
    }
    this.options.activity?.();
  }

  /** Lets go of a drag's button. */
  private release(): void {
    if (this.mode === 'drag' && this.pressAt) this.options.button(false, this.pressAt.x, this.pressAt.y);
    this.pressAt = null;
  }

  private startHold(): void {
    this.cancelHold();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      const anchor = this.anchor;
      if (this.mode !== 'tap' || this.pointers.size !== 1 || !anchor) return;
      const remote = this.options.mapPoint(anchor.x, anchor.y);
      if (!remote) return;
      this.mode = 'held';
      this.pressAt = remote;
      this.options.held?.(anchor.x, anchor.y);
      this.options.activity?.();
    }, HOLD_MS);
  }

  private cancelHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  /** Forgets the gesture; a tap still pairs with the next one. */
  private clear(): void {
    this.cancelHold();
    const zoomed = this.mode === 'zoom';
    this.pointers.clear();
    this.mode = null;
    this.anchor = null;
    this.spread = 0;
    this.scrollPoint = null;
    this.hasScrolled = false;
    this.pressAt = null;
    this.twoAt = null;
    this.twoMoved = false;
    if (zoomed) this.options.zoomEnd?.();
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

  /** Twice the fingers' mean distance from their centroid: for two fingers, their distance apart. */
  private currentSpread(): number {
    if (this.pointers.size < 2) return 0;
    const centre = this.centroid();
    let sum = 0;
    for (const point of this.pointers.values()) sum += Math.hypot(point.x - centre.x, point.y - centre.y);
    return (2 * sum) / this.pointers.size;
  }

  private remove(pointerId: number): void {
    this.pointers.delete(pointerId);
    if (this.pointers.size === 0) this.clear();
    else {
      this.anchor = this.centroid();
      this.spread = this.currentSpread();
    }
  }
}
