import type { AccountUsage, BalanceTransaction, BillingState, RegionPricing } from '@cloudbrowser/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { keys } from '../../lib/query.js';

export const useBilling = () => useQuery({ queryKey: keys.billing, queryFn: () => api<BillingState>('GET', '/billing'), refetchInterval: 60_000 });
export const usePricing = () => useQuery({ queryKey: keys.pricing, queryFn: () => api<RegionPricing[]>('GET', '/pricing'), staleTime: 60_000 });
export const useTransactions = () => useQuery({ queryKey: keys.transactions, queryFn: () => api<BalanceTransaction[]>('GET', '/billing/transactions') });
export const useAccountUsage = (month: string) =>
  useQuery({ queryKey: keys.usage(month), queryFn: () => api<AccountUsage>('GET', `/usage?month=${month}`) });

/** Checkout and the receipts portal are Creem-hosted pages: the app only redirects to them. */
export function useCheckout() {
  return useMutation({
    mutationFn: (productId: string) => api<{ url: string }>('POST', '/billing/checkout', { body: { productId } }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

export function usePortal() {
  return useMutation({
    mutationFn: () => api<{ url: string }>('POST', '/billing/portal'),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

/** The current month (UTC), and the months a user can look back at. */
export const currentMonth = () => new Date().toISOString().slice(0, 7);
export function recentMonths(n = 6) {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
}
export const monthLabel = (month: string, locale: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' });
