import { createDb, operationRow, schema } from '@cloudbrowser/db';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env.js';
import { enqueueOperation, systemOperation } from '../src/ops.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>;
let db: ReturnType<typeof createDb>;
let userId: string;
let context: Context<AppEnv>;
const browserId = 'browser-preempt';

beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec(`INSERT INTO invites (email) VALUES ('owner@example.com')`);
  await signIn(t, 'owner@example.com');
  userId = (t.d1.sqlite.prepare("SELECT id FROM user WHERE email = 'owner@example.com'").get() as { id: string }).id;
  db = createDb(t.d1 as never);
  await db.insert(schema.browserInstances).values({ id: browserId, userId, name: 'Private browser', regionId: 'tyo1', status: 'running', desiredState: 'running', idleTimeoutS: 600, locale: 'en-US', screen: 'auto', fingerprint: { timezone: 'Asia/Tokyo', locale: 'en-US', screen: 'auto', chromeMajor: null }, createdAt: new Date(), updatedAt: new Date() });
  Object.assign(t.env, { OPERATIONS: { send: async () => {} } });
  context = { get: (key: string) => key === 'db' ? db : { id: userId, email: 'owner@example.com', name: 'Owner' }, env: t.env, executionCtx: t.ctx } as unknown as Context<AppEnv>;
});

async function existing(kind: string, params?: Record<string, unknown>, leased = false) {
  const op = operationRow({ instanceId: browserId, userId, kind, params, now: new Date() });
  await db.insert(schema.operations).values({ ...op, ...(leased ? { status: 'running', leaseOwner: 'stalled-worker', leaseExpiresAt: new Date(Date.now() + 60_000) } : {}) });
  return op;
}

async function priority(kind: 'stop' | 'delete', key = kind) {
  return enqueueOperation(context, {
    instanceId: browserId, kind, priority: kind, key, route: `${kind}:${browserId}`,
    params: { reason: 'user', ...(kind === 'delete' ? { purgeNow: true } : {}) },
    before: [db.update(schema.browserInstances).set({ desiredState: kind === 'delete' ? 'deleted' : 'stopped', status: kind === 'delete' ? 'deleting' : 'stopping', updatedAt: new Date() }).where(eq(schema.browserInstances.id, browserId))],
  });
}

