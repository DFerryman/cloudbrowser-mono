import type { IceServer } from '@cloudbrowser/contracts';
import type { Env } from './env.js';

/**
 * Short-lived Cloudflare Realtime TURN credentials (page 5). Returns no servers when no TURN key is
 * configured, which only works on networks where direct connections succeed.
 */
export async function turnIceServers(env: Env, ttlSeconds: number): Promise<IceServer[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return [];
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: ttlSeconds }),
  });
  if (!res.ok) throw new Error(`TURN credentials: ${res.status} ${await res.text()}`);
  const { iceServers } = (await res.json()) as { iceServers: IceServer[] };
  // Port 53 is blocked by browsers and only makes ICE wait for a timeout.
  return iceServers
    .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length > 0);
}
