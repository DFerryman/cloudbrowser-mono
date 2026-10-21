import { TIERS, VIDEO_QUALITIES, type TierSpec, type VideoQuality } from '@cloudbrowser/contracts';

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
  /** Share of the time since the previous reading the picture stood frozen, 0–1; null when unknown. */
  frozenShare?: number | null;
  rttMs: number | null;
  /**
   * Width of the decoded picture over the remote desktop's width (1 = full size); null when
   * either is unknown. Below MIN_LEGIBLE_SCALE ordinary page text blurs when the picture is
   * enlarged back to the desktop's size.
   */
  scale?: number | null;
}

/**
 * What the controller needs from the browser's tier: neko encodes at a constant rate whatever is
 * on screen, each tier's image at its own rate per level (TIERS[tier].fps: neko.yaml for Basic,
 * neko-premium.yaml for Premium), and each tier lets the round trip and stutter limit the picture
 * its own way (TIERS[tier].latency, TIERS[tier].freezeShare).
 */
export type StreamProfile = Pick<TierSpec, 'fps' | 'latency' | 'freezeShare'>;
/** A switch restarts the stream at a keyframe; readings right after it say little. */
const SETTLE_MS = 4_000;
/** Consecutive bad readings (about 6 s) before stepping down: brief hiccups keep the picture. */
const BAD_READINGS = 3;
/**
 * Readings before stepping down when no frame arrives at all or a fifth of the packets are lost:
 * the picture is frozen or falling apart, and waiting longer only keeps it so.
 */
const SEVERE_READINGS = 2;
const SEVERE_LOSS = 0.2;
const UPGRADE_AFTER_MS = 12_000;
/** A step up that turns bad this soon was too much: wait twice as long before the next one. */
const PROBATION_MS = 20_000;
const MAX_UPGRADE_WAIT_MS = 120_000;
const LOSS_LIMIT = 0.06;
const FPS_SHARE = 0.5;
/**
 * The best round trip is taken over the last minute of readings, so a path that simply got
 * longer (another network, another relay) becomes the new normal instead of looking congested.
 */
const RTT_WINDOW = 30;
/**
 * A long round trip can cap the picture even while nothing is lost (TIERS[tier].latency.caps;
 * Premium has none). Every level is full size (images/browser/neko.yaml), so a cap costs frame
 * rate, not sharpness. A cap lifts only once the round trip is back below its lower `belowMs`, so
 * a path near the threshold does not flap. Caps stop above low; only a struggling connection gets
 * low. The path's round trip is the median of the last readings (about 10 s): one spike is not a
 * long path.
 */
const LATENCY_READINGS = 5;
const LATENCY_MIN_READINGS = 3;
/**
 * The smallest picture, relative to the desktop, that keeps ordinary page text crisp. Every level
 * of the ladder in images/browser/neko.yaml is full size; on an older image whose lower levels
 * are downscaled pictures (75% or 50%), the viewer stays at full rather than blur the text.
 */
export const MIN_LEGIBLE_SCALE = 0.9;
/** Consecutive readings below MIN_LEGIBLE_SCALE before a level is ruled out; a resize can mislead one. */
const ILLEGIBLE_READINGS = 2;

/**
 * Chooses the live view's picture level from what the viewer receives. neko 3.0.8's own
 * estimator compares its bandwidth estimate in bits with the stream rate in bytes, so it only
 * steps down once bandwidth falls to about an eighth of the stream; the viewer decides instead.
 * A good connection keeps the sharpest level at full frame rate. On Basic a long round trip
 * lowers the sharpest level allowed (TIERS[tier].latency.caps). Below that, it steps down after a
 * few seconds of dropped frames, loss, stutter or growing delay (sooner when nothing decodes at
 * all), and probes one level up again after a quiet period, never above the preferred level or
 * the path's cap; a probe the path cannot carry is undone at its first bad reading. It never goes below
 * the lowest level whose picture keeps text readable (MIN_LEGIBLE_SCALE): a clear picture at a
 * lower frame rate is worth more than a smooth one nobody can read.
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
  /** Index of the lowest level allowed: a level whose picture proved too small to read is ruled out. */
  private floor = VIDEO_QUALITIES.length - 1;
  private illegible = 0;

  constructor(maxQuality: VideoQuality, now: number, current: VideoQuality = maxQuality, private readonly profile: StreamProfile = TIERS.basic) {
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
    if (s.scale != null && s.scale < MIN_LEGIBLE_SCALE && this.level > 0) {
      if (++this.illegible >= ILLEGIBLE_READINGS) {
        this.floor = Math.min(this.floor, this.level - 1);
        this.illegible = 0;
        return this.move(this.level - 1, s.at);
      }
    } else this.illegible = 0;
    const ceiling = Math.min(Math.max(this.max, this.latencyCap), Math.max(this.max, this.floor));
    if (this.level < ceiling) {
      // A long path: go straight to what it allows rather than waiting for frames to suffer. Its
      // round trip is the new baseline for growing delay, as on a path that simply got longer.
      this.stepUpFailed(s.at);
      this.rtts = [];
      return this.move(ceiling, s.at);
    }
    const expected = this.profile.fps[this.quality];
    const severe = s.stalled || s.fps === 0 || s.lossRate > SEVERE_LOSS;
    const struggling = severe || s.lossRate > LOSS_LIMIT || this.stuttering(s) || (s.fps !== null && s.fps < expected * FPS_SHARE)
      || this.queueBuilding(s.rttMs, bestRtt);
    if (struggling) {
      this.goodSince = null;
      // A step up still on probation goes back at the first bad reading: it was too much, and
      // every reading spent above what the path carries is a stalled picture.
      const onProbation = this.lastUpgradeAt !== null && s.at - this.lastUpgradeAt < PROBATION_MS;
      const needed = onProbation ? 1 : severe ? SEVERE_READINGS : BAD_READINGS;
      if (++this.bad < needed || this.level >= Math.max(this.max, this.floor)) return null;
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

  /** Freezes, or with TIERS[tier].freezeShare, more of the time frozen than that (by the count where the time is unknown). */
  private stuttering(s: QualitySample) {
    const share = this.profile.freezeShare;
    return share !== null && s.frozenShare != null ? s.frozenShare > share : s.freezes > 0;
  }

  /** Queueing on a saturated link shows as round trips well above the best recent one (TIERS[tier].latency.rising). */
  private queueBuilding(rttMs: number | null, bestRtt: number | null) {
    const rising = this.profile.latency.rising;
    return !!rising && rttMs !== null && bestRtt !== null && rttMs > bestRtt + Math.max(rising.minMs, bestRtt * rising.factor);
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
    for (const { aboveMs, belowMs, quality } of this.profile.latency.caps) {
      const level = VIDEO_QUALITIES.indexOf(quality);
      const threshold = level <= this.latencyCap ? belowMs : aboveMs;
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
