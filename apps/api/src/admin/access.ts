/**
 * Who may use /admin (page 10, "Operator console"): a user in `admins`, from an allowlisted IP,
 * with a passkey step-up in this sign-in session within the last 30 minutes. Add a Cloudflare WAF
 * rule on the same IPs in front of `/admin*` and `/api/v1/admin*` as a second layer.
 */
import { schema, type Db } from '@cloudbrowser/db';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env.js';
import { problem } from '../problem.js';

const { admins, adminStepUps } = schema;
export const STEP_UP_TTL_MS = 30 * 60_000;

function ipv4(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n);
}

function ipv6(ip: string): bigint | null {
  if (!ip.includes(':')) return null;
  const [head, tail] = ip.split('::') as [string, string | undefined];
  if (ip.split('::').length > 2) return null;
  const a = head ? head.split(':') : [];
  const b = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - a.length - b.length : 0;
  if (fill < 0 || (tail === undefined && a.length !== 8)) return null;
  const groups = [...a, ...Array(fill).fill('0'), ...b];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** True if `ip` matches one entry of a comma-separated list of addresses and CIDR ranges. */
export function ipAllowed(list: string, ip: string): boolean {
  for (const raw of list.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [base, bits] = entry.split('/') as [string, string | undefined];
    const v4 = ipv4(base);
    const fam = v4 !== null ? { want: v4, got: ipv4(ip), size: 32 } : { want: ipv6(base), got: ipv6(ip), size: 128 };
    if (fam.want === null || fam.got === null) continue;
    const prefix = bits === undefined ? fam.size : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > fam.size) continue;
    const shift = BigInt(fam.size - prefix);
    if (fam.want >> shift === fam.got >> shift) return true;
  }
  return false;
}

export async function isAdmin(db: Db, userId: string) {
  const [row] = await db.select({ userId: admins.userId }).from(admins).where(eq(admins.userId, userId));
  return !!row;
}

export async function stepUpUntil(db: Db, sessionId: string): Promise<Date | null> {
  const [row] = await db.select().from(adminStepUps).where(eq(adminStepUps.sessionId, sessionId));
  return row?.verifiedAt ? new Date(row.verifiedAt.getTime() + STEP_UP_TTL_MS) : null;
}

function clientIp(env: Env, header: string | undefined) {
  // cf-connecting-ip is set by Cloudflare; locally (wrangler dev) it is missing.
  return header ?? (env.ENVIRONMENT === 'development' ? '127.0.0.1' : '');
}

/** Admin role and IP allowlist. Unknown callers get 404 so the console's existence is not revealed. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const list = c.env.ADMIN_IP_ALLOWLIST || (c.env.ENVIRONMENT === 'development' ? '127.0.0.1,::1' : '');
  if (!ipAllowed(list, clientIp(c.env, c.req.header('cf-connecting-ip')))) throw problem(404, 'not_found');
  if (!(await isAdmin(c.get('db'), c.get('user').id))) throw problem(404, 'not_found');
  await next();
};

/** A recent passkey step-up in this session (everything except the step-up endpoints themselves). */
export const requireStepUp: MiddlewareHandler<AppEnv> = async (c, next) => {
  const until = await stepUpUntil(c.get('db'), c.get('sessionId'));
  if (!until || until.getTime() <= Date.now()) throw problem(403, 'step_up_required', 'Confirm with your passkey.');
  await next();
};
