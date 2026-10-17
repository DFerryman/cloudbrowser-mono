import { Hono } from 'hono';
import type { AppEnv } from '../env.js';

/**
 * GET /v1/events: instance status, operation progress and entitlement changes (page 1, "Live
 * updates"). The stream is served by the user's EventHub Durable Object, which replays the
 * `events` feed after Last-Event-ID and pushes new rows as writers notify it.
 */
export const eventsRoute = new Hono<AppEnv>().get('/events', async (c) => {
  const userId = c.get('user').id;
  const hub = c.env.EVENT_HUB.get(c.env.EVENT_HUB.idFromName(userId));
  const url = new URL('https://hub/stream');
  url.searchParams.set('userId', userId);
  const resume = c.req.header('last-event-id') ?? c.req.query('lastEventId');
  if (resume && /^\d+$/.test(resume)) url.searchParams.set('lastEventId', resume);
  return hub.fetch(url.toString(), { signal: c.req.raw.signal });
});
