import { describe, expect, it, vi } from 'vitest';
import { keysymFor, keysymForName } from '../src/keyboard.js';
import { decode, encode, fitScreen } from '../src/neko.js';
import { RemoteBrowser } from '../src/remote-browser.js';
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
  function setup(iceServers: { urls: string[]; username?: string; credential?: string }[] = []) {
    FakeWS.all = [];
    const getConnectInfo = vi.fn(async () => ({ gatewayUrl: 'wss://gw/v1/stream/i1', token: `tok${getConnectInfo.mock.calls.length}`, iceServers }));
    const states: string[] = [];
    const b = new RemoteBrowser({
      getConnectInfo,
      onState: (s) => states.push(s),
      WebSocketImpl: FakeWS as never,
      RTCPeerConnectionImpl: FakePC as never,
    });
    return { b, getConnectInfo, states };
  }

  it('requests a stream, answers neko over the gateway, and goes live', async () => {
    const { b, states } = setup([{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }]);
    await b.connect();
    const ws = FakeWS.all[0]!;
    expect(ws.url).toBe('wss://gw/v1/stream/i1?token=tok1');

    ws.push({ t: 'agent_online' });
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

    FakeWS.all[1]!.push({ t: 'taken_over' });
    FakeWS.all[1]!.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.at(-1)).toBe('taken-over');
    expect(getConnectInfo).toHaveBeenCalledTimes(2);
    b.disconnect();
    vi.useRealTimers();
  });
});
