export interface InputTransport {
  readyState: number;
  bufferedAmount?: number;
  send(data: string): void;
}

export type InputFailure = 'overflow' | 'transport' | 'disconnected' | 'relay';

/** One FIFO for every input kind. WebSocket.send order is preserved across backpressure pauses. */
export class InputQueue {
  private readonly pending: { data: string; bytes: number }[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private blocked = false;
  private used = false;

  constructor(private readonly options: {
    transport: () => InputTransport | null;
    ready: () => boolean;
    failed: (reason: InputFailure) => void;
    sent?: (data: string) => void;
    maxEvents?: number;
    maxBytes?: number;
    highWaterBytes?: number;
  }) {}

  enqueue(frame: unknown): boolean {
    if (this.blocked) return false;
    const data = JSON.stringify(frame);
    const bytes = new TextEncoder().encode(data).byteLength;
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
        this.options.sent?.(next.data);
      } catch {
        this.interrupt('transport', true);
        return;
      }
      this.pending.shift();
      this.bytes -= next.bytes;
    }
  }

  /** Interrupted input is never replayed into a replacement connection. */
  interrupt(reason: InputFailure, force = false): void {
    if (this.blocked) return;
    const notify = this.used || force;
    this.clear();
    this.blocked = true;
    if (notify) this.options.failed(reason);
  }

  clear(): void {
    this.cancelTimer();
    this.pending.length = 0;
    this.bytes = 0;
    this.used = false;
  }

  resume(): void {
    this.blocked = false;
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
