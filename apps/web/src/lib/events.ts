import { useEffect } from 'react';
import { keys, queryClient } from './query.js';

/** The first wait before a closed event stream is opened again; it doubles up to RETRY_MAX_MS. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

type Source = Pick<EventSource, 'addEventListener' | 'close' | 'readyState'> & { onerror: ((event: Event) => void) | null };

/**
 * Opens /api/v1/events and keeps it open. Each event invalidates the matching queries, so status
 * changes appear without polling, and the browser resumes with Last-Event-ID after a dropped
 * stream. An HTTP error (a deploy, a 502 from the edge) closes an EventSource for good, though:
 * the page then showed stale statuses until it was reloaded. A closed source is replaced, backing
 * off. Returns the function that stops it.
 */
export function openLiveEvents(createSource: () => Source = () => new EventSource('/api/v1/events')): () => void {
  let source: Source | null = null;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const invalidate = (queryKey: readonly unknown[]) => void queryClient.invalidateQueries({ queryKey });
  const onInstance = (e: MessageEvent) => {
    const { instanceId } = JSON.parse(e.data) as { instanceId?: string };
    invalidate(keys.instances);
    if (instanceId) invalidate(keys.instance(instanceId));
    invalidate(keys.me);
    invalidate(keys.billing);
  };
  const onOperation = (e: MessageEvent) => {
    const { operationId, instanceId } = JSON.parse(e.data) as { operationId?: string; instanceId?: string };
    if (operationId) invalidate(keys.operation(operationId));
    invalidate(keys.instances);
    if (instanceId) invalidate(keys.instance(instanceId));
  };
  const open = () => {
    const current = createSource();
    source = current;
    // Each stream starts with `ready`. A new source starts from the latest event rather than
    // where the closed one stopped, so whatever changed in between is fetched again.
    current.addEventListener('ready', () => {
      failures = 0;
      invalidate(keys.instances);
      invalidate(keys.me);
      invalidate(keys.billing);
    });
    current.addEventListener('instance.updated', onInstance as EventListener);
    current.addEventListener('operation.updated', onOperation as EventListener);
    current.addEventListener('entitlements.updated', () => {
      invalidate(keys.me);
      invalidate(keys.billing);
      invalidate(keys.promotions);
    });
    current.onerror = () => {
      // While CONNECTING the browser retries by itself.
      if (stopped || source !== current || current.readyState !== 2) return;
      current.close();
      const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** failures++);
      retry = setTimeout(open, delay * (0.75 + Math.random() * 0.5));
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    source?.close();
  };
}

/** One live event stream for the signed-in app (openLiveEvents). */
export function useLiveEvents(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    return openLiveEvents();
  }, [enabled]);
}
