import { describe, expect, it } from 'vitest';
import { readHandshake, readStats } from '../src/stats.js';

const read = (values: Record<string, unknown>[]) => readStats({
  getStats: async () => new Map(values.map((value, index) => [String(value.id ?? index), value])),
} as unknown as RTCPeerConnection, null);

describe('safe media stats', () => {
  it('uses the video transport selected pair and exports only allowed enums and counters', async () => {
    const { media } = await read([
      { id: 'video', type: 'inbound-rtp', kind: 'video', transportId: 'transport', bytesReceived: 12_000, packetsReceived: 20, packetsLost: -1, framesReceived: 2, framesDecoded: 0, keyFramesDecoded: 0, nackCount: 3, pliCount: 4, jitter: 0.015, decoderImplementation: 'private-decoder' },
      { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected', dtlsCipher: 'private-cipher' },
      { id: 'selected', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.125 },
      { id: 'local', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls', address: '203.0.113.12', url: 'turns:private.example:443', usernameFragment: 'private-credential' },
      { id: 'remote', type: 'remote-candidate', candidateType: 'host', address: '10.0.0.8', port: 12345 },
      // A previous ICE pair may still be nominated; it is not the selected transport.
      { id: 'previous', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'old', currentRoundTripTime: 1 },
      { id: 'old', type: 'local-candidate', candidateType: 'srflx', protocol: 'tcp' },
    ]);
    expect(media).toEqual({
      inboundVideo: true, rttMs: 125, localCandidateType: 'relay', remoteCandidateType: 'host', protocol: 'udp', relayProtocol: 'tls',
      video: { bytesReceived: 12_000, packetsReceived: 20, packetsLost: -1, framesReceived: 2, framesDecoded: 0, keyFramesDecoded: 0, nackCount: 3, pliCount: 4, jitterMs: 15 },
    });
    expect(JSON.stringify(media)).not.toMatch(/203\.0\.113|10\.0\.0|private|turns:|username|candidateId|port/);
  });

  it('follows the video transport when several transports have selected pairs', async () => {
    const { media } = await read([
      { id: 'v', type: 'inbound-rtp', kind: 'video', transportId: 'video-transport' },
      { id: 'video-transport', type: 'transport', selectedCandidatePairId: 'video-pair' },
      { id: 'other-transport', type: 'transport', selectedCandidatePairId: 'other-pair' },
      { id: 'video-pair', type: 'candidate-pair', currentRoundTripTime: 0.1 },
      { id: 'other-pair', type: 'candidate-pair', currentRoundTripTime: 0.9 },
    ]);
    expect(media).toEqual({ inboundVideo: true, rttMs: 100 });
  });

  it('uses one legacy selected or nominated pair without guessing between several', async () => {
    const video = { id: 'v', type: 'inbound-rtp', mediaType: 'video', framesDecoded: 0 };
    const one = { id: 'p1', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.1 };
    const two = { id: 'p2', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.2 };
    expect((await read([video, one])).media).toMatchObject({ rttMs: 100, video: { framesDecoded: 0 } });
    expect((await read([video, one, two])).media).not.toHaveProperty('rttMs');
    expect((await read([video, one, { ...two, selected: true }])).media.rttMs).toBe(200);
  });

  it('does not fall back to a stale nominated pair when the explicit selected pair is absent', async () => {
    const { media } = await read([
      { id: 'v', type: 'inbound-rtp', kind: 'video', transportId: 't' },
      { id: 't', type: 'transport', selectedCandidatePairId: 'missing' },
      { id: 'p', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 1 },
    ]);
    expect(media).toEqual({ inboundVideo: true });
  });

  it('does not borrow another transport when the video transport record is absent', async () => {
    const { media } = await read([
      { id: 'v', type: 'inbound-rtp', kind: 'video', transportId: 'missing-video' },
      { id: 'audio', type: 'transport', selectedCandidatePairId: 'audio-pair' },
      { id: 'audio-pair', type: 'candidate-pair', currentRoundTripTime: 0.321 },
    ]);
    expect(media).toEqual({ inboundVideo: true });
  });

  it.each([undefined, null, '0', -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('omits missing or invalid video counts (%s) instead of manufacturing zeros', async (value) => {
    const { media } = await read([{ id: 'v', type: 'inbound-rtp', kind: 'video', bytesReceived: value, packetsReceived: value, framesReceived: value, framesDecoded: value, keyFramesDecoded: value, nackCount: value, pliCount: value, jitter: -1 }]);
    expect(media).toEqual({ inboundVideo: true });
  });

  it('allows signed packet loss but omits values beyond its signed lower bound', async () => {
    expect((await read([{ id: 'v', type: 'inbound-rtp', kind: 'video', packetsLost: -2_147_483_648 }])).media.video).toEqual({ packetsLost: -2_147_483_648 });
    expect((await read([{ id: 'v', type: 'inbound-rtp', kind: 'video', packetsLost: -2_147_483_649 }])).media).toEqual({ inboundVideo: true });
  });

  it('distinguishes a sampled report without a video receiver from explicit zero counters', async () => {
    expect((await read([])).media).toEqual({ inboundVideo: false });
    expect((await read([{ id: 'audio', type: 'inbound-rtp', kind: 'audio', packetsReceived: 50 }])).media).toEqual({ inboundVideo: false });
    expect((await read([{ id: 'v', type: 'inbound-rtp', kind: 'video', packetsReceived: 0, framesDecoded: 0 }])).media).toEqual({ inboundVideo: true, video: { packetsReceived: 0, framesDecoded: 0 } });
  });

  it('rejects arbitrary transport strings and invalid timing values', async () => {
    const { media } = await read([
      { id: 'v', type: 'inbound-rtp', kind: 'video', jitter: Number.POSITIVE_INFINITY },
      { id: 'p', type: 'candidate-pair', selected: true, state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: -1 },
      { id: 'local', type: 'local-candidate', candidateType: 'private-type', protocol: 'https://private.example', relayProtocol: 'private' },
      { id: 'remote', type: 'remote-candidate', candidateType: '10.0.0.1' },
    ]);
    expect(media).toEqual({ inboundVideo: true });
  });

  it('reads a handshake as counts and states only, from the video transport', async () => {
    const values: Record<string, unknown>[] = [
      { id: 'v', type: 'inbound-rtp', kind: 'video', transportId: 't', bytesReceived: 0 },
      { id: 't', type: 'transport', dtlsState: 'connecting', bytesReceived: 1480, selectedCandidatePairId: 'p', dtlsCipher: 'private-cipher' },
      { id: 'other', type: 'transport', dtlsState: 'failed', bytesReceived: 9 },
      { id: 'p', type: 'candidate-pair', state: 'succeeded', requestsSent: 2, responsesReceived: 2, localCandidateId: 'l', currentRoundTripTime: 0.2 },
      { id: 'q', type: 'candidate-pair', state: 'frozen', requestsSent: 0, responsesReceived: 0 },
      { id: 'l', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tcp', address: '203.0.113.4', url: 'turn:private.example?transport=tcp' },
      { id: 'h', type: 'local-candidate', candidateType: 'host', address: '10.0.0.2' },
    ];
    const reading = await readHandshake({ getStats: async () => new Map(values.map((v) => [String(v.id), v])) } as unknown as RTCPeerConnection);
    expect(reading.handshake).toEqual({
      candidates: { relayUdp: 0, relayTcp: 1, relayTls: 0, other: 1 },
      pairs: { succeeded: 1, inProgress: 0, waiting: 1, failed: 0 },
      checksSent: 2, checksAnswered: 2, dtlsState: 'connecting', transportBytesReceived: 1480,
    });
    expect(reading.media).toMatchObject({ inboundVideo: true, rttMs: 200, localCandidateType: 'relay', relayProtocol: 'tcp' });
    expect(JSON.stringify(reading)).not.toMatch(/203\.0\.113|10\.0\.0|private|turn:/);
  });
});
