import type { GatewayToViewer, IceServer } from '@cloudbrowser/contracts';
import { VIDEO_QUALITIES, type VideoQuality } from '@cloudbrowser/contracts';
import { decode, EV, fitScreen, sameScreen, screenOf, x11Button, type NekoMessage, type ScreenConfiguration, type SignalCandidate, type SignalProvide } from './neko.js';
import { QualityController, type VideoPreference } from './quality.js';
import { KEYSYM, keyIdentity, keysymFor, keysymForName, matchingKeyIdentity, unidentifiedKey, type KeyIdentityEvent } from './keyboard.js';
import { readStats, type ViewerStats } from './stats.js';
import { ScrollAccumulator } from './scroll.js';
import { InputQueue, type InputFailure } from './input-queue.js';

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
  /** Delivery was interrupted; discard old input and require an explicit reconnect. */
  onInputError?: (reason: InputFailure) => void;
  /** Map Cmd → Ctrl and Option → Alt (macOS default, page 5). */
  macToPc?: boolean;
  /** Picture quality; the sharpest level by default, adapting to the connection. */
  video?: VideoPreference;
  /** The level neko streams now, whenever it changes. */
  onVideo?: (quality: VideoQuality) => void;
  statsIntervalMs?: number;
  /** Maximum time per token fetch or transport/WebRTC handshake before retrying. Defaults to 20 s. */
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
/** Characters that require Shift on the remote US X11 keyboard. */
const SOFTWARE_SHIFTED = new Set([...`~!@#$%^&*()_+{}|:"<>?`]);
const SHIFTED_KEYSYMS = new Map([...'`1234567890-=[]\\;\',./'].map((character, index) =>
  [character.charCodeAt(0), [...SOFTWARE_SHIFTED][index]!.charCodeAt(0)]));
const modifierKeysym = (sym: number) => sym >= 0xffe1 && sym <= 0xffee;
const shiftedKeysym = (sym: number) => sym >= 0x61 && sym <= 0x7a ? sym - 0x20 : SHIFTED_KEYSYMS.get(sym) ?? sym;

/**
 * Live-view client for one browser (page 5, `packages/viewer`): signaling over the gateway
 * WebSocket (neko v3 messages wrapped in `viewer.v1` frames), a receive-only RTCPeerConnection,
 * and all input on one ordered WebSocket FIFO. The data channel only receives cursor updates.
 * Framework-agnostic; it never calls the REST API itself.
 */
