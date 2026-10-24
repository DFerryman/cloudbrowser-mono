import { STREAM, VIDEO_QUALITIES, type StreamSpec, type VideoQuality } from '@cloudbrowser/contracts';

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
  /** NACKs sent (lost packets asked for again) since the previous reading; null when unknown. */
  nacks?: number | null;
  /** Video received since the previous reading, in kbit/s; null when unknown. */
  kbps?: number | null;
  rttMs: number | null;
  /**
   * Width of the decoded picture over the remote desktop's width (1 = full size); null when
   * either is unknown. Below MIN_LEGIBLE_SCALE ordinary page text blurs when the picture is
   * enlarged back to the desktop's size.
   */
  scale?: number | null;
}

/**
 * What the controller needs from the stream: neko encodes at a constant rate whatever is on
 * screen, at its own rate per level (STREAM.fps, images/browser/neko.yaml), and the round trip
 * limits the picture (STREAM.latency).
 */
export type StreamProfile = StreamSpec;
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
/**
 * Every level streams at a constant bitrate (STREAM.kbps). While packets are lost or a queue
 * builds, what arrives is about what the path carries, so a step down goes straight to the
 * sharpest level that fits in this share of it, rather than one level per few seconds.
 */
const FIT_SHARE = 0.9;
const UPGRADE_AFTER_MS = 12_000;
/**
 * A level on trial (a step up, or the level a stream starts at) that turns bad this soon was too
 * much; a step up then waits twice as long before that level is tried again.
 */
const PROBATION_MS = 20_000;
const MAX_UPGRADE_WAIT_MS = 120_000;
/**
 * Where a stream starts when this device has held no level recently (levelMemory): one below
 * full. It is the same full-size picture at the same 30 fps on 1.8 instead of 3 Mbit/s, so a path
 * that carries about 2 Mbit/s starts without the 6–7 s of frozen picture full gave it before the
 * first step down (2 Mbit/s and 60 ms locally); a good path gets full after the usual quiet spell.
 */
export const START_QUALITY: VideoQuality = 'high';
/** A level carried this long without trouble, outside any trial, is the one a device holds. */
const HOLD_MS = 20_000;
/** A device moves between networks: what it held stands for its next stream for an hour. */
const MEMORY_MS = 60 * 60_000;
const MEMORY_KEY = 'cloudbrowser.viewer.level';
/** How often an unchanged held level is written again, to keep it from expiring. */
const MEMORY_REFRESH_MS = 60_000;
const LOSS_LIMIT = 0.06;
const FPS_SHARE = 0.5;
/**
 * A frame that waits for a resent packet waits about a round trip. From this round trip on, that
 * alone is a freeze at 30 fps (Chrome counts a frame more than 150 ms later than usual), and no
 * lower level shortens it. On a 230 ms path losing 1% of packets, views that stepped down to low
 * for those freezes showed 10 fps and froze longer than views held at high, which showed 20 fps
 * (5 s a minute against 2–4 s). So on a path this long, freezes while resends were asked for,
 * with nothing else wrong, are not trouble with the level.
 */
const RESEND_FREEZE_RTT_MS = 150;
/**
 * The best round trip is taken over the last minute of readings, so a path that simply got
 * longer (another network, another relay) becomes the new normal instead of looking congested.
 */
const RTT_WINDOW = 30;
/**
 * A long round trip can cap the picture even while nothing is lost (STREAM.latency.caps). Every level is full size (images/browser/neko.yaml), so a cap costs frame
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
/** Consecutive readings below MIN_LEGIBLE_SCALE before a level is ruled out. */
const ILLEGIBLE_READINGS = 2;
/**
 * How long after the desktop changes size the picture's scale says nothing about a level. neko
 * reports the new size at once, while frames of the old size keep arriving until its encoder has
 * restarted (and the receiver's statistics lag those): a reduced level then reads as a small
 * picture and was ruled out for the rest of the session, pinning the lowest level allowed above
 * what a congested path carries. Ignoring the scale for a while keeps the rule for what it is
 * for, an older image whose lower levels really are downscaled pictures, which stays so.
 */
const SCREEN_SETTLE_MS = 10_000;

/** The level a stream starts at: what this device held last (levelMemory), else START_QUALITY; never above the preference. */
export function startingQuality(preferred: VideoQuality, held: VideoQuality | null): VideoQuality {
  return VIDEO_QUALITIES[Math.max(VIDEO_QUALITIES.indexOf(preferred), VIDEO_QUALITIES.indexOf(held ?? START_QUALITY))]!;
}

let lastHeld: { quality: VideoQuality; at: number } | null = null;

