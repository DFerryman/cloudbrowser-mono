import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from 'react';
import { isMac } from './keyboard.js';
import { RemoteBrowser, type ConnectInfo, type ViewerState } from './remote-browser.js';
import type { ViewerStats } from './stats.js';

export interface RemoteBrowserHandle {
  sendCombo(names: string[]): void;
  /** Pastes local text into the remote page: remote clipboard, then Ctrl+V. */
  paste(text: string): void;
  focus(): void;
  reconnect(): void;
}

export interface RemoteBrowserViewProps {
  getConnectInfo: () => Promise<ConnectInfo>;
  onState?: (state: ViewerState, attempt: number) => void;
  onStats?: (stats: ViewerStats) => void;
  /** Called on any user input, for the idle timeout. */
  onInput?: () => void;
  muted?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The live view (page 5): the remote screen rendered 1:1, input mapped to remote pixels, a hidden
 * textarea that owns the keyboard (so IME composition works), and the remote cursor drawn locally.
 */
export const RemoteBrowserView = forwardRef<RemoteBrowserHandle, RemoteBrowserViewProps>(function RemoteBrowserView(
  { getConnectInfo, onState, onStats, onInput, muted = true, className, style },
  ref,
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const browserRef = useRef<RemoteBrowser | null>(null);
  const [cursor, setCursor] = useState('default');
  const callbacks = useRef({ getConnectInfo, onState, onStats, onInput });
  callbacks.current = { getConnectInfo, onState, onStats, onInput };

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
        // Remote → local clipboard; allowed while this document has focus.
        void navigator.clipboard?.writeText(text).catch(() => {});
      },
      macToPc: isMac(),
    });
    browserRef.current = browser;
    void browser.connect();
    return () => browser.disconnect();
  }, []);

  // The remote screen follows the viewport (page 5, "Screen-size policy").
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) browserRef.current?.setViewport(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // Pointer and wheel input, coalesced once per animation frame.
  useEffect(() => {
    const box = boxRef.current;
    const video = videoRef.current;
    if (!box || !video) return;
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
      return { x: Math.max(0, Math.min(vw - 1, (clientX - ox) / scale)), y: Math.max(0, Math.min(vh - 1, (clientY - oy) / scale)) };
    };
    const onMove = (e: PointerEvent) => {
      pendingMove = toRemote(e.clientX, e.clientY);
      schedule();
    };
    const onDown = (e: PointerEvent) => {
      keysRef.current?.focus({ preventScroll: true });
      const p = toRemote(e.clientX, e.clientY);
      browserRef.current?.button(true, e.button, p.x, p.y);
      callbacks.current.onInput?.();
      e.preventDefault();
    };
    const onUp = (e: PointerEvent) => {
      const p = toRemote(e.clientX, e.clientY);
      browserRef.current?.button(false, e.button, p.x, p.y);
    };
    const onWheel = (e: WheelEvent) => {
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
    box.addEventListener('wheel', onWheel, { passive: false });
    box.addEventListener('contextmenu', noMenu);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerdown', onDown);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('contextmenu', noMenu);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    sendCombo: (names) => browserRef.current?.sendCombo(names),
    paste: (text) => {
      browserRef.current?.setClipboard(text);
      browserRef.current?.sendCombo(['Control', 'v']);
    },
    focus: () => keysRef.current?.focus({ preventScroll: true }),
    reconnect: () => {
      browserRef.current?.disconnect();
      void browserRef.current?.connect();
    },
  }));

  return (
    // The caller positions the box (e.g. `absolute inset-0`); an inline `position` here would override it.
    <div ref={boxRef} className={className} style={{ overflow: 'hidden', touchAction: 'none', cursor, ...style }}>
      <video ref={videoRef} autoPlay playsInline muted={muted} style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
      <textarea
        ref={keysRef}
        aria-label="Remote browser keyboard"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0, border: 0, padding: 0, resize: 'none' }}
        onKeyDown={(e) => {
          const b = browserRef.current;
          if (!b || e.nativeEvent.isComposing || e.key === 'Process') return;
          // Ctrl/Cmd+V is handled by the paste event, which carries the local clipboard text.
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
          if (b.key(true, e)) e.preventDefault();
          callbacks.current.onInput?.();
        }}
        onKeyUp={(e) => {
          if (e.nativeEvent.isComposing || e.key === 'Process') return;
          if (browserRef.current?.key(false, e)) e.preventDefault();
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain');
          e.preventDefault();
          if (text) {
            browserRef.current?.setClipboard(text);
            browserRef.current?.sendCombo(['Control', 'v']);
          }
        }}
        onCompositionEnd={(e) => {
          browserRef.current?.typeText(e.data);
          e.currentTarget.value = '';
        }}
        onInput={(e) => {
          if (!(e.nativeEvent as InputEvent).isComposing) e.currentTarget.value = '';
        }}
        onBlur={() => browserRef.current?.releaseAllKeys()}
      />
    </div>
  );
});
