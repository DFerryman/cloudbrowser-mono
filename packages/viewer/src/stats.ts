import type { ConnectionMediaSnapshot } from '@cloudbrowser/contracts';

/** Connection quality read from RTCPeerConnection.getStats() every 2 s (page 5, "Quality telemetry"). */
export interface ViewerStats {
  rttMs: number | null;
  fps: number | null;
  /** Share of video packets lost so far, 0–1. */
  loss: number | null;
  bitrateKbps: number | null;
  codec: string | null;
  /** `relay` when media goes through TURN. */
  transport: string | null;
  width: number | null;
  height: number | null;
}

/** green under 80 ms, amber up to 150 ms, red above 150 ms or above 3 % loss (page 5). */
export function qualityLevel(s: Pick<ViewerStats, 'rttMs' | 'loss'>): 'good' | 'fair' | 'poor' | 'unknown' {
  if (s.rttMs === null) return 'unknown';
  if (s.rttMs > 150 || (s.loss ?? 0) > 0.03) return 'poor';
  if (s.rttMs >= 80) return 'fair';
  return 'good';
}

type AnyStat = Record<string, unknown> & { type: string; id: string };

function counter(value: unknown, signed = false): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (signed ? -2_147_483_648 : 0)
    ? value : undefined;
}

function milliseconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const ms = Math.round(value * 1000);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

function allowed<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? value as T : undefined;
}

/** Prefer the video transport's selected pair; several nominated pairs can remain after ICE changes. */
function selectedPair(all: Map<string, AnyStat>, video: AnyStat | undefined): AnyStat | undefined {
  const transport = typeof video?.transportId === 'string' ? all.get(video.transportId) : undefined;
  // An explicit but unavailable video transport must not borrow another track's route.
  if (typeof video?.transportId === 'string' && transport?.type !== 'transport') return undefined;
  const selected = transport
    ? (typeof transport.selectedCandidatePairId === 'string' ? [transport.selectedCandidatePairId] : [])
    : [...new Set([...all.values()].filter((s) => s.type === 'transport')
      .flatMap((s) => typeof s.selectedCandidatePairId === 'string' ? [s.selectedCandidatePairId] : []))];
  if (selected.length) {
    if (selected.length !== 1) return undefined;
    const pair = all.get(selected[0]!);
    return pair?.type === 'candidate-pair' ? pair : undefined;
  }
  // Older browsers omit transport.selectedCandidatePairId. Do not guess between multiple pairs.
  const pairs = [...all.values()].filter((s) => s.type === 'candidate-pair' && s.state === 'succeeded'
    && (!transport || typeof s.transportId !== 'string' || s.transportId === transport.id));
  const legacySelected = pairs.filter((s) => s.selected === true);
  const candidates = legacySelected.length ? legacySelected : pairs.filter((s) => s.nominated === true);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Only fixed enums and numeric counters leave the RTCStatsReport; never candidate addresses or SDP. */
function mediaSnapshot(pair: AnyStat | undefined, video: AnyStat | undefined, all: Map<string, AnyStat>): ConnectionMediaSnapshot {
  const media: ConnectionMediaSnapshot = { inboundVideo: video !== undefined };
  const local = typeof pair?.localCandidateId === 'string' ? all.get(pair.localCandidateId) : undefined;
  const remote = typeof pair?.remoteCandidateId === 'string' ? all.get(pair.remoteCandidateId) : undefined;
  const rttMs = milliseconds(pair?.currentRoundTripTime);
  const localCandidateType = allowed(local?.candidateType, ['host', 'srflx', 'prflx', 'relay'] as const);
  const remoteCandidateType = allowed(remote?.candidateType, ['host', 'srflx', 'prflx', 'relay'] as const);
  const protocol = allowed(local?.protocol, ['udp', 'tcp'] as const);
  const relayProtocol = allowed(local?.relayProtocol, ['udp', 'tcp', 'tls'] as const);
  if (rttMs !== undefined) media.rttMs = rttMs;
  if (localCandidateType) media.localCandidateType = localCandidateType;
  if (remoteCandidateType) media.remoteCandidateType = remoteCandidateType;
  if (protocol) media.protocol = protocol;
  if (relayProtocol) media.relayProtocol = relayProtocol;
  if (video) {
    const result: NonNullable<ConnectionMediaSnapshot['video']> = {};
    for (const key of ['bytesReceived', 'packetsReceived', 'packetsLost', 'framesReceived', 'framesDecoded', 'keyFramesDecoded', 'nackCount', 'pliCount'] as const) {
      const value = counter(video[key], key === 'packetsLost');
      if (value !== undefined) result[key] = value;
    }
    const jitterMs = milliseconds(video.jitter);
    if (jitterMs !== undefined) result.jitterMs = jitterMs;
    if (Object.keys(result).length) media.video = result;
  }
  return media;
}

export async function readStats(pc: RTCPeerConnection, previous: { bytes: number; at: number } | null) {
  const report = await pc.getStats();
  const all = new Map<string, AnyStat>();
  report.forEach((s: AnyStat) => all.set(s.id, s));
  let video: AnyStat | undefined;
  for (const s of all.values()) {
    if (s.type === 'inbound-rtp' && s.isRemote !== true && (s.kind === 'video' || s.mediaType === 'video')) video = s;
  }
  const pair = selectedPair(all, video);
  const bytes = Number(video?.bytesReceived ?? 0);
  const lost = Number(video?.packetsLost ?? 0);
  const received = Number(video?.packetsReceived ?? 0);
  const local = pair ? all.get(String(pair.localCandidateId)) : undefined;
  const codec = video?.codecId ? all.get(String(video.codecId)) : undefined;
  const elapsed = previous ? (Date.now() - previous.at) / 1000 : 0;
  // Cumulative counters, for the changes the quality controller and the quality report look at.
  // The ones after `frames` are NaN when the browser does not report them; times are in seconds.
  const counters = {
    lost,
    received,
    freezes: Number(video?.freezeCount ?? 0),
    // Frames decoded so far; NaN when the browser does not report it.
    frames: Number(video?.framesDecoded ?? Number.NaN),
    freezeSeconds: Number(video?.totalFreezesDuration ?? Number.NaN),
    jitterBufferDelay: Number(video?.jitterBufferDelay ?? Number.NaN),
    jitterBufferEmitted: Number(video?.jitterBufferEmittedCount ?? Number.NaN),
    decodeSeconds: Number(video?.totalDecodeTime ?? Number.NaN),
    dropped: Number(video?.framesDropped ?? Number.NaN),
  };
  const stats: ViewerStats = {
    rttMs: typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
    fps: typeof video?.framesPerSecond === 'number' ? Math.round(video.framesPerSecond) : null,
    loss: received + lost > 0 ? lost / (received + lost) : null,
    bitrateKbps: previous && elapsed > 0 ? Math.round(((bytes - previous.bytes) * 8) / elapsed / 1000) : null,
    codec: typeof codec?.mimeType === 'string' ? codec.mimeType.replace(/^video\//, '') : null,
    transport: typeof local?.candidateType === 'string' ? local.candidateType : null,
    width: typeof video?.frameWidth === 'number' ? video.frameWidth : null,
    height: typeof video?.frameHeight === 'number' ? video.frameHeight : null,
  };
  return { stats, bytes, counters, media: mediaSnapshot(pair, video, all) };
}
