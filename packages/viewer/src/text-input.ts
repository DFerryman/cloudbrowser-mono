import { keyIdentity, matchingKeyIdentity, unidentifiedKey } from './keyboard.js';

/** Keyboard and text events are separate on mobile: many soft keys have no usable keydown. */
export interface TextKeyEvent {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** KeyboardEvent's own; the controller asks it for AltGraph. */
  getModifierState?: (key: string) => boolean;
}

export interface TextInputEvent {
  inputType?: string;
  data?: string | null;
  isComposing?: boolean;
  cancelable?: boolean;
}

export interface TextInputCallbacks {
  mode: () => 'desktop' | 'software';
  key: (down: boolean, event: TextKeyEvent) => boolean;
  typeText: (text: string) => void;
  /** `exact`: modifiers held but not named are lifted for the combination (RemoteBrowser.sendCombo). */
  sendCombo: (names: string[], exact?: boolean) => void;
  releaseAllKeys: () => void;
  activity?: () => void;
  /** A Mac's (or an iPad's) keyboard, whose Cmd and Option the remote reads as Control and Alt: see keyDown. */
  mac?: boolean;
}

type Edit = { kind: 'backspace' | 'delete' | 'enter'; combo: string[] };

function inputEdit(inputType = ''): Edit | null {
  switch (inputType) {
    case 'deleteContentBackward': return { kind: 'backspace', combo: ['Backspace'] };
    case 'deleteContentForward': return { kind: 'delete', combo: ['Delete'] };
    case 'deleteWordBackward': return { kind: 'backspace', combo: ['Control', 'Backspace'] };
    case 'deleteWordForward': return { kind: 'delete', combo: ['Control', 'Delete'] };
    case 'insertLineBreak':
    case 'insertParagraph': return { kind: 'enter', combo: ['Enter'] };
    default: return null;
  }
}

function keyEdit(key: string): Edit | null {
  if (key === 'Backspace') return inputEdit('deleteContentBackward');
  if (key === 'Delete') return inputEdit('deleteContentForward');
  if (key === 'Enter') return inputEdit('insertLineBreak');
  return null;
}

const modifierKey = (key: string) => ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(key);

/**
 * A Mac moves the caret by word with Option and to the ends of the line or the text with Cmd. On
 * the remote PC those would arrive as Alt+← (Chrome's Back) and Ctrl+←: the PC's own keys for the
 * same motion go out instead. Shift still selects.
 */
function macMotion(event: TextKeyEvent): string[] | null {
  if (event.ctrlKey || !!event.altKey === !!event.metaKey) return null;
  switch (event.key) {
    case 'ArrowLeft': return event.altKey ? ['Control', 'ArrowLeft'] : ['Home'];
    case 'ArrowRight': return event.altKey ? ['Control', 'ArrowRight'] : ['End'];
    case 'ArrowUp': return event.metaKey ? ['Control', 'Home'] : null;
    case 'ArrowDown': return event.metaKey ? ['Control', 'End'] : null;
    default: return null;
  }
}

/**
 * A DOM-independent controller for the viewer's textarea.
 *
 * keyDown/keyUp/beforeInput return whether to preventDefault(). input returns whether to clear
 * the textarea; preserve its value when it returns false during composition. compositionEnd
 * commits its text and returns true so the caller can clear the textarea. Pass native event
 * fields and the textarea's current value; this controller never changes DOM or focus.
 */
