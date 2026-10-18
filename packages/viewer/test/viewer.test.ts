import { afterEach, describe, expect, it, vi } from 'vitest';
import { keysymFor, keysymForName } from '../src/keyboard.js';
import { decode, encode, fitScreen } from '../src/neko.js';
import { RemoteBrowser, type RemoteBrowserOptions } from '../src/remote-browser.js';
import { qualityLevel } from '../src/stats.js';

describe('neko data channel encoding', () => {
  it('encodes move, scroll, key and button frames big-endian', () => {
    expect([...new Uint8Array(encode.move(1920, 5))]).toEqual([0x01, 0, 4, 0x07, 0x80, 0, 5]);
    expect([...new Uint8Array(encode.scroll(-1, 120, true))]).toEqual([0x02, 0, 5, 0xff, 0xff, 0, 120, 1]);
    expect([...new Uint8Array(encode.key(true, 0xff0d))]).toEqual([0x03, 0, 4, 0, 0, 0xff, 0x0d]);
    expect([...new Uint8Array(encode.button(false, 3))]).toEqual([0x06, 0, 4, 0, 0, 0, 3]);
  });

  it('decodes cursor frames', () => {
    const buf = new ArrayBuffer(13);
    const v = new DataView(buf);
    v.setUint8(0, 2);
    v.setUint16(1, 10);
    v.setUint16(3, 16);
    v.setUint16(5, 24);
    v.setUint16(7, 1);
    v.setUint16(9, 2);
    const d = decode(buf);
    expect(d).toMatchObject({ kind: 'cursor_image', width: 16, height: 24, hotX: 1, hotY: 2 });
  });

  it('picks the largest remote screen that fits the viewport', () => {
    expect(fitScreen(1600, 860)).toEqual({ width: 1366, height: 768 }); // 1536×864 is too tall
    expect(fitScreen(3000, 2000)).toEqual({ width: 2560, height: 1440 });
    expect(fitScreen(800, 600)).toEqual({ width: 1280, height: 720 });
  });

  it('selects an advertised screen mode and its supported refresh rate', () => {
    const configurations = [
      { width: 1280, height: 720, rate: 30 },
      { width: 1368, height: 768, rate: 30 },
      { width: 1600, height: 900, rate: 25 },
      { width: 1920, height: 1080, rate: 60 },
      { width: 1920, height: 1080, rate: 30 },
      { width: 2560, height: 1440, rate: 30 },
      { width: 3840, height: 2160, rate: 25 },
    ];
    expect(fitScreen(1440, 860, configurations)).toEqual({ width: 1368, height: 768, rate: 30 });
    expect(fitScreen(1700, 1000, configurations)).toEqual({ width: 1600, height: 900, rate: 25 });
    expect(fitScreen(2000, 1200, configurations)).toEqual({ width: 1920, height: 1080, rate: 30 });
    expect(fitScreen(4000, 2500, configurations)).toEqual({ width: 2560, height: 1440, rate: 30 });
    expect(fitScreen(800, 600, configurations)).toEqual({ width: 1280, height: 720, rate: 30 });
    expect(fitScreen(1600, 900, [])).toBeNull();
  });

  it('uses the supported rate when a screen has no mode at or below 30 Hz', () => {
    expect(fitScreen(1600, 1000, [{ width: 1440, height: 900, rate: 60 }])).toEqual({ width: 1440, height: 900, rate: 60 });
  });
});

describe('keyboard mapping', () => {
  const pc = { macToPc: false };
  it('maps printable, named and modifier keys to X11 keysyms', () => {
    expect(keysymFor({ key: 'a', code: 'KeyA' }, pc)).toBe(0x61);
    expect(keysymFor({ key: 'é', code: 'Quote' }, pc)).toBe(0xe9);
    expect(keysymFor({ key: '你', code: '' }, pc)).toBe(0x01004f60);
    expect(keysymFor({ key: 'Enter', code: 'Enter' }, pc)).toBe(0xff0d);
    expect(keysymFor({ key: 'F5', code: 'F5' }, pc)).toBe(0xffc2);
    expect(keysymFor({ key: 'Control', code: 'ControlRight' }, pc)).toBe(0xffe4);
    expect(keysymFor({ key: 'Shift', code: '' }, pc)).toBe(0xffe1);
    expect(keysymFor({ key: 'Process', code: 'KeyA' }, pc)).toBeNull();
    expect(keysymFor({ key: 'Dead', code: 'Quote' }, pc)).toBeNull();
  });
  it('maps Cmd to Control on macOS', () => {
    expect(keysymFor({ key: 'Meta', code: 'MetaLeft' }, { macToPc: true })).toBe(0xffe3);
    expect(keysymFor({ key: 'Meta', code: '' }, { macToPc: true })).toBe(0xffe3);
    expect(keysymFor({ key: 'Meta', code: 'MetaLeft' }, pc)).toBe(0xffeb);
    expect(keysymForName('Control')).toBe(0xffe3);
  });
});

