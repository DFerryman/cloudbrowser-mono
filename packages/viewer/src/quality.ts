import { VIDEO_QUALITIES, type VideoQuality } from '@cloudbrowser/contracts';

/** The sharpest level to use, and whether to adapt below it (the web app uses the default: full, adapting). */
export interface VideoPreference {
  quality: VideoQuality;
  auto: boolean;
}

/** One reading of the receiving side (every 2 s), as changes since the previous reading. */
export interface QualitySample {
  at: number;
  /** No video packets arrived since the previous reading. */
  stalled: boolean;
  /** Frames decoded per second; null when the browser does not report it. */
  fps: number | null;
  /** Share of video packets lost since the previous reading, 0–1. */
  lossRate: number;
  /** Video freezes since the previous reading. */
  freezes: number;
  rttMs: number | null;
}

/** neko encodes at a constant rate whatever is on screen (images/browser/neko.yaml). */
const EXPECTED_FPS: Record<VideoQuality, number> = { full: 25, high: 25, medium: 25, low: 15 };
/** A switch restarts the stream at a keyframe; readings right after it say little. */
const SETTLE_MS = 4_000;
/** Consecutive bad readings (about 4 s) before stepping down. */
const BAD_READINGS = 2;
const UPGRADE_AFTER_MS = 15_000;
/** A step up that turns bad this soon was too much: wait twice as long before the next one. */
const PROBATION_MS = 20_000;
const MAX_UPGRADE_WAIT_MS = 120_000;
const LOSS_LIMIT = 0.05;
const FPS_SHARE = 0.6;
/** Queueing on a saturated link shows as round trips well above the best recent one. */
const RTT_RISE_MS = 250;
/**
 * The best round trip is taken over the last minute of readings, so a path that simply got
 * longer (another network, another relay) becomes the new normal instead of looking congested.
 */
const RTT_WINDOW = 30;
/**
 * A long round trip caps the picture even while nothing is lost: smaller frames reach the
 * screen sooner, and fewer packets go missing that would take a whole round trip to resend.
 * The cap stops at medium, which keeps 25 fps; only a struggling connection gets low's 15 fps.
 * Above 150 ms is also where the toolbar's indicator turns poor (stats.ts).
 */
const LATENCY_CAPS: readonly { aboveMs: number; quality: VideoQuality }[] = [
  { aboveMs: 150, quality: 'high' },
  { aboveMs: 250, quality: 'medium' },
];
/** A cap lifts only once the round trip is this far below its threshold, so a path near one does not flap. */
const LATENCY_HYSTERESIS_MS = 30;
/** The path's round trip is the median of the last readings (about 10 s): one spike is not a long path. */
const LATENCY_READINGS = 5;
const LATENCY_MIN_READINGS = 3;

/**
 * Chooses the live view's picture level from what the viewer receives. neko 3.0.8's own
 * estimator compares its bandwidth estimate in bits with the stream rate in bytes, so it only
 * steps down once bandwidth falls to about an eighth of the stream; the viewer decides instead.
 * A good connection keeps the sharpest level at full frame rate. A long round trip lowers the
 * sharpest level allowed to keep the view smooth (LATENCY_CAPS). Below that, it steps down after a
 * few seconds of dropped frames, loss, freezes or growing delay, and probes one level up again
 * after a quiet period, never above the preferred level or the path's cap.
 */
export class QualityController {
  private level: number;
  private max: number;
  private bad = 0;
  private goodSince: number | null = null;
  private settleUntil: number;
  private upgradeWait = UPGRADE_AFTER_MS;
  private lastUpgradeAt: number | null = null;
  private rtts: number[] = [];
  /** Index into VIDEO_QUALITIES of the sharpest level the path's round trip allows; 0 is no cap. */
  private latencyCap = 0;

  constructor(maxQuality: VideoQuality, now: number, current: VideoQuality = maxQuality) {
    this.max = VIDEO_QUALITIES.indexOf(maxQuality);
    this.level = Math.max(this.max, VIDEO_QUALITIES.indexOf(current));
    this.settleUntil = now + SETTLE_MS;
  }

  get quality(): VideoQuality {
    return VIDEO_QUALITIES[this.level]!;
  }

  /** The stream restarted (a new connection): give it time before judging it. */
  restart(now: number) {
    this.rtts = [];
    this.bad = 0;
    this.goodSince = null;
    this.settleUntil = now + SETTLE_MS;
  }

  /** Returns the level to switch to, or null to stay. */
  observe(s: QualitySample): VideoQuality | null {
    const bestRtt = this.rtts.length ? Math.min(...this.rtts) : null;
    if (s.rttMs !== null) this.rtts = [...this.rtts, s.rttMs].slice(-RTT_WINDOW);
    this.updateLatencyCap();
    if (s.at < this.settleUntil) return null;
    const ceiling = Math.max(this.max, this.latencyCap);
    if (this.level < ceiling) {
      // A long path: go straight to what it allows rather than waiting for frames to suffer. Its
      // round trip is the new baseline for growing delay, as on a path that simply got longer.
      this.stepUpFailed(s.at);
      this.rtts = [];
      return this.move(ceiling, s.at);
    }
    const expected = EXPECTED_FPS[this.quality];
    const struggling = s.stalled || s.lossRate > LOSS_LIMIT || s.freezes > 0 || (s.fps !== null && s.fps < expected * FPS_SHARE)
      || (s.rttMs !== null && bestRtt !== null && s.rttMs > bestRtt + RTT_RISE_MS);
    if (struggling) {
      this.goodSince = null;
      if (++this.bad < BAD_READINGS || this.level === VIDEO_QUALITIES.length - 1) return null;
      this.stepUpFailed(s.at);
      return this.move(this.level + 1, s.at);
    }
    this.bad = 0;
    this.goodSince ??= s.at;
    if (this.lastUpgradeAt !== null && s.at - this.lastUpgradeAt >= PROBATION_MS) {
      this.lastUpgradeAt = null;
      this.upgradeWait = UPGRADE_AFTER_MS;
    }
    if (this.level > ceiling && s.at - this.goodSince >= this.upgradeWait) {
      this.lastUpgradeAt = s.at;
      return this.move(this.level - 1, s.at);
    }
    return null;
  }

  /** A step down this soon after a step up means it was too much: wait twice as long next time. */
  private stepUpFailed(at: number) {
    if (this.lastUpgradeAt !== null && at - this.lastUpgradeAt < PROBATION_MS) this.upgradeWait = Math.min(this.upgradeWait * 2, MAX_UPGRADE_WAIT_MS);
    this.lastUpgradeAt = null; // that step up is over; only a surviving one resets the wait
  }

  private updateLatencyCap() {
    const recent = this.rtts.slice(-LATENCY_READINGS);
    if (recent.length < LATENCY_MIN_READINGS) return;
    const typical = [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)]!;
    let cap = 0;
    for (const { aboveMs, quality } of LATENCY_CAPS) {
      const level = VIDEO_QUALITIES.indexOf(quality);
      const threshold = level <= this.latencyCap ? aboveMs - LATENCY_HYSTERESIS_MS : aboveMs;
      if (typical > threshold) cap = Math.max(cap, level);
    }
    this.latencyCap = cap;
  }

  private move(level: number, now: number): VideoQuality {
    this.level = level;
    this.bad = 0;
    this.goodSince = null;
    this.settleUntil = now + SETTLE_MS;
    return this.quality;
  }
}