export class RemoteBrowser {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private state: ViewerState = 'closed';
  private attempt = 0;
  private connectSequence = 0;
  private cancelConnectInfo: (() => void) | null = null;
  private stopped = true;
  private signalRequested = false;
  private remoteDescriptionReady = false;
  private pendingCandidates: SignalCandidate[] = [];
  private iceServers: IceServer[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private pressed = new Set<number>();
  private softwarePressed = new Set<number>();
  private readonly scrollAccumulator = new ScrollAccumulator();
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollControl = false;
  private pointerPosition: { x: number; y: number } | null = null;
  private pressedEvents = new Map<string, KeyIdentityEvent & { sym: number }>();
  private softwareEvents = new Map<string, KeyIdentityEvent & { sym: number }>();
  private readonly pressedButtons = new Set<number>();
  private readonly transportKeys = new Set<number>();
  private readonly transportButtons = new Set<number>();
  private inputReady = false;
  private readonly inputQueue: InputQueue;
  private pendingViewport: { width: number; height: number } | null = null;
  private screenConfigurations: ScreenConfiguration[] = [];
  /** neko's current screen (system/init, screen/updated): it restarts its encoder on every change. */
  private remoteScreen: ScreenConfiguration | null = null;
  private screenTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScreenAt = 0;
  private appliedScreen = '';
  private cursorUrl: string | null = null;
  private video: VideoPreference;
  /** Present while the picture adapts to the connection; it outlives reconnects. */
  private qualityController: QualityController | null = null;
  /** The level neko reported streaming. */
  private videoId: VideoQuality | null = null;
  /** neko's videos (system/init). Browsers on an image older than the quality ladder offer one. */
  private offeredVideos: string[] = [];
  private counters: { lost: number; received: number; freezes: number; frames: number; at: number } | null = null;

  constructor(private readonly opts: RemoteBrowserOptions) {
    this.video = opts.video ?? { quality: 'full', auto: true };
    this.inputQueue = new InputQueue({
      transport: () => this.ws,
      ready: () => this.inputReady && !this.stopped,
      held: () => this.transportKeys.size > 0 || this.transportButtons.size > 0,
      failed: (reason) => {
        this.inputReady = false;
        this.stopped = true;
        this.releaseTransportKeys();
        this.opts.onInputError?.(reason);
      },
      sent: (data) => {
        const frame = JSON.parse(data) as { data: NekoMessage<{ keysym?: number; code?: number }> };
        const { event, payload } = frame.data;
        if (event === EV.CONTROL_KEYDOWN && payload?.keysym !== undefined) this.transportKeys.add(payload.keysym);
        if (event === EV.CONTROL_KEYUP && payload?.keysym !== undefined) this.transportKeys.delete(payload.keysym);
        if (event === EV.CONTROL_BUTTONDOWN && payload?.code !== undefined) this.transportButtons.add(payload.code);
        if (event === EV.CONTROL_BUTTONUP && payload?.code !== undefined) this.transportButtons.delete(payload.code);
      },
    });
  }

  get currentState() {
    return this.state;
  }

  /** The remote desktop in its own pixels; the video may be a downscaled picture of it. */
  get screenSize(): { width: number; height: number } | null {
    return this.remoteScreen ? { width: this.remoteScreen.width, height: this.remoteScreen.height } : null;
  }

  /** A changed preference applies at once to a live stream, without reconnecting. */
  setVideoPreference(video: VideoPreference) {
    if (video.quality === this.video.quality && video.auto === this.video.auto) return;
    this.video = video;
    const current = this.qualityController?.quality ?? this.videoId ?? video.quality;
    this.qualityController = video.auto ? new QualityController(video.quality, Date.now(), current) : null;
    this.selectVideo(this.qualityController?.quality ?? video.quality);
  }

  async connect(): Promise<void> {
    const sequence = ++this.connectSequence;
    this.cancelConnectInfo?.();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearConnectionTimer();
    this.releaseTransportKeys();
    this.inputQueue.clear();
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.teardownPeer();
    this.inputQueue.resume();
    this.screenConfigurations = [];
    this.remoteScreen = null;
    this.appliedScreen = '';
    this.stopped = false;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let info: ConnectInfo;
    let infoTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelInfo: (() => void) | undefined;
    try {
      const pendingInfo = this.opts.getConnectInfo();
      const deadline = new Promise<never>((_resolve, reject) => {
        infoTimer = setTimeout(() => reject(new Error('connection information timed out')), this.opts.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS);
        cancelInfo = () => reject(new Error('connection attempt replaced'));
        this.cancelConnectInfo = cancelInfo;
      });
      info = await Promise.race([pendingInfo, deadline]);
    } catch {
      if (sequence === this.connectSequence) this.scheduleReconnect();
      return;
    } finally {
      clearTimeout(infoTimer);
      if (this.cancelConnectInfo === cancelInfo) this.cancelConnectInfo = null;
    }
    // A repeated Retry click or a slow, older token response must not create a second
    // socket which would take over the newer connection from this same page.
    if (this.stopped || sequence !== this.connectSequence) return;
    this.iceServers = info.iceServers;
    this.signalRequested = false;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const sep = info.gatewayUrl.includes('?') ? '&' : '?';
    const ws = new WS(`${info.gatewayUrl}${sep}token=${encodeURIComponent(info.token)}`);
    this.ws = ws;
    // A blocked WebSocket upgrade may never deliver agent_online or even an error event.
    // Bound the whole transport handshake rather than waiting for the first server frame.
    this.startConnectionTimer(ws);
    ws.onmessage = (e) => {
      if (this.ws === ws && !this.stopped) this.onGatewayFrame(e.data, ws);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.inputReady = false;
      this.inputQueue.interrupt('disconnected');
      this.ws = null;
      this.clearConnectionTimer();
      this.teardownPeer();
      if (!this.stopped && this.state !== 'taken-over') this.scheduleReconnect();
    };
  }

  disconnect() {
    this.connectSequence++;
    this.cancelConnectInfo?.();
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearConnectionTimer();
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.releaseTransportKeys();
    this.inputQueue.clear();
    this.teardownPeer();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState('closed');
  }

  // --- input ---------------------------------------------------------------------------------

  /** Pointer position in remote screen pixels. */
  move(x: number, y: number) {
    const position = { x: Math.round(x), y: Math.round(y) };
    if (position.x !== this.pointerPosition?.x || position.y !== this.pointerPosition?.y) this.finishScroll();
    this.pointerPosition = position;
    this.sendInput({ event: EV.CONTROL_MOVE, payload: position });
  }

  button(down: boolean, domButton: number, x?: number, y?: number) {
    const b = x11Button(domButton);
    if (b === null) return;
    if (x !== undefined && y !== undefined) this.move(x, y);
    if (down) this.pressedButtons.add(b);
    else this.pressedButtons.delete(b);
    this.sendInput({ event: down ? EV.CONTROL_BUTTONDOWN : EV.CONTROL_BUTTONUP, payload: { code: b } });
  }

  /** CSS pixel deltas, converted to Neko's signed X11 wheel-click counts. */
  scroll(dx: number, dy: number, controlKey = false) {
    if (this.scrollAccumulator.needsFinish(dx, dy, controlKey)) this.finishScroll();
    this.scrollControl = controlKey;
    const ticks = this.scrollAccumulator.consume(dx, dy, controlKey);
    if (ticks.x || ticks.y) this.sendInput({ event: EV.CONTROL_SCROLL, payload: { delta_x: ticks.x, delta_y: ticks.y, control_key: controlKey } });
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => this.finishScroll(), 100);
  }

