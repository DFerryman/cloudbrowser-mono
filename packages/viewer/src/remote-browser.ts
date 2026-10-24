import type { ControlState, GatewayToViewer, IceServer } from '@cloudbrowser/contracts';
import { ConnectionDiagnostic, ConnectionMediaSnapshot, STREAM, VIDEO_QUALITIES, type VideoQuality } from '@cloudbrowser/contracts';
import { decode, EV, fitScreen, sameScreen, screenOf, x11Button, type NekoMessage, type ScreenConfiguration, type SignalCandidate, type SignalProvide } from './neko.js';
import { QualityController, type VideoPreference } from './quality.js';
import { KEYSYM, keyIdentity, keysymFor, keysymForName, matchingKeyIdentity, unidentifiedKey, type KeyIdentityEvent } from './keyboard.js';
import { readStats, type ViewerStats } from './stats.js';
import { ScrollAccumulator } from './scroll.js';
import { InputQueue, type InputFailure } from './input-queue.js';
import { FileTransfers, type TransferAction, type TransferFile, type TransferUpdate } from './file-transfer.js';

export type ViewerState = 'connecting' | 'live' | 'reconnecting' | 'agent-offline' | 'failed' | 'taken-over' | 'closed';

/**
 * Why the live view lost its connection, or could not make one, for the page to tell the user:
 * `offline` the device reported no network; `background` the page was hidden (the system
 * suspends it); `network` the connection dropped or stopped answering on the way, most often the
 * user's own network; `service` Nevazu's gateway closed it; `desktop` the cloud browser's own
 * connection dropped.
 */
export type ConnectionIssue = 'offline' | 'background' | 'network' | 'gateway' | 'service' | 'desktop';

/** A coding agent's bridge is connected (or not) and who may drive the browser (docs/agent-access.md). */
export type AutomationStatus = { connected: boolean; control: ControlState };

export interface ConnectInfo {
  gatewayUrl: string;
  token: string;
  iceServers: IceServer[];
}

export interface RemoteBrowserOptions {
  /** Fetches fresh connect info; each viewer token works once, so every (re)connect calls it. */
  getConnectInfo: () => Promise<ConnectInfo>;
  /** `issue`: why the connection is being made again or failed; null while live or for a first connection. */
  onState?: (state: ViewerState, attempt: number, issue: ConnectionIssue | null) => void;
  onStream?: (stream: MediaStream, attemptId: string, frameSequence: number) => void;
  /** Safe connection milestones only; never contains tokens, SDP or user input. */
  onDiagnostic?: (diagnostic: ConnectionDiagnostic) => void;
  /** Playback state for this exact peer only; diagnostics never read pixels or page content. */
  getPlaybackState?: (attemptId: string, frameSequence: number) => ConnectionMediaSnapshot['playback'];
  onStats?: (stats: ViewerStats) => void;
  /** A CSS `cursor` value for the remote cursor, drawn locally (page 5). */
  onCursor?: (css: string) => void;
  /** Text the remote Chrome put on its clipboard. Report a successful local copy with clipboardCopied. */
  onClipboard?: (text: string) => void;
  /** A pasted or dropped file transfer started, progressed or ended; also a text paste refused as too large (`files` 0). */
  onTransfer?: (update: TransferUpdate) => void;
  /** Delivery was interrupted; discard old input and require an explicit reconnect. `issue`: why the connection dropped, when known. */
  onInputError?: (reason: InputFailure, issue: ConnectionIssue | null) => void;
  /** A coding agent connected, left, took or lost control; the gateway sends it on connect and on every change. */
  onAutomation?: (status: AutomationStatus) => void;
  /** Map Cmd → Ctrl and Option → Alt (macOS default, page 5). */
  macToPc?: boolean;
  /** Picture quality; the sharpest level by default, adapting to the connection. */
  video?: VideoPreference;
  /** The level neko streams now, whenever it changes. */
  onVideo?: (quality: VideoQuality) => void;
  statsIntervalMs?: number;
  /** The most desktop pixels to ask for (TIERS[tier].maxScreenPixels); unbounded by default. */
  maxScreenPixels?: number;
  /** Maximum time per token fetch or transport/WebRTC handshake before retrying. Defaults to 20 s. */
  connectionTimeoutMs?: number;
  /** Total consecutive failed attempts, including the initial one. Defaults to three. */
  maxConnectionAttempts?: number;
  /** Renderers confirm a decoded video frame before the desktop becomes live. */
  requireFirstFrame?: boolean;
  WebSocketImpl?: typeof WebSocket;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];
/** Screen size changes are debounced and applied at most once every 5 s (page 5). */
const SCREEN_DEBOUNCE_MS = 750;
const SCREEN_MIN_INTERVAL_MS = 5000;
const CONNECTION_TIMEOUT_MS = 20_000;
const MAX_CONNECTION_ATTEMPTS = 3;
const MAX_PENDING_ICE_CANDIDATES = 256;
const MAX_MEDIA_SAMPLE_AGE_MS = 5000;
/**
 * The gateway answers this frame itself, without waking its object (setWebSocketAutoResponse),
 * and in order: its pong proves the socket works now and that the gateway received every frame
 * sent before the ping.
 */
const PING = '{"t":"ping"}';
/** With nothing from the gateway this long, the viewer pings it (neko's own heartbeat arrives every 10 s while its relay is up). */
const KEEPALIVE_MS = 12_000;
/** A socket that answers nothing this long after a ping is dead: mobile networks drop connections without closing them. */
const PONG_TIMEOUT_MS = 8_000;
/** How often the socket is checked; a much longer gap between checks means the page was frozen. */
const LIVENESS_TICK_MS = 2_000;
/** After this long hidden or frozen, the page checks its socket before it sends input on it. */
const RESUME_CHECK_AFTER_MS = 3_000;
/** How long that check waits for the gateway's pong before it reconnects. */
const RESUME_PROBE_MS = 4_000;
/**
 * A connection found dropped or silent this soon after the page came back from the background
 * (or a freeze) was lost while the system had the page suspended: iPadOS ends a locked page's
 * connections without a word.
 */
const RESUME_SETTLE_MS = 10_000;
/** Sent input is confirmed by the pong to a ping sent this soon after it. */
const ACK_PING_DELAY_MS = 250;
/** A media path that drops while live (a mobile network's blip) gets this long to come back by itself. */
const ICE_GRACE_MS = 4_000;
/** How long an ICE restart (neko's signal/restart) may take before the connection starts over. */
const ICE_RESTART_MS = 12_000;
/** Characters that require Shift on the remote US X11 keyboard. */
const SOFTWARE_SHIFTED = new Set([...`~!@#$%^&*()_+{}|:"<>?`]);
const SHIFTED_KEYSYMS = new Map([...'`1234567890-=[]\\;\',./'].map((character, index) =>
  [character.charCodeAt(0), [...SOFTWARE_SHIFTED][index]!.charCodeAt(0)]));
