import type { PublicPricing, PublicStatus } from '@cloudbrowser/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, isUnauthenticated } from '../lib/api.js';
import { useMe } from '../features/instances/hooks.js';

export const usePublicPricing = () =>
  useQuery({ queryKey: ['public', 'pricing'], queryFn: () => api<PublicPricing>('GET', '/api/public/pricing'), staleTime: 60_000 });

export const usePublicStatus = () =>
  useQuery({ queryKey: ['public', 'status'], queryFn: () => api<PublicStatus>('GET', '/api/public/status'), refetchInterval: 60_000 });

/** Signed in, signed out, or not known yet; for the public pages' header buttons. */
export function useSignedIn(): boolean | null {
  const me = useMe();
  if (me.isSuccess) return true;
  if (me.isError) return isUnauthenticated(me.error) ? false : null;
  return null;
}
