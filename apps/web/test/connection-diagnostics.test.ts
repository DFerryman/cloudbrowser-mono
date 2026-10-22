import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionDiagnostic } from '@cloudbrowser/contracts';
import { connectionDiagnosticReporter } from '../src/features/session/diagnostics.js';

afterEach(() => vi.useRealTimers());
const diagnostic = (stage: ConnectionDiagnostic['stage'] = 'token_start'): ConnectionDiagnostic => ({
  attemptId: '658338e1-5c61-4933-a886-1554d138e613', stage, elapsedMs: 0,
});

it('reports allowlisted milestones once and refuses sensitive or malformed payloads', async () => {
  const send = vi.fn(async () => {});
  const reporter = connectionDiagnosticReporter('session', send);
  expect(reporter.report(diagnostic())).toBe(true);
  expect(reporter.report(diagnostic())).toBe(false);
  expect(reporter.report({ ...diagnostic('failed'), token: 'private-value' } as never)).toBe(false);
  expect(reporter.report({ ...diagnostic('failed'), code: 'raw URL and token' } as never)).toBe(false);
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toEqual(diagnostic());
  expect(JSON.stringify(send.mock.calls)).not.toContain('private-value');
  reporter.dispose();
});

it('bounds concurrent reporting and times out stalled requests without retrying them', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const send = vi.fn((_value: ConnectionDiagnostic, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<void>(() => {});
  });
  const reporter = connectionDiagnosticReporter('session', send);
  for (const stage of ['token_start', 'token_ok', 'transport_start', 'transport_open', 'gateway_accepted', 'agent_received'] as const) {
    reporter.report(diagnostic(stage));
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(3000);
  expect(signals.slice(0, 4).every((signal) => signal.aborted)).toBe(true);
  expect(send).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(send).toHaveBeenCalledTimes(6);
  expect(vi.getTimerCount()).toBe(0);
  reporter.dispose();
});

it('aborts pending diagnostics and refuses new reports after its session is disposed', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  const send = vi.fn((_value: ConnectionDiagnostic, requestSignal: AbortSignal) => {
    signal = requestSignal;
    return new Promise<void>(() => {});
  });
  const reporter = connectionDiagnosticReporter('session', send);
  reporter.report(diagnostic());
  await vi.advanceTimersByTimeAsync(0);
  reporter.dispose();
  expect(signal.aborted).toBe(true);
  expect(reporter.report(diagnostic('failed'))).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains evidence for a new peer on a long-lived socket after an earlier peer fills its reporting budget', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async (_value: ConnectionDiagnostic) => {});
  const reporter = connectionDiagnosticReporter('session', send);
  for (const stage of [
    'token_start', 'token_ok', 'transport_start', 'transport_open', 'gateway_accepted', 'agent_received',
    'login_start', 'login_ok', 'websocket_start', 'websocket_open', 'desktop_ready', 'signal_received', 'peer_connected', 'first_frame',
  ] as const) expect(reporter.report({ ...diagnostic(stage), peerSequence: 1 })).toBe(true);
  for (const code of ['token_timeout', 'token_failed', 'transport_error', 'transport_closed', 'agent_offline', 'relay_failed'] as const) {
    expect(reporter.report({ ...diagnostic('failed'), peerSequence: 1, code })).toBe(true);
  }
  expect(reporter.report({ ...diagnostic('peer_connected'), peerSequence: 2 })).toBe(true);
  expect(reporter.report({ ...diagnostic('first_frame'), peerSequence: 2 })).toBe(true);
  expect(reporter.report({ ...diagnostic('failed'), peerSequence: 3, code: 'connection_timeout' })).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(23);
  expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'failed', peerSequence: 3, code: 'connection_timeout' });
  reporter.dispose();
});