it('rates connection quality like the toolbar indicator', () => {
  expect(qualityLevel({ rttMs: 40, loss: 0 })).toBe('good');
  expect(qualityLevel({ rttMs: 100, loss: 0 })).toBe('fair');
  expect(qualityLevel({ rttMs: 60, loss: 0.05 })).toBe('poor');
  expect(qualityLevel({ rttMs: null, loss: null })).toBe('unknown');
});

// --- RemoteBrowser with fake WebSocket and RTCPeerConnection ----------------------------------

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  neko(event: string) {
    return this.sent.filter((f: any) => f.t === 'neko' && f.data.event === event).map((f: any) => f.data.payload);
  }
}

class FakeDC {
  readyState = 'open';
  binaryType = 'blob';
  sent: ArrayBuffer[] = [];
  onmessage = null;
  send(b: ArrayBuffer) {
    this.sent.push(b);
  }
}

class FakePC {
  static last: FakePC;
  connectionState = 'new';
  ontrack: any;
  ondatachannel: any;
  onicecandidate: any;
  onconnectionstatechange: any;
  remote: any;
  closed = false;
  candidates: any[] = [];
  constructor(readonly config: RTCConfiguration) {
    FakePC.last = this;
  }
  async setRemoteDescription(d: any) {
    this.remote = d;
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' };
  }
  async setLocalDescription() {}
  async addIceCandidate(c: any) {
    this.candidates.push(c);
  }
  close() {
    this.closed = true;
  }
  connect() {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Media is receive-only; input becomes ready after signaling and the control request. */
async function readyInput(ws: FakeWS) {
  ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
  await tick();
  FakePC.last.connect();
  ws.sent.length = 0;
}

describe('RemoteBrowser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(
    iceServers: { urls: string[]; username?: string; credential?: string }[] = [],
    options: Pick<RemoteBrowserOptions, 'connectionTimeoutMs' | 'onInputError'> = {},
  ) {
    FakeWS.all = [];
    const getConnectInfo = vi.fn(async () => ({ gatewayUrl: 'wss://gw/v1/stream/i1', token: `tok${getConnectInfo.mock.calls.length}`, iceServers }));
    const states: string[] = [];
    const b = new RemoteBrowser({
      getConnectInfo,
      onState: (s) => states.push(s),
      WebSocketImpl: FakeWS as never,
      RTCPeerConnectionImpl: FakePC as never,
      ...options,
    });
    return { b, getConnectInfo, states };
  }

  it('requests a stream, answers neko over the gateway, and goes live', async () => {
    const { b, states } = setup([{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }]);
    await b.connect();
    const ws = FakeWS.all[0]!;
    expect(ws.url).toBe('wss://gw/v1/stream/i1?token=tok1');

    ws.push({ t: 'agent_online' });
    expect(ws.neko('signal/request')).toHaveLength(0);
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    expect(ws.neko('signal/request')).toHaveLength(1);
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp', iceservers: [] } } });
    await tick();
    const pc = FakePC.last;
    expect(pc.remote).toEqual({ type: 'offer', sdp: 'offer-sdp' });
    expect(pc.config.iceTransportPolicy).toBe('relay');
    expect(ws.neko('signal/answer')).toEqual([{ sdp: 'answer-sdp' }]);

    ws.push({ t: 'neko', data: { event: 'signal/candidate', payload: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } } });
    await tick();
    expect(pc.candidates).toHaveLength(1);
    pc.onicecandidate({ candidate: { candidate: 'mine', sdpMid: '0', sdpMLineIndex: 0 } });
    expect(ws.neko('signal/candidate')).toEqual([{ candidate: 'mine', sdpMid: '0', sdpMLineIndex: 0 }]);

    const dc = new FakeDC();
    pc.ondatachannel({ channel: dc });
    pc.connect();
    expect(states.at(-1)).toBe('live');
    expect(ws.neko('control/request')).toHaveLength(1);

    b.move(10, 20);
    expect(b.key(true, { key: 'a', code: 'KeyA' })).toBe(true);
    b.releaseAllKeys();
    expect(dc.sent).toEqual([]);
    expect(ws.sent.slice(-3)).toEqual([
      { t: 'neko', data: { event: 'control/move', payload: { x: 10, y: 20 } } },
      { t: 'neko', data: { event: 'control/keydown', payload: { keysym: 0x61 } } },
      { t: 'neko', data: { event: 'control/keyup', payload: { keysym: 0x61 } } },
    ]);

    b.typeText('你好');
    expect(ws.sent.at(-1)).toEqual({ t: 'neko', data: { event: 'control/paste', payload: { text: '你好' } } });
  });

