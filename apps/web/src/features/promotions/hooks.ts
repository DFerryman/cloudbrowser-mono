import type { PromotionTask } from '@cloudbrowser/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { keys } from '../../lib/query.js';

/** The user's tasks; fetching them also completes and credits any the user has just finished. */
export const usePromotions = () => useQuery({ queryKey: keys.promotions, queryFn: () => api<PromotionTask[]>('GET', '/promotions'), refetchInterval: 5 * 60_000 });
