/** The page's visibility, for a frame the browser does not present while the page is hidden. */
type Page = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/**
 * Observe one frame from this exact stream: a presented one (requestVideoFrameCallback) where the
 * browser reports it, else a decoded one (loadeddata, or resize when audio came first). A hidden
 * page presents nothing, so there a decoded frame is the proof, also when the page is hidden after
 * the video has data: waiting for the page to be shown timed the attempt out (connection_timeout)
 * with the video playing.
 */
export function observeFirstFrame(video: HTMLVideoElement, stream: MediaStream, received: () => void, page: Page | undefined = globalThis.document): () => void {
  let active = true;
  let frame: number | undefined;
  const presents = typeof video.requestVideoFrameCallback === 'function';
  const stop = () => {
    active = false;
    video.removeEventListener('loadeddata', decoded);
    video.removeEventListener('resize', decoded);
    page?.removeEventListener('visibilitychange', decoded);
    if (frame !== undefined && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frame);
  };
  const finish = () => {
    if (!active || video.srcObject !== stream) return;
    stop();
    received();
  };
  const decoded = () => {
    if (presents && page?.visibilityState !== 'hidden') return;
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish();
  };
  if (presents) frame = video.requestVideoFrameCallback(finish);
  video.addEventListener('loadeddata', decoded);
  video.addEventListener('resize', decoded);
  page?.addEventListener('visibilitychange', decoded);
  return stop;
}
