import { z } from 'zod';

/**
 * Machine tiers. A browser's tier is chosen when it is created and never changes. The tiers differ
 * only in the VM: its vCPUs and memory (every launch candidate of a tier has the same). Every
 * browser streams the same live view (STREAM, images/browser/neko.yaml).
 */
export const BROWSER_TIERS = ['basic', 'premium'] as const;
export const BrowserTier = z.enum(BROWSER_TIERS);
export type BrowserTier = z.infer<typeof BrowserTier>;

export interface TierSpec {
  /** vCPUs and memory every launch candidate of the tier has (AWS: DEFAULT_TIER_INSTANCE_TYPES). */
  vcpu: number;
  memoryGb: number;
}

export const TIERS: Record<BrowserTier, TierSpec> = {
  basic: { vcpu: 2, memoryGb: 4 },
  premium: { vcpu: 4, memoryGb: 8 },
};

/** The live view every browser streams, whatever its tier. */
export interface StreamSpec {
  /** Frame rate of each picture level (VIDEO_QUALITIES in instances.ts), as images/browser/neko.yaml encodes it. */
  fps: { full: number; high: number; medium: number; low: number };
  /** Bitrate cap of each level in kbit/s, as images/browser/neko.yaml encodes it (H.264, constant quality under the cap). */
  kbps: { full: number; high: number; medium: number; low: number };
  /** The highest desktop refresh rate the viewer asks for: Chrome draws no faster than the desktop. */
  maxRefreshRate: number;
  /**
   * How the round trip to the browser limits the picture.
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
}

export const STREAM: StreamSpec = {
  fps: { full: 30, high: 30, medium: 15, low: 10 },
  kbps: { full: 3000, high: 1800, medium: 1200, low: 800 },
  maxRefreshRate: 30,
  // A long path has less room for bursts, so above about 180 ms the lighter 30 fps level is used.
  // The round trip alone never lowers the frame rate: at 300 ms with 1% loss the stream measured a
  // steady 30 fps. Fewer frames come only from what is measured: loss, frames missing, a queue.
  latency: { caps: [{ quality: 'high', aboveMs: 180, belowMs: 150 }], rising: { minMs: 300, factor: 0 } },
};
