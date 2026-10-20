/**
 * Client coordinates → remote pixels, accounting for letterboxing (object-fit: contain). A lower
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
  const scale = Math.min(box.width / vw, box.height / vh);
  const ox = box.left + (box.width - vw * scale) / 2;
  const oy = box.top + (box.height - vh * scale) / 2;
  if (scale <= 0 || clientX < ox || clientY < oy || clientX >= ox + vw * scale || clientY >= oy + vh * scale) return null;
  // A picture level keeps the screen's shape. Right after a resize the old frames may still
  // show while neko already reports the new screen: map to what is on screen then.
  const sameShape = screen && Math.abs(screen.width / screen.height - vw / vh) < 0.02;
  const width = sameShape ? screen.width : vw;
  const height = sameShape ? screen.height : vh;
  return {
    x: Math.min(((clientX - ox) / (vw * scale)) * width, width - 1),
    y: Math.min(((clientY - oy) / (vh * scale)) * height, height - 1),
  };
}

type Rect = { left: number; top: number; width: number; height: number };

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
