import type { Accepted, Backup, CreateInstanceBody, Instance, InstanceStorage, InstanceUsage, IpCheck, Me, Region } from '@cloudbrowser/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { keys, queryClient } from '../../lib/query.js';
import { refreshChangedPrices } from '../billing/hooks.js';

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<Me>('GET', '/me') });
export const useRegions = () => useQuery({ queryKey: keys.regions, queryFn: () => api<Region[]>('GET', '/regions'), staleTime: 60_000 });
export const useInstances = () => useQuery({ queryKey: keys.instances, queryFn: () => api<Instance[]>('GET', '/instances') });
export const useInstance = (id: string) =>
  useQuery({ queryKey: keys.instance(id), queryFn: () => api<Instance>('GET', `/instances/${id}`) });

export type RecentSession = { id: string; startedAt: string; endedAt: string | null; country: string | null; userAgent: string | null };
export const useRecentSessions = (id: string) =>
  useQuery({ queryKey: keys.sessions(id), queryFn: () => api<RecentSession[]>('GET', `/instances/${id}/sessions`) });

export const useBackups = (id: string) =>
  useQuery({ queryKey: keys.backups(id), queryFn: () => api<Backup[]>('GET', `/instances/${id}/backups`) });

export const useStorage = (id: string) =>
  useQuery({ queryKey: keys.storage(id), queryFn: () => api<InstanceStorage>('GET', `/instances/${id}/storage`), refetchInterval: 30_000 });

export const useInstanceUsage = (id: string, month: string) =>
  useQuery({ queryKey: keys.instanceUsage(id, month), queryFn: () => api<InstanceUsage>('GET', `/instances/${id}/usage?month=${month}`), refetchInterval: 60_000 });

const refresh = (instanceId?: string) => {
  void queryClient.invalidateQueries({ queryKey: keys.instances });
  void queryClient.invalidateQueries({ queryKey: keys.me });
  void queryClient.invalidateQueries({ queryKey: keys.billing });
  // keys.instance(id) is the prefix of the browser's storage, backups and usage queries too.
  if (instanceId) void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId) });
};

/**
 * Lifecycle actions send an Idempotency-Key and wait for the server's state (SSE); the UI never
 * shows a state the backend has not reached.
 */
export function useLifecycle() {
  return useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: 'start' | 'stop' | 'undelete' | 'delete'; body?: unknown } | { id: string; action: 'ip-change'; body: { priceVersion: string } }) => {
      if (action === 'delete') return api<Accepted>('DELETE', `/instances/${id}`, { idempotent: true });
      if (action === 'ip-change') return api<Accepted>('POST', `/instances/${id}/ip-change-requests`, { idempotent: true, body: { confirm: true, ...body } });
      return api<Accepted>('POST', `/instances/${id}/${action}`, { idempotent: true, body });
    },
    onError: refreshChangedPrices,
    onSettled: (_d, _e, v) => refresh(v.id),
  });
}

export function useCreateInstance() {
  return useMutation({
    mutationFn: (body: CreateInstanceBody) =>
      api<Accepted>('POST', '/instances', { idempotent: true, body }),
    onError: refreshChangedPrices,
    onSettled: () => refresh(),
  });
}

/** Rename and settings edits are reversible, so they update the cache optimistically. */
export function useUpdateInstance() {
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<Instance, 'name' | 'idleTimeoutS' | 'screen' | 'locale' | 'backupsEnabled'>> & { priceVersion?: string } }) =>
      api<Instance>('PATCH', `/instances/${id}`, { body: patch }),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: keys.instances });
      const prev = queryClient.getQueryData<Instance[]>(keys.instances);
      const { priceVersion: _shown, ...fields } = patch;
      queryClient.setQueryData<Instance[]>(keys.instances, (list) => list?.map((i) => (i.id === id ? { ...i, ...fields } : i)));
      return { prev };
    },
    onError: async (error, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(keys.instances, ctx.prev);
      await refreshChangedPrices(error);
    },
    onSettled: (_d, _e, v) => refresh(v.id),
  });
}

export function useVerifyIp() {
  return useMutation({
    mutationFn: (id: string) => api<IpCheck>('POST', `/instances/${id}/ip/verify`),
    onSettled: (_d, _e, id) => refresh(id),
  });
}

/** Replaces the browser's data with a backup; the result arrives over SSE like any operation. */
export function useRestoreBackup() {
  return useMutation({
    mutationFn: ({ id, backupId }: { id: string; backupId: string }) =>
      api<Accepted>('POST', `/instances/${id}/backups/${backupId}/restore`, { idempotent: true }),
    onSettled: (_d, _e, v) => refresh(v.id),
  });
}

/** Grows the data volume; the price version is the one the user confirmed. */
export function useResizeStorage() {
  return useMutation({
    mutationFn: ({ id, sizeGb, priceVersion }: { id: string; sizeGb: number; priceVersion: string }) =>
      api<Accepted>('POST', `/instances/${id}/storage`, { idempotent: true, body: { sizeGb, priceVersion } }),
    onError: refreshChangedPrices,
    onSettled: (_d, _e, v) => refresh(v.id),
  });
}
