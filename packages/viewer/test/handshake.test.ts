import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandshakeProbe, stalledAt } from '../src/handshake.js';

/** A peer as the probe sees it: events, states and a stats report. */
class Peer extends EventTarget {
  iceConnectionState = 'new';
  connectionState = 'new';
  stats: Record<string, unknown>[] = [];
  getStats = vi.fn(async () => new Map(this.stats.map((s) => [String(s.id), s])));
  emit(type: string, fields: Record<string, unknown> = {}) {
    this.dispatchEvent(Object.assign(new Event(type), fields));
  }
}

const reached = (candidate: boolean, ice: boolean, peer: boolean) => ({ candidate, ice, peer });

describe('handshake stall', () => {
  it('names the first step that did not happen', () => {
    expect(stalledAt(reached(false, false, false), { iceConnectionState: 'checking', connectionState: 'connecting' }, {})).toBe('candidates');
    expect(stalledAt(reached(true, false, false), { iceConnectionState: 'checking', connectionState: 'connecting' }, {})).toBe('ice');
    expect(stalledAt(reached(true, true, false), { iceConnectionState: 'disconnected', connectionState: 'connecting' }, {})).toBe('dtls');
    // ICE reported connected even though no candidate event was seen (a peer that trickled late).
    expect(stalledAt(reached(false, false, false), { iceConnectionState: 'connected', connectionState: 'connecting' }, {})).toBe('dtls');
    const connected = { iceConnectionState: 'connected', connectionState: 'connected' } as const;
    expect(stalledAt(reached(true, true, true), connected, { inboundVideo: false })).toBe('media');
    expect(stalledAt(reached(true, true, true), connected, { inboundVideo: true, video: { bytesReceived: 0 } })).toBe('media');
    expect(stalledAt(reached(true, true, true), connected, { inboundVideo: true, video: { bytesReceived: 9000, framesDecoded: 0 } })).toBe('decode');
    expect(stalledAt(reached(true, true, true), connected, { inboundVideo: true, video: { bytesReceived: 9000, framesDecoded: 4 } })).toBe('render');
    // Connected, but no recent reading of the video: unknown rather than guessed.
    expect(stalledAt(reached(true, true, true), connected, {})).toBeUndefined();
  });
});

describe('handshake probe', () => {
  afterEach(() => vi.useRealTimers());

  it('times each step, keeps error codes only, and stops reading once the peer connects', async () => {
    vi.useFakeTimers();
    const pc = new Peer();
    const media = vi.fn();
    const probe = new HandshakeProbe(pc as unknown as RTCPeerConnection, media);
    pc.stats = [
      { id: 'l1', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'udp', address: '203.0.113.9', url: 'turn:private.example:3478' },
      { id: 'l2', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tls', address: '203.0.113.9' },
      { id: 'p1', type: 'candidate-pair', state: 'in-progress', requestsSent: 3, responsesReceived: 0, localCandidateId: 'l1' },
      { id: 'p2', type: 'candidate-pair', state: 'failed', requestsSent: 5, responsesReceived: 0, localCandidateId: 'l2' },
      { id: 't', type: 'transport', dtlsState: 'new', bytesReceived: 0, iceRole: 'controlled' },
    ];
    await vi.advanceTimersByTimeAsync(300);
    pc.emit('icecandidate', { candidate: { candidate: 'candidate:1 1 udp 1 203.0.113.9 50000 typ relay' } });
    pc.emit('icecandidateerror', { errorCode: 701, url: 'turn:private.example:3478', errorText: 'private timeout', address: '192.0.2.1' });
    pc.emit('icecandidateerror', { errorCode: 701 });
    pc.emit('icecandidateerror', { errorCode: 401 });
    await vi.advanceTimersByTimeAsync(700);
    expect(pc.getStats).toHaveBeenCalledTimes(1);
    expect(media).toHaveBeenCalledTimes(1);
    const stalled = probe.snapshot({ media: media.mock.calls[0]![0] });
    expect(stalled).toEqual({
      stalledAt: 'ice', candidateMs: 300, turnErrors: [701, 401],
      candidates: { relayUdp: 1, relayTcp: 0, relayTls: 1, other: 0 },
      pairs: { succeeded: 0, inProgress: 1, waiting: 0, failed: 1 },
      checksSent: 8, checksAnswered: 0, dtlsState: 'new', transportBytesReceived: 0,
    });
    expect(JSON.stringify(stalled)).not.toMatch(/203\.0\.113|192\.0\.2|private|turn:/);

    pc.iceConnectionState = 'connected';
    pc.emit('iceconnectionstatechange');
    await vi.advanceTimersByTimeAsync(500);
    pc.connectionState = 'connected';
    probe.connected();
    await vi.advanceTimersByTimeAsync(5_000);
    // startStats reads the peer from here on: no reading after the one at 1 s.
    expect(pc.getStats).toHaveBeenCalledTimes(1);
    expect(probe.snapshot()).toMatchObject({ candidateMs: 300, iceMs: 1000, dtlsMs: 1500 });
    expect(probe.snapshot()).not.toHaveProperty('stalledAt');
    probe.stop();
  });

  it('keeps no more than eight distinct codes and ignores malformed ones', () => {
    const pc = new Peer();
    const probe = new HandshakeProbe(pc as unknown as RTCPeerConnection, () => {});
    for (const errorCode of [701, 1000, -1, 0.5, 300, 401, 403, 437, 486, 500, 508, 600, 701, 702]) pc.emit('icecandidateerror', { errorCode });
    expect(probe.snapshot().turnErrors).toEqual([701, 300, 401, 403, 437, 486, 500, 508]);
    probe.stop();
    pc.emit('icecandidateerror', { errorCode: 999 });
    expect(probe.snapshot().turnErrors).not.toContain(999);
  });

  it('reports no candidates when the relay never answered', async () => {
    vi.useFakeTimers();
    const pc = new Peer();
    const probe = new HandshakeProbe(pc as unknown as RTCPeerConnection, () => {});
    pc.emit('icecandidateerror', { errorCode: 701 });
    pc.emit('icecandidate', { candidate: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe.snapshot({ media: {} })).toEqual({
      stalledAt: 'candidates', turnErrors: [701],
      candidates: { relayUdp: 0, relayTcp: 0, relayTls: 0, other: 0 },
      pairs: { succeeded: 0, inProgress: 0, waiting: 0, failed: 0 },
      checksSent: 0, checksAnswered: 0,
    });
    probe.stop();
  });
});
