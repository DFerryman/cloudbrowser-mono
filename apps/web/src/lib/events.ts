import { useEffect } from 'react';
import { keys, queryClient } from './query.js';

/**
 * One EventSource on /api/v1/events. Each event invalidates the matching queries, so status
 * changes appear without polling. The browser resumes with Last-Event-ID after a reconnect.
 */
export function useLiveEvents(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource('/api/v1/events');
    const onInstance = (e: MessageEvent) => {
      const { instanceId } = JSON.parse(e.data) as { instanceId?: string };
      void queryClient.invalidateQueries({ queryKey: keys.instances });
      if (instanceId) void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId) });
      void queryClient.invalidateQueries({ queryKey: keys.me });
    };
    const onOperation = (e: MessageEvent) => {
      const { operationId, instanceId } = JSON.parse(e.data) as { operationId?: string; instanceId?: string };
      if (operationId) void queryClient.invalidateQueries({ queryKey: keys.operation(operationId) });
      void queryClient.invalidateQueries({ queryKey: keys.instances });
      if (instanceId) void queryClient.invalidateQueries({ queryKey: keys.instance(instanceId) });
    };
    es.addEventListener('instance.updated', onInstance);
    es.addEventListener('operation.updated', onOperation);
    es.addEventListener('entitlements.updated', () => void queryClient.invalidateQueries({ queryKey: keys.me }));
    return () => es.close();
  }, [enabled]);
}
