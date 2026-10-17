import { z } from 'zod';

/** Server-sent event types on GET /v1/events. Each one tells the client which query to refresh. */
export const EventType = z.enum(['instance.updated', 'operation.updated', 'entitlements.updated']);
export type EventType = z.infer<typeof EventType>;

export const EventPayload = z.object({
  instanceId: z.string().optional(),
  operationId: z.string().optional(),
});
export type EventPayload = z.infer<typeof EventPayload>;
