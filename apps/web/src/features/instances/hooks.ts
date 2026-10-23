import { REGION_INFO } from '@cloudbrowser/contracts';
import type { Accepted, AgentControlMode, AgentKey, AutomationStatus, CreateAgentKeyBody, CreateInstanceBody, Instance, InstanceStorage, InstanceUsage, IpCheck, Me, NeverSleepQuote, Region } from '@cloudbrowser/contracts';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { keys, queryClient } from '../../lib/query.js';
import { refreshChangedPrices } from '../billing/hooks.js';

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<Me>('GET', '/me') });
export const useRegions = () => useQuery({ queryKey: keys.regions, queryFn: () => api<Region[]>('GET', '/regions'), staleTime: 30_000, refetchInterval: 30_000 });
export const useInstances = () => useQuery({ queryKey: keys.instances, queryFn: () => api<Instance[]>('GET', '/instances') });
export const useInstance = (id: string) =>
  useQuery({ queryKey: keys.instance(id), queryFn: () => api<Instance>('GET', `/instances/${id}`) });

export type RecentSession = { id: string; startedAt: string; endedAt: string | null; country: string | null; userAgent: string | null };
/** One page of viewer sessions, newest first; one extra row tells whether a next page exists. */
export function useRecentSessions(id: string, page: number, size: number) {
  const q = useQuery({
    queryKey: [...keys.sessions(id), page, size],
    queryFn: () => api<RecentSession[]>('GET', `/instances/${id}/sessions?limit=${size + 1}&offset=${page * size}`),
    placeholderData: keepPreviousData,
  });
  return { ...q, rows: q.data?.slice(0, size), hasMore: (q.data?.length ?? 0) > size };
}

export const useStorage = (id: string) =>
  useQuery({ queryKey: keys.storage(id), queryFn: () => api<InstanceStorage>('GET', `/instances/${id}/storage`), refetchInterval: 30_000 });

/** What Never sleep costs for 24 hours and whether it may be turned on; read fresh each time the dialog opens. */
export const useNeverSleepQuote = (id: string, enabled: boolean) =>
  useQuery({ queryKey: keys.neverSleep(id), queryFn: () => api<NeverSleepQuote>('GET', `/instances/${id}/never-sleep`), enabled, staleTime: 0, gcTime: 0 });

export const useInstanceUsage = (id: string, month: string) =>
  useQuery({ queryKey: keys.instanceUsage(id, month), queryFn: () => api<InstanceUsage>('GET', `/instances/${id}/usage?month=${month}`), refetchInterval: 60_000 });

const refresh = (instanceId?: string) => {
  void queryClient.invalidateQueries({ queryKey: keys.regions });
  void queryClient.invalidateQueries({ queryKey: keys.instances });
  void queryClient.invalidateQueries({ queryKey: keys.me });
  void queryClient.invalidateQueries({ queryKey: keys.billing });
  // keys.instance(id) is the prefix of the browser's storage and usage queries too.
  if (instanceId) void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId) });
};

/**
 * Lifecycle actions send an Idempotency-Key and wait for the server's state (SSE); the UI never
 * shows a state the backend has not reached.
 */
export function useLifecycle() {
  return useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: 'start' | 'stop' | 'undelete' | 'delete'; body?: unknown }) => {
      if (action === 'delete') return api<Accepted>('DELETE', `/instances/${id}`, { idempotent: true });
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
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<Instance, 'name' | 'idleTimeoutS' | 'screen' | 'agentAccess'>> & { priceVersion?: string } }) =>
      api<Instance>('PATCH', `/instances/${id}`, { body: patch }),
    onMutate: async ({ id, patch }) => {
      await Promise.all([queryClient.cancelQueries({ queryKey: keys.instances }), queryClient.cancelQueries({ queryKey: keys.instance(id) })]);
      const prev = queryClient.getQueryData<Instance[]>(keys.instances);
      // The browser's own pages read the single-browser query; update it too, or a control
      // snaps back until the refetch.
      const prevOne = queryClient.getQueryData<Instance>(keys.instance(id));
      const { priceVersion: _shown, ...fields } = patch;
      queryClient.setQueryData<Instance[]>(keys.instances, (list) => list?.map((i) => (i.id === id ? { ...i, ...fields } : i)));
      queryClient.setQueryData<Instance>(keys.instance(id), (one) => (one ? { ...one, ...fields } : one));
      return { prev, prevOne };
    },
    onError: async (error, v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(keys.instances, ctx.prev);
      if (ctx?.prevOne) queryClient.setQueryData(keys.instance(v.id), ctx.prevOne);
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

/** Grows the data volume; the price version is the one the user confirmed. */
export function useResizeStorage() {
  return useMutation({
    mutationFn: ({ id, sizeGb, priceVersion }: { id: string; sizeGb: number; priceVersion: string }) =>
      api<Accepted>('POST', `/instances/${id}/storage`, { idempotent: true, body: { sizeGb, priceVersion } }),
    onError: refreshChangedPrices,
    onSettled: (_d, _e, v) => refresh(v.id),
  });
}

// --- coding-agent access (docs/agent-access.md) ----------------------------------------------

export const useAutomation = (id: string, enabled = true) =>
  useQuery({ queryKey: keys.automation(id), queryFn: () => api<AutomationStatus>('GET', `/instances/${id}/automation`), enabled, refetchInterval: 15_000 });

/** Creates an access key for the browser's hosted MCP endpoint: the key comes back once. */
export function useCreateAgentKey() {
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CreateAgentKeyBody }) => api<AgentKey>('POST', `/instances/${id}/automation/keys`, { body }),
    onSettled: (_d, _e, v) => void queryClient.invalidateQueries({ queryKey: keys.automation(v.id) }),
  });
}

export function useRevokeClient() {
  return useMutation({
    mutationFn: ({ id, clientId }: { id: string; clientId: string }) => api<void>('DELETE', `/instances/${id}/automation/clients/${clientId}`),
    onSettled: (_d, _e, v) => void queryClient.invalidateQueries({ queryKey: keys.automation(v.id) }),
  });
}

/** Hand control back to the agent, keep it, or privacy-pause; the browser's own query shows the new mode. */
export function useSetControl() {
  return useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: AgentControlMode }) => api<Instance>('POST', `/instances/${id}/automation/control`, { body: { mode } }),
    onSuccess: (instance) => {
      queryClient.setQueryData<Instance>(keys.instance(instance.id), instance);
      queryClient.setQueryData<Instance[]>(keys.instances, (list) => list?.map((i) => (i.id === instance.id ? instance : i)));
    },
    onSettled: (_d, _e, v) => refresh(v.id),
  });
}

export function useRegionInfo(id: string) {
  const regions = useRegions();
  const row = regions.data?.find((r) => r.id === id);
  return row ?? { id, name: id, ...(REGION_INFO[id] ?? { country: '', city: id, timezone: 'UTC' }) };
}
