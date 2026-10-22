/** Stand-ins for the Durable Object runtime: hibernating sockets, upgrade responses and state. */

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

export function state() {
  const storage = new Map<string, unknown>();
  const sockets: { ws: Socket; tags: string[] }[] = [];
  const pending: Promise<unknown>[] = [];
  return {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
      setAlarm: async (at: number) => void storage.set('alarm', at),
    },
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws: Socket, tags: string[]) { ws.readyState = Socket.OPEN; sockets.push({ ws, tags }); },
    getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
    waitUntil(p: Promise<unknown>) { pending.push(p); },
    settle: () => Promise.all(pending),
  };
}
