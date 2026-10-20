import { z } from 'zod';
import { BillingMode } from './billing.js';

export const Entitlements = z.object({
  /** `pilot`: free invite-only pilot; `prepaid`: usage is taken from the prepaid balance. */
  billing: BillingMode,
  maxBrowsers: z.number().int(),
  maxRunning: z.number().int(),
  idleTimeoutMaxS: z.number().int(),
  /** Whether the operator offers Never sleep to this account (`never_sleep` cap). */
  neverSleep: z.boolean(),
  /** Whether the operator offers Premium browsers to this account (`premium` cap). */
  premium: z.boolean(),
  /** The most a browser's storage can grow to, in GB. */
  maxStorageGb: z.number().int(),
});
export type Entitlements = z.infer<typeof Entitlements>;

export const Me = z.object({
  /** `twoFactorEnabled`: sign-in also asks for a code from an authenticator app. */
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), twoFactorEnabled: z.boolean().optional() }),
  entitlements: Entitlements,
  usage: z.object({ browsers: z.number().int(), running: z.number().int() }),
});
export type Me = z.infer<typeof Me>;
