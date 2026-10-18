import { createDb, operationRow, schema } from '@cloudbrowser/db';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env.js';
import { enqueueOperation } from '../src/ops.js';
import { RESIZE_WINDOW_MS, resizeQuota } from '../src/storage.js';
import { setup, signIn } from './helpers.js';

let t: ReturnType<typeof setup>, db: ReturnType<typeof createDb>, userId: string;
const instanceId = 'resizable-private-browser';

beforeEach(async () => {
  t = setup();
  t.d1.sqlite.exec("INSERT INTO invites(email) VALUES ('owner@example.com')");
  await signIn(t, 'owner@example.com');
  userId = (t.d1.sqlite.prepare("SELECT id FROM user WHERE email='owner@example.com'").get() as { id: string }).id;
  db = createDb(t.d1 as never);
  await db.insert(schema.browserInstances).values({ id: instanceId, userId, name: 'Private', regionId: 'tyo1', status: 'running', desiredState: 'running', idleTimeoutS: 600, locale: 'en-US', screen: 'auto', fingerprint: { timezone: 'Asia/Tokyo', locale: 'en-US', screen: 'auto', chromeMajor: null }, createdAt: new Date(), updatedAt: new Date() });
  Object.assign(t.env, { OPERATIONS: { send: async () => {} } });
});

async function attempt(status: string, at: number, createdAt = at, browser = instanceId) {
  const op = operationRow({ instanceId: browser, userId, kind: 'resize_volume', params: { sizeGb: 20 }, now: new Date(createdAt) });
  await db.insert(schema.operations).values({ ...op, status, finishedAt: new Date(at), updatedAt: new Date(at) });
}

describe('rolling EBS modification quota', () => {
  it('counts cancellations, unknown failures and late accepted attempts until 24 hours after activity', async () => {
    const now = Date.now();
    await attempt('succeeded', now - 3_600_000);
    await attempt('canceled', now - 2_000);
    await attempt('failed', now - 1_000);
    // The request was admitted two days ago, but AWS's unknown outcome only settled recently.
    await attempt('canceled', now, now - 2 * RESIZE_WINDOW_MS);
    expect(await resizeQuota(db, instanceId, new Date(now))).toEqual(new Date(now - 3_600_000 + RESIZE_WINDOW_MS + 1));
    expect((await t.call('GET', `/api/v1/instances/${instanceId}/storage`)).body).toMatchObject({ resizable: false, blockedReason: 'cooldown' });
    expect(await resizeQuota(db, instanceId, new Date(now - 3_600_000 + RESIZE_WINDOW_MS + 1))).toBeNull();
  });

  it('enforces the fourth-attempt boundary inside the transaction after a stale preflight read', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) await attempt('succeeded', now - i);
    expect(await resizeQuota(db, instanceId)).toBeNull();
    await attempt('canceled', now);
    const context = { get: (key: string) => key === 'db' ? db : { id: userId }, env: t.env, executionCtx: t.ctx } as unknown as Context<AppEnv>;
    await expect(enqueueOperation(context, { instanceId, kind: 'resize_volume', key: 'stale-quota', route: 'storage', params: { sizeGb: 30 } })).rejects.toMatchObject({ status: 409, type: 'invalid_state' });
    expect(t.d1.sqlite.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 4 });
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE key='stale-quota'").get()).toEqual({ n: 0 });
    expect(t.d1.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action='operation.requested'").get()).toEqual({ n: 0 });
  });

  it('keeps the rolling quota scoped to the browser', async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) await attempt('succeeded', now - i);
    expect(await resizeQuota(db, instanceId)).toBeInstanceOf(Date);
    expect(await resizeQuota(db, 'different-private-browser')).toBeNull();
  });
});
