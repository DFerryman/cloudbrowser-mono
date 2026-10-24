/** How far a pinch zooms the picture in. */
export const MAX_ZOOM = 4;
/** A pinch that ends below this zoom returns to the whole picture: a slight zoom only looks blurred. */
const SETTLE_BELOW = 1.1;

type Size = { width: number; height: number };
type Rect = { left: number; top: number; width: number; height: number };

/**
 * One axis of the offset: a picture shown larger than the frame never shows past its edges, and
 * one still smaller (a letterboxed picture) stays centred.
 */
function fit(offset: number, scale: number, size: number, start: number, length: number): number {
  const shown = scale * length;
  if (shown <= size) return (size - shown) / 2 - scale * start;
  // `|| 0`: an edge at 0 gives 0, not -0.
  return Math.min(-scale * start, Math.max(size - scale * (start + length), offset)) || 0;
}

/**
 * The picture zoomed in on this device, for small screens: the remote page itself is not zoomed.
 * A point in the picture's frame is shown at offset + scale × point, and input maps back through
 * it. `picture` is where the picture is painted in the frame (pictureRect), the whole frame by
 * default.
 */
export class PictureZoom {
  scale = 1;
  x = 0;
  y = 0;

  /** Scales by `factor` about (cx, cy), which moved by (dx, dy): what was under the fingers stays under them. */
  pinch(factor: number, cx: number, cy: number, dx: number, dy: number, frame: Size, picture?: Rect): void {
    const scale = Math.min(MAX_ZOOM, Math.max(1, this.scale * (Number.isFinite(factor) && factor > 0 ? factor : 1)));
    const px = (cx - dx - this.x) / this.scale;
    const py = (cy - dy - this.y) / this.scale;
    this.scale = scale;
    this.x = cx - scale * px;
    this.y = cy - scale * py;
    this.clamp(frame, picture);
  }

  clamp(frame: Size, picture: Rect = { left: 0, top: 0, width: frame.width, height: frame.height }): void {
    this.x = fit(this.x, this.scale, frame.width, picture.left, picture.width);
    this.y = fit(this.y, this.scale, frame.height, picture.top, picture.height);
  }

  settle(): void {
    if (this.scale < SETTLE_BELOW) this.reset();
  }

  reset(): void {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
  }

  get zoomed(): boolean {
    return this.scale > 1;
  }

  /** A point as shown, back in the unzoomed frame. */
  unzoom(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.x) / this.scale, y: (y - this.y) / this.scale };
  }

  /** The CSS transform that shows it, about the frame's top-left corner. */
  get transform(): string {
    return this.zoomed ? `translate(${this.x}px, ${this.y}px) scale(${this.scale})` : '';
  }
}
