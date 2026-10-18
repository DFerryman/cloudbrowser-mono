/**
 * KeyboardEvent → X11 keysym (page 5, "Keyboard"). Printable characters use their Unicode code
 * point (Latin-1 directly, others as 0x01000000 + code point); named keys use the X11 keysym table.
 * On macOS, Cmd maps to Control and Option to Alt by default, so Cmd+C copies in the remote Chrome.
 */

const NAMED: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Pause: 0xff13,
  ScrollLock: 0xff14,
  Escape: 0xff1b,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  PrintScreen: 0xff61,
  Insert: 0xff63,
  ContextMenu: 0xff67,
  NumLock: 0xff7f,
  CapsLock: 0xffe5,
  Delete: 0xffff,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  ' ': 0x0020,
};

const BY_CODE: Record<string, number> = {
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,
  NumpadEnter: 0xff8d,
};

export const KEYSYM = { Control_L: 0xffe3, Alt_L: 0xffe9, Shift_L: 0xffe1, Tab: 0xff09 } as const;

export interface KeyMapOptions {
  /** Map Cmd to Control and Option to Alt (default on macOS). */
  macToPc: boolean;
}

export function keysymFor(e: Pick<KeyboardEvent, 'key' | 'code'>, opts: KeyMapOptions): number | null {
  if (opts.macToPc && (e.code === 'MetaLeft' || e.code === 'MetaRight')) return e.code === 'MetaLeft' ? 0xffe3 : 0xffe4;
  if (opts.macToPc && !e.code && e.key === 'Meta') return 0xffe3;
  if (e.code in BY_CODE) return BY_CODE[e.code]!;
  if (e.key in NAMED) return NAMED[e.key]!;
  const f = /^F(\d{1,2})$/.exec(e.key);
  if (f) {
    const n = Number(f[1]);
    if (n >= 1 && n <= 24) return 0xffbe + n - 1;
  }
  // A single printable character (key is one code point).
  const cp = e.key.codePointAt(0);
  if (cp !== undefined && [...e.key].length === 1 && cp >= 0x20) {
    return cp <= 0xff ? cp : 0x01000000 + cp;
  }
  return null; // Dead, Process (IME), Unidentified…
}

export interface KeyIdentityEvent {
  key: string;
  code: string;
  keyCode?: number;
}

const usableCode = (code: string) => code && code !== 'Unidentified';
const usableKeyCode = (code?: number) => code !== undefined && code !== 0 && code !== 229;
const keyName = (key: string) => [...key].length === 1 ? key.toLowerCase() : key;

/** Keyboard layouts and iOS can change key/keyCode between a press and its release. */
export function keyIdentity(event: KeyIdentityEvent): string {
  if (usableCode(event.code)) return `code:${event.code}`;
  if (usableKeyCode(event.keyCode)) return `keyCode:${event.keyCode}`;
  return `key:${keyName(event.key)}`;
}

export function matchingKeyIdentity<T extends KeyIdentityEvent>(held: ReadonlyMap<string, T>, event: KeyIdentityEvent): string | null {
  const exact = keyIdentity(event);
  if (held.has(exact)) return exact;
  // A usable physical code identifies a different key; do not match another key by its label.
  if (usableCode(event.code)) return null;
  if (usableKeyCode(event.keyCode)) {
    for (const [id, down] of held) if (down.keyCode === event.keyCode) return id;
  }
  for (const [id, down] of held) if (keyName(down.key) === keyName(event.key)) return id;
  return null;
}

export function unidentifiedKey(event: KeyIdentityEvent): boolean {
  return !usableCode(event.code) && !usableKeyCode(event.keyCode)
    && ['Unidentified', 'Process', 'Dead', ''].includes(event.key);
}

export function isMac(platform = typeof navigator !== 'undefined' ? navigator.platform : ''): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

/** Key combos the toolbar's Keys menu sends (page 1). */
export const COMBOS: Record<string, string[]> = {
  'Ctrl+T': ['Control', 't'],
  'Ctrl+W': ['Control', 'w'],
  'Ctrl+N': ['Control', 'n'],
  'Ctrl+Tab': ['Control', 'Tab'],
  'Ctrl+Shift+T': ['Control', 'Shift', 't'],
  'Ctrl+L': ['Control', 'l'],
  'Alt+Left': ['Alt', 'ArrowLeft'],
  'Alt+Right': ['Alt', 'ArrowRight'],
};

/** Keysym for a key name used in combos. */
export function keysymForName(name: string): number | null {
  if (name === 'Control') return KEYSYM.Control_L;
  if (name === 'Alt') return KEYSYM.Alt_L;
  if (name === 'Shift') return KEYSYM.Shift_L;
  return keysymFor({ key: name, code: '' }, { macToPc: false });
}
