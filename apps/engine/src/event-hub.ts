import { DurableObject } from 'cloudflare:workers';
import type { Env } from './deps.js';

type Client = { writer: WritableStreamDefaultWriter<Uint8Array>; cursor: number; chain: Promise<void>; closed: boolean };
type Row = { id: number; type: string; data: string };

const PING_MS = 15_000;
/** Streams end after a few minutes; EventSource reconnects and resumes with Last-Event-ID. */
const STREAM_MS = 5 * 60_000;
const encoder = new TextEncoder();

/**
 * One Durable Object per user fans out SSE (stands in for PostgreSQL LISTEN/NOTIFY, page 2).
 * The `events` table in D1 stays the durable feed, so a reconnect resumes from Last-Event-ID;
 * writers (api and engine) call /notify after committing, and every open stream reads the new rows.
 * Each ping also re-reads the feed, so a lost notify delays an update by at most 15 s.
 *
 * It lives in the engine Worker because the engine writes most events and deploys first; the api
 * reaches it through a cross-script Durable Object binding.
 */
export class EventHub extends DurableObject<Env> {
  private clients = new Set<Client>();
  private userId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.userId = url.searchParams.get('userId') ?? this.userId;
    if (url.pathname === '/notify') {
      await Promise.all([...this.clients].map((c) => this.flush(c)));
      return new Response(null, { status: 204 });
    }
    if (url.pathname !== '/stream' || !this.userId) return new Response('not found', { status: 404 });

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const client: Client = { writer: writable.getWriter(), cursor: await this.startCursor(url), chain: Promise.resolve(), closed: false };
    this.clients.add(client);
    this.write(client, `retry: 3000\nid: ${client.cursor}\nevent: ready\ndata: {}\n\n`);
    void this.flush(client);
    setTimeout(() => this.close(client), STREAM_MS);
    this.timer ??= setInterval(() => this.tick(), PING_MS);

    return new Response(readable, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    });
  }

  private async startCursor(url: URL): Promise<number> {
    const resume = Number(url.searchParams.get('lastEventId') ?? NaN);
    if (Number.isFinite(resume)) return resume;
    const last = await this.env.DB.prepare('SELECT max(id) AS id FROM events WHERE user_id = ?').bind(this.userId).first<{ id: number | null }>();
    return last?.id ?? 0;
  }

  private tick() {
    for (const c of this.clients) {
      this.write(c, ': ping\n\n');
      void this.flush(c);
    }
    if (this.clients.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Sends the client every event after its cursor. Serialized per client, so nothing is sent twice. */
  private flush(c: Client): Promise<void> {
    c.chain = c.chain.then(async () => {
      if (c.closed) return;
      const { results } = await this.env.DB.prepare('SELECT id, type, data FROM events WHERE user_id = ? AND id > ? ORDER BY id LIMIT 100')
        .bind(this.userId, c.cursor)
        .all<Row>();
      for (const r of results) {
        this.write(c, `id: ${r.id}\nevent: ${r.type}\ndata: ${r.data}\n\n`);
        c.cursor = r.id;
      }
    });
    return c.chain.catch((e) => console.error('event flush failed', e));
  }

  private write(c: Client, text: string) {
    if (c.closed) return;
    c.writer.write(encoder.encode(text)).catch(() => this.close(c));
  }

  private close(c: Client) {
    if (c.closed) return;
    c.closed = true;
    this.clients.delete(c);
    c.writer.close().catch(() => {});
  }
}