export class TextInputController {
  private composing = false;
  private forwarded = new Map<string, TextKeyEvent>();
  private compositionTail: string | null = null;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEdit: Edit['kind'] | null = null;
  private editTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly callbacks: TextInputCallbacks) {}

  keyDown(event: TextKeyEvent): boolean {
    // A new key starts a new input sequence, even when its character equals the IME commit.
    this.clearTail();
    this.clearEdit();
    if (this.composing || event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.keyCode === 229) return false;
    // The textarea's paste handler owns both local paste and its remote clipboard transfer.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return false;

    const modified = event.ctrlKey || event.metaKey || event.altKey;
    const edit = keyEdit(event.key);
    if (this.callbacks.mode() === 'software') {
      // Soft keyboards can omit keyup entirely. Shift is reflected in the committed text;
      // hardware shortcuts carry their modifier flags on the non-modifier key itself.
      if (modifierKey(event.key)) return false;
      if (!modified && edit) {
        this.sendEdit(edit);
        return true;
      }
      if (!modified && [...event.key].length === 1) return false; // Let input carry the actual text.
      return this.softwareStroke(event);
    }

    // Windows types an AltGr character (@ on a German keyboard) with Control and Alt held, which the
    // remote US layout would take as a Ctrl+Alt shortcut: type the character itself. The AltGraph
    // key stays local.
    if (event.key === 'AltGraph') return false;
    if (!event.metaKey && [...event.key].length === 1 && event.getModifierState?.('AltGraph')) {
      this.callbacks.typeText(event.key);
      this.callbacks.activity?.();
      return true;
    }
    const motion = this.callbacks.mac ? macMotion(event) : null;
    if (motion) {
      this.callbacks.sendCombo(motion, true);
      this.callbacks.activity?.();
      return true;
    }
    // macOS sends no keyup for a key pressed while Cmd is held. Tracked, the key would stay down on
    // the remote, where X11 repeats it, and its next press would read as a repeat. Send the stroke at once.
    if (this.callbacks.mac && event.metaKey && !modifierKey(event.key)) {
      if (!this.callbacks.key(true, event)) return false;
      this.callbacks.key(false, event);
      if (edit) this.rememberEdit(edit.kind);
      this.callbacks.activity?.();
      return true;
    }

    // Neko/X11 already repeats a held key. Repeated keydowns would replace the original
    // mapping when Shift or the input layout changes, leaving the first keysym held forever.
    if (matchingKeyIdentity(this.forwarded, event) !== null) {
      this.callbacks.activity?.();
      return true;
    }
    if (!this.callbacks.key(true, event)) return false;
    // DOM KeyboardEvent fields live on its prototype and are not enumerable.
    this.forwarded.set(keyIdentity(event), {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.isComposing,
      keyCode: event.keyCode,
    });
    if (edit) this.rememberEdit(edit.kind);
    this.callbacks.activity?.();
    return true;
  }

  keyUp(event: TextKeyEvent): boolean {
    const id = matchingKeyIdentity(this.forwarded, event);
    if (id === null) {
      // Safari can replace both key and code with Unidentified after an IME transition.
      // There is no reliable individual match, so end the outstanding remote presses.
      if (unidentifiedKey(event) && this.forwarded.size > 0) {
        this.releaseForwarded();
        return true;
      }
      return false;
    }
    const down = this.forwarded.get(id)!;
    this.forwarded.delete(id);
    if (this.callbacks.mac && down.key === 'Meta') {
      // A key that was already down when Cmd was pressed lost its keyup as well (see keyDown).
      for (const [other, held] of [...this.forwarded]) {
        if (modifierKey(held.key)) continue;
        this.forwarded.delete(other);
        this.callbacks.key(false, held);
      }
    }
    // Use the original mapping if the OS changed key/modifier fields before keyup.
    return this.callbacks.key(false, down);
  }

  beforeInput(event: TextInputEvent): boolean {
    if (this.composing || event.isComposing) return false;
    if (this.isCompositionTail(event, event.data ?? '')) return event.cancelable !== false;
    const edit = inputEdit(event.inputType);
    if (!edit || event.cancelable === false) return false;
    if (this.pendingEdit !== edit.kind) this.sendEdit(edit);
    return true;
  }

  input(event: TextInputEvent, value: string): boolean {
    if (this.composing || event.isComposing) return false;
    const text = value || event.data || '';
    if (this.isCompositionTail(event, text)) {
      this.clearTail();
      return true;
    }
    this.clearTail();
    const edit = inputEdit(event.inputType);
    if (edit) {
      if (this.pendingEdit !== edit.kind) this.sendEdit(edit);
      this.clearEdit();
      return true;
    }
    this.clearEdit();
    if (text) {
      this.callbacks.typeText(text);
      this.callbacks.activity?.();
    }
    return true;
  }

  compositionStart(): void {
    this.releaseForwarded();
    this.composing = true;
    this.clearTail();
    this.clearEdit();
  }

  compositionEnd(text: string): true {
    this.composing = false;
    this.clearTail();
    if (text) {
      this.callbacks.typeText(text);
      this.callbacks.activity?.();
      this.compositionTail = text;
      // Safari can emit a final non-composing input after compositionend. Limit suppression
      // to that event sequence; a later, identical character must still reach the remote page.
      this.tailTimer = setTimeout(() => this.clearTail(), 0);
    }
    return true;
  }

  reset(): void {
    this.composing = false;
    this.forwarded.clear();
    this.clearTail();
    this.clearEdit();
    this.callbacks.releaseAllKeys();
  }

  private softwareStroke(event: TextKeyEvent): boolean {
    const modifiers: TextKeyEvent[] = [];
    if (event.ctrlKey) modifiers.push({ key: 'Control', code: 'ControlLeft' });
    if (event.metaKey) modifiers.push({ key: 'Meta', code: 'MetaLeft' });
    if (event.altKey) modifiers.push({ key: 'Alt', code: 'AltLeft' });
    if (event.shiftKey) modifiers.push({ key: 'Shift', code: 'ShiftLeft' });
    const pressed = modifiers.filter((modifier) => this.callbacks.key(true, modifier));
    const sent = this.callbacks.key(true, event);
    if (sent) this.callbacks.key(false, event);
    for (const modifier of pressed.reverse()) this.callbacks.key(false, modifier);
    if (sent) this.callbacks.activity?.();
    return sent;
  }

  private releaseForwarded(): void {
    if (this.forwarded.size === 0) return;
    this.forwarded.clear();
    this.callbacks.releaseAllKeys();
  }

  private isCompositionTail(event: TextInputEvent, text: string): boolean {
    return this.compositionTail !== null && text === this.compositionTail
      && ['insertText', 'insertFromComposition', 'insertCompositionText'].includes(event.inputType ?? '');
  }

  private sendEdit(edit: Edit) {
    this.callbacks.sendCombo(edit.combo);
    this.rememberEdit(edit.kind);
    this.callbacks.activity?.();
  }

  private rememberEdit(kind: Edit['kind']) {
    this.clearEdit();
    this.pendingEdit = kind;
    this.editTimer = setTimeout(() => this.clearEdit(), 0);
  }

  private clearTail() {
    if (this.tailTimer !== null) clearTimeout(this.tailTimer);
    this.tailTimer = null;
    this.compositionTail = null;
  }

  private clearEdit() {
    if (this.editTimer !== null) clearTimeout(this.editTimer);
    this.editTimer = null;
    this.pendingEdit = null;
  }
}
