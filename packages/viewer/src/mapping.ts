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
  const width = screen?.width ?? vw;
  const height = screen?.height ?? vh;
  return {
    x: Math.min(((clientX - ox) / (vw * scale)) * width, width - 1),
    y: Math.min(((clientY - oy) / (vh * scale)) * height, height - 1),
  };
}
