/** Observe one decoded frame from this exact stream, with a fallback for older browsers. */
export function observeFirstFrame(video: HTMLVideoElement, stream: MediaStream, received: () => void): () => void {
  let active = true;
  let frame: number | undefined;
  const finish = () => {
    if (!active || video.srcObject !== stream) return;
    active = false;
    video.removeEventListener('loadeddata', loaded);
    received();
  };
  const loaded = () => {
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish();
  };
  if (typeof video.requestVideoFrameCallback === 'function') frame = video.requestVideoFrameCallback(finish);
  else video.addEventListener('loadeddata', loaded);
  return () => {
    active = false;
    video.removeEventListener('loadeddata', loaded);
    if (frame !== undefined && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frame);
  };
}
