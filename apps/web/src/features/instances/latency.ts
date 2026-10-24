import { useEffect, useState } from 'react';

const CACHE_KEY = 'nevazu.latency.v1';
const CACHE_MS = 10 * 60_000;

type Cached = Record<string, { ms: number; at: number }>;
export function readLatencyCache(): Cached {
  try {
    const all = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? '{}') as Cached;
    return Object.fromEntries(Object.entries(all).filter(([, v]) => Date.now() - v.at < CACHE_MS));
  } catch {
    return {};
  }
}
export function writeLatencyCache(id: string, ms: number) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ...readLatencyCache(), [id]: { ms, at: Date.now() } }));
  } catch {
    // Storage may be unavailable (private mode); the measurement is simply repeated next time.
  }
}

/** Round trip to a region's ping endpoint. The first request also opens the connection, so it is not counted. */
export async function measureLatency(url: string): Promise<number | null> {
  const samples: number[] = [];
  for (let n = 0; n < 3; n++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4_000);
    const start = performance.now();
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      samples.push(performance.now() - start);
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  const warm = samples.slice(1);
  return warm.length ? Math.round(Math.min(...warm)) : null;
}

/**
 * The user's round trip to one region the way web pages travel (through any VPN or proxy):
 * measured here or by the region picker in the last ten minutes, else the api's estimate.
 */
export function useRegionLatency(region: { id: string; probeUrl?: string | null; estimatedRttMs?: number | null }, active: boolean): number | null {
  const [measured, setMeasured] = useState<number | null>(() => readLatencyCache()[region.id]?.ms ?? null);
  useEffect(() => {
    const cached = readLatencyCache()[region.id]?.ms;
    if (cached !== undefined) {
      setMeasured(cached);
      return;
    }
    setMeasured(null);
    if (!active || !region.probeUrl) return;
    let cancelled = false;
    void measureLatency(region.probeUrl).then((ms) => {
      if (cancelled || ms === null) return;
      writeLatencyCache(region.id, ms);
      setMeasured(ms);
    });
    return () => {
      cancelled = true;
    };
  }, [region.id, region.probeUrl, active]);
  return measured ?? (typeof region.estimatedRttMs === 'number' ? region.estimatedRttMs : null);
}
