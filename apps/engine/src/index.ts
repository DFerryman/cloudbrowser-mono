/**
 * The engine Worker. Two deployments share this code (page 2):
 *  - worker mode (wrangler.jsonc): consumes the `cloudbrowser-operations` queue and runs each
 *    operation; a 1-minute cron is the safety net (lost messages, expired leases), puts idle
 *    browsers to sleep and runs the 5-minute IP checks. It also hosts the EventHub Durable Object.
 *  - reaper mode (wrangler.reaper.jsonc): the only deleter, every 15 minutes.
 * Neither deployment has a public URL.
 */
import type { OperationMessage } from '@cloudbrowser/db';
import { makeDeps, type Env } from './deps.js';
import { reaperTick } from './reaper.js';
import { runOperation } from './runner.js';
import { meterUsage, reclaimTrials } from './metering.js';
import { refreshPrices } from './prices.js';
import { enforceStoppedIntent } from './enforce-stopped.js';
import { checkInstanceIp, idleStops, periodicIpChecks, runPending } from './scheduler.js';
import { errorMessages } from './errors.js';

export type { Env } from './deps.js';
export { EventHub } from './event-hub.js';
export { runOperation } from './runner.js';
export { reaperTick } from './reaper.js';
export { runPending, idleStops, checkInstanceIp } from './scheduler.js';
export { meterUsage, reclaimTrials } from './metering.js';
export { refreshPrices } from './prices.js';
export type { EngineDeps } from './context.js';

/** Queues accept delays up to 12 hours; longer waits are picked up by the cron sweep. */
const MAX_DELAY_S = 12 * 3600;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  /** Service binding from the api: synchronous IP checks, and a price refresh from the operator console. */
  async fetch(req, env, ctx) {
    const deps = makeDeps(env, (p) => ctx.waitUntil(p));
    const url = new URL(req.url);
    if (deps.mode !== 'worker') return json({ error: 'not found' }, 404);
    const ipCheck = url.pathname.match(/^\/instances\/([^/]+)\/ip-check$/);
    if (req.method === 'POST' && ipCheck) {
      const result = await checkInstanceIp(deps, ipCheck[1]!);
      return result ? json(result) : json({ error: 'not running' }, 409);
    }
    if (req.method === 'POST' && url.pathname === '/prices/refresh') return json(await refreshPrices(deps, { force: true }));
    return json({ error: 'not found' }, 404);
  },

  /** One message per operation. A deferred operation is re-enqueued with a delay (backoff, capacity waits). */
  async queue(batch, env, ctx) {
    const deps = makeDeps(env, (p) => ctx.waitUntil(p));
    for (const msg of batch.messages) {
      try {
        const r = await runOperation(deps, msg.body.operationId);
        if (r.state === 'deferred' && env.OPERATIONS) {
          const delaySeconds = Math.ceil((r.notBefore.getTime() - Date.now()) / 1000);
          if (delaySeconds <= MAX_DELAY_S) await env.OPERATIONS.send(msg.body, { delaySeconds: Math.max(1, delaySeconds) });
        }
        // `busy` means another worker holds the lease or the operation is not due; the holder or
        // the cron sweep finishes it.
        msg.ack();
      } catch (e) {
        console.error('operation run failed', msg.body.operationId, e);
        msg.retry({ delaySeconds: 10 });
      }
    }
  },

  async scheduled(controller, env, ctx) {
    try {
      const deps = makeDeps(env, (p) => ctx.waitUntil(p));
      if (deps.mode === 'reaper') {
        console.log('reaper', JSON.stringify(await reaperTick(deps)));
        return;
      }
      await idleStops(deps);
      // Four-minute settlement leaves one cron tick of headroom under the five-minute billing cap.
      await meterUsage(deps, { minIntervalMs: 4 * 60_000 });
      await reclaimTrials(deps);
      await runPending(deps);
      const minute = new Date(controller.scheduledTime).getUTCMinutes();
      if (minute % 5 === 0) {
        await periodicIpChecks(deps);
        await enforceStoppedIntent(deps);
      }
      // Cheap when prices are fresh: only stale regions (older than 12 hours) are read from the provider.
      await refreshPrices(deps).catch((e) => console.error('price refresh failed', e));
    } catch (error) {
      console.error('engine scheduled task failed', JSON.stringify({
        cron: controller.cron, scheduledTime: controller.scheduledTime, errors: errorMessages(error),
      }));
      throw error;
    }
  },
} satisfies ExportedHandler<Env, OperationMessage>;
