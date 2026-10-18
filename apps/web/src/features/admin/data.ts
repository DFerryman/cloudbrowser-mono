import { useMutation, useQuery, type QueryKey } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api.js';
import { queryClient } from '../../lib/query.js';

/** Admin API under /api/v1/admin (page 10). Every query is refetched on window focus like the app. */
export const adminKey = (...parts: unknown[]): QueryKey => ['admin', ...parts];

/** A call that comes back `step_up_required` sends the console back to the passkey prompt. */
function onStepUpExpired(e: unknown) {
  if (e instanceof ApiError && e.problem.type === 'step_up_required') void queryClient.invalidateQueries({ queryKey: adminKey('/session') });
}

export function useAdmin<T>(path: string, opts: { refetchInterval?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: adminKey(path),
    queryFn: () =>
      api<T>('GET', `/admin${path}`).catch((e: unknown) => {
        onStepUpExpired(e);
        throw e;
      }),
    refetchInterval: opts.refetchInterval,
    enabled: opts.enabled,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
}

/** A change through the admin API; refreshes every admin query afterwards. */
export function useAdminAction<V>(fn: (v: V) => Promise<unknown>) {
  return useMutation({
    mutationFn: (v: V) =>
      fn(v).catch((e: unknown) => {
        onStepUpExpired(e);
        throw e;
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
}

export const post = (path: string, body?: unknown) => api('POST', `/admin${path}`, { body });
export const put = (path: string, body: unknown) => api('PUT', `/admin${path}`, { body });
export const del = (path: string, body: unknown) => api('DELETE', `/admin${path}`, { body });

export type AdminSession = { email: string; passkeys: number; stepUpUntil: string | null };

export type Overview = {
  instances: Record<string, number>;
  users: number;
  operations: { unfinished: number; failed24h: number };
  flags: Record<string, { value: string; reason: string | null; updatedAt: string }>;
  spend: { projectedCents: number; budgetCents: number | null; takenAt: string } | null;
  quotas: { executor: string; region: string; metric: string; limit: number; used: number }[];
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
  backups: Row[];
  audit: (Row & { id: number; actor: string; action: string; createdAt: string; detail: unknown })[];
};

export type UserRow = {
  id: string;
  email: string;
  createdAt: string;
  browsers: number;
  suspended: number;
  subscription: { plan: string; status: string; units: number; revoked: boolean } | null;
  admin: boolean;
};

export const when = (iso: unknown) => (typeof iso === 'string' && iso ? new Date(iso).toLocaleString() : '—');
export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
