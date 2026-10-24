export interface InputTransport {
  readyState: number;
  bufferedAmount?: number;
  send(data: string): void;
}

export type InputFailure = 'overflow' | 'transport' | 'disconnected' | 'relay';

/**
 * Input handed to the socket this long before it closed has reached the gateway and been relayed
 * (or refused, which the gateway reports with `input_error`). A connection that drops after a
 * quiet spell lost nothing, so it reconnects without asking the user. Where the gateway confirms
 * what it received (acknowledge), a confirmation settles input sooner, and input sent into a
 * socket that died without closing stays unsettled however long the close takes to arrive.
 */
const SETTLED_MS = 10_000;
const encoder = new TextEncoder();

/** One FIFO for every input kind. WebSocket.send order is preserved across backpressure pauses. */
export class InputQueue {
  private readonly pending: { data: string; bytes: number }[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private blocked = false;
  private used = false;
  /** When input was last handed to the transport; queued input is at risk by being queued. */
  private lastSentAt = -Infinity;
  /** Frames handed to this transport, and how many of them the gateway confirmed it received. */
  private sentFrames = 0;
  private confirmedFrames = 0;
  /** The gateway confirmed something on this transport: confirmations, not time, settle input. */
  private confirming = false;

  constructor(private readonly options: {
    transport: () => InputTransport | null;
    ready: () => boolean;
    failed: (reason: InputFailure) => void;
    sent?: (data: string) => void;
    /** A key or button is down on the remote: a lost release would leave it stuck. */
    held?: () => boolean;
    settledMs?: number;
    maxEvents?: number;
    maxBytes?: number;
    highWaterBytes?: number;
  }) {}

  enqueue(frame: unknown): boolean {
    if (this.blocked) return false;
    const data = JSON.stringify(frame);
    const bytes = encoder.encode(data).byteLength;
    if (this.pending.length >= (this.options.maxEvents ?? 4096) || this.bytes + bytes > (this.options.maxBytes ?? 1024 * 1024)) {
      this.interrupt('overflow', true);
      return false;
    }
    this.used = true;
    this.pending.push({ data, bytes });
    this.bytes += bytes;
    this.flush();
    return true;
  }

  flush(): void {
    this.cancelTimer();
    if (this.blocked || !this.options.ready()) return;
    const transport = this.options.transport();
    if (!transport || transport.readyState !== 1) {
      this.interrupt('transport');
      return;
    }
    while (this.pending.length) {
      if ((transport.bufferedAmount ?? 0) >= (this.options.highWaterBytes ?? 256 * 1024)) {
        this.timer = setTimeout(() => this.flush(), 10);
        return;
      }
      const next = this.pending[0]!;
      try {
        transport.send(next.data);
        this.sentFrames++;
        this.lastSentAt = Date.now();
        this.options.sent?.(next.data);
      } catch {
        this.interrupt('transport', true);
        return;
      }
      this.pending.shift();
      this.bytes -= next.bytes;
    }
  }

  /** Input not yet handed to the transport. */
  get queued(): number {
    return this.pending.length;
  }

  /** Frames handed to the transport so far: a ping sent now confirms them all when its pong arrives. */
  get sent(): number {
    return this.sentFrames;
  }

  /** Whether frames were handed to the transport since the last confirmation. */
  get unconfirmed(): boolean {
    return this.sentFrames > this.confirmedFrames;
  }

  /** The gateway received the first `frames` frames: the pong to a ping sent after them on the same ordered socket. */
  acknowledge(frames: number): void {
    this.confirming = true;
    this.confirmedFrames = Math.max(this.confirmedFrames, Math.min(frames, this.sentFrames));
  }

  /**
   * Interrupted input is never replayed into a replacement connection. The user is told only when
   * input may have been lost: something was still queued, sent but not settled, or held down.
   * `beyondGateway`: the failure is past the gateway (the VM's relay), where the gateway's
   * confirmations prove nothing and only the time since the input settles it. `keepQueued`: input
   * never handed to this transport (held while the connection was checked) is kept for the next
   * connection instead of counting as lost; true is returned when it was kept.
   */
  interrupt(reason: InputFailure, force = false, options: { beyondGateway?: boolean; keepQueued?: boolean } = {}): boolean {
    if (this.blocked) return false;
    const recent = Date.now() - this.lastSentAt < (this.options.settledMs ?? SETTLED_MS);
    const unsettled = options.beyondGateway || !this.confirming ? recent : this.unconfirmed;
    const sentAtRisk = unsettled || (this.options.held?.() ?? false);
    if (!force && options.keepQueued && !sentAtRisk && this.pending.length > 0) {
      // Nothing was lost: the queued input waits for the next connection, as input made while connecting does.
      this.cancelTimer();
      this.sentFrames = this.confirmedFrames = 0;
      this.lastSentAt = -Infinity;
      this.confirming = false;
      return true;
    }
    const notify = force || (this.used && (sentAtRisk || this.pending.length > 0));
    this.clear();
    this.blocked = true;
    if (notify) this.options.failed(reason);
    return false;
  }

  clear(): void {
    this.cancelTimer();
    this.pending.length = 0;
    this.bytes = 0;
    this.used = false;
    this.lastSentAt = -Infinity;
    this.sentFrames = 0;
    this.confirmedFrames = 0;
    this.confirming = false;
  }

  resume(): void {
    this.blocked = false;
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