/** The level this device last held (QualityController.held), in localStorage where there is one. */
export const levelMemory = {
  read(now: number): VideoQuality | null {
    try {
      const saved = JSON.parse(globalThis.localStorage?.getItem(MEMORY_KEY) ?? 'null') as { quality?: unknown; at?: unknown } | null;
      if (!saved || typeof saved.at !== 'number' || !(VIDEO_QUALITIES as readonly unknown[]).includes(saved.quality)) return null;
      return now - saved.at >= 0 && now - saved.at < MEMORY_MS ? saved.quality as VideoQuality : null;
    } catch {
      return null; // Storage blocked or unreadable: the stream starts at START_QUALITY.
    }
  },
  write(quality: VideoQuality, now: number) {
    if (lastHeld?.quality === quality && now - lastHeld.at < MEMORY_REFRESH_MS) return;
    lastHeld = { quality, at: now };
    try {
      globalThis.localStorage?.setItem(MEMORY_KEY, JSON.stringify({ quality, at: now }));
    } catch {
      // Not remembered: the next stream starts at START_QUALITY.
    }
  },
};

/**
 * Chooses the live view's picture level from what the viewer receives. neko 3.0.8's own
 * estimator compares its bandwidth estimate in bits with the stream rate in bytes, so it only
 * steps down once bandwidth falls to about an eighth of the stream; the viewer decides instead.
 * A good connection keeps the sharpest level at full frame rate. On Basic a long round trip
 * lowers the sharpest level allowed (STREAM.latency.caps). Below that, it steps down after a
 * few seconds of dropped frames, loss, stutter or growing delay (sooner when nothing decodes at
 * all), and probes one level up again after a quiet period, never above the preferred level or
 * the path's cap. A level on trial (a probe, or the level a stream starts at) that the path
 * plainly cannot carry ends at its first reading, settling or not, and a failed probe's level
 * waits longer before it is tried again. It never goes below
 * the lowest level whose picture keeps text readable (MIN_LEGIBLE_SCALE): a clear picture at a
 * lower frame rate is worth more than a smooth one nobody can read.
 */
export class QualityController {
  private level: number;
  private max: number;
  private bad = 0;
  private goodSince: number | null = null;
  private settleUntil: number;
  /** How long a level waits, after a quiet spell begins, before it is tried: by index into VIDEO_QUALITIES. */
  private readonly waits = VIDEO_QUALITIES.map(() => UPGRADE_AFTER_MS);
  /** The level on trial since `at`: a step up (probe), or the level a stream started at. */
  private trial: { at: number; probe: boolean } | null;
  private rtts: number[] = [];
  /** Index into VIDEO_QUALITIES of the sharpest level the path's round trip allows; 0 is no cap. */
  private latencyCap = 0;
  /** Index of the lowest level allowed: a level whose picture proved too small to read is ruled out. */
  private floor = VIDEO_QUALITIES.length - 1;
  private illegible = 0;
  /** Scale readings before this mean nothing: the desktop changed size (screenChanged). */
  private scaleSettleUntil = -Infinity;
  /** The least the path carried while congested in the current run of bad readings, kbit/s. */
  private carried: number | null = null;

  constructor(maxQuality: VideoQuality, now: number, current: VideoQuality = maxQuality, private readonly profile: StreamProfile = STREAM) {
    this.max = VIDEO_QUALITIES.indexOf(maxQuality);
    this.level = Math.max(this.max, VIDEO_QUALITIES.indexOf(current));
    this.settleUntil = now + SETTLE_MS;
    this.trial = { at: now, probe: false };
  }

  get quality(): VideoQuality {
    return VIDEO_QUALITIES[this.level]!;
  }

  /** The stream restarted (a new connection): give it time before judging it, and try its level again. */
  restart(now: number) {
    this.rtts = [];
    this.bad = 0;
    this.carried = null;
    this.goodSince = null;
    this.settleUntil = now + SETTLE_MS;
    this.trial = { at: now, probe: false };
  }

  /**
   * The level this stream has carried without trouble for HOLD_MS, outside any trial; null
   * otherwise, and while a lower preference holds it there: the path may carry more.
   */
  held(now: number): VideoQuality | null {
    if (this.level === this.max && this.max > 0) return null;
    return this.trial === null && this.goodSince !== null && now - this.goodSince >= HOLD_MS ? this.quality : null;
  }

  /** The remote desktop changed size (or a new session reported its own): see SCREEN_SETTLE_MS. */
  screenChanged(now: number) {
    this.scaleSettleUntil = now + SCREEN_SETTLE_MS;
    this.illegible = 0;
  }

