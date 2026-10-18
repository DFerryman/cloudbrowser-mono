import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema.js';

export * as schema from './schema.js';
export type { Fingerprint } from './schema.js';
export { newId, sha256Hex } from './ids.js';
export { operationRow, OPERATION_DEADLINE_MIN, type OperationMessage, type AgentCommandsMessage } from './operations.js';

export type Db = DrizzleD1Database<typeof schema>;

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

/** A change-feed row for the user's SSE stream (stands in for NOTIFY). */
export function eventRow(userId: string, type: string, data: Record<string, unknown>, now = new Date()) {
  return { userId, type, data, createdAt: now };
}
export { newArchiveKey, wrapArchiveKey, unwrapArchiveKey } from './archive-keys.js';
export { userCaps, billingRequired, usageMonth, usageDay } from './caps.js';
export { pricingSettings, priceSheets, type StoredSheet } from './pricing.js';
export { raiseAlert, type AlertSeverity } from './alerts.js';