  finishScroll(): void {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = null;
    const ticks = this.scrollAccumulator.finish();
    if (ticks.x || ticks.y) this.sendInput({ event: EV.CONTROL_SCROLL, payload: { delta_x: ticks.x, delta_y: ticks.y, control_key: this.scrollControl } });
  }

  /** Returns true if the key was sent (the caller then prevents the browser default). */
  key(down: boolean, e: KeyIdentityEvent): boolean {
    const sym = this.trackKey(down, e, this.pressedEvents);
    if (sym === null) return false;
    if (sym === 'repeat') return true;
    if (sym === 'release-all') {
      this.releaseAllKeys();
      return true;
    }
    if (down) this.pressed.add(sym);
    else this.pressed.delete(sym);
    return this.sendInput({ event: down ? EV.CONTROL_KEYDOWN : EV.CONTROL_KEYUP, payload: { keysym: sym } });
  }

  /** Releases every key the remote side thinks is held, e.g. when the page loses focus. */
  releaseAllKeys() {
    for (const sym of [...this.pressed].reverse()) this.sendInput({ event: EV.CONTROL_KEYUP, payload: { keysym: sym } });
    this.pressed.clear();
    this.pressedEvents.clear();
    this.releaseSoftwareKeys();
  }

  /** Presses and releases a combination such as ['Control', 't'] (toolbar Keys menu). */
  sendCombo(names: string[]) {
    this.sendChord(names);
  }

  /** IME commits share the input FIFO and work in browser chrome as well as web pages. */
  typeText(text: string) {
    this.typeSoftwareText(text);
  }

  /** Software input uses one ordered WebSocket, including edits and browser-chrome shortcuts. */
  softwareKey(down: boolean, e: KeyIdentityEvent): boolean {
    const sym = this.trackKey(down, e, this.softwareEvents);
    if (sym === null) return false;
    if (sym === 'repeat') return true;
    if (sym === 'release-all') {
      this.releaseSoftwareKeys();
      return true;
    }
    this.sendSoftwareKey(down, sym);
    return true;
  }

  sendSoftwareCombo(names: string[]) {
    this.releaseSoftwareKeys();
    this.sendChord(names);
  }

  /** Types into the focused X11 window, including Chrome's address bar and menus. */
  typeSoftwareText(text: string) {
    // Native input is a committed text operation, never a continuation of a held key.
    // Missing mobile keyups must not change its casing or keep the last character repeating.
    this.releaseSoftwareKeys();
    const held = [...this.pressed];
    for (const keysym of [...held].reverse()) this.sendInput({ event: EV.CONTROL_KEYUP, payload: { keysym } });
    let paste = '';
    let pasted = false;
    const flush = () => {
      if (paste) {
        this.sendInput({ event: EV.CONTROL_PASTE, payload: { text: paste } });
        pasted = true;
      }
      paste = '';
    };
    for (const character of text.replace(/\r\n?/g, '\n')) {
      const cp = character.codePointAt(0)!;
      if (cp >= 0x80) {
        paste += character;
        continue;
      }
      flush();
      let sym: number;
      let shift = false;
      if (character === '\n') sym = 0xff0d;
      else if (character === '\t') sym = KEYSYM.Tab;
      else if (cp >= 0x20 && cp <= 0x7e) {
        shift = SOFTWARE_SHIFTED.has(character) || (cp >= 0x41 && cp <= 0x5a);
        // Neko resolves a keysym using the current X11 modifiers. Once Shift is down,
        // send the resulting symbol (A/!), otherwise it allocates a new dynamic keycode.
        sym = cp;
      } else continue;
      const addShift = shift;
      if (addShift) this.sendSoftwareKey(true, KEYSYM.Shift_L);
      this.sendSoftwareKey(true, sym);
      this.sendSoftwareKey(false, sym);
      if (addShift) this.sendSoftwareKey(false, KEYSYM.Shift_L);
    }
    flush();
    for (const keysym of held) this.sendInput({ event: EV.CONTROL_KEYDOWN, payload: { keysym } });
    if (pasted) for (const code of this.pressedButtons) this.sendInput({ event: EV.CONTROL_BUTTONDOWN, payload: { code } });
  }

