import { z } from 'zod';
import { RegionId } from './regions.js';
import { OperationSummary } from './operations.js';
import { TrialState } from './billing.js';
import { BrowserTier } from './tiers.js';

/**
 * Engine-owned lifecycle status (page 2, "Instance lifecycle").
 * `purged` rows are kept for history and never returned by the list endpoint.
 */
export const InstanceStatus = z.enum([
  'creating',
  'running',
  'stopping',
  'sleeping',
  'starting',
  'waiting_capacity',
  'provider_issue',
  'needs_attention',
  'failed',
  'deleting',
  'purged',
]);
export type InstanceStatus = z.infer<typeof InstanceStatus>;

/** User intent, owned by the api. */
export const DesiredState = z.enum(['running', 'stopped', 'deleted']);
export type DesiredState = z.infer<typeof DesiredState>;

/** Zero disables inactivity sleep; billing and trial limits still apply. */
export const NEVER_SLEEP_TIMEOUT_S = 0;
export const IDLE_TIMEOUT_OPTIONS_S = [300, 600, 900, 1800, 3600, NEVER_SLEEP_TIMEOUT_S] as const;
export const DEFAULT_IDLE_TIMEOUT_S = 600;

export const SCREEN_SIZES = [
  'auto',
  '1280x720',
  '1366x768',
  '1440x900',
  '1536x864',
  '1600x900',
  '1920x1080',
  '2560x1440',
] as const;
/** Deprecated: never applied. The remote screen follows the viewer's size. */
export const ScreenSize = z.enum(SCREEN_SIZES);

/**
 * Picture levels of the live view, sharpest first (neko video ids, images/browser/neko.yaml and
 * neko-premium.yaml). Every level shows the same desktop at the same size in the viewer; a lower
 * level gives up frame rate first (TIERS[tier].fps) and a little fine detail second. The viewer
 * picks the level from the connection; there is no per-browser setting.
 */
export const VIDEO_QUALITIES = ['full', 'high', 'medium', 'low'] as const;
export const VideoQuality = z.enum(VIDEO_QUALITIES);
export type VideoQuality = z.infer<typeof VideoQuality>;


export const InstanceName = z.string().trim().min(1).max(64);

export const StopReason = z.enum(['balance', 'operator', 'suspended', 'frozen']);
export type StopReason = z.infer<typeof StopReason>;

export const IpCheck = z.object({
  ok: z.boolean(),
  expected: z.string().nullable(),
  observed: z.array(z.string()),
  checkedAt: z.string(),
  detail: z.string().optional(),
});
export type IpCheck = z.infer<typeof IpCheck>;

export const Instance = z.object({
  id: z.string(),
  name: z.string(),
  regionId: RegionId,
  /** Machine tier, fixed at creation (TIERS). */
  tier: BrowserTier,
  status: InstanceStatus,
  /** Short reason for failed / needs_attention / provider_issue states. */
  statusReason: z.string().nullable(),
  desiredState: DesiredState,
  /**
   * Inactivity timeout in seconds; zero means never sleep. Never sleep is offered only to paid,
   * topped-up accounts with credit for 24 hours of continuous running (see NeverSleepQuote).
   */
  idleTimeoutS: z.number().int(),
  screen: ScreenSize,
  /**
   * Deprecated, always full and adapting: the picture setting was removed. Live views opened
   * before that release still read these to choose their stream; drop them in a later release.
   */
  videoQuality: z.literal('full'),
  videoAuto: z.literal(true),
  /** The dedicated outbound IPv4 address; null until allocated. */
  ipAddress: z.string().nullable(),
  dedicatedSince: z.string().nullable(),
  lastIpCheck: IpCheck.nullable(),
  lastActiveAt: z.string().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  purgeAfter: z.string().nullable(),
  currentOperation: OperationSummary.nullable(),
  /** Size of the data volume in GB (the system disk is extra, see pricing). */
  storageGb: z.number().int(),
  /**
   * Why a sleeping browser was stopped when neither the user nor auto-sleep did it: credit ran
   * out, an administrator stopped or suspended it, or the account was frozen. Null otherwise.
   * Such a browser is never woken automatically; the user resumes it.
   */
  stopReason: StopReason.nullable(),
  /** Set while credit has run out: the browser is permanently deleted at this time unless credit is added. */
  deletesAt: z.string().nullable(),
  /** Set for the free trial browser: free until converted by adding credit (see TRIAL). */
  trial: z
    .object({
      state: TrialState,
      secondsLeft: z.number().int(),
      /** A trial browser is deleted at this time unless the user adds credit first. */
      reclaimAt: z.string().nullable(),
    })
    .nullable(),
});
export type Instance = z.infer<typeof Instance>;

