/**
 * neko v3 protocol, as much of it as the viewer uses (page 5). WebSocket messages are JSON
 * `{event, payload}`; low-latency input goes over the WebRTC data channel as small big-endian
 * binary frames `[opcode u8][payload length u16][payload]`. Confirm event names and opcodes
 * against the pinned neko version when the browser image is built (page 5 says the same of the
 * neko configuration).
 */

export interface NekoMessage<P = Record<string, unknown>> {
  event: string;
  payload?: P;
}

export const EV = {
  SYSTEM_INIT: 'system/init',
  SYSTEM_ADMIN: 'system/admin',
  SYSTEM_DISCONNECT: 'system/disconnect',
  SIGNAL_REQUEST: 'signal/request',
  SIGNAL_PROVIDE: 'signal/provide',
  SIGNAL_ANSWER: 'signal/answer',
  SIGNAL_CANDIDATE: 'signal/candidate',
  /** Which video (quality level) neko streams; sent by either side. */
  SIGNAL_VIDEO: 'signal/video',
  CONTROL_REQUEST: 'control/request',
  CONTROL_MOVE: 'control/move',
  CONTROL_SCROLL: 'control/scroll',
  CONTROL_BUTTONDOWN: 'control/buttondown',
  CONTROL_BUTTONUP: 'control/buttonup',
  CONTROL_KEYDOWN: 'control/keydown',
  CONTROL_KEYUP: 'control/keyup',
  CONTROL_PASTE: 'control/paste',
  SCREEN_SET: 'screen/set',
  SCREEN_UPDATED: 'screen/updated',
  CLIPBOARD_SET: 'clipboard/set',
  CLIPBOARD_UPDATED: 'clipboard/updated',
  CURSOR_IMAGE: 'cursor/image',
} as const;

export interface SignalProvide {
  sdp: string;
  iceservers?: { urls: string[] | string; username?: string; credential?: string }[];
  video?: { id?: string };
}

export interface SignalCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** Data channel opcodes, client → neko. */
export const OP = {
  MOVE: 0x01,
  SCROLL: 0x02,
  KEY_DOWN: 0x03,
  KEY_UP: 0x04,
  BTN_DOWN: 0x05,
  BTN_UP: 0x06,
} as const;

/** Data channel opcodes, neko → client. */
export const OP_IN = {
  CURSOR_POSITION: 0x01,
  CURSOR_IMAGE: 0x02,
} as const;

function frame(op: number, length: number, write: (v: DataView) => void): ArrayBuffer {
  const buf = new ArrayBuffer(3 + length);
  const v = new DataView(buf);
  v.setUint8(0, op);
  v.setUint16(1, length);
  write(v);
  return buf;
}

const clamp16 = (n: number) => Math.max(0, Math.min(0xffff, Math.round(n)));
const clampS16 = (n: number) => Math.max(-0x8000, Math.min(0x7fff, Math.round(n)));

export const encode = {
  move: (x: number, y: number) =>
    frame(OP.MOVE, 4, (v) => {
      v.setUint16(3, clamp16(x));
      v.setUint16(5, clamp16(y));
    }),
  /** Signed X11 click counts: positive X/Y inject left/up, negative X/Y right/down. */
  scroll: (dx: number, dy: number, controlKey = false) =>
    frame(OP.SCROLL, 5, (v) => {
      v.setInt16(3, clampS16(dx));
      v.setInt16(5, clampS16(dy));
      v.setUint8(7, controlKey ? 1 : 0);
    }),
  key: (down: boolean, keysym: number) =>
    frame(down ? OP.KEY_DOWN : OP.KEY_UP, 4, (v) => {
      v.setUint32(3, keysym >>> 0);
    }),
  /** X11 buttons: 1 left, 2 middle, 3 right, 8 back, 9 forward. */
  button: (down: boolean, button: number) =>
    frame(down ? OP.BTN_DOWN : OP.BTN_UP, 4, (v) => {
      v.setUint32(3, button);
    }),
};

