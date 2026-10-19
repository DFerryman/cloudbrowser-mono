import type { Context } from 'hono';

/**
 * `?limit=&offset=` for list endpoints. Without them a list returns its first `size` rows, as it
 * always did. Clients that page ask for one row more than they show to learn whether another
 * page exists, so no count query is needed.
 */
export function pageQuery(c: Context, size: number, max = 500) {
  const int = (v: string | undefined) => (v !== undefined && /^\d{1,7}$/.test(v) ? Number(v) : undefined);
  const limit = Math.min(max, Math.max(1, int(c.req.query('limit')) ?? size));
  const offset = Math.min(1_000_000, int(c.req.query('offset')) ?? 0);
  return { limit, offset };
}
