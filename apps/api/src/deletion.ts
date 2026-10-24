/**
 * Permanent deletion of one of the signed-in user's browsers: DELETE /v1/instances/{id}, and every
 * browser of an account being closed (closure.ts).
 */
import { schema, settleRunningStatements, type Db } from '@cloudbrowser/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Context } from 'hono';
import { revokeInstanceClientsStatements } from './automation.js';
import type { AppEnv } from './env.js';
import { enqueueOperation } from './ops.js';

const { browserInstances, viewerSessions, agentCredentials, archiveKeys, agentCommands, auditLog } = schema;

/** What accepting a permanent deletion changes, in the same batch as the delete operation. */
export function permanentDeleteStatements(db: Db, instanceId: string, now: Date): BatchItem<'sqlite'>[] {
  return [
    ...settleRunningStatements(db, instanceId, now),
    db.update(browserInstances).set({ status: 'deleting', desiredState: 'deleted', deletedAt: sql`coalesce(${browserInstances.deletedAt}, ${now.getTime()})`, purgeAfter: sql`min(coalesce(${browserInstances.purgeAfter}, ${now.getTime()}), ${now.getTime()})`, updatedAt: now }).where(eq(browserInstances.id, instanceId)),
    db.update(viewerSessions).set({ endedAt: now }).where(and(eq(viewerSessions.instanceId, instanceId), isNull(viewerSessions.endedAt))),
    db.update(agentCredentials).set({ credentialHash: null, bootstrapHash: null, bootstrapExpiresAt: null, rotatedAt: now }).where(eq(agentCredentials.instanceId, instanceId)),
    db.update(archiveKeys).set({ wrappedKey: null, destroyedAt: now }).where(eq(archiveKeys.instanceId, instanceId)),
    db.update(schema.browserReservations).set({ reservedMicros: 0, updatedAt: now }).where(eq(schema.browserReservations.instanceId, instanceId)),
    db.update(agentCommands).set({ status: 'failed', reply: { error: 'Browser permanently deleted.' }, completedAt: now }).where(and(eq(agentCommands.instanceId, instanceId), isNull(agentCommands.completedAt))),
    ...revokeInstanceClientsStatements(db, instanceId, now),
  ];
}

export async function deleteBrowserPermanently(c: Context<AppEnv>, row: typeof browserInstances.$inferSelect, key: string, route: string, detail: Record<string, unknown> = {}) {
  const db = c.get('db');
  const now = new Date();
  const result = await enqueueOperation(c, {
    instanceId: row.id,
    kind: 'delete',
    priority: 'delete',
    key,
    route,
    params: { reason: 'user', purgeNow: true },
    // One transaction: accepting a permanent deletion also invalidates every route back to the
    // profile. Provider deletion is asynchronous and may be retried; access never waits for it.
    before: permanentDeleteStatements(db, row.id, now),
    after: [db.insert(auditLog).values({ actor: `user:${c.get('user').id}`, action: 'instance.delete_requested', target: `instance:${row.id}`, detail: { permanent: true, ...detail }, createdAt: now })],
  });
  // Existing WebRTC sessions outlive their short-lived entry tokens. Close their signaling
  // sockets now as well; the gateway's per-frame database checks are the lost-RPC backstop.
  await c.env.GATEWAY?.revokeInstance(row.id).catch((e: unknown) => console.error('revoke deleted browser connections failed', row.id, e));
  return result;
}
