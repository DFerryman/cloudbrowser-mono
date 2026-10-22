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

  it('gives Premium the 60 Hz desktop where neko has one, and the same size as Basic', () => {
    const configurations = [
      { width: 1368, height: 768, rate: 60 },
      { width: 1368, height: 768, rate: 30 },
      { width: 1600, height: 900, rate: 60 },
      { width: 1600, height: 900, rate: 25 },
      { width: 1920, height: 1080, rate: 60 },
      { width: 1920, height: 1080, rate: 30 },
      { width: 2560, height: 1440, rate: 30 },
      { width: 2560, height: 1440, rate: 25 },
    ];
    expect(fitScreen(2000, 1200, configurations, 60)).toEqual({ width: 1920, height: 1080, rate: 60 });
    expect(fitScreen(1700, 1000, configurations, 60)).toEqual({ width: 1600, height: 900, rate: 60 });
    expect(fitScreen(1440, 860, configurations, 60)).toEqual({ width: 1368, height: 768, rate: 60 });
    // Basic keeps its 30 Hz cap on the same image.
    expect(fitScreen(2000, 1200, configurations)).toEqual({ width: 1920, height: 1080, rate: 30 });
    expect(fitScreen(1700, 1000, configurations)).toEqual({ width: 1600, height: 900, rate: 25 });
    // A size without a 60 Hz mode stays at its best rate.
    expect(fitScreen(4000, 2500, configurations, 60)).toEqual({ width: 2560, height: 1440, rate: 30 });
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
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
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
  getStats?: () => Promise<Map<string, unknown>>;
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
    options: Pick<RemoteBrowserOptions, 'connectionTimeoutMs' | 'maxConnectionAttempts' | 'requireFirstFrame' | 'onDiagnostic' | 'onStream' | 'onStats' | 'onInputError' | 'video' | 'onVideo'> = {},
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
    expect(new URL(ws.url).searchParams.get('token')).toBe('tok1');
    expect(new URL(ws.url).searchParams.get('attemptId')).toMatch(/^[0-9a-f-]{36}$/);

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

  it('does not restart neko\'s encoder when its screen already fits, on connect and on reconnect', async () => {
    vi.useFakeTimers();
    const { b } = setup();
    b.setViewport(1700, 1000);
    await b.connect();
    for (let attempt = 0; attempt < 2; attempt++) {
      const ws = FakeWS.all.at(-1)!;
      ws.push({ t: 'agent_online' });
      ws.push({ t: 'neko', data: { event: 'system/init', payload: { screen_size: { width: 1600, height: 900, rate: 25 } } } });
      ws.push({ t: 'neko', data: { event: 'system/admin', payload: { screen_sizes_list: [{ width: 1600, height: 900, rate: 25 }, { width: 1920, height: 1080, rate: 30 }] } } });
      ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
      await vi.advanceTimersByTimeAsync(0);
      FakePC.last.connect();
      await vi.advanceTimersByTimeAsync(5000);
      expect(ws.neko('screen/set')).toEqual([]);
      if (attempt === 0) {
        ws.close();
        await vi.advanceTimersByTimeAsync(1000); // the viewer reconnects with a fresh token
      }
    }
    b.disconnect();
  });

  it('changes the screen during the handshake so the first frame already has the right size', async () => {
    vi.useFakeTimers();
    const { b } = setup();
    b.setViewport(1700, 1000);
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { screen_size: { width: 1920, height: 1080, rate: 30 } } } });
    expect(ws.neko('signal/request')).toHaveLength(1);
    ws.push({ t: 'neko', data: { event: 'system/admin', payload: { screen_sizes_list: [{ width: 1600, height: 900, rate: 25 }, { width: 1920, height: 1080, rate: 30 }] } } });
    // Sent before neko's offer: its encoder restart overlaps ICE and DTLS instead of following the first frame.
    expect(ws.neko('screen/set')).toEqual([{ width: 1600, height: 900, rate: 25 }]);
    expect(ws.sent.findIndex((f: any) => f.data.event === 'screen/set')).toBeGreaterThan(ws.sent.findIndex((f: any) => f.data.event === 'signal/request'));
    ws.push({ t: 'neko', data: { event: 'screen/updated', payload: { width: 1600, height: 900, rate: 25 } } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.neko('screen/set')).toHaveLength(1);
    // A later viewport change still applies, through the ordered input queue.
    b.setViewport(2000, 1200);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.neko('screen/set').at(-1)).toEqual({ width: 1920, height: 1080, rate: 30 });
    b.disconnect();
  });

  it('treats Xorg\'s width rounding as the same screen mode', async () => {
    vi.useFakeTimers();
    const { b } = setup();
    b.setViewport(1600, 860);
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    // 1366×768 was requested earlier; Xorg rounded the width down to 1360.
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { screen_size: { width: 1360, height: 768, rate: 60 } } } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(ws.neko('screen/set')).toEqual([]);
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
    expect(vi.getTimerCount()).toBe(1); // an offline agent also has a bounded reconnect deadline
    ws.push({ t: 'agent_online' });
    expect(ws.neko('signal/request')).toHaveLength(1);
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    expect(ws.neko('signal/request')).toHaveLength(2);
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'fresh-offer' } } });
    await vi.advanceTimersByTimeAsync(0);

    expect(FakePC.last.candidates).toEqual([]);
    expect(ws.neko('signal/answer')).toHaveLength(1);
    FakePC.last.connect();
    b.button(true, 0, 100, 100);
    b.button(false, 0, 100, 100);
    expect(ws.neko('control/buttondown')).toEqual([{ code: 1 }]);
    expect(ws.neko('control/buttonup')).toEqual([{ code: 1 }]);
    b.disconnect();
  });

  it('retries when a WebSocket upgrade never delivers the first gateway frame', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup([], { connectionTimeoutMs: 1000 });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.readyState = 0;

    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.readyState).toBe(3);
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    b.disconnect();
  });

  it('stops after three failed attempts and gives an explicit retry a fresh budget', async () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const { b, getConnectInfo, states } = setup([], { connectionTimeoutMs: 100, onDiagnostic });
    await b.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getConnectInfo).toHaveBeenCalledTimes(3);
    expect(states.at(-1)).toBe('failed');
    expect(FakeWS.all.every((ws) => ws.readyState === 3)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const attempts = onDiagnostic.mock.calls.map(([d]) => d).filter((d) => d.stage === 'token_start');
    expect(new Set(attempts.map((d) => d.attemptId)).size).toBe(3);
    expect(onDiagnostic.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'closed', code: 'retry_exhausted' });

    await b.connect();
    expect(states.at(-1)).toBe('connecting');
    await vi.advanceTimersByTimeAsync(600);
    expect(getConnectInfo).toHaveBeenCalledTimes(5);
    expect(states.at(-1)).toBe('reconnecting');
    b.disconnect();
  });

  it('bounds repeated token failures without exposing the rejected error', async () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const { b, getConnectInfo, states } = setup([], { onDiagnostic });
    getConnectInfo.mockRejectedValue(new Error('token=private-value https://private.example/path'));
    await b.connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getConnectInfo).toHaveBeenCalledTimes(3);
    expect(FakeWS.all).toHaveLength(0);
    expect(states.at(-1)).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private-value|private\.example/);
    b.disconnect();
  });

  it('resets the consecutive failure budget once the desktop becomes live', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup([], { maxConnectionAttempts: 2 });
    await b.connect();
    FakeWS.all[0]!.close();
    await vi.advanceTimersByTimeAsync(500);
    const current = FakeWS.all[1]!;
    current.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(states.at(-1)).toBe('live');
    current.close();
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(getConnectInfo).toHaveBeenCalledTimes(3);
    b.disconnect();
  });

  it('gives a dropped live connection a full new automatic connection budget', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup([], { maxConnectionAttempts: 1, connectionTimeoutMs: 100 });
    await b.connect();
    const current = FakeWS.all[0]!;
    current.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    current.close();
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
    b.disconnect();
  });

  it('does not let a late token response revive the exhausted attempt', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup([], { connectionTimeoutMs: 100, maxConnectionAttempts: 1 });
    let finish!: (info: { gatewayUrl: string; token: string; iceServers: [] }) => void;
    getConnectInfo.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = b.connect();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(states.at(-1)).toBe('failed');
    finish({ gatewayUrl: 'wss://gw', token: 'late-token', iceServers: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.all).toHaveLength(0);
    expect(states.at(-1)).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
    b.disconnect();
  });

  it('correlates safe milestones with the gateway attempt and relay without SDP or tokens', async () => {
    const onDiagnostic = vi.fn();
    const { b } = setup([], { onDiagnostic });
    await b.connect();
    const ws = FakeWS.all[0]!;
    const attemptId = new URL(ws.url).searchParams.get('attemptId');
    const relayId = '74c20e60-8c15-4c3d-849e-ddc4cc42c728';
    ws.onopen?.();
    ws.push({ t: 'connection_stage', stage: 'gateway_accepted', relayId });
    ws.push({ t: 'connection_stage', stage: 'received', relayId });
    ws.push({ t: 'connection_stage', stage: 'login_start', relayId });
    ws.push({ t: 'connection_stage', stage: 'login_ok', relayId });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { privateField: 'never-export-this' } } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'private-sdp-should-not-appear' } } });
    await tick();
    const diagnostics = onDiagnostic.mock.calls.map(([d]) => d);
    expect(diagnostics.every((d) => d.attemptId === attemptId)).toBe(true);
    expect(diagnostics.map((d) => d.stage)).toEqual([
      'token_start', 'token_ok', 'transport_start', 'transport_open', 'gateway_accepted',
      'agent_received', 'login_start', 'login_ok', 'desktop_ready', 'signal_received',
    ]);
    expect(diagnostics.find((d) => d.stage === 'agent_received')).toMatchObject({ relayId });
    expect(JSON.stringify(diagnostics)).not.toMatch(/tok1|private-sdp|never-export/);
    b.disconnect();
  });

  it('keeps a rendered desktop connecting until an actual frame from the current attempt arrives', async () => {
    const onDiagnostic = vi.fn();
    const onStream = vi.fn();
    const { b, states } = setup([], { requireFirstFrame: true, onDiagnostic, onStream });
    await b.connect();
    const ws = FakeWS.all[0]!;
    const attemptId = new URL(ws.url).searchParams.get('attemptId')!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await tick();
    const track = { kind: 'video' };
    FakePC.last.ontrack({ streams: [{ getTracks: () => [track] }], track });
    const frameSequence = onStream.mock.calls[0]![2];
    FakePC.last.connect();
    expect(states.at(-1)).toBe('connecting');
    b.reportFirstFrame('older-attempt', frameSequence);
    expect(states.at(-1)).toBe('connecting');
    b.reportFirstFrame(attemptId, frameSequence);
    expect(states.at(-1)).toBe('live');
    b.reportFirstFrame(attemptId, frameSequence);
    expect(onDiagnostic.mock.calls.filter(([d]) => d.stage === 'first_frame')).toHaveLength(1);
    await b.connect();
    b.reportFirstFrame(attemptId, frameSequence);
    expect(states.at(-1)).toBe('connecting');
    b.disconnect();
  });

  it('times out a connected peer that never produces a video frame', async () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const { b, states } = setup([], { requireFirstFrame: true, connectionTimeoutMs: 100, maxConnectionAttempts: 1, onDiagnostic });
    await b.connect();
    FakeWS.all[0]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(states.at(-1)).toBe('connecting');
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)).toBe('failed');
    expect(onDiagnostic.mock.calls.some(([d]) => d.stage === 'peer_connected')).toBe(true);
    expect(onDiagnostic.mock.calls.some(([d]) => d.stage === 'first_frame')).toBe(false);
    expect(onDiagnostic.mock.calls.some(([d]) => d.code === 'connection_timeout')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    b.disconnect();
  });

  it('requires a fresh frame for a replacement peer on the same socket and ignores its old render callback', async () => {
    vi.useFakeTimers();
    const onStream = vi.fn();
    const onDiagnostic = vi.fn();
    const { b, states } = setup([], { requireFirstFrame: true, onStream, onDiagnostic });
    await b.connect();
    const ws = FakeWS.all[0]!;
    const attemptId = new URL(ws.url).searchParams.get('attemptId')!;
    const track = { kind: 'video' };
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'first' } } });
    await vi.advanceTimersByTimeAsync(0);
    const first = FakePC.last;
    first.ontrack({ streams: [{ getTracks: () => [track] }], track });
    first.connect();
    const oldFrameSequence = onStream.mock.calls[0]![2];
    b.reportFirstFrame(attemptId, oldFrameSequence);
    expect(states.at(-1)).toBe('live');

    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'replacement' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.closed).toBe(true);
    FakePC.last.connect();
    b.reportFirstFrame(attemptId, oldFrameSequence);
    expect(states.at(-1)).toBe('connecting');
    FakePC.last.ontrack({ streams: [{ getTracks: () => [track] }], track });
    const newFrameSequence = onStream.mock.calls[1]![2];
    expect(newFrameSequence).not.toBe(oldFrameSequence);
    b.reportFirstFrame(attemptId, oldFrameSequence);
    expect(states.at(-1)).toBe('connecting');
    b.reportFirstFrame(attemptId, newFrameSequence);
    expect(states.at(-1)).toBe('live');
    const connected = onDiagnostic.mock.calls.map(([d]) => d).filter((d) => d.stage === 'peer_connected');
    const frames = onDiagnostic.mock.calls.map(([d]) => d).filter((d) => d.stage === 'first_frame');
    expect(connected.map((d) => d.peerSequence)).toEqual([oldFrameSequence, newFrameSequence]);
    expect(frames.map((d) => d.peerSequence)).toEqual([oldFrameSequence, newFrameSequence]);
    expect(frames.every((d) => d.attemptId === attemptId)).toBe(true);
    b.disconnect();
  });

  it('keeps video and audio on one playback stream and ignores tracks from a replaced attempt', async () => {
    const onStream = vi.fn();
    const { b } = setup([], { onStream });
    await b.connect();
    FakeWS.all[0]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await tick();
    const old = FakePC.last;
    const video = { kind: 'video' };
    const audio = { kind: 'audio' };
    const tracks = [video];
    const stream = { getTracks: () => tracks, addTrack: (track: typeof video) => tracks.push(track) };
    old.ontrack({ streams: [stream], track: video });
    old.ontrack({ streams: [{ getTracks: () => [audio] }], track: audio });
    expect(onStream.mock.calls.map(([value]) => value)).toEqual([stream, stream]);
    expect(stream.getTracks()).toEqual([video, audio]);
    await b.connect();
    old.ontrack({ streams: [stream], track: video });
    expect(onStream).toHaveBeenCalledTimes(2);
    b.disconnect();
  });

  it('waits for a video track before attaching an audio-first stream to the renderer', async () => {
    const onStream = vi.fn();
    const { b } = setup([], { onStream });
    await b.connect();
    FakeWS.all[0]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await tick();
    const audio = { kind: 'audio' };
    const video = { kind: 'video' };
    const tracks = [audio];
    const stream = { getTracks: () => tracks, addTrack: (track: typeof audio) => tracks.push(track) };
    FakePC.last.ontrack({ streams: [stream], track: audio });
    expect(onStream).not.toHaveBeenCalled();
    FakePC.last.ontrack({ streams: [{ getTracks: () => [video] }], track: video });
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onStream.mock.calls[0]![0]).toBe(stream);
    expect(tracks).toEqual([audio, video]);
    b.disconnect();
  });

  it('does not wait forever when a running browser has no connected agent', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup([], { connectionTimeoutMs: 1000 });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_offline' });
    expect(states.at(-1)).toBe('agent-offline');

    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.readyState).toBe(3);
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    b.disconnect();
  });

  it('ignores an older token response that arrives after a repeated connection attempt', async () => {
    const { b, getConnectInfo } = setup();
    let finishOld!: (info: { gatewayUrl: string; token: string; iceServers: [] }) => void;
    getConnectInfo.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const oldAttempt = b.connect();
    await b.connect();
    expect(FakeWS.all).toHaveLength(1);
    const current = FakeWS.all[0]!;
    finishOld({ gatewayUrl: 'wss://gw/v1/stream/i1', token: 'stale', iceServers: [] });
    await oldAttempt;

    expect(FakeWS.all).toHaveLength(1);
    expect(current.readyState).toBe(1);
    b.disconnect();
  });

  it('does not let a stale failed connection schedule a retry over the current socket', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup();
    let rejectOld!: (error: Error) => void;
    getConnectInfo.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const oldAttempt = b.connect();
    await b.connect();
    const current = FakeWS.all[0]!;
    rejectOld(new Error('outdated request failed'));
    await oldAttempt;

    expect(states.at(-1)).toBe('connecting');
    expect(vi.getTimerCount()).toBe(1); // current socket's deadline, no stale retry
    expect(current.readyState).toBe(1);
    b.disconnect();
  });

  it('does not revive a disconnected page from an outstanding token response', async () => {
    const { b, getConnectInfo, states } = setup();
    let finish!: (info: { gatewayUrl: string; token: string; iceServers: [] }) => void;
    getConnectInfo.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const attempt = b.connect();
    b.disconnect();
    finish({ gatewayUrl: 'wss://gw/v1/stream/i1', token: 'late', iceServers: [] });
    await attempt;

    expect(FakeWS.all).toHaveLength(0);
    expect(states.at(-1)).toBe('closed');
  });

  it('bounds a stalled token request and ignores its response after the fresh attempt starts', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo, states } = setup([], { connectionTimeoutMs: 1000 });
    let finishOld!: (info: { gatewayUrl: string; token: string; iceServers: [] }) => void;
    getConnectInfo.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const stalled = b.connect();
    await vi.advanceTimersByTimeAsync(1000);
    await stalled;
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    expect(FakeWS.all).toHaveLength(1);

    finishOld({ gatewayUrl: 'wss://gw/v1/stream/i1', token: 'expired', iceServers: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all).toHaveLength(1);
    b.disconnect();
  });

  it('cancels a pending token deadline immediately when the page disconnects', async () => {
    vi.useFakeTimers();
    const { b, getConnectInfo } = setup();
    getConnectInfo.mockImplementationOnce(() => new Promise(() => {}));
    const pending = b.connect();
    b.disconnect();
    await pending;

    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWS.all).toHaveLength(0);
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

  it('asks for the picture level from the settings and switches it on a live stream', async () => {
    const levels: string[] = [];
    const { b } = setup([], { video: { quality: 'high', auto: false }, onVideo: (q) => levels.push(q) });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { screen_size: { width: 1920, height: 1080, rate: 30 }, webrtc: { videos: ['full', 'high', 'medium', 'low'] } } } });
    expect(ws.neko('signal/request')).toEqual([{ video: { selector: { id: 'high', type: 'exact' }, auto: false }, audio: {} }]);
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp', video: { id: 'high' } } } });
    await tick();
    FakePC.last.connect();
    expect(levels).toEqual(['high']);
    expect(b.screenSize).toEqual({ width: 1920, height: 1080 });

    // A changed setting applies without reconnecting; neko confirms the level it streams.
    b.setVideoPreference({ quality: 'medium', auto: false });
    expect(ws.neko('signal/video')).toEqual([{ selector: { id: 'medium', type: 'exact' }, auto: false }]);
    ws.push({ t: 'neko', data: { event: 'signal/video', payload: { id: 'medium', auto: false } } });
    expect(levels).toEqual(['high', 'medium']);
    b.setVideoPreference({ quality: 'medium', auto: false });
    expect(ws.neko('signal/video')).toHaveLength(1);
    b.disconnect();
  });

  it.each([false, true])('steps down for undecoded frames, not unknown counts (requireFirstFrame=%s)', async (requireFirstFrame) => {
    vi.useFakeTimers();
    for (const framesDecoded of [0, undefined]) {
      const { b } = setup([], { requireFirstFrame, video: { quality: 'full', auto: true } });
      await b.connect();
      const ws = FakeWS.all[0]!;
      ws.push({ t: 'agent_online' });
      ws.push({ t: 'neko', data: { event: 'system/init', payload: { webrtc: { videos: ['full', 'high', 'medium', 'low'] } } } });
      ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp', video: { id: 'full' } } } });
      await vi.advanceTimersByTimeAsync(0);
      // The decoder waits for a keyframe: packets keep coming, frames do not (no framesPerSecond either).
      let received = 0;
      FakePC.last.getStats = async () => {
        received += 500;
        return new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', packetsReceived: received, packetsLost: 0, bytesReceived: received * 1200, framesDecoded }]]);
      };
      FakePC.last.connect();
      await vi.advanceTimersByTimeAsync(10_000);
      // Another level starts with a keyframe; a browser that reports no frame counts is left alone.
      expect(ws.neko('signal/video')).toEqual(framesDecoded === 0 ? [{ selector: { id: 'high', type: 'exact' }, auto: false }] : []);
      expect(b.currentState).toBe(requireFirstFrame ? 'connecting' : 'live');
      b.disconnect();
    }
  });

  it('recovers picture quality before the first frame without enabling input or reporting live early', async () => {
    vi.useFakeTimers();
    const onStream = vi.fn();
    const onStats = vi.fn();
    const { b, states } = setup([], { requireFirstFrame: true, onStream, onStats });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { webrtc: { videos: ['full', 'high', 'medium', 'low'] } } } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer', video: { id: 'full' } } } });
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePC.last;
    let received = 0;
    pc.getStats = vi.fn(async () => {
      received += 500;
      return new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', packetsReceived: received, bytesReceived: received * 1200, framesDecoded: 0 }]]);
    });
    const track = { kind: 'video' };
    pc.ontrack({ streams: [{ getTracks: () => [track] }], track });
    pc.connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.neko('signal/video')).toEqual([{ selector: { id: 'high', type: 'exact' }, auto: false }]);
    expect(pc.getStats).toHaveBeenCalledTimes(5);
    expect(onStats).toHaveBeenCalledTimes(5);
    expect(states).not.toContain('live');
    b.key(true, { key: 'a', code: 'KeyA' });
    expect(ws.neko('control/keydown')).toEqual([]);
    b.reportFirstFrame(new URL(ws.url).searchParams.get('attemptId')!, onStream.mock.calls[0]![2]);
    expect(states.at(-1)).toBe('live');
    // First-frame confirmation keeps the existing sampler instead of starting another one.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pc.getStats).toHaveBeenCalledTimes(6);
    b.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 9000])('keeps the connection deadline while adapting a peer connected after %i ms', async (connectDelay) => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const { b, states } = setup([], { requireFirstFrame: true, maxConnectionAttempts: 1, onDiagnostic });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { webrtc: { videos: ['full', 'high', 'medium', 'low'] } } } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer', video: { id: 'full' } } } });
    await vi.advanceTimersByTimeAsync(0);
    let received = 0;
    FakePC.last.getStats = async () => {
      received += 500;
      return new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', packetsReceived: received, bytesReceived: received * 1200, framesDecoded: 0 }]]);
    };
    await vi.advanceTimersByTimeAsync(connectDelay);
    FakePC.last.connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.neko('signal/video')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000 - connectDelay - 1);
    expect(states.at(-1)).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(states.at(-1)).toBe('failed');
    expect(states).not.toContain('live');
    expect(onDiagnostic.mock.calls.some(([d]) => d.code === 'connection_timeout')).toBe(true);
    expect(onDiagnostic.mock.calls.some(([d]) => d.code === 'retry_exhausted')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    b.disconnect();
  });

  it('collects pre-frame stats without overriding a fixed picture preference', async () => {
    vi.useFakeTimers();
    const onStats = vi.fn();
    const { b } = setup([], { requireFirstFrame: true, video: { quality: 'high', auto: false }, onStats });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { webrtc: { videos: ['full', 'high', 'medium', 'low'] } } } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer', video: { id: 'high' } } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.getStats = async () => new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', packetsReceived: 0, framesDecoded: 0 }]]);
    FakePC.last.connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onStats).toHaveBeenCalledTimes(5);
    expect(ws.neko('signal/video')).toEqual([]);
    expect(b.currentState).toBe('connecting');
    b.disconnect();
  });

  it('ignores pending media stats from a replaced peer and does not overlap reads', async () => {
    vi.useFakeTimers();
    const onStats = vi.fn();
    const { b } = setup([], { requireFirstFrame: true, onStats });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'first' } } });
    await vi.advanceTimersByTimeAsync(0);
    const old = FakePC.last;
    let finishOld!: (report: Map<string, unknown>) => void;
    old.getStats = vi.fn(() => new Promise((resolve) => { finishOld = resolve; }));
    old.connect();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(old.getStats).toHaveBeenCalledTimes(1);
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'replacement' } } });
    await vi.advanceTimersByTimeAsync(0);
    const current = FakePC.last;
    current.getStats = vi.fn(async () => new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', frameWidth: 1280 }]]));
    current.connect();
    finishOld(new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', frameWidth: 640 }]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(onStats).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(current.getStats).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ width: 1280 }));
    b.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('streams the one video of an older browser image, without picture levels', async () => {
    const { b } = setup([], { video: { quality: 'medium', auto: true } });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { webrtc: { videos: ['main'] } } } });
    expect(ws.neko('signal/request')).toEqual([{ video: {}, audio: {} }]);
    await readyInput(ws);
    b.setVideoPreference({ quality: 'low', auto: false });
    expect(ws.neko('signal/video')).toEqual([]);
    b.disconnect();
  });

  it('cancels the connection deadline once the stream is live', async () => {
    vi.useFakeTimers();
    // A fixed picture level needs no quality readings, so no timer should remain.
    const { b, getConnectInfo, states } = setup([], { video: { quality: 'full', auto: false } });
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