  it('commits fractional wheel input before reversal, keyboard input, and a changed pointer target', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    b.move(10, 20);
    b.scroll(0, 120);
    b.scroll(0, 15);
    b.scroll(0, -1);
    b.scroll(0, -15);
    b.key(true, { key: 'a', code: 'KeyA' });
    b.scroll(0, 120);
    b.scroll(0, 15);
    b.move(30, 40);
    expect(ws.sent.map((frame: any) => [frame.data.event, frame.data.payload])).toEqual([
      ['control/move', { x: 10, y: 20 }],
      ['control/scroll', { delta_x: 0, delta_y: -1, control_key: false }],
      ['control/scroll', { delta_x: 0, delta_y: -1, control_key: false }],
      ['control/scroll', { delta_x: 0, delta_y: 1, control_key: false }],
      ['control/scroll', { delta_x: 0, delta_y: 1, control_key: false }],
      ['control/keydown', { keysym: 0x61 }],
      ['control/scroll', { delta_x: 0, delta_y: -1, control_key: false }],
      ['control/scroll', { delta_x: 0, delta_y: -1, control_key: false }],
      ['control/move', { x: 30, y: 40 }],
    ]);
    b.disconnect();
  });

  it('restores physical holds after Neko atomic paste and preserves held modifiers around toolbar chords', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    b.key(true, { key: 'Control', code: 'ControlLeft' });
    b.paste('中文');
    b.sendCombo(['Control', 't']);
    b.key(false, { key: 'Control', code: 'ControlLeft' });
    expect(ws.sent.map((frame: any) => [frame.data.event, frame.data.payload])).toEqual([
      ['control/keydown', { keysym: 0xffe3 }],
      ['control/paste', { text: '中文' }],
      ['control/keydown', { keysym: 0xffe3 }],
      ['control/keydown', { keysym: 0x74 }],
      ['control/keyup', { keysym: 0x74 }],
      ['control/keyup', { keysym: 0xffe3 }],
    ]);
    b.disconnect();
  });

  it('uses final shifted keysyms and still strokes a toolbar character that was already held', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    b.key(true, { key: 't', code: 'KeyT' });
    b.sendCombo(['Control', 'Shift', 't']);
    b.key(false, { key: 't', code: 'KeyT' });
    expect(ws.neko('control/keydown').map((payload: any) => payload.keysym)).toEqual([0x74, 0xffe3, 0xffe1, 0x54, 0x74]);
    expect(ws.neko('control/keyup').map((payload: any) => payload.keysym)).toEqual([0x74, 0x54, 0xffe1, 0xffe3, 0x74]);
    b.disconnect();
  });

  it('uses all candidates without a TURN relay', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'o', iceservers: [{ urls: ['stun:x'] }] } } });
    await tick();
    expect(FakePC.last.config.iceTransportPolicy).toBe('all');
    b.disconnect();
  });

  it('types an address using ordered Neko keys with explicit Shift for capitals and US punctuation', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    const down = (keysym: number) => ({ t: 'neko', data: { event: 'control/keydown', payload: { keysym } } });
    const up = (keysym: number) => ({ t: 'neko', data: { event: 'control/keyup', payload: { keysym } } });
    const key = (character: string) => [down(character.charCodeAt(0)), up(character.charCodeAt(0))];
    const shifted = (character: string) => [down(0xffe1), ...key(character), up(0xffe1)];
    b.typeSoftwareText('https://A.co/?q=B_2');
    expect(ws.sent).toEqual([
      ...key('h'), ...key('t'), ...key('t'), ...key('p'), ...key('s'), ...shifted(':'),
      ...key('/'), ...key('/'), ...shifted('A'), ...key('.'), ...key('c'), ...key('o'),
      ...key('/'), ...shifted('?'), ...key('q'), ...key('='), ...shifted('B'), ...shifted('_'), ...key('2'),
    ]);
    b.disconnect();
  });

  it('pastes consecutive Unicode text and orders following Backspace and Enter on the same WebSocket', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    b.typeSoftwareText('你好🙂');
    expect(b.softwareKey(true, { key: 'Backspace', code: 'Backspace' })).toBe(true);
    b.softwareKey(false, { key: 'Backspace', code: 'Backspace' });
    b.sendSoftwareCombo(['Enter']);
    expect(ws.sent).toEqual([
      { t: 'neko', data: { event: 'control/paste', payload: { text: '你好🙂' } } },
      { t: 'neko', data: { event: 'control/keydown', payload: { keysym: 0xff08 } } },
      { t: 'neko', data: { event: 'control/keyup', payload: { keysym: 0xff08 } } },
      { t: 'neko', data: { event: 'control/keydown', payload: { keysym: 0xff0d } } },
      { t: 'neko', data: { event: 'control/keyup', payload: { keysym: 0xff0d } } },
    ]);
    b.disconnect();
  });

  it('maps all US shifted punctuation and newline/tab without using the page-only IME path', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    b.typeSoftwareText('~!@#$%^&*()_+{}|:"<>?\r\n\t');
    const keys = ws.sent.map((frame: any) => [frame.data.event, frame.data.payload.keysym]);
    const expected = [...'~!@#$%^&*()_+{}|:"<>?'].flatMap((character) => [
      ['control/keydown', 0xffe1], ['control/keydown', character.charCodeAt(0)],
      ['control/keyup', character.charCodeAt(0)], ['control/keyup', 0xffe1],
    ]);
    expected.push(['control/keydown', 0xff0d], ['control/keyup', 0xff0d], ['control/keydown', 0xff09], ['control/keyup', 0xff09]);
    expect(keys).toEqual(expected);
    b.disconnect();
  });

  it('releases software-held keys before committed text rather than preserving a missing Shift keyup', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    b.softwareKey(true, { key: 'Shift', code: 'ShiftLeft' });
    b.typeSoftwareText('A');
    expect(ws.neko('control/keyup')).toEqual([{ keysym: 0xffe1 }, { keysym: 0x41 }, { keysym: 0xffe1 }]);
    b.softwareKey(true, { key: 'ArrowLeft', code: 'ArrowLeft' });
    b.releaseAllKeys();
    expect(ws.neko('control/keyup')).toEqual([{ keysym: 0xffe1 }, { keysym: 0x41 }, { keysym: 0xffe1 }, { keysym: 0xff51 }]);
    const count = ws.sent.length;
    b.releaseAllKeys();
    expect(ws.sent).toHaveLength(count);
    expect(b.softwareKey(true, { key: 'Process', code: '' })).toBe(false);
    b.disconnect();
  });

  it('reports a failed keyup and releases the keydown already handed to the transport', async () => {
    const onInputError = vi.fn();
    const { b } = setup([], { onInputError });
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    const send = ws.send.bind(ws);
    let failKeyup = true;
    vi.spyOn(ws, 'send').mockImplementation((raw) => {
      if (failKeyup && JSON.parse(raw).data?.event === 'control/keyup') {
        failKeyup = false;
        throw new Error('transport write failed');
      }
      send(raw);
    });
    b.typeSoftwareText('a');
    expect(onInputError.mock.calls).toEqual([['transport']]);
    expect(ws.neko('control/keydown')).toEqual([{ keysym: 0x61 }]);
    expect(ws.neko('control/keyup')).toEqual([{ keysym: 0x61 }]);
    const sent = ws.sent.length;
    b.typeSoftwareText('b');
    expect(ws.sent).toHaveLength(sent);
    b.disconnect();
  });

  it('releases a transmitted key when its keyup is backpressured and the relay reports input failure', async () => {
    const onInputError = vi.fn();
    const { b } = setup([], { onInputError });
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    const send = ws.send.bind(ws);
    vi.spyOn(ws, 'send').mockImplementation((raw) => {
      send(raw);
      if (JSON.parse(raw).data?.event === 'control/keydown') ws.bufferedAmount = 512 * 1024;
    });
    b.typeSoftwareText('a');
    expect(ws.neko('control/keydown')).toEqual([{ keysym: 0x61 }]);
    expect(ws.neko('control/keyup')).toEqual([]);
    ws.push({ t: 'input_error', reason: 'relay unavailable' });
    expect(onInputError.mock.calls).toEqual([['relay']]);
    expect(ws.neko('control/keyup')).toEqual([{ keysym: 0x61 }]);
    ws.bufferedAmount = 0;
    await tick();
    expect(ws.neko('control/keyup')).toEqual([{ keysym: 0x61 }]);
    b.disconnect();
  });

  it('uses Neko screen capabilities for both dimensions and rate, ignoring malformed entries', async () => {
    vi.useFakeTimers();
    const { b } = setup();
    b.setViewport(1700, 1000);
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    ws.push({ t: 'neko', data: { event: 'system/admin', payload: { screen_sizes_list: [
      null,
      { width: 1600, height: 900, rate: 0 },
      { width: '1600', height: 900, rate: 30 },
      { width: 1280, height: 720, rate: 30 },
      { width: 1368, height: 768, rate: 30 },
      { width: 1600, height: 900, rate: 25 },
      { width: 1920, height: 1080, rate: 30 },
    ] } } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(ws.neko('screen/set')).toEqual([{ width: 1600, height: 900, rate: 25 }]);

    b.setViewport(1440, 860);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.neko('screen/set').at(-1)).toEqual({ width: 1368, height: 768, rate: 30 });
    b.disconnect();
  });

  it('uses Neko\'s 60 Hz fallback and corrects it if capabilities arrive after the stream', async () => {
    vi.useFakeTimers();
    const { b } = setup();
    b.setViewport(1700, 1000);
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(ws.neko('screen/set')).toEqual([{ width: 1600, height: 900, rate: 60 }]);

    ws.push({ t: 'neko', data: { event: 'system/admin', payload: {
      screen_sizes_list: [{ width: 1600, height: 900, rate: 25 }],
    } } });
    expect(ws.neko('screen/set')).toEqual([
      { width: 1600, height: 900, rate: 60 },
      { width: 1600, height: 900, rate: 25 },
    ]);
    b.disconnect();
  });

  it('keeps trickle candidates that arrive before the offer and applies them in order', async () => {
    vi.useFakeTimers();
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    const candidates = ['first', 'second'].map((candidate) => ({ candidate, sdpMid: '0', sdpMLineIndex: 0 }));
    for (const payload of candidates) ws.push({ t: 'neko', data: { event: 'signal/candidate', payload } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);

    expect(FakePC.last.candidates).toEqual(candidates);
    expect(ws.neko('signal/answer')).toHaveLength(1);
    b.disconnect();
  });

  it('waits for the remote description before adding candidates received during negotiation', async () => {
    vi.useFakeTimers();
    let finishDescription!: () => void;
    vi.spyOn(FakePC.prototype, 'setRemoteDescription').mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishDescription = resolve; }),
    );
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    const pc = FakePC.last;
    const candidate = { candidate: 'during-description', sdpMid: '0', sdpMLineIndex: 0 };
    ws.push({ t: 'neko', data: { event: 'signal/candidate', payload: candidate } });
    expect(pc.candidates).toEqual([]);

    finishDescription();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.candidates).toEqual([candidate]);
    expect(ws.neko('signal/answer')).toHaveLength(1);
    b.disconnect();
  });

  it('clears old candidates on disconnect and ignores frames from the old socket', async () => {
    vi.useFakeTimers();
    const { b } = setup();
    await b.connect();
    const old = FakeWS.all[0]!;
    old.push({ t: 'agent_online' });
    old.push({ t: 'neko', data: { event: 'signal/candidate', payload: { candidate: 'stale' } } });
    b.disconnect();
    await b.connect();
    const current = FakeWS.all[1]!;
    current.push({ t: 'agent_online' });
    old.push({ t: 'neko', data: { event: 'signal/candidate', payload: { candidate: 'late-stale' } } });
    const candidate = { candidate: 'current', sdpMid: '0', sdpMLineIndex: 0 };
    current.push({ t: 'neko', data: { event: 'signal/candidate', payload: candidate } });
    current.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);

    expect(FakePC.last.candidates).toEqual([candidate]);
    b.disconnect();
  });

  it('retries instead of keeping an unbounded queue of candidates without an offer', async () => {
    vi.useFakeTimers();
    const { b, states } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    for (let i = 0; i < 257; i++) {
      ws.push({ t: 'neko', data: { event: 'signal/candidate', payload: { candidate: `candidate-${i}` } } });
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.readyState).toBe(3);
    expect(states.at(-1)).toBe('reconnecting');
    b.disconnect();
  });

  it('starts a fresh handshake and clears queued candidates after the agent goes offline', async () => {
    vi.useFakeTimers();
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    ws.push({ t: 'neko', data: { event: 'signal/candidate', payload: { candidate: 'before-offline' } } });
    ws.push({ t: 'agent_offline' });
    expect(vi.getTimerCount()).toBe(0);
    ws.push({ t: 'agent_online' });
    expect(ws.neko('signal/request')).toHaveLength(1);
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    expect(ws.neko('signal/request')).toHaveLength(2);
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'fresh-offer' } } });
    await vi.advanceTimersByTimeAsync(0);

    expect(FakePC.last.candidates).toEqual([]);
    expect(ws.neko('signal/answer')).toHaveLength(1);
    b.disconnect();
  });

  it('retries with a fresh token when an online agent never provides an offer', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    expect(ws.neko('signal/request')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(ws.readyState).toBe(1);
    expect(getConnectInfo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.readyState).toBe(3);
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    expect(FakeWS.all[1]!.url).toContain('token=tok2');
    b.disconnect();
  });

  it('also retries when ICE does not connect within the configured deadline', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup([], { connectionTimeoutMs: 1000 });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePC.last;
    expect(ws.neko('signal/answer')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.readyState).toBe(3);
    expect(pc.closed).toBe(true);
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    b.disconnect();
  });

  it('reconnects after an invalid offer instead of remaining in connecting', async () => {
    vi.useFakeTimers();
    vi.spyOn(FakePC.prototype, 'setRemoteDescription').mockRejectedValueOnce(new Error('invalid offer'));
    const { b, getConnectInfo, states } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'invalid-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.readyState).toBe(3);
    expect(FakePC.last.closed).toBe(true);
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    b.disconnect();
  });

  it('pauses preconnect input on a negotiation deadline and never replays its queued click', async () => {
    vi.useFakeTimers();
    const onInputError = vi.fn();
    const { b, getConnectInfo } = setup([], { connectionTimeoutMs: 100, onInputError });
    await b.connect();
    const old = FakeWS.all[0]!;
    old.push({ t: 'agent_online' });
    b.button(true, 0, 100, 100);
    b.button(false, 0, 100, 100);
    expect(old.neko('control/buttondown')).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onInputError).toHaveBeenCalledExactlyOnceWith('disconnected');
    expect(old.readyState).toBe(3);
    expect(getConnectInfo).toHaveBeenCalledTimes(1);

    await b.connect(); // An explicit retry starts a fresh queue.
    const current = FakeWS.all[1]!;
    current.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(current.neko('control/buttondown')).toEqual([]);
    expect(current.neko('control/buttonup')).toEqual([]);
    b.disconnect();
  });

  it('cancels the connection deadline once the stream is live', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.at(-1)).toBe('live');
    expect(ws.readyState).toBe(1);
    expect(getConnectInfo).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    b.disconnect();
  });

  it('cancels the connection deadline when disconnected', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup();
    await b.connect();
    FakeWS.all[0]!.push({ t: 'agent_online' });
    b.disconnect();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.at(-1)).toBe('closed');
    expect(getConnectInfo).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a rejected negotiation from a replaced connection', async () => {
    vi.useFakeTimers();
    let rejectOffer!: (error: Error) => void;
    vi.spyOn(FakePC.prototype, 'setRemoteDescription').mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectOffer = reject; }),
    );
    const { b, getConnectInfo, states } = setup();
    await b.connect();
    const old = FakeWS.all[0]!;
    old.push({ t: 'agent_online' });
    old.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'old-offer' } } });
    old.close();
    expect(vi.getTimerCount()).toBe(1); // only the reconnect backoff remains

    await vi.advanceTimersByTimeAsync(500);
    const current = FakeWS.all[1]!;
    current.push({ t: 'agent_online' });
    current.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'new-offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    rejectOffer(new Error('old peer closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(current.readyState).toBe(1);
    FakePC.last.connect();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.at(-1)).toBe('live');
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    b.disconnect();
  });

  it('reconnects with a fresh token after the connection drops, but not after a take-over', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup();
    await b.connect();
    FakeWS.all[0]!.close();
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(600);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    expect(FakeWS.all[1]!.url).toContain('token=tok2');

    FakeWS.all[1]!.push({ t: 'agent_online' });
    FakeWS.all[1]!.push({ t: 'taken_over' });
    FakeWS.all[1]!.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.at(-1)).toBe('taken-over');
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    b.disconnect();
    vi.useRealTimers();
  });
});
