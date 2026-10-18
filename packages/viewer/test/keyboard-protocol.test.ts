import { afterEach, describe, expect, it } from 'vitest';
import { RemoteBrowser } from '../src/remote-browser.js';
import { TextInputController } from '../src/text-input.js';

type Frame = { t: string; data?: { event: string; payload?: { keysym?: number; text?: string } } };

class ReceiverSocket {
  static last: ReceiverSocket;
  readyState = 1;
  bufferedAmount = 0;
  sent: Frame[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { ReceiverSocket.last = this; }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.(); }
  push(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

class MediaPeer {
  static last: MediaPeer;
  connectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  ontrack = null;
  ondatachannel = null;
  onicecandidate = null;
  constructor() { MediaPeer.last = this; }
  async setRemoteDescription() {}
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription() {}
  async addIceCandidate() {}
  close() {}
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const active: RemoteBrowser[] = [];
afterEach(() => { for (const browser of active.splice(0)) browser.disconnect(); });

async function setup(mode: 'software' | 'desktop' = 'software') {
  const browser = new RemoteBrowser({
    getConnectInfo: async () => ({ gatewayUrl: 'wss://fixture', token: 'fixture', iceServers: [] }),
    WebSocketImpl: ReceiverSocket as never,
    RTCPeerConnectionImpl: MediaPeer as never,
    macToPc: true,
  });
  active.push(browser);
  await browser.connect();
  const socket = ReceiverSocket.last;
  socket.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
  await tick();
  MediaPeer.last.connect();
  await tick();
  const controller = new TextInputController({
    mode: () => mode,
    key: (down, event) => mode === 'software' ? browser.softwareKey(down, event) : browser.key(down, event),
    typeText: (text) => mode === 'software' ? browser.typeSoftwareText(text) : browser.typeText(text),
    sendCombo: (names) => mode === 'software' ? browser.sendSoftwareCombo(names) : browser.sendCombo(names),
    releaseAllKeys: () => browser.releaseAllKeys(),
  });
  socket.sent.length = 0;
  return { browser, socket, controller };
}

function receiveKeys(frames: Frame[]) {
  const held = new Set<number>();
  const downs: number[] = [];
  for (const frame of frames) {
    if (frame.t !== 'neko') continue;
    const { event, payload } = frame.data!;
    if (event === 'control/keydown') {
      expect(held.has(payload!.keysym!)).toBe(false);
      held.add(payload!.keysym!);
      downs.push(payload!.keysym!);
    } else if (event === 'control/keyup') {
      expect(held.delete(payload!.keysym!)).toBe(true);
    }
  }
  return { held, downs };
}

describe('keyboard controller through the production Neko transport', () => {
  it('leaves no remotely held keys after iOS soft input and shortcuts that omit all keyups', async () => {
    const { socket, controller } = await setup();
    controller.keyDown({ key: 'Shift', code: '', shiftKey: true });
    controller.keyDown({ key: 'a', code: '' });
    controller.input({ inputType: 'insertText', data: 'a' }, 'a');
    controller.keyDown({ key: 'ArrowLeft', code: '' });
    controller.keyDown({ key: 'Control', code: '', ctrlKey: true });
    controller.keyDown({ key: 'a', code: '', ctrlKey: true });
    controller.keyDown({ key: 'Enter', code: '' });
    controller.compositionStart();
    controller.compositionEnd('你');
    controller.input({ inputType: 'insertFromComposition', data: '你' }, '你');
    await tick();
    const { held, downs } = receiveKeys(socket.sent);
    expect([...held]).toEqual([]); // X11 autorepeat requires a key to remain held.
    expect(downs).toEqual([0x61, 0xff51, 0xffe3, 0x61, 0xff0d]);
    expect(socket.sent.filter((frame) => frame.data?.event === 'control/paste').map((frame) => frame.data?.payload?.text)).toEqual(['你']);
    expect(socket.sent.some((frame) => frame.t === 'ime')).toBe(false);
  });

  it('releases the original desktop keysym when repeat casing changes and Safari omits the release code', async () => {
    const { socket, controller } = await setup('desktop');
    controller.keyDown({ key: 'a', code: 'KeyA', keyCode: 65 });
    controller.keyDown({ key: 'A', code: 'KeyA', keyCode: 65, shiftKey: true });
    controller.keyUp({ key: 'A', code: '', keyCode: 65 });
    controller.keyDown({ key: 'b', code: 'KeyB' });
    controller.keyUp({ key: 'Unidentified', code: '', keyCode: 229 });
    await tick();
    const { held, downs } = receiveKeys(socket.sent);
    expect(downs).toEqual([0x61, 0x62]);
    expect([...held]).toEqual([]);
  });

  it('uses symbols present under the current US X11 modifiers rather than allocating dynamic lowercase mappings', async () => {
    const { browser, socket } = await setup();
    const text = 'AZaz09~!@#$%^&*()_+{}|:"<>?';
    browser.typeSoftwareText(text);
    await tick();
    const { held } = receiveKeys(socket.sent);
    let shift = false;
    let inserted = '';
    const shiftSymbols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:"<>? ';
    const plainSymbols = 'abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;\',./ ';
    for (const frame of socket.sent) {
      const { event, payload } = frame.data!;
      const sym = payload?.keysym;
      if (sym === 0xffe1) { shift = event === 'control/keydown'; continue; }
      if (event !== 'control/keydown' || sym === undefined) continue;
      const character = String.fromCodePoint(sym);
      // Neko v3 XkbKeysymToKeycode compares the keysym AFTER current modifiers.
      expect(shift ? shiftSymbols : plainSymbols).toContain(character);
      inserted += character;
    }
    expect(inserted).toBe(text);
    expect([...held]).toEqual([]);
  });
});
