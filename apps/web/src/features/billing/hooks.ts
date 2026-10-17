import type { BillingState, PlanKey } from '@cloudbrowser/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { keys, queryClient } from '../../lib/query.js';

export const useBilling = () => useQuery({ queryKey: keys.billing, queryFn: () => api<BillingState>('GET', '/billing') });

const settle = () => {
  void queryClient.invalidateQueries({ queryKey: keys.billing });
  void queryClient.invalidateQueries({ queryKey: keys.me });
};

/** Checkout and the portal are Creem-hosted pages: the app only redirects to them. */
export function useCheckout() {
  return useMutation({
    mutationFn: (body: { plan: PlanKey; browsers: number }) => api<{ url: string }>('POST', '/billing/checkout', { body }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

export function usePortal() {
  return useMutation({
    mutationFn: () => api<{ url: string }>('POST', '/billing/portal'),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

export function useChangeBrowsers() {
  return useMutation({
    mutationFn: (browsers: number) => api<BillingState>('POST', '/billing/browsers', { body: { browsers } }),
    onSettled: settle,
  });
}

export function useChangePlan() {
  return useMutation({
    mutationFn: (body: { plan: PlanKey; browsers?: number }) => api<BillingState>('POST', '/billing/plan', { body }),
    onSettled: settle,
  });
}
