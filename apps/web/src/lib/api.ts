import type { Problem } from '@cloudbrowser/contracts';

/** A problem+json error from the api, with its stable `type` code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
    /** Better Auth's error code (`/api/auth/*`), e.g. INVALID_CODE. */
    readonly code?: string,
  ) {
    super(problem.detail ?? problem.title);
  }
}

type Options = { body?: unknown; idempotent?: boolean; idempotencyKey?: string; signal?: AbortSignal };

/**
 * All data comes from /api/v1 on the same origin; the session cookie is HttpOnly. Lifecycle
 * actions send an Idempotency-Key so a retried click never creates a second operation.
 */
export async function api<T>(method: string, path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  else if (opts.idempotent) headers['idempotency-key'] = crypto.randomUUID();
  const res = await fetch(path.startsWith('/api/') ? path : `/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const problem: Problem =
      data && typeof data.type === 'string'
        ? data
        : { type: 'internal', title: data?.message ?? res.statusText, status: res.status };
    throw new ApiError(res.status, problem, typeof data?.code === 'string' ? data.code : undefined);
  }
  return data as T;
}

export const isUnauthenticated = (e: unknown) => e instanceof ApiError && e.status === 401;
