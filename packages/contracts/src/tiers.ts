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
}

export const TIERS: Record<BrowserTier, TierSpec> = {
  basic: { vcpu: 2, memoryGb: 4, fps: { full: 25, high: 20, medium: 15, low: 10 }, maxRefreshRate: 30 },
  premium: { vcpu: 4, memoryGb: 8, fps: { full: 60, high: 30, medium: 20, low: 10 }, maxRefreshRate: 60 },
};
