import { VIDEO_QUALITIES, type VideoQuality } from '@cloudbrowser/contracts';

/** What the browser's settings ask for: the sharpest level, and whether to adapt below it. */
export interface VideoPreference {
  quality: VideoQuality;
  auto: boolean;
}

/** One reading of the receiving side (every 2 s), as changes since the previous reading. */
export interface QualitySample {
  at: number;
  /** Frames decoded per second; null when none were. */
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
/** Queueing on a saturated link shows as round trips well above the best one seen. */
const RTT_RISE_MS = 250;

/**
 * Chooses the live view's picture level from what the viewer receives. neko 3.0.8's own
 * estimator compares its bandwidth estimate in bits with the stream rate in bytes, so it only
 * steps down once bandwidth falls to about an eighth of the stream; the viewer decides instead.
 * It steps down after a few seconds of dropped frames, loss, freezes or growing delay, and
 * probes one level up again after a quiet period, never above the browser's setting.
 */
export class QualityController {
  private level: number;
  private max: number;
  private bad = 0;
  private goodSince: number | null = null;
  private settleUntil: number;
  private upgradeWait = UPGRADE_AFTER_MS;
  private lastUpgradeAt: number | null = null;
  private bestRtt = Infinity;

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
    this.bad = 0;
    this.goodSince = null;
    this.settleUntil = now + SETTLE_MS;
  }

  /** Returns the level to switch to, or null to stay. */
  observe(s: QualitySample): VideoQuality | null {
    if (s.rttMs !== null) this.bestRtt = Math.min(this.bestRtt, s.rttMs);
    if (s.at < this.settleUntil) return null;
    const expected = EXPECTED_FPS[this.quality];
    const struggling = s.lossRate > LOSS_LIMIT || s.freezes > 0 || s.fps === null || s.fps < expected * FPS_SHARE
      || (s.rttMs !== null && Number.isFinite(this.bestRtt) && s.rttMs > this.bestRtt + RTT_RISE_MS);
    if (struggling) {
      this.goodSince = null;
      if (++this.bad < BAD_READINGS || this.level === VIDEO_QUALITIES.length - 1) return null;
      if (this.lastUpgradeAt !== null && s.at - this.lastUpgradeAt < PROBATION_MS) this.upgradeWait = Math.min(this.upgradeWait * 2, MAX_UPGRADE_WAIT_MS);
      this.lastUpgradeAt = null; // that step up is over; only a surviving one resets the wait
      return this.move(this.level + 1, s.at);
    }
    this.bad = 0;
    this.goodSince ??= s.at;
    if (this.lastUpgradeAt !== null && s.at - this.lastUpgradeAt >= PROBATION_MS) {
      this.lastUpgradeAt = null;
      this.upgradeWait = UPGRADE_AFTER_MS;
    }
    if (this.level > this.max && s.at - this.goodSince >= this.upgradeWait) {
      this.lastUpgradeAt = s.at;
      return this.move(this.level - 1, s.at);
    }
    return null;
  }

  private move(level: number, now: number): VideoQuality {
    this.level = level;
    this.bad = 0;
    this.goodSince = null;
    this.settleUntil = now + SETTLE_MS;
    return this.quality;
  }
}
