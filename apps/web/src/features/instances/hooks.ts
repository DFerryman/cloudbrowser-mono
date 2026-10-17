import type { Accepted, Backup, Instance, IpCheck, Me, Region } from '@cloudbrowser/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { keys, queryClient } from '../../lib/query.js';

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

const refresh = (instanceId?: string) => {
  void queryClient.invalidateQueries({ queryKey: keys.instances });
  void queryClient.invalidateQueries({ queryKey: keys.me });
  if (instanceId) void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId) });
};

/**
 * Lifecycle actions send an Idempotency-Key and wait for the server's state (SSE); the UI never
 * shows a state the backend has not reached.
 */
export function useLifecycle() {
  return useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: 'start' | 'stop' | 'undelete' | 'delete' | 'ip-change'; body?: unknown }) => {
      if (action === 'delete') return api<Accepted>('DELETE', `/instances/${id}`, { idempotent: true });
      if (action === 'ip-change') return api<Accepted>('POST', `/instances/${id}/ip-change-requests`, { idempotent: true, body: { confirm: true } });
      return api<Accepted>('POST', `/instances/${id}/${action}`, { idempotent: true, body });
    },
    onSettled: (_d, _e, v) => refresh(v.id),
  });
}

export function useCreateInstance() {
  return useMutation({
    mutationFn: (body: { name: string; regionId: Instance['regionId']; locale?: Instance['locale']; screen?: Instance['screen'] }) =>
      api<Accepted>('POST', '/instances', { idempotent: true, body }),
    onSettled: () => refresh(),
  });
}

/** Rename and settings edits are reversible, so they update the cache optimistically. */
export function useUpdateInstance() {
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<Instance, 'name' | 'idleTimeoutS' | 'screen' | 'locale'>> }) =>
      api<Instance>('PATCH', `/instances/${id}`, { body: patch }),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: keys.instances });
      const prev = queryClient.getQueryData<Instance[]>(keys.instances);
      queryClient.setQueryData<Instance[]>(keys.instances, (list) => list?.map((i) => (i.id === id ? { ...i, ...patch } : i)));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && queryClient.setQueryData(keys.instances, ctx.prev),
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
