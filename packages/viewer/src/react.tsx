import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from 'react';
import { isMac } from './keyboard.js';
import { elementPoint, pictureRect, remoteSpace, toRemotePoint, unrotate, type PositionedEvent } from './mapping.js';
import { squarePixels } from './neko.js';
import type { ConnectionDiagnostic, VideoQuality } from '@cloudbrowser/contracts';
import type { VideoPreference } from './quality.js';
import { RemoteBrowser, type AutomationStatus, type ConnectInfo, type ViewerState } from './remote-browser.js';
import type { ViewerStats } from './stats.js';
import { TouchGestureController } from './touch.js';
import { TextInputController } from './text-input.js';
import type { InputFailure } from './input-queue.js';
import { pastedFiles, type TransferUpdate } from './file-transfer.js';
import { observeFirstFrame } from './first-frame.js';
import { isDisplaying, readPlayback, startPlayback, type PlaybackState } from './playback.js';

/** Image types Chrome cannot paste from the X clipboard; one is pasted as a PNG instead. */
const CONVERTED_IMAGES = ['image/jpeg', 'image/webp', 'image/bmp', 'image/avif'];

/** Re-encodes one pasted image as PNG, the only image Chrome reads from the X clipboard. */
async function asPng(file: File): Promise<File> {
  if (!CONVERTED_IMAGES.includes(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.png', { type: 'image/png' }) : file;
  } catch {
    return file; // Pasted as a file instead.
  }
}

export interface RemoteBrowserHandle {
  /** Whether the current video element is playing a live video track with a usable picture. */
  isDisplaying(): boolean;
  sendCombo(names: string[]): void;
  /** Pastes local text into the remote page: remote clipboard, then Ctrl+V. */
  paste(text: string): void;
  /** Pastes local files into the focused field, as Ctrl+V with them on the clipboard would. */
  pasteFiles(files: File[]): void;
  focus(): void;
  toggleKeyboard(): void;
  reconnect(): void;
}

export interface RemoteBrowserViewProps {
  getConnectInfo: () => Promise<ConnectInfo>;
  onState?: (state: ViewerState, attempt: number) => void;
  onDiagnostic?: (diagnostic: ConnectionDiagnostic) => void;
  onStats?: (stats: ViewerStats) => void;
  /** Called on any user input, for the idle timeout. */
  onInput?: () => void;
  onKeyboardChange?: (open: boolean) => void;
  onInputError?: (reason: InputFailure) => void;
  /**
   * Shows the remote screen a quarter turn clockwise, for a phone held sideways in portrait
   * orientation; the remote screen then takes the turned shape. Input follows the turn.
   */
  rotated?: boolean;
  /** Files pasted or dropped into the view: started, progressing, done or failed. */
  onTransfer?: (update: TransferUpdate) => void;
  /** A coding agent's bridge connected or left, or control changed hands. */
  onAutomation?: (status: AutomationStatus) => void;
  /**
   * Shows where each pointer down and up is registered (a marker at the point the browser
   * reported, in the box) with the geometry behind the mapping, for a screenshot.
   */
  debug?: boolean;
  /** Picture quality; the sharpest level adapting to the connection by default. Changes apply to the live stream. */
  video?: VideoPreference;
  /** The level being streamed now. */
  onVideo?: (quality: VideoQuality) => void;
  /** The most desktop pixels to ask for (TIERS[tier].maxScreenPixels), read once per viewer. */
  maxScreenPixels?: number;
  muted?: boolean;
  /**
   * The viewer muted itself: the browser refused to play the stream with sound before a user
   * gesture (WebKit, when the view mounts again unmuted). The page shows sound as off.
   */
  onMutedChange?: (muted: boolean) => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * The live view (page 5): the remote screen rendered 1:1, input mapped to remote pixels, a hidden
 * textarea that owns the keyboard (so IME composition works), and the remote cursor drawn locally.
 */
export const RemoteBrowserView = forwardRef<RemoteBrowserHandle, RemoteBrowserViewProps>(function RemoteBrowserView(
  { getConnectInfo, onState, onDiagnostic, onStats, onInput, onKeyboardChange, onInputError, onTransfer, onAutomation, rotated = false, debug = false, video, onVideo, maxScreenPixels, muted = true, onMutedChange, className, style },
  ref,
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const browserRef = useRef<RemoteBrowser | null>(null);
  const textInputRef = useRef<TextInputController | null>(null);
  const keyboardRequested = useRef(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [touchDevice] = useState(() => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  const [cursor, setCursor] = useState('default');
  const [dragging, setDragging] = useState(false);
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  /**
   * The one frame size behind the painted rectangle and the input mapping: the decoded frame's
   * pixels, from the frame being presented where the browser reports it (requestVideoFrameCallback)
   * and from the element's resize events otherwise. `source` is whichever saw the last change.
   */
  const [pictureSize, setPictureSize] = useState<{ width: number; height: number; source: 'none' | 'frame' | 'element' }>({ width: 0, height: 0, source: 'none' });
  const pictureSizeRef = useRef(pictureSize);
  pictureSizeRef.current = pictureSize;
  const rotatedRef = useRef(rotated);
  rotatedRef.current = rotated;
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const [debugInfo, setDebugInfo] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const statsRef = useRef<ViewerStats | null>(null);
  const callbacks = useRef({ getConnectInfo, onState, onDiagnostic, onStats, onInput, onKeyboardChange, onInputError, onVideo, onTransfer, onAutomation, onMutedChange });
  callbacks.current = { getConnectInfo, onState, onDiagnostic, onStats, onInput, onKeyboardChange, onInputError, onVideo, onTransfer, onAutomation, onMutedChange };
  /** Plays the current stream again if it is paused; a pointer press calls it, as a user gesture. */
  const resumePlayback = useRef<(() => void) | null>(null);
  const initialVideo = useRef(video);

  const updateKeyboard = (open: boolean) => {
    if (keyboardRequested.current === open) return;
    // A key pressed before changing mode must be released on that original transport.
    textInputRef.current?.reset();
    if (keysRef.current) keysRef.current.value = '';
    keyboardRequested.current = open;
    setKeyboardOpen(open);
    callbacks.current.onKeyboardChange?.(open);
    const keys = keysRef.current;
    if (!keys) return;
    // iOS requires focus during the toolbar's user gesture, before React's next render.
    keys.inputMode = open ? 'text' : 'none';
    keys.readOnly = !open && touchDevice;
    if (open) keys.focus({ preventScroll: true });
    else keys.blur();
  };

  useEffect(() => {
    let stopFirstFrame: (() => void) | undefined;
    let active = true;
    let observedAttemptId: string | undefined;
    let observedFrameSequence: number | undefined;
    let observedStream: MediaStream | undefined;
    let playSequence = 0;
    let playState: PlaybackState = 'unknown';
    const browser = new RemoteBrowser({
      getConnectInfo: () => callbacks.current.getConnectInfo(),
      onState: (s, a) => callbacks.current.onState?.(s, a),
      onDiagnostic: (d) => callbacks.current.onDiagnostic?.(d),
      getPlaybackState: (attemptId, frameSequence) => {
        const element = videoRef.current;
        if (!active || !element || observedAttemptId !== attemptId || observedFrameSequence !== frameSequence || element.srcObject !== observedStream) return undefined;
        return readPlayback(element, {
          visibility: document.visibilityState,
          playState,
          frameCallback: typeof element.requestVideoFrameCallback === 'function',
        });
      },
      requireFirstFrame: true,
      ...(maxScreenPixels ? { maxScreenPixels } : {}),
      onStats: (s) => {
        statsRef.current = s;
        callbacks.current.onStats?.(s);
      },
      onInputError: (reason) => {
        textInputRef.current?.reset();
        callbacks.current.onInputError?.(reason);
      },
      onStream: (stream, attemptId, frameSequence) => {
        const element = videoRef.current;
        if (element) {
          if (element.srcObject !== stream || observedAttemptId !== attemptId || observedFrameSequence !== frameSequence) {
            stopFirstFrame?.();
            element.srcObject = stream;
            observedStream = stream;
            observedAttemptId = attemptId;
            observedFrameSequence = frameSequence;
            playState = 'unknown';
            stopFirstFrame = observeFirstFrame(element, stream, () => browser.reportFirstFrame(attemptId, frameSequence));
          }
          const shown = () => active && videoRef.current === element && element.srcObject === stream
            && observedAttemptId === attemptId && observedFrameSequence === frameSequence;
          const play = () => {
            const request = ++playSequence;
            playState = 'unknown';
            startPlayback(element, {
              current: () => shown() && request === playSequence,
              report: (state) => { playState = state; },
              muted: () => callbacks.current.onMutedChange?.(true),
            });
          };
          play();
          // Playback refused even muted (iOS Low Power Mode blocks autoplay) is allowed in a gesture.
          resumePlayback.current = () => { if (shown() && element.paused) play(); };
        }
      },
      onCursor: setCursor,
      onClipboard: (text) => {
        // Unicode software input can use the remote clipboard; do not replace the user's
        // local clipboard with each IME commit while the keyboard is open.
        if (keyboardRequested.current) return;
        // Remote → local clipboard; allowed while this document has focus. Until it succeeds a
        // local paste uses the remote clipboard (pasteClipboard).
        void navigator.clipboard?.writeText(text).then(() => browser.clipboardCopied(text), () => {});
      },
      macToPc: isMac(),
      ...(initialVideo.current ? { video: initialVideo.current } : {}),
      onVideo: (q) => callbacks.current.onVideo?.(q),
      onTransfer: (update) => callbacks.current.onTransfer?.(update),
      onAutomation: (status) => callbacks.current.onAutomation?.(status),
    });
    browserRef.current = browser;
    textInputRef.current = new TextInputController({
      mode: () => keyboardRequested.current ? 'software' : 'desktop',
      key: (down, event) => keyboardRequested.current ? browser.softwareKey(down, event) : browser.key(down, event),
      typeText: (text) => keyboardRequested.current ? browser.typeSoftwareText(text) : browser.typeText(text),
      sendCombo: (names, exact) => keyboardRequested.current ? browser.sendSoftwareCombo(names) : browser.sendCombo(names, exact),
      releaseAllKeys: () => browser.releaseAllKeys(),
      activity: () => callbacks.current.onInput?.(),
      mac: isMac(),
    });
    void browser.connect();
    return () => {
      active = false;
      playSequence++;
      resumePlayback.current = null;
      stopFirstFrame?.();
      keyboardRequested.current = false;
      callbacks.current.onKeyboardChange?.(false);
      textInputRef.current?.reset();
      textInputRef.current = null;
      browser.disconnect();
    };
  }, []);

  useEffect(() => {
    if (video) browserRef.current?.setVideoPreference(video);
  }, [video?.quality, video?.auto]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const set = (width: number, height: number, source: 'frame' | 'element') => setPictureSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height, source });
    const update = () => set(element.videoWidth, element.videoHeight, 'element');
    // Each presented frame confirms its size, so the rectangle never waits on a resize event.
    let frame: number | undefined;
    const presented = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (metadata.width > 0 && metadata.height > 0) set(metadata.width, metadata.height, 'frame');
      frame = element.requestVideoFrameCallback(presented);
    };
    if (typeof element.requestVideoFrameCallback === 'function') frame = element.requestVideoFrameCallback(presented);
    update();
    element.addEventListener('resize', update);
    element.addEventListener('loadedmetadata', update);
    return () => {
      if (frame !== undefined && typeof element.cancelVideoFrameCallback === 'function') element.cancelVideoFrameCallback(frame);
      element.removeEventListener('resize', update);
      element.removeEventListener('loadedmetadata', update);
    };
  }, []);

  // The remote screen follows the viewport (page 5, "Screen-size policy"), turned with the view.
  const fitViewport = (size: { width: number; height: number }) => {
    // Keyboard animations resize the local view; they must not keep resizing remote Chrome.
    if (keyboardRequested.current) return;
    if (rotatedRef.current) browserRef.current?.setViewport(size.height, size.width);
    else browserRef.current?.setViewport(size.width, size.height);
  };
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const size = { width: entry.contentRect.width, height: entry.contentRect.height };
      setBoxSize(size);
      fitViewport(size);
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (boxSize) fitViewport(boxSize);
  }, [rotated]);

  /**
   * Input is mapped in the box's own coordinates (elementPoint), never through client coordinates
   * and element rectangles: iOS Safari can report those against different viewports while the
   * on-screen keyboard pans the page, which put taps beside what they touched. The picture fills
   * the box's padding box, turned or not, so no layout is read per event.
   */
  const boxFrame = () => {
    const box = boxRef.current!;
    return { left: 0, top: 0, width: box.clientWidth, height: box.clientHeight };
  };
  /** A box point in the picture's own (unturned) frame, and that frame. */
  const toLocal = (x: number, y: number) => {
    const frame = boxFrame();
    if (rotatedRef.current) return unrotate(x, y, frame);
    return { x, y, frame };
  };
  const remoteAt = (x: number, y: number, frame: { left: number; top: number; width: number; height: number }) => {
    return toRemotePoint(x, y, frame, pictureSizeRef.current, browserRef.current?.screenSize ?? null);
  };
  const toRemote = (event: PositionedEvent) => {
    const point = elementPoint(event, boxRef.current!);
    const local = toLocal(point.x, point.y);
    return remoteAt(local.x, local.y, local.frame);
  };

  // Preserve DOM order: a deferred RAF move/wheel must not be overtaken by a key or click.
  useEffect(() => {
    const box = boxRef.current;
    const video = videoRef.current;
    if (!box || !video) return;
    const pressedButtons = new Set<number>();
    // Gestures work in the picture's frame, so a turned view scrolls along the page's own axes.
    const touchEvent = (e: PointerEvent) => {
      const point = elementPoint(e, box);
      const local = toLocal(point.x, point.y);
      return { pointerId: e.pointerId, clientX: local.x, clientY: local.y };
    };
    const touch = new TouchGestureController({
      mapPoint: (x, y) => remoteAt(x, y, toLocal(0, 0).frame),
      move: (x, y) => browserRef.current?.move(x, y),
      button: (down, x, y) => browserRef.current?.button(down, 0, x, y),
      scroll: (dx, dy) => {
        browserRef.current?.scroll(dx, dy);
      },
      activity: () => callbacks.current.onInput?.(),
    });
    const capture = (e: PointerEvent) => {
      try { box.setPointerCapture(e.pointerId); } catch { /* A synthetic or already-ended pointer. */ }
    };
    /** Input diagnostics: the point as the browser reported it, and everything the mapping used. */
    const trace = (kind: string, e: PointerEvent) => {
      if (!debugRef.current) return;
      const point = elementPoint(e, box);
      const local = toLocal(point.x, point.y);
      const remote = remoteAt(local.x, local.y, local.frame);
      const rect = box.getBoundingClientRect();
      const video = videoRef.current!;
      const mode = browserRef.current?.screenMode ?? null;
      const frame = pictureSizeRef.current;
      const space = remoteSpace({ width: frame.width || local.frame.width, height: frame.height || local.frame.height }, mode);
      const picture = pictureRect(local.frame, frame);
      const stats = statsRef.current;
      const vv = window.visualViewport;
      const n = (value: number) => value.toFixed(0);
      setDebugInfo({ x: point.x, y: point.y, lines: [
        `${kind} ${e.pointerType} client ${n(e.clientX)},${n(e.clientY)} offset ${n(e.offsetX)},${n(e.offsetY)} page ${n(e.pageX)},${n(e.pageY)} target ${e.target === box ? 'box' : 'other'}`,
        `box point ${n(point.x)},${n(point.y)} → remote ${remote ? `${n(remote.x)},${n(remote.y)}` : 'outside the picture'} of ${space.width}×${space.height} (${space.source})`,
        `box ${box.clientWidth}×${box.clientHeight} rect ${n(rect.left)},${n(rect.top)} ${n(rect.width)}×${n(rect.height)} rotated ${rotatedRef.current}`,
        `frame ${frame.width}×${frame.height} from ${frame.source} · element ${video.videoWidth}×${video.videoHeight} · rtp ${stats?.width ?? '?'}×${stats?.height ?? '?'}`,
        `screen ${mode ? `${mode.width}×${mode.height}@${mode.rate}${squarePixels(mode) ? '' : ' (not 16:9: the stream is tagged with 11:10 pixels)'}` : '?'}`,
        `picture ${n(picture.left)},${n(picture.top)} ${n(picture.width)}×${n(picture.height)} · laid out ${video.offsetLeft},${video.offsetTop} ${video.offsetWidth}×${video.offsetHeight} fit ${getComputedStyle(video).objectFit}`,
        `viewport ${vv ? `offset ${n(vv.offsetLeft)},${n(vv.offsetTop)} page ${n(vv.pageLeft)},${n(vv.pageTop)} ${n(vv.width)}×${n(vv.height)} scale ${vv.scale.toFixed(2)}` : 'none'}`,
        `scroll ${window.scrollX},${window.scrollY} inner ${window.innerWidth}×${window.innerHeight} client ${document.documentElement.clientWidth}×${document.documentElement.clientHeight}`,
      ] });
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        touch.pointerMove(touchEvent(e));
        e.preventDefault();
        return;
      }
      const point = toRemote(e);
      if (point) {
        browserRef.current?.move(point.x, point.y);
        callbacks.current.onInput?.();
      }
    };
    const onDown = (e: PointerEvent) => {
      trace('down', e);
      if (e.pointerType === 'touch') {
        if (touch.pointerDown(touchEvent(e))) {
          capture(e);
          if (!keyboardRequested.current) box.focus({ preventScroll: true });
        }
        e.preventDefault();
        return;
      }
      // A press is a user gesture: playback the browser refused without one can start now.
      resumePlayback.current?.();
      const p = toRemote(e);
      if (!p) return;
      keysRef.current?.focus({ preventScroll: true });
      capture(e);
      pressedButtons.add(e.button);
      browserRef.current?.button(true, e.button, p.x, p.y);
      callbacks.current.onInput?.();
      e.preventDefault();
    };
    const onUp = (e: PointerEvent) => {
      trace('up', e);
      if (e.pointerType === 'touch') {
        // A touch becomes a user gesture only when the finger lifts; a mouse press already is one.
        resumePlayback.current?.();
        touch.pointerUp(touchEvent(e));
        browserRef.current?.finishScroll();
        e.preventDefault();
        return;
      }
      if (!pressedButtons.delete(e.button)) return;
      const p = toRemote(e);
      browserRef.current?.button(false, e.button, p?.x, p?.y);
    };
    const reset = () => {
      browserRef.current?.finishScroll();
      touch.reset();
      for (const button of pressedButtons) browserRef.current?.button(false, button);
      pressedButtons.clear();
      textInputRef.current?.reset();
    };
    const onCancel = (e: PointerEvent) => {
      browserRef.current?.finishScroll();
      if (e.pointerType === 'touch') touch.pointerCancel(touchEvent(e));
      else {
        for (const button of pressedButtons) browserRef.current?.button(false, button);
        pressedButtons.clear();
      }
    };
    const onHidden = () => { if (document.hidden) reset(); };
    const onBlur = () => {
      browserRef.current?.pageBlurred();
      reset();
    };
    const onWheel = (e: WheelEvent) => {
      // The entire viewer owns scrolling, including its letterbox. Never scroll the local page.
      e.preventDefault();
      e.stopPropagation();
      const p = toRemote(e);
      if (!p) return;
      browserRef.current?.move(p.x, p.y);
      const line = 19;
      const dx = e.deltaX * (e.deltaMode === 1 ? line : e.deltaMode === 2 ? box.clientWidth : 1);
      const dy = e.deltaY * (e.deltaMode === 1 ? line : e.deltaMode === 2 ? box.clientHeight : 1);
      if (rotatedRef.current) browserRef.current?.scroll(dy, -dx, e.ctrlKey);
      else browserRef.current?.scroll(dx, dy, e.ctrlKey);
      callbacks.current.onInput?.();
    };
    // PointerEvent.preventDefault alone does not cancel Safari's native viewport panning.
    const noTouchScroll = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
    const noMenu = (e: Event) => e.preventDefault();
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerdown', onDown);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onCancel);
    box.addEventListener('lostpointercapture', onCancel);
    box.addEventListener('wheel', onWheel, { passive: false, capture: true });
    box.addEventListener('touchstart', noTouchScroll, { passive: false });
    box.addEventListener('touchmove', noTouchScroll, { passive: false });
    box.addEventListener('contextmenu', noMenu);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      reset();
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerdown', onDown);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onCancel);
      box.removeEventListener('lostpointercapture', onCancel);
      box.removeEventListener('wheel', onWheel, true);
      box.removeEventListener('touchstart', noTouchScroll);
      box.removeEventListener('touchmove', noTouchScroll);
      box.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, []);

  useEffect(() => {
    const keys = keysRef.current;
    if (!keys) return;
    // Use the native editing sequence: Safari/IME event ordering is significant, and React's
    // beforeinput/composition fallback can omit fields or synthesize a different sequence.
    const beforeInput = (event: InputEvent) => {
      if (textInputRef.current?.beforeInput(event)) event.preventDefault();
    };
    const input = (event: Event) => {
      if (textInputRef.current?.input(event as InputEvent, keys.value)) keys.value = '';
    };
    const compositionStart = () => textInputRef.current?.compositionStart();
    const compositionEnd = (event: CompositionEvent) => {
      if (textInputRef.current?.compositionEnd(event.data)) keys.value = '';
    };
    keys.addEventListener('beforeinput', beforeInput);
    keys.addEventListener('input', input);
    keys.addEventListener('compositionstart', compositionStart);
    keys.addEventListener('compositionend', compositionEnd);
    return () => {
      keys.removeEventListener('beforeinput', beforeInput);
      keys.removeEventListener('input', input);
      keys.removeEventListener('compositionstart', compositionStart);
      keys.removeEventListener('compositionend', compositionEnd);
    };
  }, []);

  const pasteFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const sent = files.length === 1 && files[0]!.type.startsWith('image/') ? [await asPng(files[0]!)] : files;
    browserRef.current?.sendFiles('paste', sent);
    callbacks.current.onInput?.();
  };

  // Files dragged in from the desktop are dropped where the pointer lets go (page 5).
  useEffect(() => {
    const box = boxRef.current;
    const video = videoRef.current;
    if (!box || !video) return;
    let depth = 0;
    const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      // Without this the local browser opens the file in place of the app.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const point = toRemote(e);
      if (point) browserRef.current?.move(point.x, point.y);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      const point = toRemote(e);
      if (!point) return;
      browserRef.current?.sendFiles('drop', files, point);
      keysRef.current?.focus({ preventScroll: true });
      callbacks.current.onInput?.();
    };
    box.addEventListener('dragenter', onEnter);
    box.addEventListener('dragover', onOver);
    box.addEventListener('dragleave', onLeave);
    box.addEventListener('drop', onDrop);
    return () => {
      box.removeEventListener('dragenter', onEnter);
      box.removeEventListener('dragover', onOver);
      box.removeEventListener('dragleave', onLeave);
      box.removeEventListener('drop', onDrop);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    isDisplaying: () => isDisplaying(videoRef.current),
    sendCombo: (names) => {
      browserRef.current?.sendCombo(names);
      callbacks.current.onInput?.();
    },
    paste: (text) => {
      browserRef.current?.paste(text);
      if (text) callbacks.current.onInput?.();
    },
    pasteFiles: (files) => void pasteFiles(files),
    focus: () => {
      if (keyboardRequested.current || !touchDevice) keysRef.current?.focus({ preventScroll: true });
      else boxRef.current?.focus({ preventScroll: true });
    },
    toggleKeyboard: () => {
      updateKeyboard(!keyboardRequested.current);
      if (!keyboardRequested.current) boxRef.current?.focus({ preventScroll: true });
    },
    reconnect: () => {
      browserRef.current?.disconnect();
      void browserRef.current?.connect();
    },
  }));

  const fitted = boxSize ? pictureRect({ left: 0, top: 0, width: rotated ? boxSize.height : boxSize.width, height: rotated ? boxSize.width : boxSize.height }, pictureSize) : null;

  return (
    // The caller positions the box (e.g. `absolute inset-0`); an inline `position` here would override it.
    <div
      ref={boxRef}
      tabIndex={0}
      aria-label="Remote browser"
      className={className}
      style={{ overflow: 'hidden', overscrollBehavior: 'none', touchAction: 'none', userSelect: 'none', cursor, ...style }}
      onKeyDown={(e) => { if (textInputRef.current?.keyDown(e.nativeEvent)) e.preventDefault(); }}
      onKeyUp={(e) => { if (textInputRef.current?.keyUp(e.nativeEvent)) e.preventDefault(); }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          textInputRef.current?.reset();
          updateKeyboard(false);
        }
      }}
    >
      <div
        style={rotated && boxSize
          ? { position: 'absolute', left: '50%', top: '50%', width: boxSize.height, height: boxSize.width, transform: 'translate(-50%, -50%) rotate(90deg)', pointerEvents: 'none' }
          : { position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        {/* Share the input mapping's fit instead of letting the video compositor choose a
            separate intrinsic fit during a WebRTC resize. */}
        <video ref={videoRef} autoPlay playsInline muted={muted} style={{ position: 'absolute', display: 'block', ...(fitted ? { left: fitted.left, top: fitted.top, width: fitted.width, height: fitted.height } : { inset: 0, width: '100%', height: '100%' }), maxWidth: 'none', objectFit: 'fill', pointerEvents: 'none' }} />
        {/* Input diagnostics: the rectangle input is mapped to. A picture painted smaller than it
            (bars inside the outline) means the compositor fitted the frame a second time. */}
        {debug && fitted ? <div aria-hidden data-testid="input-picture" style={{ position: 'absolute', left: fitted.left, top: fitted.top, width: fitted.width, height: fitted.height, boxSizing: 'border-box', border: '1px dashed #ff2fd0', pointerEvents: 'none' }} /> : null}
      </div>
      {dragging ? <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', outline: '2px dashed currentColor', outlineOffset: -6, opacity: 0.6 }} /> : null}
      {debug && debugInfo ? (
        // The marker sits at the registered point, in the box: it shows beside the finger exactly when painting and hit-testing disagree.
        <div aria-hidden data-testid="input-diagnostics" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, lineHeight: 1.35, color: '#fff' }}>
          <div style={{ position: 'absolute', left: debugInfo.x - 14, top: debugInfo.y - 14, width: 28, height: 28, boxSizing: 'border-box', border: '2px solid #ff2fd0', borderRadius: '50%' }} />
          <div style={{ position: 'absolute', left: debugInfo.x - 1, top: debugInfo.y - 40, width: 2, height: 80, background: '#ff2fd0' }} />
          <div style={{ position: 'absolute', left: debugInfo.x - 40, top: debugInfo.y - 1, width: 80, height: 2, background: '#ff2fd0' }} />
          <pre style={{ position: 'absolute', left: 8, bottom: 8, margin: 0, padding: '6px 8px', maxWidth: 'calc(100% - 16px)', whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.75)' }}>{debugInfo.lines.join('\n')}</pre>
        </div>
      ) : null}
      <textarea
        ref={keysRef}
        aria-label="Remote browser keyboard"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        tabIndex={-1}
        inputMode={keyboardOpen ? 'text' : 'none'}
        readOnly={touchDevice && !keyboardOpen}
        style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, fontSize: 16, opacity: 0, border: 0, padding: 0, resize: 'none' }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain');
          const files = pastedFiles([...e.clipboardData.files], text);
          e.preventDefault();
          if (files.length > 0) void pasteFiles(files);
          else if (text) {
            browserRef.current?.paste(text);
            callbacks.current.onInput?.();
          }
        }}
      />
    </div>
  );
});
