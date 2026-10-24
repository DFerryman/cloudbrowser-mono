/** How far a pinch zooms the picture in. */
export const MAX_ZOOM = 4;
/** A pinch that ends below this zoom returns to the whole picture: a slight zoom only looks blurred. */
const SETTLE_BELOW = 1.1;

type Size = { width: number; height: number };

/**
 * The picture zoomed in on this device, for small screens: the remote page itself is not zoomed.
 * A point in the picture's frame is shown at offset + scale × point, and input maps back through
 * it. The zoomed picture always covers the frame, so it never moves off an edge.
 */
export class PictureZoom {
  scale = 1;
  x = 0;
  y = 0;

  /** Scales by `factor` about (cx, cy), which moved by (dx, dy): what was under the fingers stays under them. */
  pinch(factor: number, cx: number, cy: number, dx: number, dy: number, frame: Size): void {
    const scale = Math.min(MAX_ZOOM, Math.max(1, this.scale * (Number.isFinite(factor) && factor > 0 ? factor : 1)));
    const px = (cx - dx - this.x) / this.scale;
    const py = (cy - dy - this.y) / this.scale;
    this.scale = scale;
    this.x = cx - scale * px;
    this.y = cy - scale * py;
    this.clamp(frame);
  }

  clamp(frame: Size): void {
    this.x = Math.min(0, Math.max(frame.width * (1 - this.scale), this.x));
    this.y = Math.min(0, Math.max(frame.height * (1 - this.scale), this.y));
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
