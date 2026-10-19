import { keepPreviousData, useMutation, useQuery, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api.js';
import { queryClient } from '../../lib/query.js';
import { money as formatMoney } from '../../lib/money.js';

/** Admin API under /api/v1/admin (page 10). Every query is refetched on window focus like the app. */
export const adminKey = (...parts: unknown[]): QueryKey => ['admin', ...parts];

/** Keep Access login redirects out of JSON parsing and present them as an expired session. */
async function adminApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/admin${path}`, {
    method,
    credentials: 'same-origin',
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.type === 'opaqueredirect' || response.status === 401) {
    throw new ApiError(401, { type: 'unauthenticated', title: 'Your administrator session has expired.', status: 401 });
  }
  if (response.status === 403) throw new ApiError(403, { type: 'forbidden', title: 'You do not have administrator access.', status: 403 });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('The administrator service returned an unreadable response.');
  }
  if (!response.ok) {
    throw new ApiError(response.status, data && typeof data.type === 'string'
      ? data
      : { type: 'internal', title: data?.message ?? response.statusText, status: response.status });
  }
  return data as T;
}

function onAccessExpired(e: unknown) {
  if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
    void queryClient.invalidateQueries({ queryKey: adminKey('/session') });
  }
}

export function useAdmin<T>(path: string, opts: { refetchInterval?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: adminKey(path),
    queryFn: () =>
      adminApi<T>('GET', path).catch((e: unknown) => {
        if (path !== '/session') onAccessExpired(e);
        throw e;
      }),
    refetchInterval: opts.refetchInterval,
    enabled: opts.enabled,
    retry: (n, e) => path !== '/session' && !(e instanceof ApiError && e.status < 500) && n < 2,
  });
}

/** Page sizes for the console's server-paged lists. */
export const ADMIN_PAGE = { alerts: 50, operations: 50, browsers: 50, ledger: 100, findings: 50, users: 50, audit: 100 } as const;

/**
 * One page of a server-paged admin list (`limit`/`offset`). Fetches one row more than it shows
 * to know whether a next page exists. Changing the filters (the path) goes back to page one.
 */
export function useAdminPage<T>(path: string, size: number, opts: { refetchInterval?: number } = {}) {
  const [state, setState] = useState({ path, page: 0 });
  useEffect(() => setState((s) => (s.path === path ? s : { path, page: 0 })), [path]);
  const page = state.path === path ? state.page : 0;
  const url = `${path}${path.includes('?') ? '&' : '?'}limit=${size + 1}&offset=${page * size}`;
  const q = useQuery({
    queryKey: adminKey(url),
    queryFn: () =>
      adminApi<T[]>('GET', url).catch((e: unknown) => {
        onAccessExpired(e);
        throw e;
      }),
    refetchInterval: opts.refetchInterval,
    placeholderData: keepPreviousData,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  return {
    ...q,
    rows: q.data?.slice(0, size),
    pager: { page, hasMore: (q.data?.length ?? 0) > size, onPage: (p: number) => setState({ path, page: p }) },
  };
}

/** A change through the admin API; refreshes every admin query afterwards. */
export function useAdminAction<V>(fn: (v: V) => Promise<unknown>) {
  return useMutation({
    mutationFn: (v: V) =>
      fn(v).catch((e: unknown) => {
        onAccessExpired(e);
        throw e;
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
}

export const post = (path: string, body?: unknown) => adminApi('POST', path, body);
export const put = (path: string, body: unknown) => adminApi('PUT', path, body);
export const del = (path: string, body: unknown) => adminApi('DELETE', path, body);

export type AdminSession = { email: string };

export type Overview = {
  instances: Record<string, number>;
  users: number;
  operations: { unfinished: number; failed24h: number };
  flags: Record<string, { value: string; reason: string | null; updatedAt: string }>;
  findingsOpen: number;
  alertsOpen: number;
  webhooksPending: number;
};

export type AlertRow = {
  id: number;
  source: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
  sentAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
};

export type OperationRow = {
  id: string;
  instanceId: string;
  instanceName: string | null;
  userEmail: string | null;
  kind: string;
  status: string;
  step: string | null;
  attempt: number;
  errorClass: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  notBefore: string | null;
};

export type InstanceRow = {
  id: string;
  name: string;
  status: string;
  regionId: string;
  userEmail: string | null;
  userId: string;
  suspendedAt: string | null;
  updatedAt: string;
  ipAddress: string | null;
};

export type Row = Record<string, unknown>;

export type InstanceDetail = {
  instance: Row & { id: string; name: string; status: string; regionId: string; suspendedAt: string | null; suspendedReason: string | null; statusReason: string | null };
  owner: { id: string; email: string } | null;
  health: Row | null;
  placements: Row[];
  resources: Row[];
  ipAddresses: Row[];
  operations: (Row & { id: string; kind: string; status: string })[];
  audit: (Row & { id: number; actor: string; action: string; createdAt: string; detail: unknown })[];
};

export type UserRow = {
  id: string;
  email: string;
  createdAt: string;
  browsers: number;
  suspended: number;
  /** Total unspent credit, including the held deposits; available + held. */
  balanceMicros: number;
  reservedMicros: number;
  availableMicros: number;
  exhaustedAt: string | null;
  frozenAt: string | null;
  twoFactorEnabled: boolean;
  admin: boolean;
};

type RatesRow = { compute: number; ip: number; storage: number; snapshot: number; transfer: number };

export type PricingOverview = {
  settings: { markupPercent: number; minBalanceMicros: number; lowBalanceMicros: number; paymentFeeBps: number; paymentFeeFixedCents: number };
  regions: {
    regionId: string;
    name: string;
    enabled: boolean;
    executor: string;
    providerRegion: string;
    sheet: { source: string; instanceType: string; instanceTypes: Record<string, number>; rootVolumeGb: number; effectiveDate: string | null } | null;
    fetchedAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    cost: RatesRow | null;
    price: RatesRow | null;
  }[];
  month: {
    month: string;
    revenueMicros: number;
    costMicros: number;
    grossMarginMicros: number;
    byItem: Record<string, { revenueMicros: number; costMicros: number }>;
    topupMicros: number;
    topupGrossMicros: number;
    topups: number;
    refundMicros: number;
    creditMicros: number;
    estimatedFeesMicros: number;
    projectedAwsCents: number | null;
  };
  balances: { totalMicros: number; negativeMicros: number };
};

let timeLocale = 'zh-CN';
/** Dates follow the console's language (see i18n.tsx). */
export const setAdminLocale = (locale: string) => void (timeLocale = locale);
export const when = (iso: unknown) => (typeof iso === 'string' && iso ? new Date(iso).toLocaleString(timeLocale) : '—');
/** Micro-dollars, with enough digits for per-unit rates. */
export const usd = (micros: number) => formatMoney(micros, 'en-US');
