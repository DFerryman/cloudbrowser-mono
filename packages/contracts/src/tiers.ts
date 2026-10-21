import { z } from 'zod';

/**
 * Machine tiers. A browser's tier is chosen when it is created and never changes: it decides the
 * VM it runs on (every launch candidate of a tier has the same vCPUs and memory) and the live
 * view it streams. Basic is the original 2 vCPU / 4 GB browser streaming VP8 at up to 25 fps;
 * Premium runs on 4 vCPU / 8 GB and streams H.264 at up to 60 fps from a 60 Hz desktop
 * (images/browser/neko-premium.yaml), the frame rate of a local screen.
 */
export const BROWSER_TIERS = ['basic', 'premium'] as const;
export const BrowserTier = z.enum(BROWSER_TIERS);
export type BrowserTier = z.infer<typeof BrowserTier>;

export interface TierSpec {
  /** vCPUs and memory every launch candidate of the tier has (AWS: DEFAULT_TIER_INSTANCE_TYPES). */
  vcpu: number;
  memoryGb: number;
  /**
   * Frame rate of each picture level (VIDEO_QUALITIES in instances.ts), as the browser image
   * encodes it: neko.yaml for Basic, neko-premium.yaml for Premium.
   */
  fps: { full: number; high: number; medium: number; low: number };
  /** The highest desktop refresh rate the viewer asks for: Chrome draws no faster than the desktop. */
  maxRefreshRate: number;
  /**
   * How the round trip to the browser limits the picture. A long path alone is no reason for
   * fewer frames: a lower frame rate does not bring the picture sooner (it adds the wait for the
   * next frame), and what does call for one (lost packets, freezes, frames not arriving) is
   * measured directly at every latency.
   * - `caps`: above `aboveMs` (median of the last readings) the picture goes no higher than
   *   `quality`, until the round trip is back below `belowMs`.
   * - `rising`: delay growing past the path's best round trip of the last minute means more is
   *   being sent than the path carries (a queue is building), once it has grown by more than
   *   `minMs` and by more than `factor` times that best round trip. Null ignores it.
   */
  latency: {
    caps: readonly { quality: 'high' | 'medium'; aboveMs: number; belowMs: number }[];
    rising: { minMs: number; factor: number } | null;
  };
  /**
   * How much stutter the picture tolerates before stepping down: the share of the time the
   * picture stood frozen. A lost packet is resent within one round trip, so on a long path one
   * loss is one short freeze; counting freezes would step down for every one of them, the
   * longer the path, the sooner. Null steps down on any freeze.
   */
  freezeShare: number | null;
}

export const TIERS: Record<BrowserTier, TierSpec> = {
  basic: {
    vcpu: 2, memoryGb: 4, fps: { full: 25, high: 20, medium: 15, low: 10 }, maxRefreshRate: 30,
    latency: { caps: [{ quality: 'high', aboveMs: 180, belowMs: 150 }, { quality: 'medium', aboveMs: 320, belowMs: 290 }], rising: { minMs: 300, factor: 0 } },
    freezeShare: null,
  },
  // Frame rate is independent of the path's length: 60 fps at any round trip while frames keep
  // arriving. A queue still counts, judged against the path (a long path jitters more), and so
  // does stutter, once the picture stands frozen more than a tenth of the time. The ladder gives
  // up bitrate before frame rate: high is still 60 fps, under a lower bitrate cap.
  premium: {
    vcpu: 4, memoryGb: 8, fps: { full: 60, high: 60, medium: 30, low: 20 }, maxRefreshRate: 60,
    latency: { caps: [], rising: { minMs: 300, factor: 1 } },
    freezeShare: 0.1,
  },
};
