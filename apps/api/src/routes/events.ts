import { schema } from '@cloudbrowser/db';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../env.js';

const { events } = schema;

const POLL_MS = 1_500;
const PING_MS = 15_000;
/** Streams end after a few minutes; EventSource reconnects and resumes with Last-Event-ID. */
const STREAM_MS = 5 * 60_000;

/**
 * GET /v1/events: instance status, operation progress and entitlement changes (page 1, "Live
 * updates"). Reads the `events` change feed, which stands in for PostgreSQL LISTEN/NOTIFY.
 */
export const eventsRoute = new Hono<AppEnv>().get('/events', async (c) => {
  const db = c.get('db');
  const userId = c.get('user').id;
  const resumeFrom = Number(c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? NaN);

  let cursor: number;
  if (Number.isFinite(resumeFrom)) {
    cursor = resumeFrom;
  } else {
    const [last] = await db.select({ id: events.id }).from(events).where(eq(events.userId, userId)).orderBy(desc(events.id)).limit(1);
    cursor = last?.id ?? 0;
  }

  c.header('cache-control', 'no-store');
  c.header('x-accel-buffering', 'no');
  return streamSSE(c, async (stream) => {
    let open = true;
    stream.onAbort(() => {
      open = false;
    });
    const started = Date.now();
    let lastWrite = Date.now();
    await stream.writeSSE({ event: 'ready', data: '{}', id: String(cursor), retry: 3000 });
    while (open && Date.now() - started < STREAM_MS) {
      const rows = await db
        .select()
        .from(events)
        .where(and(eq(events.userId, userId), gt(events.id, cursor)))
        .orderBy(asc(events.id))
        .limit(100);
      for (const r of rows) {
        await stream.writeSSE({ id: String(r.id), event: r.type, data: JSON.stringify(r.data) });
        cursor = r.id;
        lastWrite = Date.now();
      }
      if (Date.now() - lastWrite > PING_MS) {
        await stream.write(': ping\n\n');
        lastWrite = Date.now();
      }
      await stream.sleep(POLL_MS);
    }
  });
});
