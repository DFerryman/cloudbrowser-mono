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
    expect(keysymFor({ key: 'Process', code: 'KeyA' }, pc)).toBeNull();
    expect(keysymFor({ key: 'Dead', code: 'Quote' }, pc)).toBeNull();
  });
  it('maps Cmd to Control on macOS', () => {
    expect(keysymFor({ key: 'Meta', code: 'MetaLeft' }, { macToPc: true })).toBe(0xffe3);
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

describe('RemoteBrowser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(
    iceServers: { urls: string[]; username?: string; credential?: string }[] = [],
    options: Pick<RemoteBrowserOptions, 'connectionTimeoutMs'> = {},
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
    expect(dc.sent.map((x) => new Uint8Array(x)[0])).toEqual([0x01, 0x03, 0x04]);

    b.typeText('你好');
    expect(ws.sent.at(-1)).toEqual({ t: 'ime', text: '你好' });
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
