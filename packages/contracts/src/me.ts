import { z } from 'zod';
import { Plan } from './billing.js';

export const Entitlements = z.object({
  /** `pilot`: invite-only defaults; `personal`/`pro`: a Creem subscription; `none`: no access. */
  plan: Plan,
  maxBrowsers: z.number().int(),
  maxRunning: z.number().int(),
  idleTimeoutMaxS: z.number().int(),
  ipChangesPerMonth: z.number().int(),
  /** Active (running) hours per calendar month; null means unlimited. */
  hoursPerMonth: z.number().int().nullable(),
});
export type Entitlements = z.infer<typeof Entitlements>;

export const Me = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  entitlements: Entitlements,
  usage: z.object({ browsers: z.number().int(), running: z.number().int(), hoursUsed: z.number() }),
});
export type Me = z.infer<typeof Me>;
