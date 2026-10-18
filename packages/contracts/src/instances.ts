import { z } from 'zod';
import { RegionId } from './regions.js';
import { OperationSummary } from './operations.js';
import { TrialState } from './billing.js';

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

export const IDLE_TIMEOUT_OPTIONS_S = [300, 600, 900, 1800, 3600] as const;
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
export const ScreenSize = z.enum(SCREEN_SIZES);

export const BrowserLocale = z.enum(['zh-CN', 'en-US', 'ja-JP']);
export type BrowserLocale = z.infer<typeof BrowserLocale>;

export const InstanceName = z.string().trim().min(1).max(64);

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
  status: InstanceStatus,
  /** Short reason for failed / needs_attention / provider_issue states. */
  statusReason: z.string().nullable(),
  desiredState: DesiredState,
  idleTimeoutS: z.number().int(),
  locale: BrowserLocale,
  screen: ScreenSize,
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
  /** Daily provider snapshots of the data volume, billed per GB-month. Off by default. */
  backupsEnabled: z.boolean(),
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

/** The price version (`priceVersion` in pricing.ts) the user saw; refused with `price_changed` if stale. */
export const PriceVersion = z.string().min(1).max(200);

export const CreateInstanceBody = z.object({
  name: InstanceName,
  regionId: RegionId,
  locale: BrowserLocale.optional(),
  screen: ScreenSize.optional(),
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
    idleTimeoutS: z.number().int().min(60).max(3600).optional(),
    screen: ScreenSize.optional(),
    locale: BrowserLocale.optional(),
    /** Turning snapshots on starts a monthly charge; turning them off deletes the snapshots. */
    backupsEnabled: z.boolean().optional(),
    priceVersion: PriceVersion.optional(),
  })
  .strict();
export type UpdateInstanceBody = z.infer<typeof UpdateInstanceBody>;

export const IpChangeRequestBody = z.object({
  /** Must be true: a new IP is only ever issued on a confirmed user request. */
  confirm: z.literal(true),
  priceVersion: PriceVersion,
});

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
  /** Why it cannot grow now: `state` (not running or sleeping), `cooldown` (6 hours between changes), `agent` (browser created before storage could grow), `max`. */
  blockedReason: z.enum(['state', 'cooldown', 'agent', 'max', 'busy', 'trial']).nullable(),
  nextResizeAt: z.string().nullable(),
  snapshots: z.object({ count: z.number().int(), retentionDays: z.number().int() }),
});
export type InstanceStorage = z.infer<typeof InstanceStorage>;