/**
 * The most text one paste carries, in UTF-8. The gateway closes a viewer socket for a frame above
 * 256 KiB (apps/gateway MAX_FRAME_BYTES), and JSON can double text full of quotes or newlines.
 */
const MAX_PASTE_BYTES = 128 * 1024;
/** Committed text longer than this, in characters, goes as one paste (typeSoftwareText). */
const LONG_TYPED_TEXT = 100;
/** How long a clipboard/updated matching text typed through the remote clipboard counts as its echo. */
const TYPED_ECHO_MS = 3000;
const encoder = new TextEncoder();
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
  private connectionAttempts = 0;
  private reportedAttempt = -1;
  private diagnosticAttempt: { id: string; startedAt: number; relayId?: string; stages: Set<string> } | null = null;
  private peerConnected = false;
  private firstFrame = false;
  private frameSequence = 0;
  private connectSequence = 0;
  private cancelConnectInfo: (() => void) | null = null;
  private stopped = true;
  private signalRequested = false;
  private remoteDescriptionReady = false;
  private pendingCandidates: SignalCandidate[] = [];
  private iceServers: IceServer[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private mediaSample: { pc: RTCPeerConnection; ws: WebSocket; frameSequence: number; at: number; media: ConnectionMediaSnapshot } | null = null;
  /** When a stats reading last saw video bytes arrive: the picture's path worked then. */
  private mediaProgressAt = -Infinity;
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
  private readonly files: FileTransfers;
  /** Text the remote clipboard last reported (clipboard/updated); null once typing went through it. */
  private remoteClipboard: string | null = null;
  /** The remote clipboard changed, and the page has not reported copying it to the local one. */
  private remoteClipboardNewer = false;
  /** Text recently typed through the remote clipboard, whose clipboard/updated is only an echo. */
  private typedPastes: { text: string; at: number }[] = [];
  /** The page is shown (setVisible) and the device has a network (setOnline). */
  private visible = true;
  private online = true;
  private hiddenAt: number | null = null;
  /** When the page last came back from the background or a freeze (setVisible, livenessTick). */
  private resumedAt = -Infinity;
  /** A reconnect waits for the page to be shown again or the network to come back, spending no attempts. */
  private deferred = false;
  /** Input kept for the next connection: it was held while this one was checked, never sent on it. */
  private carryInput = false;
  /** Why the connection is being made again (onState), until it is live. */
  private issue: ConnectionIssue | null = null;
  private reportedIssue: ConnectionIssue | null = null;
  /** How far this attempt got, for what a connection deadline means. */
  private reached: 'start' | 'transport' | 'desktop' | 'signal' | 'peer' = 'start';
  // Liveness (PING): when the gateway was last heard from, the ping waiting for its pong and the
  // frames it confirms, input held while the socket is checked, and their timers.
  private lastHeardAt = 0;
  /** Pings waiting for their pongs, oldest first: the socket answers them in order. */
  private pings: { at: number; frames: number; probe: boolean }[] = [];
  private lastTickAt = 0;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private holdInput = false;
  /** A media path that dropped while live: its grace or restart deadline, and whether neko restarts ICE. */
  private iceTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestarting = false;

  constructor(private readonly opts: RemoteBrowserOptions) {
    this.files = new FileTransfers({
      // Files ride the viewer socket beside the input FIFO; the agent paces them with acknowledgements.
      send: (frame) => {
        if (!this.inputReady || this.stopped || !this.ws || this.ws.readyState !== 1) return false;
        this.ws.send(JSON.stringify(frame));
        return true;
      },
      onUpdate: (update) => this.opts.onTransfer?.(update),
      onPasteReady: () => this.sendCombo(['Control', 'v']),
    });
    this.video = opts.video ?? { quality: 'full', auto: true };
    this.inputQueue = new InputQueue({
      transport: () => this.ws,
      // While the socket is checked (holdInput) input waits, unsent, for the gateway's answer.
      ready: () => this.inputReady && !this.stopped && !this.holdInput,
      held: () => this.transportKeys.size > 0 || this.transportButtons.size > 0,
      failed: (reason) => this.inputFailed(reason),
      sent: (data) => {
        const frame = JSON.parse(data) as { data: NekoMessage<{ keysym?: number; code?: number }> };
        const { event, payload } = frame.data;
        if (event === EV.CONTROL_KEYDOWN && payload?.keysym !== undefined) this.transportKeys.add(payload.keysym);
        if (event === EV.CONTROL_KEYUP && payload?.keysym !== undefined) this.transportKeys.delete(payload.keysym);
        if (event === EV.CONTROL_BUTTONDOWN && payload?.code !== undefined) this.transportButtons.add(payload.code);
        if (event === EV.CONTROL_BUTTONUP && payload?.code !== undefined) this.transportButtons.delete(payload.code);
        this.confirmSoon();
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

  /** neko's current mode with its refresh rate, for input diagnostics. */
  get screenMode(): ScreenConfiguration | null {
    return this.remoteScreen ? { ...this.remoteScreen } : null;
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
    this.attempt = 0;
    this.connectionAttempts = 0;
    this.deferred = false;
    this.carryInput = false;
    this.issue = null;
    return this.connectAttempt();
  }

  /**
   * The page was shown or hidden (document visibility). A hidden page makes no connection
   * attempts: its first frame cannot be drawn, so each one ran into the deadline, three in a row
   * spent the budget, and a page brought back found the view failed. Shown again after a while,
   * it checks its socket before it sends input on it.
   */
  setVisible(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;
    const now = Date.now();
    if (!visible) {
      this.hiddenAt = now;
      if (this.deferred) this.resumeDeferred();
      return;
    }
    const hiddenFor = this.hiddenAt === null ? 0 : now - this.hiddenAt;
    this.hiddenAt = null;
    this.lastTickAt = now;
    if (hiddenFor >= RESUME_CHECK_AFTER_MS) this.resumedAt = now;
    if (this.deferred) this.resumeDeferred();
    else if (hiddenFor >= RESUME_CHECK_AFTER_MS) this.checkConnection();
  }

  /** The device's network went away or came back (online/offline). Reconnects wait for it, spending no attempts. */
  setOnline(online: boolean) {
    if (online === this.online) return;
    this.online = online;
    if (this.deferred) this.resumeDeferred();
    else if (online) this.checkConnection();
  }

  /** The device changed networks (Wi-Fi to mobile data): the old connection may be gone without a word. */
  networkChanged() {
    if (!this.deferred) this.checkConnection();
  }

  private async connectAttempt(keepQueued = false): Promise<void> {
    const sequence = ++this.connectSequence;
    this.cancelConnectInfo?.();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearConnectionTimer();
    this.stopLiveness();
    this.releaseTransportKeys();
    // Input held while the last connection was checked was never sent on it: it waits for this one.
    if (!keepQueued) this.inputQueue.clear();
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.teardownPeer();
    this.inputQueue.resume();
    this.screenConfigurations = [];
    this.remoteScreen = null;
    this.appliedScreen = '';
    this.stopped = false;
    this.deferred = false;
    this.carryInput = false;
    this.reached = 'start';
    this.connectionAttempts++;
    this.diagnosticAttempt = { id: crypto.randomUUID(), startedAt: Date.now(), stages: new Set() };
    this.firstFrame = false;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    this.diagnostic('token_start');
    let info: ConnectInfo;
    let infoTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelInfo: (() => void) | undefined;
    let tokenTimedOut = false;
    try {
      const pendingInfo = this.opts.getConnectInfo();
      const deadline = new Promise<never>((_resolve, reject) => {
        infoTimer = setTimeout(() => {
          tokenTimedOut = true;
          reject(new Error('connection information timed out'));
        }, this.opts.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS);
        cancelInfo = () => reject(new Error('connection attempt replaced'));
        this.cancelConnectInfo = cancelInfo;
      });
      info = await Promise.race([pendingInfo, deadline]);
    } catch (error) {
      if (sequence === this.connectSequence && !this.stopped) {
        // The request never reached the api (a fetch TypeError, a timeout): the way there. Refused by it: the service.
        const status = (error as { status?: unknown } | null)?.status;
        const unreached = tokenTimedOut || error instanceof TypeError || status === 408;
        this.issue = this.classify(unreached ? 'network' : typeof status === 'number' && status >= 500 ? 'service' : null);
        this.diagnostic('failed', tokenTimedOut ? 'token_timeout' : 'token_failed');
        this.scheduleReconnect();
      }
      return;
    } finally {
      clearTimeout(infoTimer);
      if (this.cancelConnectInfo === cancelInfo) this.cancelConnectInfo = null;
    }
    // A repeated Retry click or a slow, older token response must not create a second
    // socket which would take over the newer connection from this same page.
    if (this.stopped || sequence !== this.connectSequence) return;
    this.diagnostic('token_ok');
    this.iceServers = info.iceServers;
    this.signalRequested = false;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const sep = info.gatewayUrl.includes('?') ? '&' : '?';
    this.diagnostic('transport_start');
    let ws: WebSocket;
    try {
      ws = new WS(`${info.gatewayUrl}${sep}token=${encodeURIComponent(info.token)}&attemptId=${this.diagnosticAttempt!.id}`);
    } catch {
      this.issue = this.classify(null);
      this.diagnostic('failed', 'transport_error');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // A blocked WebSocket upgrade may never deliver agent_online or even an error event.
    // Bound the whole transport handshake rather than waiting for the first server frame.
    this.startConnectionTimer(ws);
    this.startLiveness(ws);
    ws.onopen = () => {
      if (this.ws !== ws || this.stopped) return;
      this.reached = 'transport';
      this.lastHeardAt = Date.now();
      this.diagnostic('transport_open');
    };
    ws.onerror = () => {
      if (this.ws === ws && !this.stopped) {
        this.issue = this.classify(this.droppedBy(undefined));
        // Input held back while the socket was checked never went on it: it waits for the next one.
        this.reconnect(ws, 'transport_error', { keepQueued: this.holdInput });
      }
    };
    ws.onmessage = (e) => {
      if (this.ws === ws && !this.stopped) this.onGatewayFrame(e.data, ws);
    };
    ws.onclose = (event?: { code?: number }) => {
      if (this.ws !== ws) return;
      this.inputReady = false;
      const closeCode = typeof event?.code === 'number' && event.code >= 1000 && event.code <= 4999 ? event.code : undefined;
      this.issue = this.classify(this.droppedBy(closeCode));
      // Capture the peer and its last bounded sample before teardown advances its sequence.
      if (!this.stopped && this.state !== 'taken-over') this.diagnostic('failed', 'transport_closed', { closeCode });
      const kept = this.inputQueue.interrupt('disconnected', false, { keepQueued: this.holdInput });
      if (this.ws !== ws) return; // The interruption lost input and ended the connection.
      this.carryInput = kept;
      this.ws = null;
      this.stopLiveness();
      this.clearConnectionTimer();
      this.teardownPeer();
      if (!this.stopped && this.state !== 'taken-over') {
        this.scheduleReconnect();
      }
    };
  }

  /** A reconnect that waited for the page or the network starts now, with a whole budget; or says what it still waits for. */
  private resumeDeferred() {
    if (!this.deferred || this.stopped) return;
    if (!this.visible || !this.online) {
      this.issue = this.classify(this.issue);
      this.setState('reconnecting');
      return;
    }
    const keep = this.carryInput;
    this.deferred = false;
    this.attempt = Math.max(1, this.attempt);
    this.connectionAttempts = 0;
    void this.connectAttempt(keep);
  }

  /**
   * What a lost connection says about where it was lost. A gateway that closed it with a code of
   * its own: the service. A socket that dropped without one (1006) or stopped answering while the
   * picture's own path stopped too: the device's network, most likely. While the picture kept
   * arriving, the device reaches us, but not where the socket was lost: our side, or a router,
   * proxy or VPN on the way (`gateway`). Before the picture's path exists, nothing can be told.
   */
  private droppedBy(closeCode: number | undefined): ConnectionIssue | null {
    if (closeCode !== undefined && closeCode !== 1005 && closeCode !== 1006) return 'service';
    if (!this.pc || this.reached !== 'peer') return null;
    return this.mediaFlowing() ? 'gateway' : 'network';
  }

  /**
   * The device and the page come first: offline, or hidden or just back from the background
   * (suspended by the system), unless the gateway itself said why (service, desktop).
   */
  private classify(issue: ConnectionIssue | null): ConnectionIssue | null {
    if (!this.online) return 'offline';
    if (!this.visible) return 'background';
    if (issue !== 'service' && issue !== 'desktop' && this.justResumed()) return 'background';
    return issue;
  }

  /**
   * The page came back from the background or a freeze within RESUME_SETTLE_MS. A check that ran
   * far later than due says the page was frozen until now, with or without a visibility event.
   */
  private justResumed(): boolean {
    const now = Date.now();
    if (this.livenessTimer && now - this.lastTickAt > 3 * LIVENESS_TICK_MS) this.resumedAt = now;
    return now - this.resumedAt < RESUME_SETTLE_MS;
  }

  disconnect() {
    this.diagnostic('closed', 'canceled');
    this.end();
    this.issue = null;
    this.setState('closed');
  }

  /** Ends the connection for good: only connect() starts another. */
  private end() {
    this.connectSequence++;
    this.cancelConnectInfo?.();
    this.stopped = true;
    this.deferred = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearConnectionTimer();
    this.stopLiveness();
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.releaseTransportKeys();
    this.inputQueue.clear();
    this.teardownPeer();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    if (this.cursorUrl) {
      URL.revokeObjectURL(this.cursorUrl);
      this.cursorUrl = null;
      // The page must not keep drawing a cursor whose image is gone.
      this.opts.onCursor?.('default');
    }
  }

  /**
   * Input may have been lost. The connection ends here rather than carrying on with input the
   * user believes was delivered: an open socket and peer would also keep reporting a live,
   * watched desktop (and keep the browser awake) behind the page's interruption notice.
   */
  private inputFailed(reason: InputFailure) {
    this.end();
    this.setState('closed');
    this.opts.onInputError?.(reason, this.issue);
  }

  /** A renderer calls this only after observing a frame from this attempt's video stream. */
  reportFirstFrame(attemptId: string, frameSequence: number) {
    if (this.stopped || this.diagnosticAttempt?.id !== attemptId || frameSequence !== this.frameSequence || !this.ws) return;
    this.firstFrame = true;
    this.diagnostic('first_frame');
    this.becomeLive();
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

  /**
   * Presses and releases a combination such as ['Control', 't'] (toolbar Keys menu). Held modifiers
   * stay down; `exact` lifts those the combination does not name for its duration, all but Shift,
   * which extends a selection (a Mac's Option+← arrives with Alt held and goes out as Ctrl+←).
   */
  sendCombo(names: string[], exact = false) {
    this.sendChord(names, exact);
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
    const normalized = text.replace(/\r\n?/g, '\n');
    // A long or multi-line commit (dictation, a text replacement) goes as one paste. Typed out key
    // by key it overflowed the input queue at about 2,000 characters, and each newline became
    // Enter, which sends a chat message or submits a form halfway through the text. A commit of
    // only line breaks and tabs is still typed: those are the keys themselves.
    const whole = [...normalized].length > LONG_TYPED_TEXT || (normalized.includes('\n') && /\S/.test(normalized));
    if (whole && !this.fitsPaste(normalized)) return;
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
        this.typedThroughClipboard(paste);
        pasted = true;
      }
      paste = '';
    };
    if (whole) paste = normalized;
    else for (const character of normalized) {
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
    if (!text || !this.fitsPaste(text)) return;
    const keys = new Set([...this.pressed, ...this.softwarePressed]);
    const buttons = [...this.pressedButtons];
    this.sendInput({ event: EV.CONTROL_PASTE, payload: { text } });
    // Neko's KeyPress resets all X11 holds around Ctrl+V. Restore the holds that
    // preceded this operation before later keyups or shortcuts pass through the FIFO.
    for (const keysym of keys) this.sendInput({ event: EV.CONTROL_KEYDOWN, payload: { keysym } });
    for (const code of buttons) this.sendInput({ event: EV.CONTROL_BUTTONDOWN, payload: { code } });
  }

  /**
   * A local Ctrl+V (Cmd+V) carrying the local clipboard's `text`. Sending it (paste) also replaces
   * the remote clipboard, which may hold what the local one cannot: an image copied in the remote
   * Chrome (neko reports text only), or text the page could not copy out. So the remote page pastes
   * its own clipboard (a plain Ctrl+V) unless the text is new: not empty, not what the remote
   * clipboard last reported, and not older than a remote copy that never reached the local clipboard.
   */
  pasteClipboard(text: string) {
    if (!text || text === this.remoteClipboard || this.remoteClipboardNewer) this.sendChord(['Control', 'v']);
    else this.paste(text);
  }

  /** The page put `text`, from onClipboard, on the local clipboard. */
  clipboardCopied(text: string) {
    if (text === this.remoteClipboard) this.remoteClipboardNewer = false;
  }

  /** The page lost focus: whatever is copied elsewhere meanwhile is newer than the remote clipboard. */
  pageBlurred() {
    this.remoteClipboardNewer = false;
  }

  /**
   * Sends local files to the remote browser. paste: onto its clipboard, then Ctrl+V into the
   * focused field; drop: onto the page at a point in remote screen pixels. Returns the transfer id,
   * or null when it was refused (onTransfer says why).
   */
  sendFiles(action: TransferAction, files: TransferFile[], point?: { x: number; y: number }): string | null {
    return this.files.start(action, files, point);
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
    // A live connection has nothing to explain; any other state says why it is not live, when known.
    const issue = s === 'live' ? null : this.issue;
    if (s === this.state && this.attempt === this.reportedAttempt && issue === this.reportedIssue) return;
    this.state = s;
    this.reportedAttempt = this.attempt;
    this.reportedIssue = issue;
    this.opts.onState?.(s, this.attempt, issue);
  }

  private diagnostic(stage: ConnectionDiagnostic['stage'], code?: ConnectionDiagnostic['code'], extra: { closeCode?: number } = {}) {
    const attempt = this.diagnosticAttempt;
    const frameSequence = this.frameSequence;
    const mediaStage = ['signal_received', 'peer_connected', 'first_frame', 'failed', 'closed', 'media_restart', 'media_recovered'].includes(stage);
    const key = mediaStage ? `${frameSequence}:${stage}:${code ?? ''}` : stage;
    if (!attempt || attempt.stages.has(key)) return;
    const media = stage === 'failed' || stage === 'first_frame' ? this.captureMediaSnapshot() : undefined;
    if (attempt !== this.diagnosticAttempt || frameSequence !== this.frameSequence) return;
    const report = ConnectionDiagnostic.safeParse({
      attemptId: attempt.id,
      ...(attempt.relayId ? { relayId: attempt.relayId } : {}),
      stage,
      peerSequence: frameSequence,
      elapsedMs: Math.max(0, Math.min(600_000, Math.round(Date.now() - attempt.startedAt))),
      ...(code ? { code } : {}),
      ...(extra.closeCode !== undefined ? { closeCode: extra.closeCode } : {}),
      ...(stage === 'failed' && this.issue ? { issue: this.issue } : {}),
      ...(media ? { media } : {}),
    });
    if (!report.success) return;
    attempt.stages.add(key);
    if (attempt.stages.size > 256) attempt.stages.delete(attempt.stages.values().next().value!);
    // Callbacks cannot break connection handling, and receive only this explicit allowlist.
    try {
      this.opts.onDiagnostic?.(report.data);
    } catch { /* Diagnostics must not affect the viewer. */ }
  }

  private captureMediaSnapshot(): ConnectionMediaSnapshot | undefined {
    const pc = this.pc;
    const ws = this.ws;
    const frameSequence = this.frameSequence;
    const attemptId = this.diagnosticAttempt?.id;
    if (!pc || !ws || !attemptId) return undefined;
    const media: ConnectionMediaSnapshot = {};
    const sample = this.mediaSample;
    const age = sample ? Date.now() - sample.at : -1;
    if (sample?.pc === pc && sample.ws === ws && sample.frameSequence === frameSequence && age >= 0 && age <= MAX_MEDIA_SAMPLE_AGE_MS) {
      Object.assign(media, sample.media, { sampleAgeMs: age });
    }
    // States and playback are read at the milestone; counters must come from a recent getStats.
    if (['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'].includes(pc.connectionState)) media.connectionState = pc.connectionState;
    if (['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) media.iceConnectionState = pc.iceConnectionState;
    if (['new', 'gathering', 'complete'].includes(pc.iceGatheringState)) media.iceGatheringState = pc.iceGatheringState;
    try {
      const playback = this.opts.getPlaybackState?.(attemptId, frameSequence);
      const parsed = ConnectionMediaSnapshot.safeParse({ playback });
      if (parsed.success && parsed.data.playback) media.playback = parsed.data.playback;
    } catch { /* A renderer cannot break connection handling or add unvalidated fields. */ }
    if (this.pc !== pc || this.ws !== ws || this.frameSequence !== frameSequence || this.diagnosticAttempt?.id !== attemptId) return undefined;
    return Object.keys(media).length ? media : undefined;
  }

  private becomeLive() {
    if (this.stopped || !this.peerConnected || (this.opts.requireFirstFrame && !this.firstFrame)) return;
    this.clearConnectionTimer();
    this.attempt = 0;
    this.connectionAttempts = 0;
    this.issue = null;
    this.inputReady = true;
    this.inputQueue.flush();
    if (this.stopped) return; // Queued input could not be delivered (inputFailed).
    this.setState('live');
    this.startStats();
    if (this.pendingViewport) this.applyScreen();
  }

  private scheduleReconnect() {
    this.clearConnectionTimer();
    this.stopLiveness();
    if (this.stopped) return;
    if (this.retryTimer) return;
    if (!this.visible || !this.online) {
      // Nothing can connect, or be seen, now: wait for the page or the network without spending
      // the budget (setVisible, setOnline). Input kept for the next connection keeps waiting too.
      this.deferred = true;
      this.issue = this.classify(this.issue);
      this.setState('reconnecting');
      return;
    }
    const configuredMax = this.opts.maxConnectionAttempts ?? MAX_CONNECTION_ATTEMPTS;
    const maxAttempts = Number.isFinite(configuredMax) ? Math.max(1, Math.floor(configuredMax)) : MAX_CONNECTION_ATTEMPTS;
    if (this.connectionAttempts >= maxAttempts) {
      this.stopped = true;
      this.connectSequence++;
      this.cancelConnectInfo?.();
      this.releaseTransportKeys();
      this.inputQueue.clear();
      this.teardownPeer();
      const ws = this.ws;
      this.ws = null;
      ws?.close();
      // Keep the original failed stage/code; exhaustion has its own final closed milestone.
      this.diagnostic('closed', 'retry_exhausted');
      this.setState('failed');
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.setState('reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectAttempt(this.carryInput);
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
      if (this.state === 'live') return;
      // A picture path that never connected after neko offered one points at the network between
      // the two (UDP and the relay's ports); a desktop that never answered, at the cloud browser.
      this.issue = this.classify(this.state === 'agent-offline' || this.reached === 'transport' || this.reached === 'desktop' ? 'desktop'
        : this.reached === 'signal' ? 'network' : null);
      this.reconnect(ws, 'connection_timeout');
    }, this.opts.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS);
  }

  /**
   * Replaces the socket. `reason` and `beyondGateway` say how its input failed (InputQueue
   * interrupt); `keepQueued` keeps input that was held, never sent, for the next connection.
   */
  private reconnect(ws: WebSocket, code: ConnectionDiagnostic['code'] = 'relay_failed', options: { reason?: InputFailure; beyondGateway?: boolean; keepQueued?: boolean } = {}) {
    if (this.ws !== ws || this.stopped) return;
    this.diagnostic('failed', code);
    // Negotiation errors and deadlines also replace the socket. Pending preconnect
    // input must pause visibly instead of following the retry into another session.
    this.inputReady = false;
    const kept = this.inputQueue.interrupt(options.reason ?? 'disconnected', false, { beyondGateway: options.beyondGateway, keepQueued: options.keepQueued });
    if (this.stopped) return; // The interruption lost input and ended the connection.
    this.carryInput = kept;
    this.ws = null;
    this.stopLiveness();
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

  private sendChord(names: string[], exact = false) {
    const held = new Set([...this.pressed, ...this.softwarePressed]);
    const shift = names.includes('Shift') || held.has(KEYSYM.Shift_L) || held.has(0xffe2);
    const syms = names.map(keysymForName).filter((sym): sym is number => sym !== null)
      .map((sym) => shift ? shiftedKeysym(sym) : sym);
    // Held modifiers remain down unless `exact` lifts them. A held character still needs a fresh
    // stroke to trigger a toolbar shortcut, then returns to its original held state after the chord.
    const suspended = [...held].filter((sym) => !modifierKeysym(sym)
      || (exact && sym !== KEYSYM.Shift_L && sym !== 0xffe2 && !syms.includes(sym)));
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

  /** Refuses text too large for one gateway frame, and says so (onTransfer), rather than lose the connection over it. */
  private fitsPaste(text: string): boolean {
    const bytes = encoder.encode(text).byteLength;
    if (bytes <= MAX_PASTE_BYTES) return true;
    this.opts.onTransfer?.({ id: `text-${Date.now().toString(36)}`, action: 'paste', files: 0, bytes, received: 0, state: 'error', reason: 'too_large' });
    return false;
  }

  /**
   * Typed text went through the remote clipboard. neko reports it back (clipboard/updated) as if it
   * had been copied, which put every IME commit on the local clipboard: that echo is dropped. The
   * remote clipboard now holds nothing the user copied, so a local paste sends its own text.
   */
  private typedThroughClipboard(text: string) {
    const now = Date.now();
    this.typedPastes = [...this.typedPastes.filter((typed) => now - typed.at < TYPED_ECHO_MS), { text, at: now }].slice(-16);
    this.remoteClipboard = null;
    this.remoteClipboardNewer = false;
  }

  private sendInput(msg: NekoMessage): boolean {
    if (msg.event !== EV.CONTROL_SCROLL && msg.event !== EV.CONTROL_MOVE) this.finishScroll();
    // Input that finds the socket check overdue comes from a page just thawed (a locked screen),
    // possibly before its timers ran: the socket is checked before anything goes into it.
    if (this.livenessTimer && this.ws && Date.now() - this.lastTickAt > 3 * LIVENESS_TICK_MS) this.thawed();
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
    if (this.video.auto) this.qualityController ??= new QualityController(this.video.quality, Date.now(), this.video.quality);
    this.qualityController?.restart(Date.now());
    const id = this.qualityController?.quality ?? this.video.quality;
    this.sendNeko({ event: EV.SIGNAL_REQUEST, payload: { video: { selector: { id, type: 'exact' }, auto: false }, audio: {} } });
  }

  private selectVideo(id: VideoQuality) {
    if (!this.mediaConnected || id === this.videoId || !this.levelsOffered) return;
    this.sendNeko({ event: EV.SIGNAL_VIDEO, payload: { selector: { id, type: 'exact' }, auto: false } });
  }

  /** Media can receive diagnostics and quality changes before a rendered frame permits input. */
  private get mediaConnected() {
    return !this.stopped && this.peerConnected && this.pc?.connectionState === 'connected' && this.ws?.readyState === 1;
  }

  private videoChanged(id: unknown) {
    if (typeof id !== 'string' || !(VIDEO_QUALITIES as readonly string[]).includes(id) || id === this.videoId) return;
    this.videoId = id as VideoQuality;
    this.opts.onVideo?.(this.videoId);
  }

  private onGatewayFrame(raw: unknown, ws: WebSocket) {
    if (typeof raw !== 'string') return;
    this.lastHeardAt = Date.now();
    let frame: GatewayToViewer;
    try {
      frame = JSON.parse(raw) as GatewayToViewer;
    } catch {
      return;
    }
    switch (frame.t) {
      case 'pong':
        this.pong(ws);
        return;
      case 'connection_stage':
        if (typeof frame.relayId === 'string' && /^[0-9a-f-]{36}$/i.test(frame.relayId) && this.diagnosticAttempt) {
          this.diagnosticAttempt.relayId = frame.relayId;
        }
        this.diagnostic(frame.stage === 'received' ? 'agent_received' : frame.stage, frame.code);
        return;
      case 'agent_online':
        // The tunnel is online before the agent's local neko relay is necessarily ready.
        // Neko's system/init is the acknowledgment that it can receive signal/request.
        if (this.state !== 'live') {
          // An offline notification with no user input pauses the queue without failing it.
          // A returning agent must make a fresh, empty queue usable on this same socket.
          this.inputQueue.resume();
          // The returning agent gets a whole deadline to renegotiate, not what its absence left.
          this.clearConnectionTimer();
          this.startConnectionTimer(ws);
        }
        return;
      case 'agent_offline':
        // The cloud browser's tunnel to the gateway dropped: past the gateway, so time settles input.
        this.issue = this.classify('desktop');
        this.diagnostic('failed', 'agent_offline');
        this.inputReady = false;
        this.inputQueue.interrupt('disconnected', false, { beyondGateway: true });
        if (this.stopped) return; // The interruption lost input and ended the connection.
        this.clearConnectionTimer();
        this.teardownPeer();
        this.signalRequested = false;
        this.setState('agent-offline');
        if (!this.stopped) this.startConnectionTimer(ws);
        return;
      case 'input_error':
        // The gateway could not relay to the cloud browser and closes this socket. Input sent
        // before that was refused at once, so it is recent: the user is told when there was some,
        // and a relay that failed with nothing in flight (neko ending its session) reconnects quietly.
        this.issue = this.classify('desktop');
        this.reconnect(ws, 'relay_failed', { reason: 'relay', beyondGateway: true });
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
        void this.onNeko(frame.data as NekoMessage, ws).catch(() => {
          this.issue = this.classify('desktop');
          this.reconnect(ws, 'negotiation_failed');
        });
        return;
      case 'file':
        this.files.handle(frame);
        return;
      case 'automation_status':
        try {
          this.opts.onAutomation?.({ connected: frame.connected, control: frame.control });
        } catch { /* A status callback cannot affect the connection. */ }
    }
  }

  private async onNeko(msg: NekoMessage, ws: WebSocket) {
    switch (msg.event) {
      case EV.SYSTEM_INIT: {
        this.reached = 'desktop';
        this.diagnostic('desktop_ready');
        const init = msg.payload as { screen_size?: unknown; webrtc?: { videos?: unknown } } | undefined;
        // Each system/init comes from a fresh neko session: an unknown screen is better than one
        // carried over from a relay that ended (input then maps to the picture's own pixels).
        this.remoteScreen = screenOf(init?.screen_size);
        this.offeredVideos = Array.isArray(init?.webrtc?.videos) ? init.webrtc.videos.filter((v): v is string => typeof v === 'string') : [];
        this.requestSignal(ws);
        this.qualityController?.screenChanged(Date.now());
        return;
      }
      case EV.SYSTEM_ADMIN: {
        const list = (msg.payload as { screen_sizes_list?: unknown } | undefined)?.screen_sizes_list;
        if (!Array.isArray(list)) return;
        this.screenConfigurations = list.map(screenOf).filter((s): s is ScreenConfiguration => s !== null).slice(0, 256);
        this.applyScreen();
        return;
      }
      case EV.SCREEN_UPDATED: {
        const screen = screenOf(msg.payload);
        if (!screen) return;
        this.remoteScreen = screen;
        this.qualityController?.screenChanged(Date.now());
        return;
      }
      case EV.SIGNAL_PROVIDE:
        this.reached = 'signal';
        this.videoChanged((msg.payload as unknown as SignalProvide).video?.id);
        await this.answer(msg.payload as unknown as SignalProvide, ws);
        return;
      case EV.SIGNAL_RESTART: {
        // neko's new offer for an ICE restart (restartIce): the same peer, a new media path.
        const sdp = (msg.payload as { sdp?: unknown } | undefined)?.sdp;
        if (typeof sdp === 'string') await this.answerRestart(sdp, ws);
        return;
      }
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
        if (typeof text !== 'string') return;
        const now = Date.now();
        const echo = this.typedPastes.findIndex((typed) => typed.text === text && now - typed.at < TYPED_ECHO_MS);
        if (echo >= 0) {
          this.typedPastes.splice(echo, 1);
          return;
        }
        this.remoteClipboard = text;
        this.remoteClipboardNewer = true;
        this.opts.onClipboard?.(text);
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
    this.diagnostic('signal_received');
    this.startConnectionTimer(ws);
    const servers = this.iceServers.length
      ? this.iceServers
      : (provide.iceservers ?? []).map((s) => ({ ...s, urls: Array.isArray(s.urls) ? s.urls : [s.urls] }));
    // Media goes through the TURN relay when we have one: the VM accepts no inbound connections (page 5).
    const relayOnly = servers.some((s) => s.urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:')));
    const PC = this.opts.RTCPeerConnectionImpl ?? RTCPeerConnection;
    const pc = new PC({ iceServers: servers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
    this.pc = pc;
    const frameSequence = this.frameSequence;
    let mediaStream: MediaStream | null = null;

    pc.ontrack = (e) => {
      if (this.pc !== pc || this.ws !== ws || this.stopped || !this.diagnosticAttempt) return;
      mediaStream ??= e.streams[0] ?? new MediaStream();
      if (!mediaStream.getTracks().includes(e.track)) mediaStream.addTrack(e.track);
      if (!mediaStream.getTracks().some((track) => track.kind === 'video')) return;
      // Audio and video can arrive in separate streams. Keep one playback source so a later
      // audio track cannot replace the picture or cancel its pending first-frame observation.
      this.opts.onStream?.(mediaStream, this.diagnosticAttempt.id, frameSequence);
    };
    pc.ondatachannel = (e) => {
      if (this.pc !== pc || this.ws !== ws || this.stopped) return;
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
        if (this.peerConnected) {
          this.mediaRecovered(ws);
          return;
        }
        this.peerConnected = true;
        this.reached = 'peer';
        this.diagnostic('peer_connected');
        this.sendNeko({ event: EV.CONTROL_REQUEST });
        // Waiting for a first frame must not also stop the measurements and quality changes
        // that can recover it. This does not make the desktop live or release queued input.
        this.startStats();
        this.becomeLive();
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        // A live picture whose path dropped (a mobile network's blip, a change of network) is
        // brought back on this socket (mediaInterrupted); input meanwhile keeps its own path.
        // Before it was ever live, or when that fails, start over with a fresh token. Pending
        // input is interrupted there, after the failure is recorded.
        if (this.peerConnected && (this.state === 'live' || this.iceRestarting) && this.ws === ws) this.mediaInterrupted(ws, pc.connectionState === 'failed');
        else {
          this.issue = this.classify('network');
          this.reconnect(ws);
        }
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
    const s = fitScreen(viewport.width, viewport.height, this.screenConfigurations, STREAM.maxRefreshRate, this.opts.maxScreenPixels)
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
    const pc = this.pc;
    const ws = this.ws;
    const frameSequence = this.frameSequence;
    if (!pc || !ws || !this.mediaConnected || this.statsTimer || (!this.opts.onStats && !this.opts.onDiagnostic && !this.video.auto)) return;
    let previous: { bytes: number; at: number } | null = null;
    let pending = false;
    const interval = this.opts.statsIntervalMs ?? 2000;
    const current = () => this.pc === pc && this.ws === ws && this.frameSequence === frameSequence && this.mediaConnected;
    this.counters = null;
    this.statsTimer = setInterval(async () => {
      if (pending || !current()) return;
      pending = true;
      const sampledAt = Date.now();
      try {
        let reading: Awaited<ReturnType<typeof readStats>>;
        try {
          reading = await readStats(pc, previous);
        } catch {
          return; // A closing connection; the next one starts its own readings.
        }
        // An earlier peer may finish getStats after a reconnect or a new offer on this socket.
        // Its counters must not change the replacement's quality or be reported as its stats.
        if (!current()) return;
        this.mediaSample = { pc, ws, frameSequence, at: sampledAt, media: reading.media };
        // A reading across a freeze (a locked screen) averages time the page did not run: its
        // bytes may have arrived before the freeze, and its rates are too low. It starts afresh.
        const spansFreeze = !!previous && (previous.at < this.resumedAt || sampledAt - previous.at > 2.5 * interval);
        if (!spansFreeze && reading.bytes > (previous?.bytes ?? 0)) this.mediaProgressAt = sampledAt;
        previous = { bytes: reading.bytes, at: Date.now() };
        if (spansFreeze) {
          this.counters = null;
          return;
        }
        this.adapt(reading.stats, reading.counters);
        this.opts.onStats?.(reading.stats);
      } finally {
        pending = false;
      }
    }, interval);
  }

  private adapt(stats: ViewerStats, counters: { lost: number; received: number; freezes: number; frames: number }) {
    const before = this.counters;
    const at = Date.now();
    this.counters = { ...counters, at };
    if (!this.qualityController || !before || !this.mediaConnected || !this.levelsOffered) return;
    const lost = Math.max(0, counters.lost - before.lost);
    const received = Math.max(0, counters.received - before.received);
    const seconds = (at - before.at) / 1000;
    // Some browsers omit framesPerSecond; decoded frames over the interval say the same. While
    // packets arrive but no frame decodes (the decoder waits for a keyframe), framesPerSecond is
    // missing too: that is 0 fps, not an unknown rate.
    const decodedFps = seconds > 0 && Number.isFinite(counters.frames) && Number.isFinite(before.frames)
      ? (counters.frames - before.frames) / seconds : null;
    const next = this.qualityController.observe({
      at,
      stalled: received === 0,
      fps: stats.fps ?? decodedFps,
      lossRate: lost + received > 0 ? lost / (lost + received) : 0,
      freezes: Math.max(0, counters.freezes - before.freezes),
      kbps: stats.bitrateKbps,
      rttMs: stats.rttMs,
      scale: stats.width && this.remoteScreen?.width ? stats.width / this.remoteScreen.width : null,
    });
    if (next) this.selectVideo(next);
  }

  private teardownPeer(preserveCandidates = false) {
    this.inputReady = false;
    this.peerConnected = false;
    this.firstFrame = false;
    this.clearIceTimer();
    if (this.iceRestarting) this.holdInput = false;
    this.iceRestarting = false;
    this.frameSequence++;
    this.mediaSample = null;
    if (this.opts.requireFirstFrame && this.state === 'live') this.setState('connecting');
    // Every path that loses the agent ends here (a new offer keeps it); the agent discards the
    // part of a transfer it received.
    if (!preserveCandidates) this.files.failAll();
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

  // --- liveness (PING) and the media path ---------------------------------------------------

  private startLiveness(ws: WebSocket) {
    this.stopLiveness();
    this.lastHeardAt = this.lastTickAt = Date.now();
    this.livenessTimer = setInterval(() => this.livenessTick(ws), LIVENESS_TICK_MS);
  }

  private stopLiveness() {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.pings = [];
    this.holdInput = false;
  }

  /**
   * Keeps an open socket honest: one the gateway stopped answering (a network that dropped it
   * without closing it) is replaced before the user's next tap goes into it. A hidden page's
   * timers are throttled or stopped, so it checks itself when shown (setVisible); a long gap
   * between ticks says the page was frozen, and it checks before trusting the socket.
   */
  private livenessTick(ws: WebSocket) {
    if (this.ws !== ws || this.stopped) return;
    const now = Date.now();
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (!this.visible || ws.readyState !== 1) return;
    if (gap > 3 * LIVENESS_TICK_MS) {
      this.thawed();
      return;
    }
    // A ping sent before the page was hidden or frozen is timed from its return: neither it nor
    // its answer could move while the page did not run. Timed by the clock, it condemned the socket
    // the moment an iPad was unlocked, ahead of the check (checkConnection), which decides then.
    const oldest = this.pings[0];
    if (oldest && !this.probeTimer && now - Math.max(oldest.at, this.resumedAt) > PONG_TIMEOUT_MS && this.lastHeardAt < oldest.at) {
      this.issue = this.classify(this.droppedBy(undefined) ?? 'network');
      this.reconnect(ws, 'transport_stale', { keepQueued: this.holdInput });
      return;
    }
    if (!oldest && now - this.lastHeardAt > KEEPALIVE_MS) this.sendPing(ws, false);
  }

  /** The page ran again after a freeze: its socket is checked before input goes into it. */
  private thawed() {
    this.lastTickAt = this.resumedAt = Date.now();
    this.checkConnection();
  }

  /** `probe`: input waits (holdInput) until this ping's pong proves the socket works. */
  private sendPing(ws: WebSocket, probe: boolean) {
    // A socket that answers none of a few is dead (livenessTick); more would only pile up.
    if (this.ws !== ws || ws.readyState !== 1 || this.pings.length >= 4) return;
    try {
      ws.send(PING);
    } catch {
      return; // A closing socket reports itself.
    }
    this.pings.push({ at: Date.now(), frames: this.inputQueue.sent, probe });
  }

  private pong(ws: WebSocket) {
    if (this.ws !== ws) return;
    const ping = this.pings.shift();
    if (!ping) return;
    this.inputQueue.acknowledge(ping.frames);
    if (ping.probe) this.releaseInput();
    // Input sent after that ping is confirmed by the next one.
    if (this.inputQueue.unconfirmed) this.confirmSoon();
  }

  /** Sent input is confirmed by a ping right after it, one at a time. */
  private confirmSoon() {
    if (this.ackTimer || this.pings.length) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.ws && !this.pings.length && this.inputQueue.unconfirmed) this.sendPing(this.ws, false);
    }, ACK_PING_DELAY_MS);
  }

  /**
   * After the page was hidden or frozen, or the network changed under it, its socket may be
   * gone without having closed: an iPad left alone came back to a tap that went nowhere and an
   * "input interrupted" notice. Input now waits while a ping checks the socket; a pong sends it,
   * and silence replaces the socket with that input carried over, never sent twice.
   */
  private checkConnection() {
    const ws = this.ws;
    if (!ws || this.stopped || ws.readyState !== 1) return;
    // A connection still being made has its own deadline; a ping is enough to keep it honest.
    if (this.state !== 'live') {
      this.sendPing(ws, false);
      return;
    }
    const sentAt = Date.now();
    this.holdInput = true;
    this.sendPing(ws, true);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.ws !== ws || this.stopped || this.lastHeardAt >= sentAt) {
        this.releaseInput();
        return;
      }
      this.issue = this.classify('background');
      this.reconnect(ws, 'transport_stale', { keepQueued: true });
    }, RESUME_PROBE_MS);
  }

  private releaseInput() {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    if (!this.holdInput || this.iceRestarting) return;
    this.holdInput = false;
    this.inputQueue.flush();
  }

  /** Media bytes arrived over the picture's own path within the last few seconds. */
  private mediaFlowing(): boolean {
    const sample = this.mediaSample;
    return this.pc?.connectionState === 'connected' && !!sample && sample.pc === this.pc && Date.now() - this.mediaProgressAt < 2.5 * (this.opts.statsIntervalMs ?? 2000);
  }

  private clearIceTimer() {
    if (this.iceTimer) clearTimeout(this.iceTimer);
    this.iceTimer = null;
  }

  /**
   * The live picture's path dropped. A blip ('disconnected') often recovers by itself: it gets
   * ICE_GRACE_MS. Then (or at once for 'failed') neko is asked for an ICE restart on this socket,
   * which keeps the desktop session and the input path; only if that fails too does the viewer
   * start over. Before, every blip tore the connection down, and a tap in the last ten seconds
   * turned it into "input interrupted".
   */
  private mediaInterrupted(ws: WebSocket, failed: boolean) {
    if (this.iceRestarting) return;
    if (!failed) {
      if (!this.iceTimer) this.iceTimer = setTimeout(() => {
        this.iceTimer = null;
        if (this.pc && this.pc.connectionState !== 'connected') this.restartIce(ws);
      }, ICE_GRACE_MS);
      return;
    }
    this.restartIce(ws);
  }

  private restartIce(ws: WebSocket) {
    if (this.ws !== ws || this.stopped || this.iceRestarting) return;
    this.clearIceTimer();
    this.issue = this.classify('network');
    if (ws.readyState !== 1 || !this.pc) {
      this.reconnect(ws, 'media_failed');
      return;
    }
    this.iceRestarting = true;
    // Taps on a frozen picture would land on a page the user cannot see: input waits for it.
    this.holdInput = true;
    this.diagnostic('media_restart');
    this.attempt = 1;
    this.setState('reconnecting');
    this.sendNeko({ event: EV.SIGNAL_RESTART });
    this.iceTimer = setTimeout(() => {
      this.iceTimer = null;
      if (this.iceRestarting && this.ws === ws) this.reconnect(ws, 'media_failed', { keepQueued: true });
    }, ICE_RESTART_MS);
  }

  private mediaRecovered(ws: WebSocket) {
    this.clearIceTimer();
    if (!this.iceRestarting || this.ws !== ws) return; // A blip that passed by itself.
    this.iceRestarting = false;
    this.holdInput = false;
    this.diagnostic('media_recovered');
    this.attempt = 0;
    this.issue = null;
    this.setState('live');
    this.inputQueue.flush();
  }

  /** neko's ICE restart offer: the same peer and tracks, a new path for them. */
  private async answerRestart(sdp: string, ws: WebSocket) {
    const pc = this.pc;
    if (!pc || this.ws !== ws) return;
    // The new path's candidates wait until its description is in place, as in answer().
    this.remoteDescriptionReady = false;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      if (this.pc !== pc || this.ws !== ws) return;
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
      if (this.pc === pc && this.ws === ws) throw error;
    }
  }
}
