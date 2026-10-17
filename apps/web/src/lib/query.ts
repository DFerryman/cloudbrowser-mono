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
  regions: ['regions'] as const,
  instances: ['instances'] as const,
  instance: (id: string) => ['instance', id] as const,
  sessions: (id: string) => ['instance', id, 'sessions'] as const,
  backups: (id: string) => ['instance', id, 'backups'] as const,
  operation: (id: string) => ['operation', id] as const,
};
