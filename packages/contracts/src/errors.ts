import { z } from 'zod';

/**
 * Stable error `type` codes (RFC 9457). The web app maps each code to a translated message,
 * so codes are only ever added, never renamed.
 */
export const ErrorType = z.enum([
  'unauthenticated',
  'not_invited',
  'forbidden',
  'not_found',
  'validation_failed',
  'idempotency_key_required',
  'idempotency_key_reused',
  'operation_in_progress',
  'invalid_state',
  'plan_limit',
  'region_unavailable',
  'capacity_unavailable',
  'spend_guard_active',
  'creation_frozen',
  'ip_change_limit',
  'viewer_unavailable',
  'internal',
]);
export type ErrorType = z.infer<typeof ErrorType>;

export const Problem = z.object({
  type: ErrorType,
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  /** Extra machine-readable fields, e.g. the id of the operation already in progress. */
  operationId: z.string().optional(),
  limit: z.string().optional(),
});
export type Problem = z.infer<typeof Problem>;