/**
 * What switching a browser to Never sleep costs and whether the account may (GET
 * /instances/{id}/never-sleep). The client shows `day` and sends `priceVersion` back to confirm.
 */
export const NeverSleepQuote = z.object({
  allowed: z.boolean(),
  /**
   * Why not: `disabled` by the operator, a free `trial` browser, `no_topup` on the account yet,
   * `insufficient_credit` for the first 24 hours, or `price_unavailable`.
   */
  reason: z.enum(['disabled', 'trial', 'no_topup', 'insufficient_credit', 'price_unavailable']).nullable(),
  regionId: RegionId,
  priceVersion: z.string().nullable(),
  /** This browser running continuously for 24 hours in its region. */
  day: z.object({
    computeMicros: z.number().int(),
    ipMicros: z.number().int(),
    storageMicros: z.number().int(),
    totalMicros: z.number().int(),
  }),
  availableMicros: z.number().int(),
  /** Available credit needed first: 24 hours of the account's spending with this browser always on. */
  requiredMicros: z.number().int(),
});
export type NeverSleepQuote = z.infer<typeof NeverSleepQuote>;

/** The price version (`priceVersion` in pricing.ts) the user saw; refused with `price_changed` if stale. */
export const PriceVersion = z.string().min(1).max(200);

export const CreateInstanceBody = z.object({
  name: InstanceName,
  regionId: RegionId,
  /** Basic unless given. Premium needs the operator's `premium` switch and is never a free trial. */
  tier: BrowserTier.optional(),
  screen: ScreenSize.optional(),
  /** The version of the chosen tier's prices (RegionPricing, or its `premium`). */
  priceVersion: PriceVersion,
  /** Data volume size shown in the quote; must still match the default size when confirmed. */
  storageGb: z.number().int().min(1).max(16_384),
  /** Use the one free trial (TRIAL): only in its region, once per user. */
  trial: z.boolean().optional(),
});
export type CreateInstanceBody = z.infer<typeof CreateInstanceBody>;

/** Region is intentionally absent: it never changes after creation. */
export const UpdateInstanceBody = z
  .object({
    name: InstanceName.optional(),
    idleTimeoutS: z.union([z.literal(NEVER_SLEEP_TIMEOUT_S), z.number().int().min(60).max(3600)]).optional(),
    screen: ScreenSize.optional(),
    priceVersion: PriceVersion.optional(),
  })
  .strict();
export type UpdateInstanceBody = z.infer<typeof UpdateInstanceBody>;

/** Grow the data volume (never shrink). AWS allows one change every 6 hours. */
export const ResizeStorageBody = z.object({
  sizeGb: z.number().int().min(1).max(16_384),
  priceVersion: PriceVersion,
});

export const InstanceStorage = z.object({
  sizeGb: z.number().int(),
  rootVolumeGb: z.number().int(),
  maxGb: z.number().int(),
  /** Reported by the browser's agent while it runs; null until the first report. */
  usedBytes: z.number().int().nullable(),
  totalBytes: z.number().int().nullable(),
  reportedAt: z.string().nullable(),
  resizable: z.boolean(),
  /** Why it cannot grow now: `state` (not running or sleeping), `cooldown` (four attempts per rolling 24 hours), `agent` (browser created before storage could grow), `max`. */
  blockedReason: z.enum(['state', 'cooldown', 'agent', 'max', 'busy', 'trial']).nullable(),
  nextResizeAt: z.string().nullable(),
});
export type InstanceStorage = z.infer<typeof InstanceStorage>;
