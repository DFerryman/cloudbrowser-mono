import type { GatewayToViewer, IceServer } from '@cloudbrowser/contracts';
import { decode, encode, EV, fitScreen, x11Button, type NekoMessage, type SignalCandidate, type SignalProvide } from './neko.js';
import { keysymFor, keysymForName } from './keyboard.js';
import { readStats, type ViewerStats } from './stats.js';

export type ViewerState = 'connecting' | 'live' | 'reconnecting' | 'agent-offline' | 'taken-over' | 'closed';

export interface ConnectInfo {
  gatewayUrl: string;
  token: string;
  iceServers: IceServer[];
}

export interface RemoteBrowserOptions {
  /** Fetches fresh connect info; each viewer token works once, so every (re)connect calls it. */
  getConnectInfo: () => Promise<ConnectInfo>;
  onState?: (state: ViewerState, attempt: number) => void;
  onStream?: (stream: MediaStream) => void;
  onStats?: (stats: ViewerStats) => void;
  /** A CSS `cursor` value for the remote cursor, drawn locally (page 5). */
  onCursor?: (css: string) => void;
  /** Text the remote Chrome put on its clipboard. */
  onClipboard?: (text: string) => void;
  /** Map Cmd → Ctrl and Option → Alt (macOS default, page 5). */
  macToPc?: boolean;
  statsIntervalMs?: number;
  /** Maximum time for signaling and WebRTC to connect before retrying. Defaults to 20 s. */
  connectionTimeoutMs?: number;
  WebSocketImpl?: typeof WebSocket;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];
/** Screen size changes are debounced and applied at most once every 5 s (page 5). */
const SCREEN_DEBOUNCE_MS = 750;
const SCREEN_MIN_INTERVAL_MS = 5000;
const CONNECTION_TIMEOUT_MS = 20_000;
const MAX_PENDING_ICE_CANDIDATES = 256;

/**
 * Live-view client for one browser (page 5, `packages/viewer`): signaling over the gateway
 * WebSocket (neko v3 messages wrapped in `viewer.v1` frames), a receive-only RTCPeerConnection,
 * and input on the WebRTC data channel. Framework-agnostic; it never calls the REST API itself.
 */
export class RemoteBrowser {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private state: ViewerState = 'closed';
  private attempt = 0;
  private stopped = true;
  private signalRequested = false;
  private remoteDescriptionReady = false;
  private pendingCandidates: SignalCandidate[] = [];
  private iceServers: IceServer[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private pressed = new Set<number>();
  private pendingScreen: { width: number; height: number } | null = null;
  private screenTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScreenAt = 0;
  private appliedScreen = '';
  private cursorUrl: string | null = null;

  constructor(private readonly opts: RemoteBrowserOptions) {}

  get currentState() {
    return this.state;
  }

  async connect(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearConnectionTimer();
    this.teardownPeer();
    this.stopped = false;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let info: ConnectInfo;
    try {
      info = await this.opts.getConnectInfo();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    this.iceServers = info.iceServers;
    this.signalRequested = false;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const sep = info.gatewayUrl.includes('?') ? '&' : '?';
    const ws = new WS(`${info.gatewayUrl}${sep}token=${encodeURIComponent(info.token)}`);
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws === ws && !this.stopped) this.onGatewayFrame(e.data, ws);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearConnectionTimer();
      this.teardownPeer();
      if (!this.stopped && this.state !== 'taken-over') this.scheduleReconnect();
    };
  }

