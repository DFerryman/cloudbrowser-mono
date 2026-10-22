import { WebSocket } from 'ws';
import {
  AUTOMATION_LIMITS,
  type AutomationRequest,
  type AutomationResponse,
  type ControlState,
  type GatewayToAutomation,
} from '@cloudbrowser/contracts';

/**
 * The bridge's connection to the session gateway (docs/agent-access.md): one WebSocket carrying
 * the automation protocol. It reconnects with backoff, reassembles screenshot blobs, and resolves
 * each request by its id. One request is in flight at a time, so the coding agent's loop stays
 * ordered; cancellation and status are the exceptions and go out immediately.
 */

export type ScreenshotImage = { base64: string; mime: 'image/jpeg'; width: number; height: number; id: string; capturedAt: string };
export type RequestOutcome = { result: Extract<AutomationResponse, { t: 'result' }>; image?: ScreenshotImage };

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
const REQUEST_TIMEOUT_MS = AUTOMATION_LIMITS.maxActMs + 15_000;

type Pending = {
  resolve: (outcome: RequestOutcome) => void;
  reject: (error: Error) => void;
  blobs: Map<string, string[]>;
  timer: ReturnType<typeof setTimeout>;
  wantsBlob?: string;
};

export interface BridgeClientOptions {
  gatewayUrl: string;
  credential: string;
  onLog?: (line: string) => void;
  onControl?: (control: ControlState) => void;
  WebSocketImpl?: typeof WebSocket;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private ready: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly fileHandlers = new Map<string, (frame: Extract<AutomationResponse, { t: 'file' }>) => void>();
  private connected = false;
  private agentOnline = false;
  control: ControlState = { controller: 'none', mode: 'agent', epoch: 0 };

  constructor(private readonly opts: BridgeClientOptions) {}

  private log(line: string) {
    this.opts.onLog?.(line);
  }

  /** Connects and resolves once the gateway's welcome arrives. */
  async connect(): Promise<void> {
    this.stopped = false;
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    this.openSocket();
    await this.ready;
  }

  private openSocket() {
    if (this.stopped) return;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new WS(this.opts.gatewayUrl, { headers: { authorization: `Bearer ${this.opts.credential}` } });
    this.ws = ws;
    ws.on('open', () => { this.attempt = 0; this.log('connected to the gateway'); });
    ws.on('message', (data: Buffer | string) => this.onFrame(typeof data === 'string' ? data : data.toString('utf8')));
    ws.on('close', (code: number) => this.onClose(code));
    ws.on('error', (err: Error) => this.log(`gateway socket error: ${err.message}`));
  }

  private onClose(code: number) {
    this.connected = false;
    this.agentOnline = false;
    if (this.ws) this.ws = null;
    // A revoked or unauthorized connection must not reconnect in a loop.
    if (code === 4003 || code === 4001 || code === 1008) {
      this.failAll(new Error(code === 4001 ? 'another bridge connected to this browser' : 'the gateway ended this session (access was revoked or turned off)'));
      this.stopped = true;
      return;
    }
    this.failAll(new Error('disconnected from the gateway'));
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.log(`reconnecting in ${delay} ms`);
    setTimeout(() => this.openSocket(), delay);
  }

  private failAll(error: Error) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  close() {
    this.stopped = true;
    this.failAll(new Error('bridge stopped'));
    this.ws?.close();
    this.ws = null;
  }

  get status() {
    return { connected: this.connected, agentOnline: this.agentOnline, control: this.control };
  }

  private onFrame(raw: string) {
    let frame: GatewayToAutomation;
    try {
      frame = JSON.parse(raw) as GatewayToAutomation;
    } catch {
      return;
    }
    switch (frame.t) {
      case 'welcome':
        this.connected = true;
        this.control = { controller: 'none', mode: frame.mode, epoch: this.control.epoch };
        this.log(`session ${frame.sessionId} open (mode: ${frame.mode})`);
        this.resolveReady?.();
        this.resolveReady = null;
        return;
      case 'agent_online': this.agentOnline = true; return;
      case 'agent_offline': this.agentOnline = false; return;
      case 'control':
        this.control = frame.control;
        this.opts.onControl?.(frame.control);
        return;
      case 'screen':
        return;
      case 'revoked':
        this.failAll(new Error(`the gateway ended this session: ${frame.reason}`));
        this.stopped = true;
        this.ws?.close();
        return;
      case 'refused': {
        const p = this.pending.get(frame.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(frame.id); p.reject(new Error(`refused: ${frame.reason}`)); }
        return;
      }
      case 'blob': {
        const p = [...this.pending.values()].find((q) => q.wantsBlob === undefined || q.wantsBlob === frame.id) ?? this.blobOwner(frame.id);
        if (!p) return;
        p.wantsBlob = frame.id;
        const parts = p.blobs.get(frame.id) ?? [];
        parts[frame.seq] = frame.data;
        p.blobs.set(frame.id, parts);
        return;
      }
      case 'result': {
        const p = this.pending.get(frame.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(frame.id);
        this.control = frame.control;
        let image: ScreenshotImage | undefined;
        if (frame.screenshot) {
          const parts = p.blobs.get(frame.screenshot.blobId) ?? [];
          image = { base64: parts.join(''), mime: 'image/jpeg', width: frame.screenshot.width, height: frame.screenshot.height, id: frame.screenshot.id, capturedAt: frame.screenshot.capturedAt };
        }
        p.resolve({ result: frame, image });
        return;
      }
      case 'file': {
        const handler = this.fileHandlers.get(frame.id);
        if (handler) handler(frame);
        return;
      }
    }
  }

  private blobOwner(blobId: string): Pending | undefined {
    for (const p of this.pending.values()) if (p.blobs.has(blobId)) return p;
    return undefined;
  }

  private sendRaw(frame: AutomationRequest) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('not connected to the gateway');
    this.ws.send(JSON.stringify(frame));
  }

  /** Sends a request and resolves with its result; screenshot bytes are reassembled into `image`. */
  request(frame: Extract<AutomationRequest, { id: string }>): Promise<RequestOutcome> {
    return new Promise<RequestOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.id);
        reject(new Error('the browser did not answer in time'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(frame.id, { resolve, reject, blobs: new Map(), timer });
      try {
        this.sendRaw(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(frame.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Fire-and-forget (cancel): no result is awaited. */
  send(frame: AutomationRequest) {
    this.sendRaw(frame);
  }

  onFile(id: string, handler: (frame: Extract<AutomationResponse, { t: 'file' }>) => void) {
    this.fileHandlers.set(id, handler);
  }
  offFile(id: string) {
    this.fileHandlers.delete(id);
  }
}
