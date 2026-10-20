import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from 'react';
import { isMac } from './keyboard.js';
import { toRemotePoint, unrotate } from './mapping.js';
import type { BrowserTier, VideoQuality } from '@cloudbrowser/contracts';
import type { VideoPreference } from './quality.js';
import { RemoteBrowser, type ConnectInfo, type ViewerState } from './remote-browser.js';
import type { ViewerStats } from './stats.js';
import { TouchGestureController } from './touch.js';
import { TextInputController } from './text-input.js';
import type { InputFailure } from './input-queue.js';
import { pastedFiles, type TransferUpdate } from './file-transfer.js';

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
  /** Picture quality; the sharpest level adapting to the connection by default. Changes apply to the live stream. */
  video?: VideoPreference;
  /** The level being streamed now. */
  onVideo?: (quality: VideoQuality) => void;
  /** The browser's machine tier: its frame rate and desktop refresh rate (read when the view mounts). */
  tier?: BrowserTier;
  muted?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The live view (page 5): the remote screen rendered 1:1, input mapped to remote pixels, a hidden
 * textarea that owns the keyboard (so IME composition works), and the remote cursor drawn locally.
 */
export const RemoteBrowserView = forwardRef<RemoteBrowserHandle, RemoteBrowserViewProps>(function RemoteBrowserView(
  { getConnectInfo, onState, onStats, onInput, onKeyboardChange, onInputError, onTransfer, rotated = false, video, onVideo, tier, muted = true, className, style },
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
  const rotatedRef = useRef(rotated);
  rotatedRef.current = rotated;
  const callbacks = useRef({ getConnectInfo, onState, onStats, onInput, onKeyboardChange, onInputError, onVideo, onTransfer });
  callbacks.current = { getConnectInfo, onState, onStats, onInput, onKeyboardChange, onInputError, onVideo, onTransfer };
  const initialVideo = useRef(video);
  const initialTier = useRef(tier);

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
    const browser = new RemoteBrowser({
      getConnectInfo: () => callbacks.current.getConnectInfo(),
      onState: (s, a) => callbacks.current.onState?.(s, a),
      onStats: (s) => callbacks.current.onStats?.(s),
      onInputError: (reason) => {
        textInputRef.current?.reset();
        callbacks.current.onInputError?.(reason);
      },
      onStream: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      },
      onCursor: setCursor,
      onClipboard: (text) => {
        // Unicode software input can use the remote clipboard; do not replace the user's
        // local clipboard with each IME commit while the keyboard is open.
        if (keyboardRequested.current) return;
        // Remote → local clipboard; allowed while this document has focus.
        void navigator.clipboard?.writeText(text).catch(() => {});
      },
      macToPc: isMac(),
      ...(initialVideo.current ? { video: initialVideo.current } : {}),
      ...(initialTier.current ? { tier: initialTier.current } : {}),
      onVideo: (q) => callbacks.current.onVideo?.(q),
      onTransfer: (update) => callbacks.current.onTransfer?.(update),
    });
    browserRef.current = browser;
    textInputRef.current = new TextInputController({
      mode: () => keyboardRequested.current ? 'software' : 'desktop',
      key: (down, event) => keyboardRequested.current ? browser.softwareKey(down, event) : browser.key(down, event),
      typeText: (text) => keyboardRequested.current ? browser.typeSoftwareText(text) : browser.typeText(text),
      sendCombo: (names) => keyboardRequested.current ? browser.sendSoftwareCombo(names) : browser.sendCombo(names),
      releaseAllKeys: () => browser.releaseAllKeys(),
      activity: () => callbacks.current.onInput?.(),
    });
    void browser.connect();
    return () => {
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

  /** A client point in the picture's own (unturned) frame, and that frame. */
  const toLocal = (clientX: number, clientY: number) => {
    const box = boxRef.current!;
    if (rotatedRef.current) return unrotate(clientX, clientY, box.getBoundingClientRect());
    return { x: clientX, y: clientY, frame: videoRef.current!.getBoundingClientRect() };
  };
  const remoteAt = (x: number, y: number, frame: { left: number; top: number; width: number; height: number }) => {
    const video = videoRef.current!;
    return toRemotePoint(x, y, frame, { width: video.videoWidth, height: video.videoHeight }, browserRef.current?.screenSize ?? null);
  };
  const toRemote = (clientX: number, clientY: number) => {
    const local = toLocal(clientX, clientY);
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
      const local = toLocal(e.clientX, e.clientY);
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
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        touch.pointerMove(touchEvent(e));
        e.preventDefault();
        return;
      }
      const point = toRemote(e.clientX, e.clientY);
      if (point) browserRef.current?.move(point.x, point.y);
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        if (touch.pointerDown(touchEvent(e))) {
          capture(e);
          if (!keyboardRequested.current) box.focus({ preventScroll: true });
        }
        e.preventDefault();
        return;
      }
      const p = toRemote(e.clientX, e.clientY);
      if (!p) return;
      keysRef.current?.focus({ preventScroll: true });
      capture(e);
      pressedButtons.add(e.button);
      browserRef.current?.button(true, e.button, p.x, p.y);
      callbacks.current.onInput?.();
      e.preventDefault();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        touch.pointerUp(touchEvent(e));
        browserRef.current?.finishScroll();
        e.preventDefault();
        return;
      }
      if (!pressedButtons.delete(e.button)) return;
      const p = toRemote(e.clientX, e.clientY);
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
    const onWheel = (e: WheelEvent) => {
      // The entire viewer owns scrolling, including its letterbox. Never scroll the local page.
      e.preventDefault();
      e.stopPropagation();
      const p = toRemote(e.clientX, e.clientY);
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
    window.addEventListener('blur', reset);
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
      window.removeEventListener('blur', reset);
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
      const point = toRemote(e.clientX, e.clientY);
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
      const point = toRemote(e.clientX, e.clientY);
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
    sendCombo: (names) => browserRef.current?.sendCombo(names),
    paste: (text) => {
      browserRef.current?.paste(text);
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
        <video ref={videoRef} autoPlay playsInline muted={muted} style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
      </div>
      {dragging ? <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', outline: '2px dashed currentColor', outlineOffset: -6, opacity: 0.6 }} /> : null}
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
          }
        }}
      />
    </div>
  );
});