describe('stop and delete preempt stale operations', () => {
  it.each(['stop', 'delete'] as const)('the %s HTTP route accepts a stalled create', async (kind) => {
    const old = await existing('create', undefined, true);
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'creating' WHERE id = ?").run(browserId);
    const res = kind === 'delete'
      ? await t.call('DELETE', `/api/v1/instances/${browserId}`, undefined, { 'idempotency-key': 'http-delete' })
      : await t.call('POST', `/api/v1/instances/${browserId}/stop`, undefined, { 'idempotency-key': 'http-stop' });
    expect(res.status).toBe(202);
    expect(res.body.operationId).not.toBe(old.id);
    expect(t.d1.sqlite.prepare('SELECT status FROM operations WHERE id = ?').get(old.id)).toEqual({ status: 'canceled' });
    expect(t.d1.sqlite.prepare('SELECT kind FROM operations WHERE finished_at IS NULL').all()).toEqual([{ kind }]);
  });
  it('accepts stop during a leased create, retains its resumable origin and fences its commands', async () => {
    const old = await existing('create', undefined, true);
    for (const [id, status] of [[`${old.id}:restore:0`, 'delivered'], [`${old.id}:shutdown:0`, 'pending'], ['another-operation:shutdown:0', 'pending']] as const) {
      await db.insert(schema.agentCommands).values({ id, instanceId: browserId, kind: 'prepare_shutdown', payload: {}, status, createdAt: new Date() });
    }
    const result = await priority('stop');
    expect(result.operationId).not.toBe(old.id);
    const [cancelled] = await db.select().from(schema.operations).where(eq(schema.operations.id, old.id));
    expect(cancelled).toMatchObject({ status: 'canceled', leaseOwner: null, leaseExpiresAt: null, finishedAt: expect.any(Date), errorClass: 'superseded' });
    const [next] = await db.select().from(schema.operations).where(eq(schema.operations.id, result.operationId));
    expect(next?.params).toMatchObject({ preemptedOperationId: old.id, resumeCreateFrom: old.id, drainUntil: old.updatedAt.getTime() + 125_000 });
    const commands = await db.select().from(schema.agentCommands);
    expect(commands.filter((c) => c.id.startsWith(old.id)).every((c) => c.status === 'failed' && c.completedAt)).toBe(true);
    expect(commands.find((c) => c.id.startsWith('another-operation'))?.status).toBe('pending');
  });

  it('accepts delete during an unfinished restore without leaving operation_in_progress', async () => {
    const old = await existing('restore', undefined, true);
    const result = await priority('delete');
    expect(result.operationId).not.toBe(old.id);
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(browserId)).toMatchObject({ status: 'deleting', desired_state: 'deleted' });
    expect(t.d1.sqlite.prepare('SELECT kind FROM operations WHERE finished_at IS NULL').all()).toEqual([{ kind: 'delete' }]);
    expect(await priority('delete', 'delete-repeat')).toEqual(result);
    expect(await priority('delete', 'delete')).toEqual(result);
  });

  it.each(['delete', 'purge'])('cannot lower an existing %s intent to stop', async (kind) => {
    const old = await existing(kind, { purgeNow: true });
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'deleting', desired_state = 'deleted' WHERE id = ?").run(browserId);
    const result = await priority('stop');
    expect(result.operationId).toBe(old.id);
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(browserId)).toMatchObject({ status: 'deleting', desired_state: 'deleted' });
    expect(t.d1.sqlite.prepare('SELECT operation_id FROM idempotency_keys WHERE key = ?').get('stop')).toEqual({ operation_id: old.id });
    expect(t.d1.sqlite.prepare('SELECT kind FROM operations WHERE finished_at IS NULL').all()).toEqual([{ kind }]);
  });

  it('coalesces repeated stops while still applying session-ending acceptance writes', async () => {
    const old = await existing('stop');
    const result = await priority('stop', 'stop-again');
    expect(result.operationId).toBe(old.id);
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(browserId)).toMatchObject({ status: 'stopping', desired_state: 'stopped' });
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 1 });
    expect(await priority('stop', 'stop-again')).toEqual(result);
  });

  it('does not flip sleeping back to stopping when a duplicate stop arrives after its finish step', async () => {
    const old = await existing('stop');
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'sleeping', desired_state = 'stopped' WHERE id = ?").run(browserId);
    const result = await t.call('POST', `/api/v1/instances/${browserId}/stop`, undefined, { 'idempotency-key': 'stop-finishing' });
    expect(result.status).toBe(202); expect(result.body.operationId).toBe(old.id);
    expect(t.d1.sqlite.prepare('SELECT status FROM browser_instances WHERE id = ?').get(browserId)).toEqual({ status: 'sleeping' });
  });

  it('acknowledges a finished delete while waiting for cleanup without reverting deletion', async () => {
    const old = await existing('delete', { purgeNow: true });
    t.d1.sqlite.prepare("UPDATE operations SET status = 'succeeded', finished_at = ? WHERE id = ?").run(Date.now(), old.id);
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'deleting', desired_state = 'deleted' WHERE id = ?").run(browserId);
    expect((await priority('stop')).operationId).toBe(old.id);
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(browserId)).toMatchObject({ status: 'deleting', desired_state: 'deleted' });
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM operations WHERE finished_at IS NULL').get()).toEqual({ n: 0 });
  });

  it('still destroys archive keys when permanent deletion coalesces with a queued purge', async () => {
    const old = await existing('purge'); const deletedAt = Date.now() - 3_600_000;
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'deleting', desired_state = 'deleted', deleted_at = ?, purge_after = ? WHERE id = ?").run(deletedAt, deletedAt, browserId);
    t.d1.sqlite.prepare('INSERT INTO archive_keys (instance_id, wrapped_key, created_at) VALUES (?, ?, ?)').run(browserId, 'old-wrapped-key', deletedAt);
    const result = await t.call('DELETE', `/api/v1/instances/${browserId}`, undefined, { 'idempotency-key': 'purge-delete' });
    expect(result.status).toBe(202); expect(result.body.operationId).toBe(old.id);
    expect(t.d1.sqlite.prepare('SELECT wrapped_key FROM archive_keys WHERE instance_id = ?').get(browserId)).toEqual({ wrapped_key: null });
    expect(t.d1.sqlite.prepare('SELECT deleted_at FROM browser_instances WHERE id = ?').get(browserId)).toEqual({ deleted_at: deletedAt });
  });

  it('upgrades an unfinished legacy soft delete to permanent deletion', async () => {
    const old = await existing('delete', { purgeNow: false }, true);
    const result = await priority('delete');
    expect(result.operationId).not.toBe(old.id);
    const [next] = await db.select().from(schema.operations).where(eq(schema.operations.id, result.operationId));
    expect(next?.params).toMatchObject({ purgeNow: true, preemptedOperationId: old.id });
  });

  it('inherits a previous drain and create origin when deletion preempts a stop', async () => {
    const drainUntil = Date.now() + 100_000;
    await existing('stop', { drainUntil, resumeCreateFrom: 'original-create' });
    const result = await priority('delete');
    const [next] = await db.select().from(schema.operations).where(eq(schema.operations.id, result.operationId));
    expect(next?.params).toMatchObject({ drainUntil, resumeCreateFrom: 'original-create' });
  });

  it('captures a provider lease acquired after the priority request read its old operation', async () => {
    const old = await existing('create');
    const batch = db.batch.bind(db);
    let claimedAt = 0;
    db.batch = (async (stmts: Parameters<typeof db.batch>[0]) => {
      if (!claimedAt) {
        claimedAt = Date.now();
        t.d1.sqlite.prepare("UPDATE operations SET status = 'running', lease_owner = 'late-worker', updated_at = ?, lease_expires_at = ? WHERE id = ?").run(claimedAt, claimedAt + 60_000, old.id);
      }
      return batch(stmts);
    }) as typeof db.batch;
    const result = await priority('stop');
    const [next] = await db.select().from(schema.operations).where(eq(schema.operations.id, result.operationId));
    expect(next?.params).toMatchObject({ drainUntil: claimedAt + 125_000 });
  });

  it.each(['start', 'recover', 'restore'])('blocks a stale ordinary %s request from resurrecting deleted intent', async (kind) => {
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'deleting', desired_state = 'deleted' WHERE id = ?").run(browserId);
    await expect(enqueueOperation(context, {
      instanceId: browserId, kind: kind as 'start', key: kind, route: kind,
      before: [db.update(schema.browserInstances).set({ desiredState: 'running' }).where(eq(schema.browserInstances.id, browserId))],
    })).rejects.toMatchObject({ status: 409, type: 'invalid_state' });
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(browserId)).toMatchObject({ status: 'deleting', desired_state: 'deleted' });
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
  });

  it('blocks a stale operator recovery before its desired-state writes can resurrect a deletion', async () => {
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'deleting', desired_state = 'deleted' WHERE id = ?").run(browserId);
    await expect(systemOperation(t.env as never, db, {
      instanceId: browserId, userId, kind: 'recover', actor: 'admin:operator',
      before: [db.update(schema.browserInstances).set({ desiredState: 'running' }).where(eq(schema.browserInstances.id, browserId))],
    })).rejects.toMatchObject({ status: 409, type: 'invalid_state' });
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(browserId)).toMatchObject({ status: 'deleting', desired_state: 'deleted' });
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
  });

  it('serializes simultaneous delete and stop with deletion winning', async () => {
    await existing('start');
    const results = await Promise.all([priority('stop'), priority('delete')]);
    expect(results).toHaveLength(2);
    expect(t.d1.sqlite.prepare('SELECT kind FROM operations WHERE finished_at IS NULL').all()).toEqual([{ kind: 'delete' }]);
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(browserId)).toMatchObject({ status: 'deleting', desired_state: 'deleted' });
  });

  it('retries a coalesced stop whose observed row was replaced by delete before its batch', async () => {
    const old = await existing('stop');
    const batch = db.batch.bind(db);
    let swapped = false;
    db.batch = (async (stmts: Parameters<typeof db.batch>[0]) => {
      if (!swapped) {
        swapped = true;
        t.d1.sqlite.prepare("UPDATE operations SET status = 'canceled', finished_at = ? WHERE id = ?").run(Date.now(), old.id);
        await existing('delete', { purgeNow: true });
        t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'deleting', desired_state = 'deleted' WHERE id = ?").run(browserId);
      }
      return batch(stmts);
    }) as typeof db.batch;
    const result = await priority('stop');
    expect(result.operationId).not.toBe(old.id);
    expect(t.d1.sqlite.prepare('SELECT kind FROM operations WHERE id = ?').get(result.operationId)).toEqual({ kind: 'delete' });
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(browserId)).toMatchObject({ status: 'deleting', desired_state: 'deleted' });
  });

  it('cannot create a stop when a delete fully completes between reading and accepting the request', async () => {
    const old = await existing('start');
    const batch = db.batch.bind(db);
    let deletionId = '';
    db.batch = (async (stmts: Parameters<typeof db.batch>[0]) => {
      if (!deletionId) {
        t.d1.sqlite.prepare("UPDATE operations SET status = 'canceled', finished_at = ? WHERE id = ?").run(Date.now(), old.id);
        const deletion = await existing('delete', { purgeNow: true });
        deletionId = deletion.id;
        t.d1.sqlite.prepare("UPDATE operations SET status = 'succeeded', finished_at = ? WHERE id = ?").run(Date.now(), deletionId);
        t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'deleting', desired_state = 'deleted' WHERE id = ?").run(browserId);
      }
      return batch(stmts);
    }) as typeof db.batch;
    expect((await priority('stop')).operationId).toBe(deletionId);
    expect(t.d1.sqlite.prepare('SELECT status, desired_state FROM browser_instances WHERE id = ?').get(browserId)).toMatchObject({ status: 'deleting', desired_state: 'deleted' });
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM operations WHERE finished_at IS NULL').get()).toEqual({ n: 0 });
  });

  it.each(['start', 'sessions'])('resumes an interrupted unactivated creation through %s even when a placement already exists', async (action) => {
    const original = await existing('create', undefined, true);
    await db.insert(schema.placements).values({ id: 'partial-placement', instanceId: browserId, generation: 1, executor: 'fake', providerRegion: 'ap-northeast-1', zone: 'ap-northeast-1a', vmId: 'partial-vm', volumeId: 'private-volume', networkId: 'private-nic', ipAllocationId: 'private-ip', ipAddress: '203.0.113.5', status: 'current', createdAt: new Date() });
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'creating' WHERE id = ?").run(browserId);
    const stop = await t.call('POST', `/api/v1/instances/${browserId}/stop`, undefined, { 'idempotency-key': 'partial-stop' });
    expect(stop.status).toBe(202);
    t.d1.sqlite.prepare("UPDATE operations SET status = 'succeeded', finished_at = ? WHERE id = ?").run(Date.now(), stop.body.operationId);
    t.d1.sqlite.prepare("UPDATE browser_instances SET status = 'sleeping', desired_state = 'stopped' WHERE id = ?").run(browserId);
    const wake = await t.call('POST', `/api/v1/instances/${browserId}/${action}`, undefined, { 'idempotency-key': 'partial-resume' });
    expect(wake.status).toBe(action === 'start' ? 202 : 201);
    const [resumed] = await db.select().from(schema.operations).where(eq(schema.operations.id, action === 'start' ? wake.body.operationId : wake.body.operationId));
    expect(resumed).toMatchObject({ kind: 'create', params: { resumeCreateFrom: original.id, storageGb: 10 } });
    expect(resumed!.id).not.toBe(original.id);
  });

  it('refuses a cross-user priority request before changing either operation or instance', async () => {
    const old = await existing('recover');
    await db.insert(schema.user).values({ id: 'another-user', email: 'other@example.com', name: 'Other', emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    t.d1.sqlite.prepare("UPDATE browser_instances SET user_id = 'another-user' WHERE id = ?").run(browserId);
    await expect(priority('delete')).rejects.toMatchObject({ status: 404, type: 'not_found' });
    expect(t.d1.sqlite.prepare('SELECT finished_at FROM operations WHERE id = ?').get(old.id)).toEqual({ finished_at: null });
  });
});
