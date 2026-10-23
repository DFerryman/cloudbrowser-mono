/** The one fitted rectangle used for both video layout and input mapping. */
export function pictureRect(
  box: { left: number; top: number; width: number; height: number },
  video: { width: number; height: number },
) {
  if (box.width <= 0 || box.height <= 0) return { left: box.left, top: box.top, width: 0, height: 0 };
  const width = video.width || box.width;
  const height = video.height || box.height;
  const scale = Math.min(box.width / width, box.height / height);
  return { left: box.left + (box.width - width * scale) / 2, top: box.top + (box.height - height * scale) / 2, width: width * scale, height: height * scale };
}

/**
 * Box coordinates → remote pixels, accounting for the explicit picture rectangle. A lower
 * picture level is a downscaled video of the same desktop, so positions are scaled to the remote
 * screen when it is known, not to the video's own pixels.
 */
export function toRemotePoint(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  video: { width: number; height: number },
  screen: { width: number; height: number } | null,
): { x: number; y: number } | null {
  const vw = video.width || box.width;
  const vh = video.height || box.height;
  const picture = pictureRect(box, video);
  if (picture.width <= 0 || picture.height <= 0 || clientX < picture.left || clientY < picture.top || clientX >= picture.left + picture.width || clientY >= picture.top + picture.height) return null;
  // A picture level keeps the screen's shape. Right after a resize the old frames may still
  // show while neko already reports the new screen: map to what is on screen then.
  const sameShape = screen && Math.abs(screen.width / screen.height - vw / vh) < 0.02;
  const width = sameShape ? screen.width : vw;
  const height = sameShape ? screen.height : vh;
  return {
    x: Math.min(((clientX - picture.left) / picture.width) * width, width - 1),
    y: Math.min(((clientY - picture.top) / picture.height) * height, height - 1),
  };
}

type Rect = { left: number; top: number; width: number; height: number };

/** The coordinates a pointer, wheel or drag event carries. */
export interface PositionedEvent {
  clientX: number;
  clientY: number;
  offsetX?: number;
  offsetY?: number;
  target?: unknown;
}

/**
 * A point in an element's padding box. For an event the element itself received, the browser's
 * offsetX/offsetY are used: it computed them against the element with the geometry it hit-tested,
 * so the point stays right where client coordinates and element rectangles disagree, as on iOS
 * Safari while the on-screen keyboard pans the page, or after it (iOS 26 leaves the visual
 * viewport offset). An event delivered to another element, or without offsets, uses the rectangle.
 */
export function elementPoint(
  event: PositionedEvent,
  element: { getBoundingClientRect(): Rect; clientLeft: number; clientTop: number },
): { x: number; y: number } {
  if (event.target === element && typeof event.offsetX === 'number' && typeof event.offsetY === 'number'
    && Number.isFinite(event.offsetX) && Number.isFinite(event.offsetY)) {
    return { x: event.offsetX, y: event.offsetY };
  }
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left - element.clientLeft, y: event.clientY - rect.top - element.clientTop };
}

/**
 * The view turned a quarter clockwise (a phone held sideways): the picture's frame as laid out
 * before the turn, centered on the box, and a client point carried back into that frame.
 */
export function unrotate(clientX: number, clientY: number, box: Rect): { x: number; y: number; frame: Rect } {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return {
    x: cx + (clientY - cy),
    y: cy - (clientX - cx),
    frame: { left: cx - box.height / 2, top: cy - box.width / 2, width: box.height, height: box.width },
  };
}