export type IncomingData =
  | { kind: 'cursor_position'; x: number; y: number }
  | { kind: 'cursor_image'; width: number; height: number; hotX: number; hotY: number; png: Uint8Array };

export function decode(buf: ArrayBuffer): IncomingData | null {
  const v = new DataView(buf);
  if (buf.byteLength < 3) return null;
  const op = v.getUint8(0);
  if (op === OP_IN.CURSOR_POSITION && buf.byteLength >= 7) return { kind: 'cursor_position', x: v.getUint16(3), y: v.getUint16(5) };
  if (op === OP_IN.CURSOR_IMAGE && buf.byteLength >= 11) {
    return {
      kind: 'cursor_image',
      width: v.getUint16(3),
      height: v.getUint16(5),
      hotX: v.getUint16(7),
      hotY: v.getUint16(9),
      png: new Uint8Array(buf, 11),
    };
  }
  return null;
}

/** DOM MouseEvent.button → X11 button. */
export function x11Button(domButton: number): number | null {
  return ({ 0: 1, 1: 2, 2: 3, 3: 8, 4: 9 } as Record<number, number>)[domButton] ?? null;
}

/** Remote screen sizes the server can apply (page 5, "Screen-size policy"). */
export const SCREEN_SIZES = [
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1536, 864],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
] as const;

export interface ScreenConfiguration {
  width: number;
  height: number;
  rate: number;
}

/** The largest supported size that fits the viewport, so pixels map 1:1. */
/** A screen mode as neko reports it, or null for anything malformed. */
export function screenOf(value: unknown): ScreenConfiguration | null {
  if (value === null || typeof value !== 'object') return null;
  const { width, height, rate } = value as Record<string, unknown>;
  return typeof width === 'number' && Number.isInteger(width) && width > 0
    && typeof height === 'number' && Number.isInteger(height) && height > 0
    && typeof rate === 'number' && Number.isInteger(rate) && rate > 0 ? { width, height, rate } : null;
}

/** Whether neko would end up on the same mode: Xorg rounds widths down to a multiple of 8. */
export const sameScreen = (a: ScreenConfiguration, b: ScreenConfiguration) =>
  a.height === b.height && a.rate === b.rate && a.width - (a.width % 8) === b.width - (b.width % 8);

export function fitScreen(width: number, height: number): { width: number; height: number };
export function fitScreen(width: number, height: number, configurations: readonly ScreenConfiguration[]): ScreenConfiguration | null;
export function fitScreen(width: number, height: number, configurations?: readonly ScreenConfiguration[]) {
  if (configurations) {
    if (configurations.length === 0) return null;
    // Keep the existing 720p–1440p policy when the server supports it. For smaller viewports,
    // use the smallest supported desktop and let the video scale down.
    const policy = configurations.filter((s) => s.width >= 1280 && s.height >= 720 && s.width <= 2560 && s.height <= 1440);
    const available = policy.length > 0 ? policy : configurations;
    const fits = available.filter((s) => s.width <= width && s.height <= height);
    const sizes = fits.length > 0 ? fits : available;
    const best = sizes.reduce((a, b) => {
      const difference = b.width * b.height - a.width * a.height;
      return (fits.length > 0 ? difference > 0 : difference < 0) ? b : a;
    });
    const rates = sizes.filter((s) => s.width === best.width && s.height === best.height).map((s) => s.rate);
    const bounded = rates.filter((rate) => rate <= 30);
    return { width: best.width, height: best.height, rate: bounded.length > 0 ? Math.max(...bounded) : Math.min(...rates) };
  }
  let best: readonly [number, number] = SCREEN_SIZES[0];
  for (const s of SCREEN_SIZES) if (s[0] <= width && s[1] <= height) best = s;
  return { width: best[0], height: best[1] };
}
