import { LiveQualityReport, type ConnectionMediaSnapshot, type VideoQuality } from '@cloudbrowser/contracts';
import type { ViewerStats } from './stats.js';

/** Cumulative counters from readStats; times in seconds, NaN where the browser does not report them. */
export interface QualityCounters {
  lost: number;
  received: number;
  freezes: number;
  frames: number;
  freezeSeconds: number;
  jitterBufferDelay: number;
  jitterBufferEmitted: number;
  jitterBufferTarget: number;
  decodeSeconds: number;
  dropped: number;
  nacks: number;
  retransmits: number;
  plis: number;
  keyframes: number;
}

type Reading = { at: number; stats: ViewerStats; counters: QualityCounters; media: ConnectionMediaSnapshot };

/** Pongs kept per window; a minute of steady typing confirms input about four times a second. */
const MAX_GATEWAY_SAMPLES = 256;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** How much a cumulative counter grew; null when either reading lacks it or it went backwards. */
const growth = (now: number, before: number) => Number.isFinite(now) && Number.isFinite(before) && now >= before ? now - before : null;
const round = (value: number, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * One interval of a live picture's stats readings (every 2 s) and the input socket's round trips,
 * summed up as a LiveQualityReport. The window's first reading is the baseline its counters are
 * measured from.
 */
export class QualityWindow {
  private baseline: Reading | null = null;
  private last: Reading | null = null;
  private attemptId: string | null = null;
  private readings = 0;
  private rtts: number[] = [];
  private fps: number[] = [];
  private kbps: number[] = [];
  private gateway: number[] = [];
  private levelChanges = 0;

  /** When the baseline was read; null while the window has none. */
  get startedAt(): number | null {
    return this.baseline?.at ?? null;
  }

  add(attemptId: string, at: number, stats: ViewerStats, counters: QualityCounters, media: ConnectionMediaSnapshot) {
    const reading = { at, stats, counters, media };
    if (!this.baseline || this.attemptId !== attemptId) {
      this.reset();
      this.baseline = this.last = reading;
      this.attemptId = attemptId;
      return;
    }
    this.last = reading;
    this.readings++;
    if (stats.rttMs !== null) this.rtts.push(stats.rttMs);
    if (stats.fps !== null) this.fps.push(stats.fps);
    if (stats.bitrateKbps !== null && stats.bitrateKbps >= 0) this.kbps.push(stats.bitrateKbps);
  }

  /** A ping's round trip on the input socket, while the window is open. */
  gatewayRtt(ms: number) {
    if (this.baseline && ms >= 0 && this.gateway.length < MAX_GATEWAY_SAMPLES) this.gateway.push(ms);
  }

  /** The viewer switched picture level, while the window is open. */
  levelChanged() {
    if (this.baseline) this.levelChanges++;
  }

  /**
   * The window's report, or null when it covers less than `minMs`. The next window starts from
   * this one's last reading, so no interval is counted twice or left out.
   */
  take(minMs: number, quality: VideoQuality | null): LiveQualityReport | null {
    const { baseline, last, attemptId } = this;
    if (!baseline || !last || !attemptId || !this.readings || last.at - baseline.at < minMs) return null;
    const report = this.summarize(baseline, last, attemptId, quality);
    this.reset();
    this.baseline = this.last = last;
    this.attemptId = attemptId;
    return report;
  }

  reset() {
    this.baseline = this.last = null;
    this.attemptId = null;
    this.readings = 0;
    this.rtts = [];
    this.fps = [];
    this.kbps = [];
    this.gateway = [];
    this.levelChanges = 0;
  }

  private summarize(first: Reading, last: Reading, attemptId: string, quality: VideoQuality | null): LiveQualityReport | null {
    const durationMs = Math.round(last.at - first.at);
    const a = first.counters;
    const b = last.counters;
    const lost = Math.max(0, b.lost - a.lost);
    const received = Math.max(0, b.received - a.received);
    const frames = growth(b.frames, a.frames);
    const frozen = growth(b.freezeSeconds, a.freezeSeconds);
    const emitted = growth(b.jitterBufferEmitted, a.jitterBufferEmitted);
    const buffered = growth(b.jitterBufferDelay, a.jitterBufferDelay);
    const targeted = growth(b.jitterBufferTarget, a.jitterBufferTarget);
    const decoding = growth(b.decodeSeconds, a.decodeSeconds);
    const dropped = growth(b.dropped, a.dropped);
    const count = (now: number, before: number) => { const n = growth(now, before); return n === null ? null : Math.round(n); };
    // Some browsers omit framesPerSecond; decoded frames over the interval say the same.
    const fps = median(this.fps) ?? (frames !== null ? frames / (durationMs / 1000) : null);
    const kbps = median(this.kbps);
    const rtt = median(this.rtts);
    const gateway = median(this.gateway);
    const parsed = LiveQualityReport.safeParse({
      attemptId,
      durationMs,
      readings: this.readings,
      rttMs: rtt === null ? null : Math.round(rtt),
      gatewayRttMs: gateway === null ? null : Math.round(gateway),
      fps: fps === null ? null : round(Math.min(fps, 240), 1),
      kbps: kbps === null ? null : Math.round(kbps),
      loss: lost + received > 0 ? round(lost / (lost + received), 4) : null,
      freezes: Math.max(0, Math.round(b.freezes - a.freezes)),
      freezeMs: frozen === null ? null : Math.min(durationMs, Math.round(frozen * 1000)),
      jitterBufferMs: emitted && buffered !== null ? round((buffered / emitted) * 1000, 1) : null,
      decodeMs: frames && decoding !== null ? round((decoding / frames) * 1000, 1) : null,
      framesDropped: dropped === null ? null : Math.round(dropped),
      quality,
      width: last.stats.width,
      height: last.stats.height,
      ...(last.media.localCandidateType ? { localCandidateType: last.media.localCandidateType } : {}),
      ...(last.media.relayProtocol ? { relayProtocol: last.media.relayProtocol } : {}),
      nacks: count(b.nacks, a.nacks),
      retransmits: count(b.retransmits, a.retransmits),
      plis: count(b.plis, a.plis),
      keyframes: count(b.keyframes, a.keyframes),
      levelChanges: this.levelChanges,
      jitterBufferTargetMs: emitted && targeted !== null ? round((targeted / emitted) * 1000, 1) : null,
    });
    // Values outside the contract's bounds (a broken counter) drop the report, not the view.
    return parsed.success ? parsed.data : null;
  }
}
