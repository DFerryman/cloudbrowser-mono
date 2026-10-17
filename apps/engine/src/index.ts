/**
 * The engine Worker. Two deployments share this code (page 2):
 *  - worker mode (wrangler.jsonc): runs operations; triggered by the api over a service binding
 *    right after it enqueues one, and every minute by cron as a safety net.
 *  - reaper mode (wrangler.reaper.jsonc): the only deleter, every 15 minutes.
 * Neither deployment has a public URL.
 */
import { makeDeps, type Env } from './deps.js';
import { reaperTick } from './reaper.js';
import { runUntilSettled } from './runner.js';
import { checkInstanceIp, idleStops, periodicIpChecks, runPending } from './scheduler.js';

export type { Env } from './deps.js';
export { runOperation, runUntilSettled } from './runner.js';
export { reaperTick } from './reaper.js';
export { runPending, idleStops, checkInstanceIp } from './scheduler.js';
export type { EngineDeps } from './context.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req, env, ctx) {
    const deps = makeDeps(env);
    const url = new URL(req.url);
    if (deps.mode !== 'worker') return json({ error: 'not found' }, 404);

    const run = url.pathname.match(/^\/operations\/([^/]+)\/run$/);
    if (req.method === 'POST' && run) {
      ctx.waitUntil(runUntilSettled(deps, run[1]!).catch((e) => console.error('run failed', e)));
      return json({ accepted: true }, 202);
    }
    const ipCheck = url.pathname.match(/^\/instances\/([^/]+)\/ip-check$/);
    if (req.method === 'POST' && ipCheck) {
      const result = await checkInstanceIp(deps, ipCheck[1]!);
      return result ? json(result) : json({ error: 'not running' }, 409);
    }
    return json({ error: 'not found' }, 404);
  },

  async scheduled(controller, env) {
    const deps = makeDeps(env);
    if (deps.mode === 'reaper') {
      console.log('reaper', JSON.stringify(await reaperTick(deps)));
      return;
    }
    await idleStops(deps);
    await runPending(deps);
    if (new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0) await periodicIpChecks(deps);
  },
} satisfies ExportedHandler<Env>;
