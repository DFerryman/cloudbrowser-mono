import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionDiagnostic, ConnectionMediaSnapshot, LiveQualityReport } from '@cloudbrowser/contracts';
import { connectionDiagnosticReporter, liveQualityReporter } from '../src/features/session/diagnostics.js';

afterEach(() => vi.useRealTimers());
const diagnostic = (stage: ConnectionDiagnostic['stage'] = 'token_start'): ConnectionDiagnostic => ({
  attemptId: '658338e1-5c61-4933-a886-1554d138e613', stage, elapsedMs: 0,
});
const media: ConnectionMediaSnapshot = {
  connectionState: 'connected', iceConnectionState: 'completed', iceGatheringState: 'complete',
  sampleAgeMs: 5000, inboundVideo: true, rttMs: 300,
  localCandidateType: 'relay', remoteCandidateType: 'srflx', protocol: 'tcp', relayProtocol: 'tls',
  video: { bytesReceived: 120_000, packetsReceived: 100, packetsLost: -1, framesDecoded: 0, jitterMs: 20 },
  playback: { paused: false, readyState: 2, width: 1280, height: 720, visibility: 'visible', playState: 'resolved', frameCallback: true },
};

it('preserves bounded terminal media evidence once per peer, including signed loss and absent counters', async () => {
  const send = vi.fn(async (_value: ConnectionDiagnostic) => {});
  const reporter = connectionDiagnosticReporter('session', send);
  const first = { ...diagnostic('first_frame'), peerSequence: 1, media };
  expect(reporter.report(first)).toBe(true);
  expect(reporter.report({ ...first, media: { ...media, video: { framesDecoded: 100 } } })).toBe(false);
  const next = { ...diagnostic('failed'), peerSequence: 2, code: 'connection_timeout' as const,
    media: { sampleAgeMs: 0, inboundVideo: false } };
  expect(reporter.report(next)).toBe(true);
  await Promise.resolve();
  expect(send.mock.calls.map(([value]) => value)).toEqual([first, next]);
  expect(send.mock.calls[1]?.[0].media).not.toHaveProperty('video');
  reporter.dispose();
});

it('drops sensitive nested media and invalid evidence before any request is sent', async () => {
  const send = vi.fn(async () => {});
  const reporter = connectionDiagnosticReporter('session', send);
  for (const snapshot of [
    { ...media, address: '203.0.113.7' },
    { ...media, url: 'turns:relay.example?credential=private-value' },
    { ...media, video: { framesDecoded: 0, sdp: 'private-value' } },
    { ...media, playback: { ...media.playback, error: 'private-value' } },
    { ...media, playback: { ...media.playback, playState: 'NotAllowedError: private-value' } },
    { ...media, sampleAgeMs: 5001 },
    { ...media, video: { packetsLost: -2_147_483_649 } },
    { ...media, video: { framesDecoded: Number.NaN } },
    { ...media, video: { bytesReceived: Number.POSITIVE_INFINITY } },
    { ...media, playback: { ...media.playback, readyState: 5 } },
    { ...media, playback: { ...media.playback, width: 32769 } },
  ]) expect(reporter.report({ ...diagnostic('failed'), media: snapshot } as never)).toBe(false);
  for (const stage of ['token_start', 'desktop_ready', 'peer_connected', 'closed'] as const) {
    expect(reporter.report({ ...diagnostic(stage), media })).toBe(false);
  }
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  reporter.dispose();
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

const quality: LiveQualityReport = {
  attemptId: '658338e1-5c61-4933-a886-1554d138e613', durationMs: 60_000, readings: 30, rttMs: 290, gatewayRttMs: 40,
  fps: 24, kbps: 2400, loss: 0.01, freezes: 0, freezeMs: 0, jitterBufferMs: 50, decodeMs: 5, framesDropped: 0,
  quality: 'high', width: 1920, height: 1080, localCandidateType: 'relay', relayProtocol: 'udp',
};

it('sends one quality report at a time, drops one that cannot go now, and gives up on a slow request', async () => {
  vi.useFakeTimers();
  const pending: { resolve: () => void; signal: AbortSignal }[] = [];
  // As fetch does, an aborted request rejects.
  const send = vi.fn((_value: LiveQualityReport, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    pending.push({ resolve, signal });
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
  const reporter = liveQualityReporter('session', send);
  expect(reporter.report(quality)).toBe(true);
  await Promise.resolve();
  // A minute later the first is still in flight: the next is dropped, not queued.
  expect(reporter.report({ ...quality, rttMs: 300 })).toBe(false);
  pending[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(reporter.report({ ...quality, rttMs: 310 })).toBe(true);
  await Promise.resolve();
  expect(send.mock.calls.map(([value]) => value.rttMs)).toEqual([290, 310]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(pending[1]!.signal.aborted).toBe(true);
  // The page disposes the reporter before the view below it disconnects and sends its last
  // interval: that report is still taken and not cut off, and nothing is taken after it.
  reporter.dispose();
  expect(reporter.report(quality)).toBe(true);
  await Promise.resolve();
  expect(pending[2]!.signal.aborted).toBe(false);
  pending[2]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(reporter.report(quality)).toBe(false);
  expect(send).toHaveBeenCalledTimes(3);
});

it('drops quality reports outside the contract before any request is sent', async () => {
  const send = vi.fn(async () => {});
  const reporter = liveQualityReporter('session', send);
  for (const value of [
    { ...quality, address: '203.0.113.7' },
    { ...quality, rttMs: Number.NaN },
    { ...quality, fps: 500 },
    { ...quality, loss: -0.1 },
    { ...quality, durationMs: 500 },
  ]) expect(reporter.report(value as never)).toBe(false);
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  reporter.dispose();
});
