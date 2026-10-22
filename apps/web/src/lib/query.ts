import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

/** One key per resource (page 1, "Rendering and data"). */
export const keys = {
  me: ['me'] as const,
  billing: ['billing'] as const,
  pricing: ['pricing'] as const,
  promotions: ['promotions'] as const,
  transactions: ['billing', 'transactions'] as const,
  usage: (month: string) => ['billing', 'usage', month] as const,
  regions: ['regions'] as const,
  instances: ['instances'] as const,
  instance: (id: string) => ['instance', id] as const,
  sessions: (id: string) => ['instance', id, 'sessions'] as const,
  storage: (id: string) => ['instance', id, 'storage'] as const,
  instanceUsage: (id: string, month: string) => ['instance', id, 'usage', month] as const,
  neverSleep: (id: string) => ['instance', id, 'never-sleep'] as const,
  automation: (id: string) => ['instance', id, 'automation'] as const,
  operation: (id: string) => ['operation', id] as const,
};
