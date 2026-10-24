import { ConnectionDiagnostic, TIERS } from '@cloudbrowser/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keysymFor, keysymForName } from '../src/keyboard.js';
import { decode, encode, fitScreen, MIN_SCREEN_SIDE, shapedScreen, squarePixels } from '../src/neko.js';
import { RemoteBrowser, type RemoteBrowserOptions } from '../src/remote-browser.js';
import { qualityLevel } from '../src/stats.js';

// What neko advertises on the browser image: its xorg.conf modes and the VESA and CVT modes Xorg
// adds itself (validateAllDefaultModes), at the rates neko lists (≤ 30 Hz, or tens up to 60).
const NEKO_MODES = ([
  [1024, 576, 30], [1024, 576, 60], [1024, 768, 60], [1152, 648, 30], [1152, 648, 60],
  [1280, 720, 30], [1280, 720, 60], [1280, 800, 60], [1280, 960, 60], [1280, 1024, 60],
  [1368, 768, 25], [1368, 768, 30], [1368, 768, 60], [1400, 900, 60], [1400, 1050, 60],
  [1600, 900, 25], [1600, 900, 60], [1600, 1200, 60], [1680, 1050, 60], [1920, 1080, 25],
  [1920, 1080, 30], [1920, 1080, 60], [1920, 1200, 60], [2048, 1152, 60], [2560, 1440, 25],
  [2560, 1440, 30], [3840, 2160, 25],
] as const).map(([width, height, rate]) => ({ width, height, rate }));

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

  it('only picks desktops that neko streams with square pixels', () => {
    // iPad Pro 12.9" in landscape: a 1366×829 box fitted 1280×800 at 60 Hz, which Safari painted at 11:10.
    expect(fitScreen(1366, 829, NEKO_MODES)).toEqual({ width: 1368, height: 768, rate: 30 });
    expect(fitScreen(1300, 985, NEKO_MODES)).toEqual({ width: 1280, height: 720, rate: 30 }); // not 1280×960
    expect(fitScreen(1400, 1000, NEKO_MODES)).toEqual({ width: 1368, height: 768, rate: 30 }); // not 1400×900
    expect(fitScreen(1700, 1250, NEKO_MODES)).toEqual({ width: 1600, height: 900, rate: 25 }); // not 1600×1200
    expect(fitScreen(1500, 950)).toEqual({ width: 1366, height: 768 }); // the fallback list has no 1440×900
    for (const [width, height] of [[1280, 720], [1360, 768], [1366, 768], [1368, 768], [1600, 900], [2560, 1440]] as const) {
      expect(squarePixels({ width, height })).toBe(true);
    }
    for (const [width, height] of [[1280, 800], [1440, 900], [1280, 960], [1280, 1024], [1400, 900], [800, 1600], [0, 0]] as const) {
      expect(squarePixels({ width, height })).toBe(false);
    }
  });

  it('takes a mode Xorg rounded up to a multiple of 8, such as 1368×768 for a 1366 px wide view', () => {
    const configurations = [{ width: 1280, height: 720, rate: 30 }, { width: 1368, height: 768, rate: 30 }];
    expect(fitScreen(1366, 829, configurations)).toEqual({ width: 1368, height: 768, rate: 30 });
    expect(fitScreen(1360, 829, configurations)).toEqual({ width: 1280, height: 720, rate: 30 });
    expect(fitScreen(1279.6, 719.6, configurations)).toEqual({ width: 1280, height: 720, rate: 30 });
  });

  it('keeps the desktop within a tier\'s pixel budget', () => {
    const configurations = [
      { width: 1368, height: 768, rate: 30 },
      { width: 1920, height: 1080, rate: 30 },
      { width: 2560, height: 1440, rate: 30 },
    ];
    expect(fitScreen(2560, 1440, configurations, 30, 1920 * 1080)).toEqual({ width: 1920, height: 1080, rate: 30 });
    expect(fitScreen(2560, 1440, configurations, 30, 2560 * 1440)).toEqual({ width: 2560, height: 1440, rate: 30 });
    expect(fitScreen(1440, 860, configurations, 30, 1920 * 1080)).toEqual({ width: 1368, height: 768, rate: 30 });
    // A budget below every mode is ignored rather than leaving no desktop at all.
    expect(fitScreen(2560, 1440, configurations, 30, 1000)).toEqual({ width: 2560, height: 1440, rate: 30 });
    // With neko's full list: Basic stops at 1080p, Premium takes 1440p, both at a bounded rate.
    expect(fitScreen(2600, 1500, NEKO_MODES, 30, TIERS.basic.maxScreenPixels)).toEqual({ width: 1920, height: 1080, rate: 30 });
    expect(fitScreen(2600, 1500, NEKO_MODES, 30, TIERS.premium.maxScreenPixels)).toEqual({ width: 2560, height: 1440, rate: 30 });
  });

  it('uses the supported rate when a screen has no mode at or below 30 Hz', () => {
    expect(fitScreen(1600, 1000, [{ width: 1440, height: 900, rate: 60 }])).toEqual({ width: 1440, height: 900, rate: 60 });
  });

  it('prefers a size offered at a bounded refresh rate over a larger one offered only faster', () => {
    // neko offers 2048×1152 only at 60 Hz: Chrome would draw twice the frames the stream carries.
    expect(fitScreen(2100, 1200, NEKO_MODES)).toEqual({ width: 1920, height: 1080, rate: 30 });
    expect(fitScreen(1700, 1000, [{ width: 1600, height: 900, rate: 60 }, { width: 1366, height: 768, rate: 30 }])).toEqual({ width: 1366, height: 768, rate: 30 });
    // Premium allows 60 Hz, so the larger desktop is the better fit there.
    expect(fitScreen(2100, 1200, NEKO_MODES, 60)).toEqual({ width: 2048, height: 1152, rate: 60 });
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

  it('shapes the desktop like the view on an image that streams any shape', () => {
    const basic = TIERS.basic.maxScreenPixels;
    // The view's own size, rounded down to multiples of 8, so the page shows at 100% and fills it:
    // a 1080p monitor's window, and an iPad Air held sideways and upright.
    expect(shapedScreen(1920, 951, 30, basic)).toEqual({ width: 1920, height: 944, rate: 30 });
    expect(shapedScreen(1180, 726, 30, basic)).toEqual({ width: 1176, height: 720, rate: 30 });
    expect(shapedScreen(820, 1086, 30, basic)).toEqual({ width: 816, height: 1080, rate: 30 });
    expect(shapedScreen(1279.6, 719.6, 30, basic)).toEqual({ width: 1272, height: 712, rate: 30 });
    // A phone: no side under MIN_SCREEN_SIDE, the desktop larger in proportion and shown scaled down.
    expect(shapedScreen(393, 660, 30, basic)).toEqual({ width: MIN_SCREEN_SIDE, height: 840, rate: 30 });
    expect(shapedScreen(852, 300, 30, basic)).toEqual({ width: 1424, height: MIN_SCREEN_SIDE, rate: 30 });
    expect(shapedScreen(660, 393, 30, basic)).toEqual({ width: 840, height: MIN_SCREEN_SIDE, rate: 30 }); // turned with the view
    // Over the tier's pixel budget, a smaller desktop of the same shape, shown enlarged.
    expect(shapedScreen(2560, 1311, 30, basic)).toEqual({ width: 2008, height: 1024, rate: 30 });
    expect(shapedScreen(2560, 1311, 30, TIERS.premium.maxScreenPixels)).toEqual({ width: 2560, height: 1304, rate: 30 });
    // A short strip of a window: the minimum side would take the area over the budget, so the long side gives way.
    expect(shapedScreen(3440, 300, 30, basic)).toEqual({ width: 4112, height: MIN_SCREEN_SIDE, rate: 30 });
    expect(shapedScreen(300, 3440, 30, basic)).toEqual({ width: MIN_SCREEN_SIDE, height: 4112, rate: 30 });
    for (const [w, h] of [[3440, 300], [5120, 400], [300, 3440], [2560, 1311], [393, 660]] as const) {
      const s = shapedScreen(w, h, 30, basic)!;
      expect(s.width * s.height).toBeLessThanOrEqual(basic);
    }
    // Without a budget, at most Premium's pixels.
    expect(shapedScreen(4000, 2500)).toEqual({ width: 2424, height: 1512, rate: 30 });
    expect(shapedScreen(0, 600)).toBeNull();
    expect(shapedScreen(800, Number.NaN)).toBeNull();
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
  /** Pings the viewer sent; the gateway's runtime answers them (setWebSocketAutoResponse) unless `answers` is off. */
  pings = 0;
  answers = true;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: { code?: number }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    if (s === '{"t":"ping"}') {
      this.pings++;
      if (this.answers) queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data: '{"t":"pong"}' }));
      return;
    }
    this.sent.push(JSON.parse(s));
  }
  close(code?: number) {
    this.readyState = 3;
    this.onclose?.(code === undefined ? undefined : { code });
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
    options: Partial<Omit<RemoteBrowserOptions, 'getConnectInfo' | 'onState' | 'WebSocketImpl' | 'RTCPeerConnectionImpl'>> = {},
  ) {
    FakeWS.all = [];
    const getConnectInfo = vi.fn(async () => ({ gatewayUrl: 'wss://gw/v1/stream/i1', token: `tok${getConnectInfo.mock.calls.length}`, iceServers }));
    const states: string[] = [];
    const issues: (string | null)[] = [];
    const b = new RemoteBrowser({
      getConnectInfo,
      onState: (s, _attempt, issue) => { states.push(s); issues.push(issue); },
      WebSocketImpl: FakeWS as never,
      RTCPeerConnectionImpl: FakePC as never,
      ...options,
    });
    return { b, getConnectInfo, states, issues };
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
    // Each boundary commits the half click (or more) left over before it, never after it.
    b.move(10, 20);
    b.scroll(0, 120);
    b.scroll(0, 60);
    b.scroll(0, -1);
    // The reversal's immediate click covers its first 120 px.
    b.scroll(0, -180);
    b.key(true, { key: 'a', code: 'KeyA' });
    b.scroll(0, 120);
    b.scroll(0, 60);
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

  it('lifts held modifiers an exact combination does not name, all but Shift', async () => {
    const { b } = setup([], { macToPc: true });
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    // A Mac's Shift+Option+←, sent as Ctrl+Shift+←; then Cmd+→ (Control on the remote) as End.
    b.key(true, { key: 'Shift', code: 'ShiftLeft' });
    b.key(true, { key: 'Alt', code: 'AltLeft' });
    b.sendCombo(['Control', 'ArrowLeft'], true);
    b.key(false, { key: 'Alt', code: 'AltLeft' });
    b.key(true, { key: 'Meta', code: 'MetaLeft' });
    b.sendCombo(['End'], true);
    b.key(false, { key: 'Meta', code: 'MetaLeft' });
    b.key(false, { key: 'Shift', code: 'ShiftLeft' });
    expect(ws.sent.map((frame: any) => `${frame.data.event.slice(8)} ${frame.data.payload.keysym.toString(16)}`)).toEqual([
      'keydown ffe1', 'keydown ffe9',
      'keyup ffe9', 'keydown ffe3', 'keydown ff51', 'keyup ff51', 'keyup ffe3', 'keydown ffe9',
      'keyup ffe9', 'keydown ffe3',
      'keyup ffe3', 'keydown ff57', 'keyup ff57', 'keydown ffe3',
      'keyup ffe3', 'keyup ffe1',
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

  it('makes the relay-only peer when the offer arrives, not before', async () => {
    // A peer made earlier to pre-allocate the relay (iceCandidatePoolSize) bought nothing: Chrome
    // uses that pool only for its own offers, and the viewer answers neko's.
    const turn = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }];
    const { b } = setup(turn);
    const before = FakePC.last;
    await b.connect();
    expect(FakePC.last).toBe(before);
    FakeWS.all[0]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await tick();
    expect(FakePC.last).not.toBe(before);
    expect(FakePC.last.config).toEqual({ iceServers: turn, iceTransportPolicy: 'relay' });
    b.disconnect();
  });

  it('reports a minute of the live picture\'s quality, and what it measured when the page is hidden', async () => {
    vi.useFakeTimers();
    const onQualityReport = vi.fn();
    const { b } = setup([], { onQualityReport });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp', video: { id: 'high' } } } });
    await vi.advanceTimersByTimeAsync(0);
    let received = 0;
    let freezeSeconds = 0;
    FakePC.last.getStats = async () => {
      received += 500;
      return new Map<string, unknown>([
        ['v', {
          id: 'v', type: 'inbound-rtp', kind: 'video', transportId: 't', packetsReceived: received, packetsLost: received / 100,
          bytesReceived: received * 1200, framesDecoded: received / 50, freezeCount: Math.floor(received / 5000), totalFreezesDuration: (freezeSeconds += 0.01),
          jitterBufferDelay: received / 1000, jitterBufferEmittedCount: received / 50, totalDecodeTime: received / 10_000, framesDropped: received / 1000,
          frameWidth: 1920, frameHeight: 1080,
        }],
        ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', { id: 'pair', type: 'candidate-pair', localCandidateId: 'local', currentRoundTripTime: 0.29 }],
        ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'udp' }],
      ]);
    };
    FakePC.last.connect();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(onQualityReport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onQualityReport).toHaveBeenCalledTimes(1);
    const report = onQualityReport.mock.calls[0]![0];
    expect(report).toEqual({
      attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      durationMs: 60_000,
      readings: 30,
      rttMs: 290,
      // The keepalive pings, answered at once by the fake gateway.
      gatewayRttMs: 0,
      fps: 5,
      kbps: 2400,
      loss: 0.0099,
      freezes: 3,
      freezeMs: 300,
      jitterBufferMs: 50,
      decodeMs: 5,
      framesDropped: 15,
      quality: 'high',
      width: 1920,
      height: 1080,
      localCandidateType: 'relay',
      relayProtocol: 'udp',
      nacks: null,
      retransmits: null,
      plis: null,
      keyframes: null,
      levelChanges: 0,
    });
    // Hidden 20 s into the next minute: those 20 s are reported now, and nothing while hidden.
    await vi.advanceTimersByTimeAsync(20_000);
    b.setVisible(false);
    expect(onQualityReport).toHaveBeenCalledTimes(2);
    expect(onQualityReport.mock.calls[1]![0]).toMatchObject({ durationMs: 20_000, readings: 10 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onQualityReport).toHaveBeenCalledTimes(2);
    // Shown again, and closed after less than the shortest report: nothing more is sent.
    b.setVisible(true);
    await vi.advanceTimersByTimeAsync(8_000);
    b.disconnect();
    expect(onQualityReport).toHaveBeenCalledTimes(2);
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

  it('sends long or multi-line soft-keyboard text as one paste, within the size limit', async () => {
    const transfers: unknown[] = [];
    const { b } = setup([], { onTransfer: (update) => transfers.push(update) });
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    b.typeSoftwareText('first line\r\nsecond line');
    b.typeSoftwareText('x'.repeat(101));
    expect(ws.neko('control/paste')).toEqual([{ text: 'first line\nsecond line' }, { text: 'x'.repeat(101) }]);
    expect(ws.neko('control/keydown')).toEqual([]);
    ws.sent.length = 0;
    b.typeSoftwareText('é'.repeat(70_000)); // 140,000 bytes of UTF-8
    b.paste('y'.repeat(128 * 1024 + 1));
    expect(ws.sent).toEqual([]);
    expect(transfers).toMatchObject([{ files: 0, state: 'error', reason: 'too_large' }, { files: 0, state: 'error', reason: 'too_large' }]);
    b.disconnect();
  });

  it('pastes the remote clipboard on Ctrl+V unless the local text is new', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    const strokes = () => ws.sent.map((frame: any) => frame.data.event === 'control/paste' ? `paste:${frame.data.payload.text}` : `${frame.data.event}:${frame.data.payload.keysym}`);
    // Nothing local (an image copied remotely, or an empty clipboard): the remote page pastes its own.
    b.pasteClipboard('');
    expect(strokes()).toEqual(['control/keydown:65507', 'control/keydown:118', 'control/keyup:118', 'control/keyup:65507']);
    ws.sent.length = 0;
    b.pasteClipboard('local text');
    expect(strokes()).toEqual(['paste:local text']);
    ws.sent.length = 0;
    // Copied remotely but never written locally: the local text is older.
    ws.push({ t: 'neko', data: { event: 'clipboard/updated', payload: { text: 'remote text' } } });
    b.pasteClipboard('local text');
    expect(ws.neko('control/paste')).toEqual([]);
    ws.sent.length = 0;
    // Written locally, or copied elsewhere while the page was in the background: the local text counts.
    b.clipboardCopied('remote text');
    b.pasteClipboard('remote text');
    expect(ws.neko('control/paste')).toEqual([]);
    b.pasteClipboard('copied since');
    expect(ws.neko('control/paste')).toEqual([{ text: 'copied since' }]);
    ws.push({ t: 'neko', data: { event: 'clipboard/updated', payload: { text: 'remote again' } } });
    b.pageBlurred();
    ws.sent.length = 0;
    b.pasteClipboard('copied elsewhere');
    expect(ws.neko('control/paste')).toEqual([{ text: 'copied elsewhere' }]);
    b.disconnect();
  });

  it('does not report text typed through the remote clipboard as copied', async () => {
    const clipboard: string[] = [];
    const { b } = setup([], { onClipboard: (text) => clipboard.push(text) });
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    b.typeSoftwareText('你好');
    ws.push({ t: 'neko', data: { event: 'clipboard/updated', payload: { text: '你好' } } });
    expect(clipboard).toEqual([]);
    // A real copy of the same text later is reported.
    ws.push({ t: 'neko', data: { event: 'clipboard/updated', payload: { text: '你好' } } });
    expect(clipboard).toEqual(['你好']);
    b.disconnect();
  });

  it('maps all US shifted punctuation and newline/tab without using the page-only IME path', async () => {
    const { b } = setup();
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    // Typed apart: a line break among other text goes as one paste (typeSoftwareText).
    b.typeSoftwareText('~!@#$%^&*()_+{}|:"<>?');
    b.typeSoftwareText('\r\n\t');
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
    expect(onInputError.mock.calls).toEqual([['transport', null]]);
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
    expect(onInputError.mock.calls).toEqual([['relay', 'desktop']]);
    expect(ws.neko('control/keyup')).toEqual([{ keysym: 0x61 }]);
    ws.bufferedAmount = 0;
    await tick();
    expect(ws.neko('control/keyup')).toEqual([{ keysym: 0x61 }]);
    b.disconnect();
  });

  it('ends the connection when input may have been lost, instead of staying live behind the notice', async () => {
    vi.useFakeTimers();
    const onInputError = vi.fn();
    const { b, states } = setup([], { onInputError });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePC.last;
    pc.connect();
    expect(b.currentState).toBe('live');
    b.move(10, 10);
    // The socket drops right after input, before the gateway confirmed it: the move may not have arrived.
    ws.close(1006);
    expect(onInputError).toHaveBeenCalledExactlyOnceWith('disconnected', 'network');
    expect(states.at(-1)).toBe('closed');
    expect(b.currentState).toBe('closed');
    expect(ws.readyState).toBe(3);
    expect(pc.closed).toBe(true);
    // Nothing reconnects by itself: the page asks the user first.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.all).toHaveLength(1);
    expect(b.currentState).toBe('closed');
    // An explicit reconnect starts over.
    await b.connect();
    expect(FakeWS.all).toHaveLength(2);
    b.disconnect();
  });

  it('reconnects without a notice when the gateway had confirmed the input before the socket dropped', async () => {
    vi.useFakeTimers();
    const onInputError = vi.fn();
    const { b, states, issues } = setup([], { onInputError });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    b.button(true, 0, 10, 10);
    b.button(false, 0, 10, 10);
    // A ping right after the tap; its pong says the gateway received everything before it.
    await vi.advanceTimersByTimeAsync(300);
    expect(ws.pings).toBe(1);
    ws.close(1006);
    expect(onInputError).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('reconnecting');
    expect(issues.at(-1)).toBe('network');
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeWS.all).toHaveLength(2);
    b.disconnect();
  });

  it('brings a live picture back with an ICE restart when its path drops, keeping the socket and its input', async () => {
    vi.useFakeTimers();
    const onInputError = vi.fn();
    const { b, states, issues, getConnectInfo } = setup([], { onInputError });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePC.last;
    pc.connect();
    b.move(10, 10);
    // A blip that passes within the grace changes nothing.
    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange();
    await vi.advanceTimersByTimeAsync(2_000);
    pc.connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.neko('signal/restart')).toHaveLength(0);
    expect(states.at(-1)).toBe('live');
    // A path that stays down: an ICE restart on the same socket. Input waits for the picture.
    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(ws.neko('signal/restart')).toHaveLength(1);
    expect(states.at(-1)).toBe('reconnecting');
    expect(issues.at(-1)).toBe('network');
    b.move(20, 20);
    expect(ws.neko('control/move')).toEqual([{ x: 10, y: 10 }]);
    ws.push({ t: 'neko', data: { event: 'signal/restart', payload: { sdp: 'restart-offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.remote).toEqual({ type: 'offer', sdp: 'restart-offer' });
    expect(ws.neko('signal/answer')).toHaveLength(2);
    pc.connect();
    expect(states.at(-1)).toBe('live');
    expect(ws.neko('control/move')).toEqual([{ x: 10, y: 10 }, { x: 20, y: 20 }]);
    expect(FakeWS.all).toHaveLength(1);
    // A restart that brings nothing back starts over with a fresh connection, quietly when nothing was at risk.
    pc.connectionState = 'failed';
    pc.onconnectionstatechange();
    expect(ws.neko('signal/restart')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(ws.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    expect(onInputError).not.toHaveBeenCalled();
    b.disconnect();
  });

  it('replaces a socket that stopped answering before input goes into it', async () => {
    vi.useFakeTimers();
    const onInputError = vi.fn();
    const { b, states, issues, getConnectInfo } = setup([], { onInputError });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    // A network that dropped the socket without closing it: nothing arrives, pings go unanswered.
    ws.answers = false;
    // Pinged after 12 quiet seconds (on the next 2 s check), declared dead 8 s later without a pong.
    await vi.advanceTimersByTimeAsync(12_000 + 2_000 + 8_000 + 2_000);
    expect(ws.pings).toBeGreaterThan(0);
    expect(ws.readyState).toBe(3);
    expect(states.at(-1)).toBe('reconnecting');
    expect(issues.at(-1)).toBe('network');
    expect(onInputError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    b.disconnect();
  });

  it('holds a page\'s first input after it was hidden until the gateway answers, and carries it to a new socket if it does not', async () => {
    vi.useFakeTimers();
    const onInputError = vi.fn();
    const { b, states, issues } = setup([], { onInputError });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    // Shown again after a short break, on a socket that still works: the tap waits one round trip.
    b.setVisible(false);
    await vi.advanceTimersByTimeAsync(5_000);
    b.setVisible(true);
    b.button(true, 0, 10, 10);
    expect(ws.neko('control/buttondown')).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.neko('control/buttondown')).toEqual([{ code: 1 }]);
    b.button(false, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(1_000);
    // An iPad left alone for a minute: its socket is gone, though it still looks open.
    b.setVisible(false);
    ws.answers = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.readyState).toBe(1);
    b.setVisible(true);
    b.button(true, 0, 30, 30);
    b.button(false, 0, 30, 30);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(ws.readyState).toBe(3);
    expect(onInputError).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('reconnecting');
    expect(issues.at(-1)).toBe('background');
    await vi.advanceTimersByTimeAsync(600);
    const next = FakeWS.all[1]!;
    next.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    // The tap went nowhere on the old socket; it is sent once, on the new one.
    expect(ws.neko('control/buttondown')).toEqual([{ code: 1 }]);
    expect(next.neko('control/buttondown')).toEqual([{ code: 1 }]);
    expect(next.neko('control/buttonup')).toEqual([{ code: 1 }]);
    b.disconnect();
  });

  /** Video that keeps arriving: each stats reading has more bytes than the last. */
  function flowingVideo(pc: FakePC) {
    let received = 0;
    pc.getStats = async () => {
      received += 500;
      return new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', packetsReceived: received, packetsLost: 0, bytesReceived: received * 1200, framesDecoded: received / 50 }]]);
    };
  }

  it('lets the check after an unlock decide about a ping sent before the lock, and carries taps made meanwhile', async () => {
    vi.useFakeTimers();
    const onInputError = vi.fn();
    const { b, states, issues } = setup([], { onInputError });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    flowingVideo(FakePC.last);
    FakePC.last.connect();
    // A quiet spell sends the keepalive ping; the screen is locked before any answer comes.
    ws.answers = false;
    await vi.advanceTimersByTimeAsync(14_000);
    expect(ws.pings).toBe(1);
    b.setVisible(false);
    await vi.advanceTimersByTimeAsync(60_000);
    // Unlocked, and tapped at once: the tap waits for the check.
    b.setVisible(true);
    b.button(true, 0, 10, 10);
    b.button(false, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(2_000);
    // Timed by the clock, the ping from before the lock condemned the socket here and lost the tap.
    expect(ws.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ws.readyState).toBe(3);
    expect(onInputError).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('reconnecting');
    expect(issues.at(-1)).toBe('background');
    await vi.advanceTimersByTimeAsync(600);
    const next = FakeWS.all[1]!;
    next.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(ws.neko('control/buttondown')).toEqual([]);
    expect(next.neko('control/buttondown')).toEqual([{ code: 1 }]);
    b.disconnect();
  });

  it('puts a socket lost while the page was frozen down to the background, not to us, and keeps the taps made since', async () => {
    vi.useFakeTimers();
    const onInputError = vi.fn();
    const onStats = vi.fn();
    const { b, issues } = setup([], { onInputError, onStats });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    flowingVideo(FakePC.last);
    FakePC.last.connect();
    await vi.advanceTimersByTimeAsync(5_000);
    const readings = onStats.mock.calls.length;
    // Frozen for a minute with no visibility event (a locked screen): nothing runs, and the socket
    // dies meanwhile. A tap made the moment it thaws, before any timer has run, waits for a check.
    ws.answers = false;
    vi.setSystemTime(Date.now() + 60_000);
    b.button(true, 0, 10, 10);
    b.button(false, 0, 10, 10);
    expect(ws.neko('control/buttondown')).toEqual([]);
    // The stats reading across the freeze is a new baseline, not slow video or a picture still arriving.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onStats.mock.calls.length).toBe(readings);
    // The socket died while frozen; its close is delivered now.
    ws.close(1006);
    expect(onInputError).not.toHaveBeenCalled();
    expect(issues.at(-1)).toBe('background');
    await vi.advanceTimersByTimeAsync(600);
    const next = FakeWS.all[1]!;
    next.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(next.neko('control/buttondown')).toEqual([{ code: 1 }]);
    b.disconnect();
  });

  it('does not blame either side when the socket goes silent while the picture keeps arriving', async () => {
    vi.useFakeTimers();
    const { b, issues } = setup([], { onStats: vi.fn() });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    flowingVideo(FakePC.last);
    FakePC.last.connect();
    ws.answers = false;
    await vi.advanceTimersByTimeAsync(12_000 + 2_000 + 8_000 + 2_000);
    expect(ws.readyState).toBe(3);
    // The device is online (the video came through), but where the socket was lost cannot be told.
    expect(issues.at(-1)).toBe('gateway');
    b.disconnect();
  });

  it('makes no attempts while hidden or offline, and reconnects with a whole budget when it can', async () => {
    vi.useFakeTimers();
    const { b, states, issues, getConnectInfo } = setup([], { connectionTimeoutMs: 1_000, maxConnectionAttempts: 1 });
    await b.connect();
    FakeWS.all[0]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    b.setVisible(false);
    FakeWS.all[0]!.close(1006);
    expect(states.at(-1)).toBe('reconnecting');
    expect(issues.at(-1)).toBe('background');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getConnectInfo).toHaveBeenCalledTimes(1);
    b.setOnline(false);
    b.setVisible(true);
    expect(issues.at(-1)).toBe('offline');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getConnectInfo).toHaveBeenCalledTimes(1);
    b.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    FakeWS.all[1]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(states.at(-1)).toBe('live');
    expect(issues.at(-1)).toBeNull();
    b.disconnect();
  });

  it('tells a gateway that closed the socket itself from the user\'s network, by the picture\'s own path', async () => {
    vi.useFakeTimers();
    const { b, issues } = setup();
    await b.connect();
    FakeWS.all[0]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    FakeWS.all[0]!.close(1012);
    expect(issues.at(-1)).toBe('service');
    b.disconnect();
  });

  it('ends the connection when the agent leaves right after input', async () => {
    const onInputError = vi.fn();
    const { b, states } = setup([], { onInputError });
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    b.typeSoftwareText('a');
    ws.push({ t: 'agent_offline' });
    expect(onInputError).toHaveBeenCalledExactlyOnceWith('disconnected', 'desktop');
    expect(states.at(-1)).toBe('closed');
    expect(ws.readyState).toBe(3);
  });

  it('gives a returning agent a whole connection deadline', async () => {
    vi.useFakeTimers();
    const { b, states } = setup([], { connectionTimeoutMs: 20_000 });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(states.at(-1)).toBe('live');
    ws.push({ t: 'agent_offline' });
    await vi.advanceTimersByTimeAsync(15_000);
    // Back after 15 s: it renegotiates within its own 20 s, not the 5 s the outage left.
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.all).toHaveLength(1);
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    expect(states.at(-1)).toBe('live');
    expect(FakeWS.all).toHaveLength(1);
    b.disconnect();
  });

  it('frees the cursor image when the view goes away', async () => {
    const cursors: string[] = [];
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cursor');
    const { b } = setup([], { onCursor: (css) => cursors.push(css) });
    await b.connect();
    const ws = FakeWS.all[0]!;
    await readyInput(ws);
    const channel = { binaryType: '', onmessage: null as null | ((m: { data: ArrayBuffer }) => void) };
    FakePC.last.ondatachannel({ channel });
    const image = new ArrayBuffer(12);
    new DataView(image).setUint8(0, 2);
    channel.onmessage!({ data: image });
    expect(cursors).toEqual(['url(blob:cursor) 0 0, default']);
    b.disconnect();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:cursor');
    expect(cursors.at(-1)).toBe('default');
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

  it('moves an iPad off a 16:10 desktop and forgets a screen that a new relay does not report', async () => {
    vi.useFakeTimers();
    const { b } = setup();
    b.setViewport(1366, 829);
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { screen_size: { width: 1280, height: 800, rate: 60 } } } });
    ws.push({ t: 'neko', data: { event: 'system/admin', payload: { screen_sizes_list: NEKO_MODES } } });
    expect(ws.neko('screen/set')).toEqual([{ width: 1368, height: 768, rate: 30 }]);
    ws.push({ t: 'neko', data: { event: 'screen/updated', payload: { id: 'a', width: 1368, height: 768, rate: 30 } } });
    expect(b.screenMode).toEqual({ width: 1368, height: 768, rate: 30 });
    // The agent's relay restarts on the same socket; its init says nothing about the screen.
    ws.push({ t: 'agent_offline' });
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init' } });
    expect(b.screenSize).toBeNull();
    b.disconnect();
  });

  it('asks for no more desktop than the tier\'s pixel budget', async () => {
    vi.useFakeTimers();
    const { b } = setup([], { maxScreenPixels: TIERS.basic.maxScreenPixels });
    b.setViewport(2600, 1500);
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'system/init', payload: { screen_size: { width: 1280, height: 720, rate: 30 } } } });
    ws.push({ t: 'neko', data: { event: 'system/admin', payload: { screen_sizes_list: NEKO_MODES } } });
    expect(ws.neko('screen/set')).toEqual([{ width: 1920, height: 1080, rate: 30 }]);
    b.disconnect();
  });

  it('gives an image that streams any shape a desktop shaped like the view, portrait included', async () => {
    vi.useFakeTimers();
    const { b } = setup([], { maxScreenPixels: TIERS.basic.maxScreenPixels });
    b.setViewport(820, 1086); // an iPad Air held upright
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: {
      screen_size: { width: 1920, height: 1080, rate: 30 }, webrtc: { videos: ['full', 'high', 'medium', 'low', 'square'] },
    } } });
    ws.push({ t: 'neko', data: { event: 'system/admin', payload: { screen_sizes_list: NEKO_MODES } } });
    expect(b.anyShapeOffered).toBe(true);
    // Not one of neko's advertised modes: neko creates it.
    expect(ws.neko('screen/set')).toEqual([{ width: 816, height: 1080, rate: 30 }]);
    ws.push({ t: 'neko', data: { event: 'screen/updated', payload: { width: 816, height: 1080, rate: 30 } } });
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer-sdp' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    // Turned sideways.
    b.setViewport(1180, 726);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.neko('screen/set').at(-1)).toEqual({ width: 1176, height: 720, rate: 30 });
    b.disconnect();
  });

  it('keeps an image without the square video on 16:9 desktops', async () => {
    vi.useFakeTimers();
    const { b } = setup([], { maxScreenPixels: TIERS.basic.maxScreenPixels });
    b.setViewport(820, 1086);
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'agent_online' });
    ws.push({ t: 'neko', data: { event: 'system/init', payload: {
      screen_size: { width: 1920, height: 1080, rate: 30 }, webrtc: { videos: ['full', 'high', 'medium', 'low'] },
    } } });
    ws.push({ t: 'neko', data: { event: 'system/admin', payload: { screen_sizes_list: NEKO_MODES } } });
    expect(b.anyShapeOffered).toBe(false);
    expect(ws.neko('screen/set')).toEqual([{ width: 1280, height: 720, rate: 30 }]);
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
    expect(vi.getTimerCount()).toBe(2); // an offline agent also has a bounded reconnect deadline, beside the socket's liveness check
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

  it('attaches recent media and peer-fenced playback only to first-frame and failure milestones', async () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const onStream = vi.fn();
    const playback = { paused: false, readyState: 2 as const, width: 1280, height: 720, visibility: 'visible' as const, playState: 'resolved' as const, frameCallback: true };
    const getPlaybackState = vi.fn(() => playback);
    // Fixed quality without a toolbar still needs diagnostic measurements.
    const { b } = setup([], { requireFirstFrame: true, onDiagnostic, onStream, getPlaybackState, video: { quality: 'high', auto: false } });
    await b.connect();
    const ws = FakeWS.all[0]!;
    const attemptId = new URL(ws.url).searchParams.get('attemptId')!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'private-offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePC.last;
    Object.assign(pc, { iceConnectionState: 'completed', iceGatheringState: 'complete' });
    pc.getStats = vi.fn(async () => new Map([
      ['v', { id: 'v', type: 'inbound-rtp', kind: 'video', transportId: 't', packetsReceived: 100, bytesReceived: 80_000, packetsLost: -1, framesReceived: 5, framesDecoded: 4, keyFramesDecoded: 1, nackCount: 2, pliCount: 3, jitter: 0.012 }],
      ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
      ['p', { id: 'p', type: 'candidate-pair', localCandidateId: 'c', currentRoundTripTime: 0.15 }],
      ['c', { id: 'c', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls', address: '203.0.113.7', url: 'turns:private.example' }],
    ]));
    const track = { kind: 'video' };
    pc.ontrack({ streams: [{ getTracks: () => [track] }], track });
    const peerSequence = onStream.mock.calls[0]![2];
    pc.connect();
    await vi.advanceTimersByTimeAsync(2_000);
    b.reportFirstFrame(attemptId, peerSequence);
    const firstFrame = onDiagnostic.mock.calls.map(([d]) => d).find((d) => d.stage === 'first_frame');
    expect(firstFrame).toMatchObject({ attemptId, peerSequence, media: {
      connectionState: 'connected', iceConnectionState: 'completed', iceGatheringState: 'complete', sampleAgeMs: 0, inboundVideo: true,
      rttMs: 150, localCandidateType: 'relay', protocol: 'udp', relayProtocol: 'tls',
      video: { packetsReceived: 100, bytesReceived: 80_000, packetsLost: -1, framesReceived: 5, framesDecoded: 4, keyFramesDecoded: 1, nackCount: 2, pliCount: 3, jitterMs: 12 }, playback,
    } });
    expect(getPlaybackState).toHaveBeenCalledWith(attemptId, peerSequence);
    await vi.advanceTimersByTimeAsync(500);
    ws.close();
    const failure = onDiagnostic.mock.calls.map(([d]) => d).find((d) => d.code === 'transport_closed');
    expect(failure).toMatchObject({ attemptId, peerSequence, media: { connectionState: 'connected', sampleAgeMs: 500, video: { framesDecoded: 4 }, playback } });
    expect(onDiagnostic.mock.calls.map(([d]) => d).filter((d) => d.media).map((d) => d.stage)).toEqual(['first_frame', 'failed']);
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/203\.0\.113|turns:|private-offer|private\.example|tok1/);
    b.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports fresh connection state while omitting a sample more than five seconds old', async () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const { b } = setup([], { requireFirstFrame: true, onDiagnostic, connectionTimeoutMs: 8_001, maxConnectionAttempts: 1 });
    await b.connect();
    FakeWS.all[0]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePC.last;
    pc.getStats = vi.fn()
      .mockResolvedValueOnce(new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', packetsReceived: 0, framesDecoded: 0 }]]))
      .mockRejectedValue(new Error('private-stats-error'));
    pc.connect();
    await vi.advanceTimersByTimeAsync(8_001);
    const failure = onDiagnostic.mock.calls.map(([d]) => d).find((d) => d.code === 'connection_timeout');
    // The peer connected; without a recent reading, where the picture stalled is left unknown.
    expect(failure.media).toEqual({ connectionState: 'connected', handshake: { dtlsMs: 0 } });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('private-stats-error');
    b.disconnect();
  });

  it('says where a handshake that never produced a picture stopped, with TURN error codes only', async () => {
    vi.useFakeTimers();
    /** A peer with listeners and stats, whose TURN relay never answers. */
    class ProbedPC extends FakePC {
      readonly events = new EventTarget();
      iceConnectionState = 'new';
      iceGatheringState = 'gathering';
      addEventListener(type: string, listener: EventListener) { this.events.addEventListener(type, listener); }
      removeEventListener(type: string, listener: EventListener) { this.events.removeEventListener(type, listener); }
      getStats = vi.fn(async () => new Map([['t', { id: 't', type: 'transport', dtlsState: 'new', bytesReceived: 0 }]]));
    }
    const onDiagnostic = vi.fn();
    const { b } = setup([{ urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'private-credential' }],
      { onDiagnostic, connectionTimeoutMs: 5_000, maxConnectionAttempts: 1, RTCPeerConnectionImpl: ProbedPC as never });
    await b.connect();
    FakeWS.all[0]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePC.last as ProbedPC;
    pc.events.dispatchEvent(Object.assign(new Event('icecandidateerror'), { errorCode: 701, url: 'turn:turn.example:3478', errorText: 'private' }));
    await vi.advanceTimersByTimeAsync(5_000);
    const failure = onDiagnostic.mock.calls.map(([d]) => d).find((d) => d.code === 'connection_timeout');
    expect(failure.media.handshake).toEqual({
      stalledAt: 'candidates', turnErrors: [701],
      candidates: { relayUdp: 0, relayTcp: 0, relayTls: 0, other: 0 },
      pairs: { succeeded: 0, inProgress: 0, waiting: 0, failed: 0 },
      checksSent: 0, checksAnswered: 0, dtlsState: 'new', transportBytesReceived: 0,
    });
    expect(ConnectionDiagnostic.safeParse(failure).success).toBe(true);
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/turn\.example|private/);
    b.disconnect();
  });

  it('does not attach unsampled or malformed playback as zero media counters', async () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const getPlaybackState = vi.fn(() => ({ paused: false, readyState: 2, width: 1280, height: 720, visibility: 'visible', playState: 'https://private.example/error', frameCallback: true }) as never);
    const { b } = setup([], { requireFirstFrame: true, onDiagnostic, getPlaybackState, connectionTimeoutMs: 100, maxConnectionAttempts: 1 });
    await b.connect();
    FakeWS.all[0]!.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    FakePC.last.connect();
    await vi.advanceTimersByTimeAsync(100);
    const failure = onDiagnostic.mock.calls.map(([d]) => d).find((d) => d.code === 'connection_timeout');
    // The peer connected; without a recent reading, where the picture stalled is left unknown.
    expect(failure.media).toEqual({ connectionState: 'connected', handshake: { dtlsMs: 0 } });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('private.example');
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
    expect(vi.getTimerCount()).toBe(2); // current socket's deadline and liveness check, no stale retry
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
    expect(onInputError).toHaveBeenCalledExactlyOnceWith('disconnected', null);
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
    const onStream = vi.fn();
    const onDiagnostic = vi.fn();
    const { b } = setup([], { requireFirstFrame: true, onStats, onStream, onDiagnostic });
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
    current.getStats = vi.fn(async () => new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', frameWidth: 1280, framesDecoded: 3 }]]));
    current.connect();
    finishOld(new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', frameWidth: 640, framesDecoded: 640 }]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(onStats).not.toHaveBeenCalled();
    const track = { kind: 'video' };
    current.ontrack({ streams: [{ getTracks: () => [track] }], track });
    b.reportFirstFrame(new URL(ws.url).searchParams.get('attemptId')!, onStream.mock.calls[0]![2]);
    const frame = onDiagnostic.mock.calls.map(([d]) => d).find((d) => d.stage === 'first_frame');
    expect(frame.media).toEqual({ connectionState: 'connected', handshake: { dtlsMs: 0 } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(current.getStats).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ width: 1280 }));
    ws.close();
    const failure = onDiagnostic.mock.calls.map(([d]) => d).find((d) => d.code === 'transport_closed');
    expect(failure.media).toMatchObject({ sampleAgeMs: 0, inboundVideo: true, video: { framesDecoded: 3 } });
    b.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('measures sample age from a slow getStats request start rather than its completion', async () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const onStream = vi.fn();
    const { b } = setup([], { requireFirstFrame: true, onDiagnostic, onStream });
    await b.connect();
    const ws = FakeWS.all[0]!;
    ws.push({ t: 'neko', data: { event: 'signal/provide', payload: { sdp: 'offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePC.last;
    let finish!: (report: Map<string, unknown>) => void;
    pc.getStats = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    pc.connect();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(pc.getStats).toHaveBeenCalledTimes(1);
    finish(new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', framesDecoded: 9 }]]));
    await vi.advanceTimersByTimeAsync(0);
    const track = { kind: 'video' };
    pc.ontrack({ streams: [{ getTracks: () => [track] }], track });
    b.reportFirstFrame(new URL(ws.url).searchParams.get('attemptId')!, onStream.mock.calls[0]![2]);
    const frame = onDiagnostic.mock.calls.map(([d]) => d).find((d) => d.stage === 'first_frame');
    expect(frame.media).toEqual({ connectionState: 'connected', handshake: { dtlsMs: 0 } });
    b.disconnect();
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
    expect(ws.pings).toBeGreaterThan(0); // quiet, so the socket was checked, and answered
    expect(vi.getTimerCount()).toBe(1); // only the socket's liveness check
    b.disconnect();
    expect(vi.getTimerCount()).toBe(0);
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
