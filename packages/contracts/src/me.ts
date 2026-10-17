import { z } from 'zod';

export const Entitlements = z.object({
  plan: z.enum(['pilot']),
  maxBrowsers: z.number().int(),
  maxRunning: z.number().int(),
  idleTimeoutMaxS: z.number().int(),
  ipChangesPerMonth: z.number().int(),
});
export type Entitlements = z.infer<typeof Entitlements>;

export const Me = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  entitlements: Entitlements,
  usage: z.object({ browsers: z.number().int(), running: z.number().int() }),
});
export type Me = z.infer<typeof Me>;
