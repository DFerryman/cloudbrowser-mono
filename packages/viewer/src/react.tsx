import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from 'react';
import { isMac } from './keyboard.js';
import { RemoteBrowser, type ConnectInfo, type ViewerState } from './remote-browser.js';
import type { ViewerStats } from './stats.js';
import { TouchGestureController } from './touch.js';
import { TextInputController } from './text-input.js';

export interface RemoteBrowserHandle {
  sendCombo(names: string[]): void;
  /** Pastes local text into the remote page: remote clipboard, then Ctrl+V. */
  paste(text: string): void;
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
  muted?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The live view (page 5): the remote screen rendered 1:1, input mapped to remote pixels, a hidden
 * textarea that owns the keyboard (so IME composition works), and the remote cursor drawn locally.
 */
export const RemoteBrowserView = forwardRef<RemoteBrowserHandle, RemoteBrowserViewProps>(function RemoteBrowserView(
  { getConnectInfo, onState, onStats, onInput, onKeyboardChange, muted = true, className, style },
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
  const callbacks = useRef({ getConnectInfo, onState, onStats, onInput, onKeyboardChange });
  callbacks.current = { getConnectInfo, onState, onStats, onInput, onKeyboardChange };

  const updateKeyboard = (open: boolean) => {
    if (keyboardRequested.current === open) return;
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

  // The remote screen follows the viewport (page 5, "Screen-size policy").
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(([entry]) => {
      // Keyboard animations resize the local view; they must not keep resizing remote Chrome.
      if (entry && !keyboardRequested.current) browserRef.current?.setViewport(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // Pointer and wheel input, coalesced once per animation frame.
  useEffect(() => {
    const box = boxRef.current;
    const video = videoRef.current;
    if (!box || !video) return;
    const pressedButtons = new Set<number>();
    let pendingMove: { x: number; y: number } | null = null;
    let wheel = { dx: 0, dy: 0, ctrl: false };
    let frame = 0;
    const flush = () => {
      frame = 0;
      const b = browserRef.current;
      if (!b) return;
      if (pendingMove) b.move(pendingMove.x, pendingMove.y);
      pendingMove = null;
      if (wheel.dx || wheel.dy) b.scroll(wheel.dx, wheel.dy, wheel.ctrl);
      wheel = { dx: 0, dy: 0, ctrl: false };
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };
    /** Client coordinates → remote pixels, accounting for letterboxing (object-fit: contain). */
    const toRemote = (clientX: number, clientY: number) => {
      const r = video.getBoundingClientRect();
      const vw = video.videoWidth || r.width;
      const vh = video.videoHeight || r.height;
      const scale = Math.min(r.width / vw, r.height / vh);
      const ox = r.left + (r.width - vw * scale) / 2;
      const oy = r.top + (r.height - vh * scale) / 2;
      if (scale <= 0 || clientX < ox || clientY < oy || clientX >= ox + vw * scale || clientY >= oy + vh * scale) return null;
      return { x: (clientX - ox) / scale, y: (clientY - oy) / scale };
    };
    const touch = new TouchGestureController({
      mapPoint: toRemote,
      move: (x, y) => browserRef.current?.move(x, y),
      button: (down, x, y) => browserRef.current?.button(down, 0, x, y),
      scroll: (dx, dy) => {
        wheel.dx += dx;
        wheel.dy += dy;
        schedule();
      },
      activity: () => callbacks.current.onInput?.(),
    });
    const capture = (e: PointerEvent) => {
      try { box.setPointerCapture(e.pointerId); } catch { /* A synthetic or already-ended pointer. */ }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        touch.pointerMove(e);
        e.preventDefault();
        return;
      }
      pendingMove = toRemote(e.clientX, e.clientY);
      if (pendingMove) schedule();
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        pendingMove = null;
        if (touch.pointerDown(e)) {
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
        touch.pointerUp(e);
        e.preventDefault();
        return;
      }
      if (!pressedButtons.delete(e.button)) return;
      const p = toRemote(e.clientX, e.clientY);
      browserRef.current?.button(false, e.button, p?.x, p?.y);
    };
    const reset = () => {
      pendingMove = null;
      wheel = { dx: 0, dy: 0, ctrl: false };
      touch.reset();
      for (const button of pressedButtons) browserRef.current?.button(false, button);
      pressedButtons.clear();
      textInputRef.current?.reset();
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerType === 'touch') touch.pointerCancel(e);
      else {
        pendingMove = null;
        for (const button of pressedButtons) browserRef.current?.button(false, button);
        pressedButtons.clear();
      }
    };
    const onHidden = () => { if (document.hidden) reset(); };
    const onWheel = (e: WheelEvent) => {
      const p = toRemote(e.clientX, e.clientY);
      if (!p) return;
      pendingMove = p;
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      wheel.dx += e.deltaX * unit;
      wheel.dy += e.deltaY * unit;
      wheel.ctrl ||= e.ctrlKey;
      schedule();
      callbacks.current.onInput?.();
      e.preventDefault();
    };
    const noMenu = (e: Event) => e.preventDefault();
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerdown', onDown);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onCancel);
    box.addEventListener('lostpointercapture', onCancel);
    box.addEventListener('wheel', onWheel, { passive: false });
    box.addEventListener('contextmenu', noMenu);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      reset();
      if (frame) cancelAnimationFrame(frame);
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerdown', onDown);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onCancel);
      box.removeEventListener('lostpointercapture', onCancel);
      box.removeEventListener('wheel', onWheel);
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

  useImperativeHandle(ref, () => ({
    sendCombo: (names) => browserRef.current?.sendCombo(names),
    paste: (text) => {
      browserRef.current?.setClipboard(text);
      browserRef.current?.sendCombo(['Control', 'v']);
    },
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
      style={{ overflow: 'hidden', touchAction: 'none', userSelect: 'none', cursor, ...style }}
      onKeyDown={(e) => { if (textInputRef.current?.keyDown(e.nativeEvent)) e.preventDefault(); }}
      onKeyUp={(e) => { if (textInputRef.current?.keyUp(e.nativeEvent)) e.preventDefault(); }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          textInputRef.current?.reset();
          updateKeyboard(false);
        }
      }}
    >
      <video ref={videoRef} autoPlay playsInline muted={muted} style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
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
          e.preventDefault();
          if (text) {
            browserRef.current?.setClipboard(text);
            browserRef.current?.sendCombo(['Control', 'v']);
          }
        }}
      />
    </div>
  );
});