  /** Returns the level to switch to, or null to stay. */
  observe(s: QualitySample): VideoQuality | null {
    const bestRtt = this.rtts.length ? Math.min(...this.rtts) : null;
    if (s.rttMs !== null) this.rtts = [...this.rtts, s.rttMs].slice(-RTT_WINDOW);
    this.updateLatencyCap();
    const trial = this.trial !== null && s.at - this.trial.at < PROBATION_MS ? this.trial : null;
    // Far more sent than arrives: the shaper drops a fifth of it, or its queue keeps growing.
    const overloaded = s.lossRate > SEVERE_LOSS || this.queueBuilding(s.rttMs, bestRtt);
    if (s.at < this.settleUntil) {
      // A level on trial that the path plainly cannot carry ends now: waiting out the settling
      // time only keeps its picture frozen (about 6 s per failed probe of full at 2 Mbit/s).
      if (!trial || !overloaded) return null;
      if (s.kbps != null && s.kbps > 0) this.carried = Math.min(this.carried ?? Infinity, s.kbps);
      return this.stepDown(s.at);
    }
    const scale = s.at < this.scaleSettleUntil ? null : s.scale;
    if (scale != null && scale < MIN_LEGIBLE_SCALE && this.level > 0) {
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
    const resent = (s.nacks ?? 0) > 0 && bestRtt !== null && bestRtt >= RESEND_FREEZE_RTT_MS;
    const struggling = severe || s.lossRate > LOSS_LIMIT || (s.freezes > 0 && !resent) || (s.fps !== null && s.fps < expected * FPS_SHARE)
      || this.queueBuilding(s.rttMs, bestRtt);
    if (struggling) {
      this.goodSince = null;
      const congested = s.lossRate > LOSS_LIMIT || this.queueBuilding(s.rttMs, bestRtt);
      if (congested && s.kbps != null && s.kbps > 0) this.carried = Math.min(this.carried ?? Infinity, s.kbps);
      // A step up still on probation goes back at the first bad reading: it was too much, and
      // every reading spent above what the path carries is a stalled picture. So does a starting
      // level the path plainly cannot carry.
      const needed = trial && (trial.probe || overloaded) ? 1 : severe ? SEVERE_READINGS : BAD_READINGS;
      if (++this.bad < needed) return null;
      return this.stepDown(s.at);
    }
    this.bad = 0;
    this.carried = null;
    this.goodSince ??= s.at;
    if (this.trial && !trial) {
      // The level held: a probe of it that later fails waits the usual time again.
      if (this.trial.probe) this.waits[this.level] = UPGRADE_AFTER_MS;
      this.trial = null;
    }
    if (this.level > ceiling && s.at - this.goodSince >= this.waits[this.level - 1]!) {
      this.move(this.level - 1, s.at);
      this.trial = { at: s.at, probe: true };
      return this.quality;
    }
    return null;
  }

  /**
   * Down to the sharpest level that fits what the path carried, or one below. A failed probe goes
   * no further back than the level it came from unless that does not fit either: right after
   * the try, its backlog of resends and keyframes needs room (back to high from full at 2 Mbit/s
   * stayed frozen another 6 s; medium recovered within a reading).
   */
  private stepDown(at: number): VideoQuality | null {
    const lowest = Math.max(this.max, this.floor);
    if (this.level >= lowest) return null;
    this.stepUpFailed(at);
    return this.move(Math.min(lowest, this.fitting(this.carried)), at);
  }

  /** One level down, or further: the sharpest level whose bitrate fits what the path carried. */
  private fitting(carriedKbps: number | null) {
    let next = this.level + 1;
    if (carriedKbps === null) return next;
    while (next < VIDEO_QUALITIES.length - 1 && this.profile.kbps[VIDEO_QUALITIES[next]!] > carriedKbps * FIT_SHARE) next++;
    return next;
  }

  /** Queueing on a saturated link shows as round trips well above the best recent one (STREAM.latency.rising). */
  private queueBuilding(rttMs: number | null, bestRtt: number | null) {
    const rising = this.profile.latency.rising;
    return !!rising && rttMs !== null && bestRtt !== null && rttMs > bestRtt + Math.max(rising.minMs, bestRtt * rising.factor);
  }

  /**
   * A step down this soon after a step up means it was too much: that level waits twice as long
   * before its next try, however the levels below it fare. Any step down ends the trial.
   */
  private stepUpFailed(at: number) {
    const trial = this.trial;
    if (trial?.probe && at - trial.at < PROBATION_MS) {
      this.waits[this.level] = Math.min(this.waits[this.level]! * 2, MAX_UPGRADE_WAIT_MS);
    }
    this.trial = null;
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
    this.carried = null;
    this.goodSince = null;
    this.settleUntil = now + SETTLE_MS;
    this.trial = null;
    return this.quality;
  }
}
