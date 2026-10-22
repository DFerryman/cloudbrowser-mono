// Mount the production React component while replacing its transport, never its DOM handlers.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteBrowserView, type RemoteBrowserHandle } from '../src/react';
import { RemoteBrowser } from '../src/remote-browser';

type RecordedCall = { method: string; actualMethod: string; args: unknown[]; phase: string | null };
const calls: RecordedCall[] = [];
const wire: { event: string; payload?: any }[] = [];
// What an agent received of pasted or dropped files.
const transfers: { action: string; x?: number; y?: number; names: string[]; text: string; done: boolean }[] = [];
const held = new Set<number>();
const remoteInput = document.createElement('textarea');
const remoteScroll = document.createElement('div');
remoteScroll.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:240px;overflow:scroll;';
remoteScroll.innerHTML = '<div style="width:3000px;height:6000px"></div>';
document.body.append(remoteScroll);
let clipboard = '';
let selectedAll = false;
const character = (keysym: number) => {
  if (keysym === 0xff08) remoteInput.value = remoteInput.value.slice(0, -1);
  else if (keysym === 0xff0d) remoteInput.value += '\n';
  else if (keysym >= 0x20 && keysym <= 0x7e) {
    if (held.has(0xffe3) || held.has(0xffe4)) {
      if (keysym === 0x61) selectedAll = true;
      if (keysym === 0x76) { remoteInput.value = (selectedAll ? '' : remoteInput.value) + clipboard; selectedAll = false; }
      return;
    }
    const text = String.fromCodePoint(keysym);
    remoteInput.value = (selectedAll ? '' : remoteInput.value) + (held.has(0xffe1) ? text.toUpperCase() : text);
    selectedAll = false;
  }
};
// Model Neko v3.0.8's X11 semantics, including the autorepeat that reveals missing key-ups.
setInterval(() => { for (const key of held) character(key); }, 40);
const receiveInput = (message: { event: string; payload?: any }) => {
  wire.push(message);
  const p = message.payload ?? {};
  if (message.event === 'control/scroll') remoteScroll.scrollBy(-p.delta_x * 120, -p.delta_y * 120);
  if (message.event === 'control/keydown' && !held.has(p.keysym)) { held.add(p.keysym); character(p.keysym); }
  if (message.event === 'control/keyup') held.delete(p.keysym);
  if (message.event === 'clipboard/set') clipboard = p.text;
  if (message.event === 'control/paste') {
    clipboard = p.text;
    held.clear();
    remoteInput.value = (selectedAll ? '' : remoteInput.value) + p.text;
    selectedAll = false;
  }
};
class FixtureSocket {
  static last: FixtureSocket;
  readyState = 1;
  bufferedAmount = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FixtureSocket.last = this;
    queueMicrotask(() => {
      this.push({ t: 'neko', data: { event: 'system/init' } });
      this.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'fixture' } } });
    });
  }
  push(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    if (typeof frame.t === 'string' && frame.t.startsWith('file_')) return this.file(frame);
    if (frame.t !== 'neko') throw new Error('All input must use the ordered Neko transport');
    receiveInput(frame.data);
  }
  close() { this.readyState = 3; this.onclose?.(); }
  // Acknowledges like agent 0.3.0: progress after each chunk, done after the end.
  private received = new Map<string, number>();
  file(frame: any) {
    if (frame.t === 'file_begin') {
      transfers.push({ action: frame.action, x: frame.x, y: frame.y, names: frame.files.map((f: any) => f.name), text: '', done: false });
      this.received.set(frame.id, 0);
    }
    const transfer = transfers.at(-1)!;
    if (frame.t === 'file_chunk') {
      const bytes = Uint8Array.from(atob(frame.chunk), (c) => c.charCodeAt(0));
      transfer.text += new TextDecoder().decode(bytes);
      const received = this.received.get(frame.id)! + bytes.length;
      this.received.set(frame.id, received);
      queueMicrotask(() => this.push({ t: 'file', id: frame.id, status: 'progress', received }));
    }
    if (frame.t === 'file_end') {
      transfer.done = true;
      queueMicrotask(() => this.push({ t: 'file', id: frame.id, status: 'done' }));
    }
  }
}
class FixturePeer {
  connectionState = 'new';
  onconnectionstatechange?: () => void;
  ondatachannel?: (event: any) => void;
  async setRemoteDescription() {
    this.ondatachannel?.({ channel: {
      readyState: 'open', ordered: false, maxRetransmits: 0,
      send: () => { throw new Error('Unreliable data-channel input must never be used'); },
    } });
  }
  async createAnswer() { return { sdp: 'fixture' }; }
  async setLocalDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
  async addIceCandidate() {}
  close() {}
}
const focusChanges: { event: string; target: string }[] = [];
let textareaFocusCalls = 0;
const focusTextarea = HTMLTextAreaElement.prototype.focus;
HTMLTextAreaElement.prototype.focus = function (...args) {
  textareaFocusCalls++;
  return focusTextarea.apply(this, args);
};
let phase: string | null = null;
const identify = (target: EventTarget | null) => target instanceof HTMLTextAreaElement ? 'textarea'
  : target instanceof HTMLElement ? target.dataset.testid ?? target.tagName.toLowerCase() : 'unknown';

for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'compositionstart', 'compositionend', 'beforeinput', 'input', 'keydown', 'keyup']) {
  document.addEventListener(type, () => { phase = type; }, true);
}
for (const event of ['focusin', 'focusout']) {
  document.addEventListener(event, (e) => focusChanges.push({ event, target: identify(e.target) }), true);
}
const record = (method: string, args: unknown[], actualMethod = method) => calls.push({ method, actualMethod, args, phase });