  /** Puts text on the remote clipboard, e.g. before sending Ctrl+V for a local paste. */
  setClipboard(text: string) {
    this.sendInput({ event: EV.CLIPBOARD_SET, payload: { text } });
  }

  /** Neko waits for the clipboard write and then pastes inside this single ordered command. */
  paste(text: string) {
    if (!text) return;
    const keys = new Set([...this.pressed, ...this.softwarePressed]);
    const buttons = [...this.pressedButtons];
    this.sendInput({ event: EV.CONTROL_PASTE, payload: { text } });
    // Neko's KeyPress resets all X11 holds around Ctrl+V. Restore the holds that
    // preceded this operation before later keyups or shortcuts pass through the FIFO.
    for (const keysym of keys) this.sendInput({ event: EV.CONTROL_KEYDOWN, payload: { keysym } });
    for (const code of buttons) this.sendInput({ event: EV.CONTROL_BUTTONDOWN, payload: { code } });
  }

  /** Reports the usable viewport in CSS pixels; the remote screen follows, debounced. */
  setViewport(width: number, height: number) {
    this.pendingViewport = { width, height };
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
    // Negotiation errors and deadlines also replace the socket. Pending preconnect
    // input must pause visibly instead of following the retry into another session.
    this.inputReady = false;
    this.inputQueue.interrupt('disconnected');
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

  private sendSoftwareKey(down: boolean, keysym: number) {
    if (down) this.softwarePressed.add(keysym);
    else this.softwarePressed.delete(keysym);
    this.sendInput({ event: down ? EV.CONTROL_KEYDOWN : EV.CONTROL_KEYUP, payload: { keysym } });
  }

  private sendChord(names: string[]) {
    const held = new Set([...this.pressed, ...this.softwarePressed]);
    const shift = names.includes('Shift') || held.has(KEYSYM.Shift_L) || held.has(0xffe2);
    const syms = names.map(keysymForName).filter((sym): sym is number => sym !== null)
      .map((sym) => shift ? shiftedKeysym(sym) : sym);
    // Held modifiers remain down. A held character still needs a fresh stroke to trigger
    // a toolbar shortcut, then returns to its original held state after the chord.
    const suspended = [...held].filter((sym) => !modifierKeysym(sym));
    for (const keysym of [...suspended].reverse()) this.sendInput({ event: EV.CONTROL_KEYUP, payload: { keysym } });
    const added = syms.filter((sym) => !modifierKeysym(sym) || !held.has(sym));
    for (const keysym of added) this.sendInput({ event: EV.CONTROL_KEYDOWN, payload: { keysym } });
    for (const keysym of [...added].reverse()) this.sendInput({ event: EV.CONTROL_KEYUP, payload: { keysym } });
    for (const keysym of suspended) this.sendInput({ event: EV.CONTROL_KEYDOWN, payload: { keysym } });
  }

  private releaseSoftwareKeys() {
    for (const sym of [...this.softwarePressed].reverse()) this.sendSoftwareKey(false, sym);
    this.softwareEvents.clear();
  }

  private trackKey(down: boolean, event: KeyIdentityEvent, held: Map<string, KeyIdentityEvent & { sym: number }>): number | 'repeat' | 'release-all' | null {
    const id = matchingKeyIdentity(held, event);
    if (down) {
      if (id !== null) return 'repeat';
      const sym = keysymFor(event, { macToPc: this.opts.macToPc ?? false });
      if (sym === null) return null;
      // Read native properties explicitly: DOM KeyboardEvent properties are not enumerable.
      held.set(keyIdentity(event), { key: event.key, code: event.code, keyCode: event.keyCode, sym });
      return sym;
    }
    if (id === null) return unidentifiedKey(event) && held.size > 0 ? 'release-all' : null;
    const sym = held.get(id)!.sym;
    held.delete(id);
    return sym;
  }

  private sendInput(msg: NekoMessage): boolean {
    if (msg.event !== EV.CONTROL_SCROLL && msg.event !== EV.CONTROL_MOVE) this.finishScroll();
    return this.inputQueue.enqueue({ t: 'neko', data: msg });
  }

  private releaseTransportKeys(): void {
    // On interruption, queued actions are canceled, never replayed. Best-effort releases are
    // appended after any frames already handed to this WebSocket, before it is closed.
    try {
      for (const sym of [...this.transportKeys].reverse()) this.sendNeko({ event: EV.CONTROL_KEYUP, payload: { keysym: sym } });
      for (const code of this.transportButtons) this.sendNeko({ event: EV.CONTROL_BUTTONUP, payload: { code } });
    } catch { /* Delivery failure is already visible; closed transports cannot acknowledge releases. */ }
    this.transportKeys.clear();
    this.transportButtons.clear();
    this.pressed.clear();
    this.softwarePressed.clear();
    this.pressedEvents.clear();
    this.softwareEvents.clear();
    this.pressedButtons.clear();
  }

  /** Picture levels need a browser image with the quality ladder (images/browser/neko.yaml). */
  private get levelsOffered() {
    return VIDEO_QUALITIES.every((q) => this.offeredVideos.includes(q));
  }

  private requestSignal(ws: WebSocket) {
    if (this.signalRequested) return;
    this.signalRequested = true;
    this.startConnectionTimer(ws);
    if (!this.levelsOffered) {
      // An older image streams its one video; asking for a level it lacks would get no stream.
      this.sendNeko({ event: EV.SIGNAL_REQUEST, payload: { video: {}, audio: {} } });
      return;
    }
    // The viewer chooses the level itself (QualityController); neko's estimator stays out.
    if (this.video.auto) this.qualityController ??= new QualityController(this.video.quality, Date.now());
    this.qualityController?.restart(Date.now());
    const id = this.qualityController?.quality ?? this.video.quality;
    this.sendNeko({ event: EV.SIGNAL_REQUEST, payload: { video: { selector: { id, type: 'exact' }, auto: false }, audio: {} } });
  }

  private selectVideo(id: VideoQuality) {
    if (this.state !== 'live' || id === this.videoId || !this.levelsOffered) return;
    this.sendNeko({ event: EV.SIGNAL_VIDEO, payload: { selector: { id, type: 'exact' }, auto: false } });
  }

  private videoChanged(id: unknown) {
    if (typeof id !== 'string' || !(VIDEO_QUALITIES as readonly string[]).includes(id) || id === this.videoId) return;
    this.videoId = id as VideoQuality;
    this.opts.onVideo?.(this.videoId);
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
        if (this.state !== 'live') {
          // An offline notification with no user input pauses the queue without failing it.
          // A returning agent must make a fresh, empty queue usable on this same socket.
          this.inputQueue.resume();
          this.startConnectionTimer(ws);
        }
        return;
      case 'agent_offline':
        this.inputReady = false;
        this.inputQueue.interrupt('disconnected');
        this.clearConnectionTimer();
        this.teardownPeer();
        this.signalRequested = false;
        this.setState('agent-offline');
        if (!this.stopped) this.startConnectionTimer(ws);
        return;
      case 'input_error':
        this.inputReady = false;
        this.inputQueue.interrupt('relay', true);
        return;
      case 'taken_over':
        this.stopped = true;
        this.releaseTransportKeys();
        this.inputQueue.clear();
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
      case EV.SYSTEM_INIT: {
        const init = msg.payload as { screen_size?: unknown; webrtc?: { videos?: unknown } } | undefined;
        this.remoteScreen = screenOf(init?.screen_size) ?? this.remoteScreen;
        this.offeredVideos = Array.isArray(init?.webrtc?.videos) ? init.webrtc.videos.filter((v): v is string => typeof v === 'string') : [];
        this.requestSignal(ws);
        return;
      }
      case EV.SYSTEM_ADMIN: {
        const list = (msg.payload as { screen_sizes_list?: unknown } | undefined)?.screen_sizes_list;
        if (!Array.isArray(list)) return;
        this.screenConfigurations = list.map(screenOf).filter((s): s is ScreenConfiguration => s !== null).slice(0, 256);
        this.applyScreen();
        return;
      }
      case EV.SCREEN_UPDATED:
        this.remoteScreen = screenOf(msg.payload) ?? this.remoteScreen;
        return;
      case EV.SIGNAL_PROVIDE:
        this.videoChanged((msg.payload as unknown as SignalProvide).video?.id);
        await this.answer(msg.payload as unknown as SignalProvide, ws);
        return;
      case EV.SIGNAL_VIDEO:
        this.videoChanged((msg.payload as { id?: unknown } | undefined)?.id);
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
        this.sendNeko({ event: EV.CONTROL_REQUEST });
        this.inputReady = true;
        this.inputQueue.flush();
        this.setState('live');
        this.startStats();
        if (this.pendingViewport) this.applyScreen();
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.inputReady = false;
        this.inputQueue.interrupt('disconnected');
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
    const viewport = this.pendingViewport;
    const live = this.state === 'live';
    // Before the stream is live, only with neko's advertised modes: the change then overlaps the
    // WebRTC handshake, and the first frame already has the right size instead of being followed
    // by an encoder restart.
    if (!viewport || (!live && (!this.screenConfigurations.length || !this.signalRequested || this.ws?.readyState !== 1))) return;
    // Neko advertises the actual X11 modes, including their refresh rates. A familiar size
    // such as 1600×900 can support 25 Hz without supporting 30 Hz.
    const s = fitScreen(viewport.width, viewport.height, this.screenConfigurations)
      ?? { ...fitScreen(viewport.width, viewport.height), rate: 60 }; // Neko v3's default for clients without capabilities.
    const key = `${s.width}x${s.height}@${s.rate}`;
    if (key === this.appliedScreen) return;
    this.appliedScreen = key;
    // Neko rebuilds its video pipeline on every screen/set, even to the same size: skip a no-op.
    if (this.remoteScreen && sameScreen(s, this.remoteScreen)) return;
    this.lastScreenAt = Date.now();
    if (live) this.sendInput({ event: EV.SCREEN_SET, payload: { ...s } });
    // No input can be queued before the stream is live; this precedes all of it on the socket.
    else this.sendNeko({ event: EV.SCREEN_SET, payload: { ...s } });
  }

  private startStats() {
    if (this.statsTimer || (!this.opts.onStats && !this.video.auto)) return;
    let previous: { bytes: number; at: number } | null = null;
    this.counters = null;
    this.statsTimer = setInterval(async () => {
      if (!this.pc) return;
      let reading: Awaited<ReturnType<typeof readStats>>;
      try {
        reading = await readStats(this.pc, previous);
      } catch {
        return; // A closing connection; the next one starts its own readings.
      }
      previous = { bytes: reading.bytes, at: Date.now() };
      this.adapt(reading.stats, reading.counters);
      this.opts.onStats?.(reading.stats);
    }, this.opts.statsIntervalMs ?? 2000);
  }

  private adapt(stats: ViewerStats, counters: { lost: number; received: number; freezes: number; frames: number }) {
    const before = this.counters;
    const at = Date.now();
    this.counters = { ...counters, at };
    if (!this.qualityController || !before || this.state !== 'live' || !this.levelsOffered) return;
    const lost = Math.max(0, counters.lost - before.lost);
    const received = Math.max(0, counters.received - before.received);
    const seconds = (at - before.at) / 1000;
    // Some browsers omit framesPerSecond; decoded frames over the interval say the same.
    const decodedFps = seconds > 0 && counters.frames > 0 ? (counters.frames - before.frames) / seconds : null;
    const next = this.qualityController.observe({
      at,
      stalled: received === 0,
      fps: stats.fps ?? decodedFps,
      lossRate: lost + received > 0 ? lost / (lost + received) : 0,
      freezes: Math.max(0, counters.freezes - before.freezes),
      rttMs: stats.rttMs,
    });
    if (next) this.selectVideo(next);
  }

  private teardownPeer(preserveCandidates = false) {
    this.inputReady = false;
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = null;
    this.scrollAccumulator.reset();
    this.pointerPosition = null;
    this.remoteDescriptionReady = false;
    if (!preserveCandidates) this.pendingCandidates = [];
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.dc = null;
    const pc = this.pc;
    this.pc = null;
    pc?.close();
    // A new offer on the same socket keeps the screen applied for it; a new socket starts afresh.
    if (!preserveCandidates) this.appliedScreen = '';
  }
}
