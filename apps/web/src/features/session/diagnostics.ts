import { ConnectionDiagnostic, LiveQualityReport } from '@cloudbrowser/contracts';
import { api } from '../../lib/api.js';

const REQUEST_TIMEOUT_MS = 3000;
const MAX_PENDING = 64;
const MAX_CONTEXTS = 32;
const MAX_IN_FLIGHT = 4;

/** Bounded, best-effort reporting; failures never start another connection or reporting loop. */
export function connectionDiagnosticReporter(
  sessionId: string,
  send: (diagnostic: ConnectionDiagnostic, signal: AbortSignal) => Promise<unknown> = (diagnostic, signal) =>
    api('POST', `/sessions/${encodeURIComponent(sessionId)}/diagnostics`, { body: diagnostic, signal }),
) {
  let disposed = false;
  const seen = new Map<string, Set<string>>();
  const pending: ConnectionDiagnostic[] = [];
  const active = new Set<AbortController>();
  const pump = () => {
    while (!disposed && active.size < MAX_IN_FLIGHT && pending.length) {
      const diagnostic = pending.shift()!;
      const controller = new AbortController();
      active.add(controller);
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const canceled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('diagnostic request ended')), { once: true });
      });
      void Promise.race([Promise.resolve().then(() => send(diagnostic, controller.signal)), canceled]).catch(() => {
        // Keep the visible reference ID; diagnostic delivery must never mask the original fault.
      }).finally(() => {
        clearTimeout(timeout);
        active.delete(controller);
        pump();
      });
    }
  };
  return {
    report(value: ConnectionDiagnostic): boolean {
      if (disposed || pending.length >= MAX_PENDING) return false;
      const parsed = ConnectionDiagnostic.safeParse(value);
      if (!parsed.success) return false;
      const diagnostic = parsed.data;
      const context = `${diagnostic.attemptId}:${diagnostic.peerSequence ?? 'transport'}`;
      let stages = seen.get(context);
      if (!stages) {
        if (seen.size >= MAX_CONTEXTS) seen.delete(seen.keys().next().value!);
        stages = new Set();
      } else {
        // Keep recently active peers; a long-lived socket must not fill a lifetime quota.
        seen.delete(context);
      }
      seen.set(context, stages);
      const key = diagnostic.stage === 'failed' || diagnostic.stage === 'closed'
        ? `${diagnostic.stage}:${diagnostic.code ?? ''}` : diagnostic.stage;
      if (stages.has(key) || stages.size >= 20) return false;
      stages.add(key);
      pending.push(diagnostic);
      pump();
      return true;
    },
    dispose() {
      disposed = true;
      pending.length = 0;
      for (const controller of active) controller.abort();
      active.clear();
      seen.clear();
    },
  };
}

/**
 * Sends the viewer's quality reports (about one a minute), one at a time and best-effort: a report
 * that arrives while another is in flight, or fails, is dropped rather than queued.
 */
export function liveQualityReporter(
  sessionId: string,
  send: (report: LiveQualityReport, signal: AbortSignal) => Promise<unknown> = (report, signal) =>
    // keepalive: the last report is often sent as the page goes away.
    api('POST', `/sessions/${encodeURIComponent(sessionId)}/quality`, { body: report, signal, keepalive: true }),
) {
  let disposed = false;
  let active: AbortController | null = null;
  return {
    report(value: LiveQualityReport): boolean {
      if (disposed || active) return false;
      const parsed = LiveQualityReport.safeParse(value);
      if (!parsed.success) return false;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      void Promise.resolve().then(() => send(parsed.data, controller.signal)).catch(() => {
        // Quality reports are statistics; a lost one changes nothing for the user.
      }).finally(() => {
        clearTimeout(timeout);
        if (active === controller) active = null;
      });
      return true;
    },
    /**
     * Refuses reports from the end of this task on. The view reports its last interval as it
     * disconnects, in a cleanup React runs after the page's: that report is still taken, and it
     * and one in flight finish within their timeout rather than being cut off.
     */
    dispose() {
      queueMicrotask(() => { disposed = true; });
    },
  };
}