for (const method of ['move', 'button', 'scroll', 'typeText', 'paste', 'setClipboard', 'sendCombo', 'releaseAllKeys', 'setViewport', 'disconnect']) {
  const actual = (RemoteBrowser.prototype as any)[method];
  (RemoteBrowser.prototype as any)[method] = function (...args: unknown[]) { record(method, args); return actual.apply(this, args); };
}
const actualKey = RemoteBrowser.prototype.key;
RemoteBrowser.prototype.key = function (down, e) {
  record('key', [down, { key: e.key, code: e.code }]);
  return actualKey.call(this, down, e);
};
for (const [actualMethod, method] of [['typeSoftwareText', 'typeText'], ['sendSoftwareCombo', 'sendCombo']]) {
  const actual = (RemoteBrowser.prototype as any)[actualMethod!];
  (RemoteBrowser.prototype as any)[actualMethod!] = function (...args: unknown[]) { record(method!, args, actualMethod); return actual.apply(this, args); };
}
const actualSoftwareKey = RemoteBrowser.prototype.softwareKey;
(RemoteBrowser.prototype as any).softwareKey = function (down: boolean, e: KeyboardEvent) {
  record('key', [down, { key: e.key, code: e.code }], 'softwareKey');
  return actualSoftwareKey.call(this, down, e);
};
const actualConnect = RemoteBrowser.prototype.connect;
RemoteBrowser.prototype.connect = async function () {
  record('connect', []);
  Object.assign((this as any).opts, {
    getConnectInfo: async () => ({ gatewayUrl: 'ws://fixture', token: 'fixture', iceServers: [] }),
    WebSocketImpl: FixtureSocket,
    RTCPeerConnectionImpl: FixturePeer,
    // The fixture peer carries no video; input becomes live on the connected peer alone.
    requireFirstFrame: false,
  });
  return actualConnect.call(this);
};

function Fixture() {
  const ref = useRef<RemoteBrowserHandle>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [rotated, setRotated] = useState(false);
  return <>
    <header>
      <button data-testid="keyboard-toggle" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={() => ref.current?.toggleKeyboard()}>Keyboard</button>
      <output data-testid="keyboard-state">{String(keyboard)}</output>
      <button data-testid="rotate-toggle" onClick={() => setRotated((r) => !r)}>Rotate</button>
    </header>
    <RemoteBrowserView
      ref={ref}
      className="remote-screen"
      style={{ position: 'absolute', top: 64, left: 0, right: 0, bottom: 0, background: '#222' }}
      getConnectInfo={async () => { throw new Error('The regression fixture must not request a real session'); }}
      onKeyboardChange={(open) => { record('keyboardChange', [open]); setKeyboard(open); }}
      rotated={rotated}
    />
  </>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);

(window as any).touchHarness = {
  transfers: () => structuredClone(transfers),
  dropFile(x: number, y: number, name: string, text: string) {
    const box = document.querySelector('.remote-screen')!;
    const data = new DataTransfer();
    data.items.add(new File([text], name, { type: 'text/markdown' }));
    for (const type of ['dragenter', 'dragover', 'drop']) box.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: data }));
  },
  pasteFile(name: string, text: string, type: string) {
    const data = new DataTransfer();
    data.items.add(new File([text], name, { type }));
    document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  },
  clear() { calls.length = 0; wire.length = 0; transfers.length = 0; focusChanges.length = 0; textareaFocusCalls = 0; phase = null; },
  resetRemote() { remoteScroll.scrollTo(0, 0); remoteInput.value = ''; selectedAll = false; },
  socketBuffer(bytes: number) { FixtureSocket.last.bufferedAmount = bytes; },
  nativeKey(type: string, key: string, code = '', modifiers = {}) {
    document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code, ...modifiers }));
  },
  interleave(x: number, y: number) {
    const box = document.querySelector('.remote-screen')!;
    const input = document.querySelector('textarea')!;
    box.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', pointerId: 20, clientX: x, clientY: y }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a', code: 'KeyA' }));
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: 120 }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'a', code: 'KeyA' }));
    input.value = '中';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中', inputType: 'insertText' }));
  },
  snapshot() {
    const textarea = document.querySelector('textarea')!;
    return {
      calls: structuredClone(calls), focusChanges: structuredClone(focusChanges), textareaFocusCalls,
      active: identify(document.activeElement), inputMode: textarea.inputMode,
      readOnly: textarea.readOnly, keyboard: document.querySelector('[data-testid="keyboard-state"]')?.textContent,
      wire: structuredClone(wire), held: [...held], remoteInput: remoteInput.value,
      remoteScroll: { x: remoteScroll.scrollLeft, y: remoteScroll.scrollTop },
      localScroll: { x: window.scrollX, y: window.scrollY },
    };
  },
  inputOnly(text: string) {
    const textarea = document.querySelector('textarea')!;
    textarea.value = text;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  },
  edit(inputType: string) {
    const textarea = document.querySelector('textarea')!;
    const allowed = textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType }));
    if (allowed) textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  },
  compose(text: string, finalBeforeEnd = false) {
    const textarea = document.querySelector('textarea')!;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    textarea.value = text;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertCompositionText', isComposing: true }));
    const finalInput = () => {
      const event = (type: string) => {
        const e = new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput', data: text, inputType: 'insertFromComposition' });
        // Chromium's constructor clears this Safari inputType. Preserve the sequence we test.
        if (e.inputType !== 'insertFromComposition') Object.defineProperty(e, 'inputType', { value: 'insertFromComposition' });
        return e;
      };
      if (textarea.dispatchEvent(event('beforeinput'))) textarea.dispatchEvent(event('input'));
    };
    if (finalBeforeEnd) finalInput();
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
    if (!finalBeforeEnd) finalInput();
  },
};
