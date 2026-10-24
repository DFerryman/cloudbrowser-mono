import type { IceServer } from '@cloudbrowser/contracts';
import type { Env } from './env.js';

/** The TURN API normally answers within a second; a viewer is not kept waiting much longer. */
const TURN_API_TIMEOUT_MS = 5_000;

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
    signal: AbortSignal.timeout(TURN_API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TURN credentials: ${res.status} ${await res.text()}`);
  const { iceServers } = (await res.json()) as { iceServers: IceServer[] };
  // Port 53 is blocked by browsers and only makes ICE wait for a timeout.
  return iceServers
    .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length > 0);
}

/**
 * Viewers in China reach Cloudflare's relay in London or Seattle over a lossy UDP path: their
 * picture is frozen 7-9% of the time while frames wait for resends, against under 1% elsewhere.
 * Half of their view sessions are offered only the TCP and TLS relay addresses, so the two halves'
 * live-quality reports can be compared (docs/connection-diagnostics.md, "Relay transport test").
 */
const TCP_RELAY_TEST_COUNTRIES = new Set(['CN']);

/**
 * Whether a viewer session is in the TCP half of the relay transport test: the viewer is in a
 * test country and the session id's last character, read as a base-36 digit, is odd (for the hex
 * ids the web app uses, 1 3 5 7 9 b d f). The same session stays in the same half when it reconnects.
 */
export function inTcpRelayTest(sessionId: string, country: string | undefined): boolean {
  return !!country && TCP_RELAY_TEST_COUNTRIES.has(country) && parseInt(sessionId.slice(-1), 36) % 2 === 1;
}

/** Only the relay addresses reached over TCP or TLS; all of them when Cloudflare offered none. */
export function tcpRelayServers(servers: IceServer[]): IceServer[] {
  const tcp = servers
    .map((s) => ({ ...s, urls: s.urls.filter((u) => u.startsWith('turns:') || (u.startsWith('turn:') && /[?&]transport=tcp(&|$)/.test(u))) }))
    .filter((s) => s.urls.length > 0);
  return tcp.length ? tcp : servers;
}
