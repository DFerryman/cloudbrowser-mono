/** Fixed playback outcomes; exception messages, URLs and media content are never exported. */
export type PlaybackState = 'unknown' | 'resolved' | 'not_allowed' | 'unsupported' | 'aborted' | 'failed';

export interface PlaybackSnapshot {
  paused: boolean;
  readyState: 0 | 1 | 2 | 3 | 4;
  width: number;
  height: number;
  visibility: 'visible' | 'hidden' | 'unknown';
  playState: PlaybackState;
  frameCallback: boolean;
}

export interface PlaybackOptions {
  visibility?: unknown;
  playState?: unknown;
  frameCallback?: unknown;
}

/** Classify a rejected play() by its standard name alone, including hostile error objects. */
export function playbackFailure(error: unknown): Exclude<PlaybackState, 'unknown' | 'resolved'> {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return 'failed';
    const name = (error as { name?: unknown }).name;
    if (name === 'NotAllowedError') return 'not_allowed';
    if (name === 'NotSupportedError') return 'unsupported';
    if (name === 'AbortError') return 'aborted';
  } catch { /* Accessors must not turn diagnostics into a playback failure. */ }
  return 'failed';
}

/** What startPlayback uses of a <video>. */
export interface PlayableVideo {
  muted: boolean;
  play(): Promise<void>;
}

/**
 * Plays the element and reports the outcome while `current` holds. WebKit refuses to play an
 * unmuted <video> that mounts again (or gets a new stream) without a user gesture; the picture
 * then stayed black until the connection deadline replaced the connection, which met the same
 * refusal, again and again. Muted playback needs no gesture: the element is muted, `muted` tells
 * the page, and it plays again once.
 */
export function startPlayback(video: PlayableVideo, options: { current: () => boolean; report: (state: PlaybackState) => void; muted: () => void }): void {
  const failed = (error: unknown, retry: boolean) => {
    if (!options.current()) return;
    const state = playbackFailure(error);
    options.report(state);
    if (state !== 'not_allowed' || !retry || video.muted) return;
    video.muted = true;
    options.muted();
    attempt(false);
  };
  const attempt = (retry: boolean) => {
    try {
      void video.play().then(
        () => { if (options.current()) options.report('resolved'); },
        (error: unknown) => failed(error, retry),
      );
    } catch (error) {
      failed(error, retry);
    }
  };
  attempt(true);
}

function dimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 32_768;
}

function playState(value: unknown): PlaybackState {
  switch (value) {
    case 'resolved': case 'not_allowed': case 'unsupported': case 'aborted': case 'failed':
      return value;
    default:
      return 'unknown';
  }
}

/**
 * Read only the video properties needed to distinguish missing media from blocked playback.
 * A missing/malformed element yields no snapshot; optional caller state uses fixed fallbacks.
 */
export function readPlayback(video: unknown, options: PlaybackOptions = {}): PlaybackSnapshot | undefined {
  try {
    if (video === null || typeof video !== 'object') return undefined;
    const source = video as { paused?: unknown; readyState?: unknown; videoWidth?: unknown; videoHeight?: unknown };
    const paused = source.paused;
    const readyState = source.readyState;
    const width = source.videoWidth;
    const height = source.videoHeight;
    if (typeof paused !== 'boolean' || typeof readyState !== 'number' || !Number.isInteger(readyState)
      || readyState < 0 || readyState > 4 || !dimension(width) || !dimension(height)) return undefined;
    const frameCallback = options.frameCallback;
    if (frameCallback !== undefined && typeof frameCallback !== 'boolean') return undefined;
    const visibility = options.visibility;
    return {
      paused, readyState: readyState as PlaybackSnapshot['readyState'], width, height,
      visibility: visibility === 'visible' || visibility === 'hidden' ? visibility : 'unknown',
      playState: playState(options.playState),
      frameCallback: frameCallback ?? false,
    };
  } catch {
    return undefined;
  }
}

/** Whether the attached stream currently has a live video track and a playable picture. */
export function isDisplaying(video: unknown): boolean {
  try {
    const playback = readPlayback(video);
    if (!playback || playback.paused || playback.readyState < 2 || playback.width === 0 || playback.height === 0) return false;
    const source = video as { ended?: unknown; srcObject?: unknown };
    if (source.ended !== false) return false;
    const stream = source.srcObject;
    if (stream === null || typeof stream !== 'object') return false;
    const getVideoTracks = (stream as { getVideoTracks?: unknown }).getVideoTracks;
    if (typeof getVideoTracks !== 'function') return false;
    const tracks: unknown = Reflect.apply(getVideoTracks, stream, []);
    if (!Array.isArray(tracks)) return false;
    return Array.prototype.some.call(tracks, (track: unknown) => {
      if (track === null || typeof track !== 'object') return false;
      const current = track as { kind?: unknown; readyState?: unknown };
      return current.kind === 'video' && current.readyState === 'live';
    });
  } catch {
    return false;
  }
}
