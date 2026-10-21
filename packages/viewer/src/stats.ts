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

export async function readStats(pc: RTCPeerConnection, previous: { bytes: number; at: number } | null) {
  const report = await pc.getStats();
  const all = new Map<string, AnyStat>();
  report.forEach((s: AnyStat) => all.set(s.id, s));
  let pair: AnyStat | undefined;
  let video: AnyStat | undefined;
  for (const s of all.values()) {
    if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') pair = s;
    if (s.type === 'inbound-rtp' && s.kind === 'video') video = s;
  }
  const bytes = Number(video?.bytesReceived ?? 0);
  const lost = Number(video?.packetsLost ?? 0);
  const received = Number(video?.packetsReceived ?? 0);
  const local = pair ? all.get(String(pair.localCandidateId)) : undefined;
  const codec = video?.codecId ? all.get(String(video.codecId)) : undefined;
  const elapsed = previous ? (Date.now() - previous.at) / 1000 : 0;
  // Cumulative counters, for the changes the quality controller looks at.
  const counters = {
    lost,
    received,
    freezes: Number(video?.freezeCount ?? 0),
    // Frames decoded so far; NaN when the browser does not report it.
    frames: Number(video?.framesDecoded ?? Number.NaN),
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
  return { stats, bytes, counters };
}
