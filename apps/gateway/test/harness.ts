/** Stand-ins for the Durable Object runtime: hibernating sockets, upgrade responses and state. */
import { createHash } from 'node:crypto';

export class Socket {
  static OPEN = 1;
  readyState = 0;
  attachment: unknown = null;
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(frame: string) {
    if (this.readyState !== Socket.OPEN) throw new Error('socket closed');
    this.sent.push(JSON.parse(frame));
  }
  close(code?: number, reason?: string) { this.readyState = 3; this.closed = { code, reason }; }
  serializeAttachment(value: unknown) {
    if (this.readyState !== Socket.OPEN) throw new Error('accept the socket first');
    this.attachment = value;
  }
  deserializeAttachment() { return this.attachment; }
}

const NativeResponse = Response;
export class UpgradeResponse extends NativeResponse {
  webSocket?: Socket;
  constructor(body: BodyInit | null, init: ResponseInit & { webSocket?: Socket } = {}) {
    super(body, { ...init, status: init.status === 101 ? 200 : init.status });
    if (init.status === 101) Object.defineProperty(this, 'status', { value: 101 });
    this.webSocket = init.webSocket;
  }
}

/** Storage keeps copies, as the runtime's does: a test that makes a new object sees only what was put. */
export function state() {
  const storage = new Map<string, unknown>();
  const sockets: { ws: Socket; tags: string[] }[] = [];
  const pending: Promise<unknown>[] = [];
  return {
    storage: {
      get: async (key: string) => structuredClone(storage.get(key)),
      put: async (key: string, value: unknown) => void storage.set(key, structuredClone(value)),
      delete: async (key: string) => storage.delete(key),
      setAlarm: async (at: number) => void storage.set('alarm', at),
      getAlarm: async () => (storage.get('alarm') as number | undefined) ?? null,
    },
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws: Socket, tags: string[]) { ws.readyState = Socket.OPEN; sockets.push({ ws, tags }); },
    getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
    waitUntil(p: Promise<unknown>) { pending.push(p); },
    /** Waits for everything handed to waitUntil, including work that work started. */
    async settle() {
      for (let done = 0; done < pending.length;) {
        const batch = pending.slice(done);
        done = pending.length;
        await Promise.all(batch);
      }
    },
  };
}

/** workerd's `crypto.DigestStream`, which Node lacks: a writable stream that hashes what it is given. */
export function installDigestStream() {
  class DigestStream extends WritableStream<ArrayBufferView | ArrayBuffer> {
    readonly digest: Promise<ArrayBuffer>;
    constructor(algorithm: string) {
      const hash = createHash(algorithm.replace('-', '').toLowerCase());
      let resolve!: (digest: ArrayBuffer) => void;
      const digest = new Promise<ArrayBuffer>((r) => { resolve = r; });
      super({
        write(chunk) { hash.update(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); },
        close() { const out = hash.digest(); resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)); },
      });
      this.digest = digest;
    }
  }
  Object.defineProperty(globalThis.crypto, 'DigestStream', { value: DigestStream, configurable: true });
}
