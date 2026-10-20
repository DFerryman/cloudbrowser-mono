import { createDb, schema } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { FakeExecutor, MemoryFakeStore, type OpContext } from '@cloudbrowser/executors';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { reconcileLedger, snapshotQuotasAndSpend } from '../src/reconcile.js';

const tags = (op: string) => ({ 'cb:managed': 'true', 'cb:env': 'test', 'cb:instance': 'x', 'cb:op': op, 'cb:gen': '1' }) as const;
const ctx = (token: string, op = 'unknown-op'): OpContext => ({ operationId: op, step: 's', token, tags: tags(op), deadline: Date.now() + 10_000 });

it('records unknown provider resources as orphans and trips the circuit breaker', async () => {
  const db = createDb(createTestD1());
  const store = new MemoryFakeStore();
  const runtime = new FakeExecutor({ store, mode: 'runtime' });
  for (let i = 0; i < 4; i++) await runtime.allocateIp(ctx(`t${i}`), 'ap-northeast-1');

  const deps = { db, envName: 'test', now: () => new Date(), executor: () => new FakeExecutor({ store, mode: 'readonly' }) };
  const summary = await reconcileLedger(deps);
  expect(summary.orphans).toBe(4);
  expect(summary.frozen).toBe(true);
  const [flag] = await db.select().from(schema.controlFlags).where(eq(schema.controlFlags.key, 'creation_freeze'));
  expect(flag?.value).toBe('true');
  // One critical alert for the circuit breaker and one per orphan, each raised once.
  const raised = await db.select().from(schema.alerts);
  expect(raised.filter((a) => a.dedupeKey === 'circuit_breaker')).toHaveLength(1);
  expect(raised.filter((a) => a.dedupeKey?.startsWith('finding:orphan:'))).toHaveLength(4);

  // Findings are not duplicated on the next run.
  expect((await reconcileLedger(deps)).orphans).toBe(0);
  await snapshotQuotasAndSpend(deps);
  const quotas = await db.select().from(schema.quotaSnapshots);
  expect(quotas.find((q) => q.metric === 'static_ips')?.used).toBe(4);
});

async function volumeFixture(kind: 'volume' | 'root_volume', visible = false) {
  const db = createDb(createTestD1());
  const now = new Date();
  await db.insert(schema.user).values({
    id: 'owner', name: 'Owner', email: 'owner@example.test', emailVerified: true, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.browserInstances).values({
    id: 'browser', userId: 'owner', name: 'Browser', regionId: 'tyo1', status: 'running', desiredState: 'running',
    idleTimeoutS: 1800, screen: 'auto', fingerprint: { timezone: 'Asia/Tokyo', screen: 'auto', chromeMajor: null },
    createdAt: now, updatedAt: now,
  });
  const resourceTags = { ...tags('create'), 'cb:instance': 'browser', 'cb:kind': kind };
  await db.insert(schema.resources).values({
    id: 'disk', instanceId: 'browser', kind: 'volume', executor: 'fake', providerId: 'vol-test',
    region: 'ap-northeast-1', zone: 'ap-northeast-1a', requestToken: 'create:disk', state: 'active',
    tags: resourceTags, firstSeenAt: now, lastSeenAt: now,
  });
  const executor = new FakeExecutor({ store: new MemoryFakeStore(), mode: 'readonly' });
  vi.spyOn(executor, 'listManaged').mockImplementation(async (_ctx, region) =>
    visible && region === 'ap-northeast-1'
      ? [{ providerId: 'vol-test', kind: 'volume', region, zone: 'ap-northeast-1a', state: 'available', tags: resourceTags }]
      : [],
  );
  return { db, now, deps: { db, envName: 'test', now: () => now, executor: () => executor } };
}

it.each(['present', 'absent'] as const)('does not report a root disk recorded by purge as missing when it is %s', async (presence) => {
  const { db, deps } = await volumeFixture('root_volume', presence === 'present');
  expect(await reconcileLedger(deps)).toEqual({ adopted: 0, orphans: 0, missing: 0, frozen: false });
  expect(await db.select().from(schema.alerts)).toEqual([]);
  const [disk] = await db.select().from(schema.resources);
  expect(disk?.state).toBe('active');
});

it('does not report a missing data disk during an intended permanent deletion', async () => {
  const { db, deps, now } = await volumeFixture('volume');
  await db.update(schema.browserInstances).set({ status: 'deleting', desiredState: 'deleted', deletedAt: now });
  expect((await reconcileLedger(deps)).missing).toBe(0);
  expect(await db.select().from(schema.alerts)).toEqual([]);
  const [disk] = await db.select().from(schema.resources);
  expect(disk?.state).toBe('active');
});

it('still raises a critical alert once when a live browser loses its data disk', async () => {
  const { db, deps } = await volumeFixture('volume');
  expect((await reconcileLedger(deps)).missing).toBe(1);
  expect((await reconcileLedger(deps)).missing).toBe(0);
  const raised = await db.select().from(schema.alerts);
  expect(raised).toHaveLength(1);
  expect(raised[0]).toMatchObject({ severity: 'critical', dedupeKey: 'finding:missing:vol-test' });
  const [finding] = await db.select().from(schema.driftFindings);
  expect(finding).toMatchObject({ kind: 'missing', resourceKind: 'volume', providerId: 'vol-test', instanceId: 'browser' });
});

it('skips a region whose provider read fails and still reconciles the others', async () => {
  const db = createDb(createTestD1());
  await db.update(schema.regions).set({ enabled: true }).where(eq(schema.regions.executor, 'fake'));
  const store = new MemoryFakeStore();
  const runtime = new FakeExecutor({ store, mode: 'runtime' });
  await runtime.allocateIp(ctx('t1'), 'ap-northeast-1');
  const executor = new FakeExecutor({ store, mode: 'readonly' });
  const list = executor.listManaged.bind(executor);
  vi.spyOn(executor, 'listManaged').mockImplementation(async (c, region) => {
    if (region === 'us-west-2') throw new Error('DescribeVolumes: deadline passed');
    return list(c, region);
  });
  const deps = { db, envName: 'test', now: () => new Date(), executor: () => executor };
  const summary = await reconcileLedger(deps);
  // The failed region is reported, nothing in it is judged missing, and the healthy one was checked.
  expect(summary.failed).toEqual(['fake/us-west-2']);
  expect(summary.orphans).toBe(1);
  expect(summary.missing).toBe(0);
});