  disconnect() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearConnectionTimer();
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.releaseAllKeys();
    this.teardownPeer();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState('closed');
  }

  // --- input ---------------------------------------------------------------------------------

  /** Pointer position in remote screen pixels. */
  move(x: number, y: number) {
    this.sendData(encode.move(x, y));
  }

  button(down: boolean, domButton: number, x?: number, y?: number) {
    const b = x11Button(domButton);
    if (b === null) return;
    if (x !== undefined && y !== undefined) this.move(x, y);
    this.sendData(encode.button(down, b));
  }

  /** Wheel deltas in pixels; the caller accumulates them per animation frame. */
  scroll(dx: number, dy: number, controlKey = false) {
    if (dx || dy) this.sendData(encode.scroll(dx, dy, controlKey));
  }

  /** Returns true if the key was sent (the caller then prevents the browser default). */
  key(down: boolean, e: Pick<KeyboardEvent, 'key' | 'code'>): boolean {
    const sym = keysymFor(e, { macToPc: this.opts.macToPc ?? false });
    if (sym === null) return false;
    if (down) this.pressed.add(sym);
    else this.pressed.delete(sym);
    this.sendData(encode.key(down, sym));
    return true;
  }

  /** Releases every key the remote side thinks is held, e.g. when the page loses focus. */
  releaseAllKeys() {
    for (const sym of this.pressed) this.sendData(encode.key(false, sym));
    this.pressed.clear();
  }

  /** Presses and releases a combination such as ['Control', 't'] (toolbar Keys menu). */
  sendCombo(names: string[]) {
    const syms = names.map(keysymForName).filter((s): s is number => s !== null);
    for (const s of syms) this.sendData(encode.key(true, s));
    for (const s of [...syms].reverse()) this.sendData(encode.key(false, s));
  }

  /** Composed IME text (CJK, emoji); the agent inserts it with CDP Input.insertText (page 5). */
  typeText(text: string) {
    if (text) this.sendGateway({ t: 'ime', text });
  }

  /** Puts text on the remote clipboard, e.g. before sending Ctrl+V for a local paste. */
  setClipboard(text: string) {
    this.sendNeko({ event: EV.CLIPBOARD_SET, payload: { text } });
  }

  /** Reports the usable viewport in CSS pixels; the remote screen follows, debounced. */
  setViewport(width: number, height: number) {
    this.pendingScreen = fitScreen(width, height);
    if (this.screenTimer) clearTimeout(this.screenTimer);
    const wait = Math.max(SCREEN_DEBOUNCE_MS, this.lastScreenAt + SCREEN_MIN_INTERVAL_MS - Date.now());
    this.screenTimer = setTimeout(() => this.applyScreen(), wait);
  }

  // --- internals -----------------------------------------------------------------------------

  private setState(s: ViewerState) {
    if (s === this.state) return;
    this.state = s;
    this.opts.onState?.(s, this.attempt);
  }

  private scheduleReconnect() {
    this.clearConnectionTimer();
    if (this.stopped) return;
    if (this.retryTimer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.setState('reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private clearConnectionTimer() {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
  }

  private startConnectionTimer(ws: WebSocket) {
    if (this.connectionTimer) return;
    this.connectionTimer = setTimeout(() => {
      this.connectionTimer = null;
      if (this.state !== 'live') this.reconnect(ws);
    }, this.opts.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS);
  }

  private reconnect(ws: WebSocket) {
    if (this.ws !== ws || this.stopped) return;
    this.ws = null;
    this.clearConnectionTimer();
    this.teardownPeer();
    ws.close();
    this.scheduleReconnect();
  }

  private sendGateway(frame: { t: 'neko'; data: NekoMessage } | { t: 'ime'; text: string }) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private sendNeko(msg: NekoMessage) {
    this.sendGateway({ t: 'neko', data: msg });
  }

  private sendData(buf: ArrayBuffer) {
    if (this.dc && this.dc.readyState === 'open') this.dc.send(buf);
  }

  private requestSignal(ws: WebSocket) {
    if (this.signalRequested) return;
    this.signalRequested = true;
    this.startConnectionTimer(ws);
    this.sendNeko({ event: EV.SIGNAL_REQUEST, payload: { video: {}, audio: {} } });
  }

  private onGatewayFrame(raw: unknown, ws: WebSocket) {
    if (typeof raw !== 'string') return;
    let frame: GatewayToViewer;
    try {
      frame = JSON.parse(raw) as GatewayToViewer;
    } catch {
      return;
    }
    switch (frame.t) {
      case 'agent_online':
        // The tunnel is online before the agent's local neko relay is necessarily ready.
        // Neko's system/init is the acknowledgment that it can receive signal/request.
        if (this.state !== 'live') this.startConnectionTimer(ws);
        return;
      case 'agent_offline':
        this.clearConnectionTimer();
        this.teardownPeer();
        this.signalRequested = false;
        this.setState('agent-offline');
        return;
      case 'taken_over':
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.clearConnectionTimer();
        this.teardownPeer();
        this.setState('taken-over');
        return;
      case 'neko':
        void this.onNeko(frame.data as NekoMessage, ws).catch(() => this.reconnect(ws));
    }
  }

  private async onNeko(msg: NekoMessage, ws: WebSocket) {
    switch (msg.event) {
      case EV.SYSTEM_INIT:
        this.requestSignal(ws);
        return;
      case EV.SIGNAL_PROVIDE:
        await this.answer(msg.payload as unknown as SignalProvide, ws);
        return;
      case EV.SIGNAL_CANDIDATE: {
        const c = msg.payload as unknown as SignalCandidate;
        if (!this.pc || !this.remoteDescriptionReady) {
          if (this.pendingCandidates.length >= MAX_PENDING_ICE_CANDIDATES) throw new Error('Too many pending ICE candidates');
          this.pendingCandidates.push(c);
          return;
        }
        const pc = this.pc;
        try {
          await pc.addIceCandidate(c);
        } catch (error) {
          if (this.pc === pc && this.ws === ws) throw error;
        }
        return;
      }
      case EV.CLIPBOARD_UPDATED: {
        const text = (msg.payload as { text?: unknown } | undefined)?.text;
        if (typeof text === 'string') this.opts.onClipboard?.(text);
        return;
      }
      case EV.CURSOR_IMAGE: {
        const p = msg.payload as { uri?: string; x?: number; y?: number } | undefined;
        if (p?.uri) this.opts.onCursor?.(`url(${p.uri}) ${p.x ?? 0} ${p.y ?? 0}, default`);
        return;
      }
      case EV.SYSTEM_DISCONNECT:
        this.ws?.close();
    }
  }

  /** neko offers; the viewer answers with a receive-only connection. */
  private async answer(provide: SignalProvide, ws: WebSocket) {
    // Trickle candidates can arrive before the offer, while neko finishes creating its peer.
    this.teardownPeer(true);
    this.startConnectionTimer(ws);
    const servers = this.iceServers.length
      ? this.iceServers
      : (provide.iceservers ?? []).map((s) => ({ ...s, urls: Array.isArray(s.urls) ? s.urls : [s.urls] }));
    // Media goes through the TURN relay when we have one: the VM accepts no inbound connections (page 5).
    const relayOnly = servers.some((s) => s.urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:')));
    const PC = this.opts.RTCPeerConnectionImpl ?? RTCPeerConnection;
    const pc = new PC({ iceServers: servers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
    this.pc = pc;

    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.opts.onStream?.(stream);
    };
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.binaryType = 'arraybuffer';
      dc.onmessage = (m) => {
        if (m.data instanceof ArrayBuffer) this.onData(m.data);
      };
      this.dc = dc;
    };
    pc.onicecandidate = (e) => {
      if (this.pc === pc && this.ws === ws && e.candidate) {
        this.sendNeko({
          event: EV.SIGNAL_CANDIDATE,
          payload: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex },
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'connected') {
        this.clearConnectionTimer();
        this.attempt = 0;
        this.setState('live');
        this.sendNeko({ event: EV.CONTROL_REQUEST });
        this.startStats();
        if (this.pendingScreen) this.applyScreen();
      } else if (pc.connectionState === 'failed') {
        // An ICE failure (e.g. a network change): start over with a fresh token.
        this.reconnect(ws);
      }
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: provide.sdp });
      if (this.pc !== pc || this.ws !== ws) return;
      // Keep queueing while these await: no candidate is added before its remote description.
      while (this.pendingCandidates.length > 0) {
        await pc.addIceCandidate(this.pendingCandidates.shift()!);
        if (this.pc !== pc || this.ws !== ws) return;
      }
      this.remoteDescriptionReady = true;
      const answer = await pc.createAnswer();
      if (this.pc !== pc || this.ws !== ws) return;
      await pc.setLocalDescription(answer);
      if (this.pc !== pc || this.ws !== ws) return;
      this.sendNeko({ event: EV.SIGNAL_ANSWER, payload: { sdp: answer.sdp } });
    } catch (error) {
      // A closed or replaced peer can finish an earlier negotiation after a retry.
      if (this.pc === pc && this.ws === ws) throw error;
    }
  }

  private onData(buf: ArrayBuffer) {
    const d = decode(buf);
    if (d?.kind === 'cursor_image' && this.opts.onCursor) {
      if (this.cursorUrl) URL.revokeObjectURL(this.cursorUrl);
      this.cursorUrl = URL.createObjectURL(new Blob([d.png.slice()], { type: 'image/png' }));
      this.opts.onCursor(`url(${this.cursorUrl}) ${d.hotX} ${d.hotY}, default`);
    }
  }

  private applyScreen() {
    const s = this.pendingScreen;
    if (!s || this.state !== 'live') return;
    const key = `${s.width}x${s.height}`;
    if (key === this.appliedScreen) return;
    this.appliedScreen = key;
    this.lastScreenAt = Date.now();
    this.sendNeko({ event: EV.SCREEN_SET, payload: { width: s.width, height: s.height, rate: 30 } });
  }

  private startStats() {
    if (this.statsTimer || !this.opts.onStats) return;
    let previous: { bytes: number; at: number } | null = null;
    this.statsTimer = setInterval(async () => {
      if (!this.pc) return;
      const { stats, bytes } = await readStats(this.pc, previous);
      previous = { bytes, at: Date.now() };
      this.opts.onStats?.(stats);
    }, this.opts.statsIntervalMs ?? 2000);
  }

  private teardownPeer(preserveCandidates = false) {
    this.remoteDescriptionReady = false;
    if (!preserveCandidates) this.pendingCandidates = [];
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.dc = null;
    const pc = this.pc;
    this.pc = null;
    pc?.close();
    this.appliedScreen = '';
  }
}
