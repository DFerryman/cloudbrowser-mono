import type { AccountUsage, BalanceTransaction, BillingState, PaymentProviderId, RegionPricing } from '@cloudbrowser/contracts';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api.js';
import { keys, queryClient } from '../../lib/query.js';

export const useBilling = () => useQuery({ queryKey: keys.billing, queryFn: () => api<BillingState>('GET', '/billing'), refetchInterval: 60_000 });
export const usePricing = () => useQuery({ queryKey: keys.pricing, queryFn: () => api<RegionPricing[]>('GET', '/pricing'), staleTime: 60_000 });
export const isPriceChanged = (error: unknown) => error instanceof ApiError && error.problem.type === 'price_changed';

/** Fetch the replacement quote, but never retry a purchase at a price the user has not reviewed. */
export async function refreshChangedPrices(error: unknown) {
  if (isPriceChanged(error)) await queryClient.invalidateQueries({ queryKey: keys.pricing });
}
/** One page of credit history; one extra row is fetched to tell whether a next page exists. */
export function useTransactions(page: number, size: number) {
  const q = useQuery({
    queryKey: [...keys.transactions, page, size],
    queryFn: () => api<BalanceTransaction[]>('GET', `/billing/transactions?limit=${size + 1}&offset=${page * size}`),
    placeholderData: keepPreviousData,
  });
  return { ...q, rows: q.data?.slice(0, size), hasMore: (q.data?.length ?? 0) > size };
}
export const useAccountUsage = (month: string) =>
  useQuery({ queryKey: keys.usage(month), queryFn: () => api<AccountUsage>('GET', `/usage?month=${month}`) });

/** Checkout and the receipts portal are pages hosted by the payment provider (Stripe or Creem): the app only redirects to them. */
export function useCheckout() {
  return useMutation({
    mutationFn: (productId: string) => api<{ url: string }>('POST', '/billing/checkout', { body: { productId } }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

export function usePortal() {
  return useMutation({
    mutationFn: (provider?: PaymentProviderId) => api<{ url: string }>('POST', provider ? `/billing/portal?provider=${provider}` : '/billing/portal'),
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
