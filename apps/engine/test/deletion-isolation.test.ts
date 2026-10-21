import { createDb, newArchiveKey, operationRow, schema } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { FakeExecutor, MemoryFakeStore, type FaultPlan } from '@cloudbrowser/executors';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAgentBridge } from '../src/agent.js';
import { placementRef, readContext, type EngineDeps, type EngineMode } from '../src/context.js';
import { reaperTick } from '../src/reaper.js';
import { runOperation } from '../src/runner.js';
import { ensureArchiveKey } from '../src/steps.js';

const { user, browserInstances, operations, placements, resources, backups, archiveKeys, agentCredentials, viewerSessions } = schema;
class World {
  db = createDb(createTestD1());
  store = new MemoryFakeStore();
  oldStore = new MemoryFakeStore();
  clock = new Date('2026-10-18T00:00:00Z');
  faults: FaultPlan = () => null;
  objects = new Set<string>();
  archiveDeletes: string[] = [];
  deleteArchives = true;
  deps(mode: EngineMode = 'worker'): EngineDeps {
    const executor = (kind: string) => new FakeExecutor({ store: kind === 'aws-ec2' ? this.oldStore : this.store, mode: mode === 'reaper' ? 'reaper' : 'runtime', faults: (method, ctx) => this.faults(method, ctx) });
    const now = () => this.clock;
    const placementOf = async (id: string) => {
      const [p] = await this.db.select().from(placements).where(and(eq(placements.instanceId, id), eq(placements.status, 'current')));
      return p ? placementRef(p) : null;
    };
    return {
      db: this.db, mode, executor, agent: () => new FakeAgentBridge(executor('fake'), () => readContext('agent', 'test'), placementOf, now),
      now, envName: 'test', gatewayUrl: 'wss://gateway.test', workerId: `${mode}-isolation`, notify() {}, bootstrapSecret: 'bootstrap-secret', sleep: async () => {}, archives: null, archiveMasterKey: null,
      ...(this.deleteArchives ? { deleteArchive: async (key: string) => { this.archiveDeletes.push(key); this.objects.delete(key); } } : {}),
    };
  }
  async seed(id: string, owner = 'alice') {
    await this.db.insert(user).values({ id: owner, email: `${owner}@example.com`, name: owner, emailVerified: true, createdAt: this.clock, updatedAt: this.clock }).onConflictDoNothing();
    await this.db.insert(browserInstances).values({ id, userId: owner, name: id, regionId: 'tyo1', status: 'creating', desiredState: 'running', idleTimeoutS: 600, locale: 'en-US', screen: 'auto', fingerprint: { timezone: 'Asia/Tokyo', locale: 'en-US', screen: 'auto', chromeMajor: null }, createdAt: this.clock, updatedAt: this.clock });
    expect(await this.settle(await this.enqueue(id, 'create'))).toEqual({ state: 'succeeded' });
  }
  async enqueue(id: string, kind: string, params?: Record<string, unknown>) {
    const op = operationRow({ instanceId: id, userId: null, kind, params, now: this.clock });
    await this.db.insert(operations).values(op); return op.id;
  }
  async permanentDelete(id: string) {
    await this.db.update(browserInstances).set({ desiredState: 'deleted', status: 'deleting', deletedAt: this.clock, purgeAfter: this.clock }).where(eq(browserInstances.id, id));
    return this.settle(await this.enqueue(id, 'delete', { reason: 'user', purgeNow: true }));
  }
  async settle(op: string, mode: EngineMode = 'worker') {
    for (let n = 0; n < 40; n++) {
      const result = await runOperation(this.deps(mode), op);
      if (result.state !== 'deferred') return result;
      this.clock = new Date(result.notBefore.getTime() + 1);
    }
    throw new Error('Operation did not settle');
  }
  async instance(id = 'private-a') { return (await this.db.select().from(browserInstances).where(eq(browserInstances.id, id)))[0]!; }
  async ledger(id = 'private-a') { return this.db.select().from(resources).where(eq(resources.instanceId, id)); }
}
let w: World;
beforeEach(async () => { w = new World(); await w.seed('private-a'); });

describe('deletion releases owned data without profile reuse', () => {
  it('purges immediately including superseded resources, old executors and unrecorded snapshots', async () => {
    const tags = { ...readContext('superseded', 'test').tags, 'cb:instance': 'private-a', 'cb:kind': 'volume' as const };
    const old = new FakeExecutor({ store: w.oldStore, mode: 'runtime' });
    const oldVolume = await old.ensureVolume({ ...readContext('old-volume', 'test'), tags }, 'old-region', 'old-zone', 10);
    await w.db.insert(resources).values({ id: 'old-ledger', instanceId: 'private-a', executor: 'aws-ec2', kind: 'volume', providerId: oldVolume.volumeId, region: 'old-region', zone: 'old-zone', requestToken: 'old-volume', state: 'superseded', tags, firstSeenAt: w.clock });
    const [p] = await w.db.select().from(placements).where(eq(placements.instanceId, 'private-a'));
    const runtime = new FakeExecutor({ store: w.store, mode: 'runtime' });
    const snapshot = await runtime.snapshot({ ...readContext('manual-snapshot', 'test'), tags: { ...tags, 'cb:kind': 'snapshot' } }, p!.providerRegion, p!.volumeId!);
    await w.db.insert(backups).values({ id: 'snap', instanceId: 'private-a', kind: 'snapshot', reason: 'manual', status: 'complete', generation: 1, location: snapshot.snapshotId, createdAt: w.clock });
    expect(await w.permanentDelete('private-a')).toEqual({ state: 'succeeded' });
    expect((await w.instance()).purgeAfter!.getTime()).toBe(w.clock.getTime());
    await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('purged');
    expect((await w.ledger()).every((r) => r.state === 'deleted')).toBe(true);
    expect([...w.store.records.values(), ...w.oldStore.records.values()].every((r) => r.state === 'deleted')).toBe(true);
    expect((await w.db.select().from(backups))[0]?.status).toBe('deleted');
  });
  it('keeps unconfirmed provider deletions pending and retries', async () => {
    await w.permanentDelete('private-a');
    w.faults = (method) => method === 'ensureDeleted' ? 'retryable' : null;
    await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('deleting');
    expect((await w.ledger()).some((r) => r.state !== 'deleted')).toBe(true);
    const [purge] = await w.db.select().from(operations).where(eq(operations.kind, 'purge'));
    expect(purge!.finishedAt).toBeNull(); w.faults = () => null;
    w.clock = new Date(purge!.notBefore!.getTime() + 1);
    expect(await w.settle(purge!.id, 'reaper')).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('purged');
  });
  it('finds lost-create resources and does not confuse an absent provider ID with deletion', async () => {
    const tags = { ...readContext('lost-create', 'test').tags, 'cb:instance': 'private-a', 'cb:kind': 'volume' as const };
    const runtime = new FakeExecutor({ store: w.store, mode: 'runtime' });
    const lostVolume = await runtime.ensureVolume({ ...readContext('lost-create', 'test'), tags }, 'ap-northeast-1', 'ap-northeast-1a', 10);
    await w.db.insert(resources).values({ id: 'pending-known', instanceId: 'private-a', executor: 'fake', kind: 'volume', region: 'ap-northeast-1', requestToken: 'lost-create', createdByOp: 'lost-create', state: 'pending', tags, firstSeenAt: w.clock });
    await w.db.insert(resources).values({ id: 'pending-unknown', instanceId: 'private-a', executor: 'fake', kind: 'volume', region: 'ap-northeast-1', requestToken: 'not-yet-visible', createdByOp: 'not-yet-visible', state: 'pending', tags: { ...tags, 'cb:op': 'not-yet-visible' }, firstSeenAt: w.clock });
    await w.permanentDelete('private-a'); await reaperTick(w.deps('reaper'));
    expect(w.store.records.get(lostVolume.volumeId)?.state).toBe('deleted');
    expect((await w.instance()).status).toBe('deleting');
    expect((await w.ledger()).find((r) => r.id === 'pending-unknown')?.state).toBe('pending');
    w.clock = new Date(w.clock.getTime() + 16 * 60_000); await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('purged');
  });
  it('destroys keys immediately and repeats archive deletion after outstanding upload URLs expire', async () => {
    const location = 'archives/private-a/profile.cbar'; w.objects.add(location);
    const { wrapped } = await newArchiveKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(3))));
    await w.db.insert(archiveKeys).values({ instanceId: 'private-a', wrappedKey: wrapped, createdAt: w.clock });
    await w.db.insert(backups).values({ id: 'pending-archive', instanceId: 'private-a', kind: 'archive', reason: 'sleep', status: 'pending', generation: 1, location, createdAt: w.clock });
    await w.db.insert(viewerSessions).values({ id: 'session', instanceId: 'private-a', userId: 'alice', startedAt: w.clock, lastSeenAt: w.clock });
    await w.permanentDelete('private-a');
    expect((await w.db.select().from(agentCredentials))[0]).toMatchObject({ credentialHash: null, bootstrapHash: null });
    await reaperTick(w.deps('reaper'));
    expect((await w.db.select().from(archiveKeys))[0]).toMatchObject({ wrappedKey: null, destroyedAt: expect.any(Date) });
    expect((await w.db.select().from(viewerSessions))[0]?.endedAt).not.toBeNull();
    expect(w.objects.has(location)).toBe(false); expect((await w.instance()).status).toBe('deleting');
    w.objects.add(location); // An already-issued PUT finishes after the first delete.
    w.clock = new Date(w.clock.getTime() + 17 * 60_000); await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('purged'); expect(w.objects.has(location)).toBe(false);
    expect(w.archiveDeletes.filter((k) => k === location).length).toBeGreaterThanOrEqual(2);
  });
  it('refuses to claim cleanup is done when archive deletion is unavailable', async () => {
    await w.db.insert(backups).values({ id: 'archive', instanceId: 'private-a', kind: 'archive', reason: 'sleep', status: 'complete', generation: 1, location: 'archives/private-a/profile.cbar', createdAt: w.clock });
    w.deleteArchives = false; await w.permanentDelete('private-a');
    w.clock = new Date(w.clock.getTime() + 17 * 60_000); await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('deleting'); expect((await w.db.select().from(backups))[0]?.status).toBe('complete');
    w.deleteArchives = true; await reaperTick(w.deps('reaper')); expect((await w.instance()).status).toBe('purged');
  });
  it('never attaches a previous owner VM, volume, IP or login to a new browser', async () => {
    const oldIds = (await w.ledger()).map((r) => r.providerId);
    const [a] = await w.db.select().from(placements).where(eq(placements.instanceId, 'private-a'));
    const volume = w.store.records.get(a!.volumeId!)!;
    await w.store.update(volume.id, { attrs: { ...volume.attrs, cookie: 'alice-private-login' } });
    await w.permanentDelete('private-a'); await reaperTick(w.deps('reaper')); await w.seed('private-b', 'bob');
    expect((await w.ledger('private-b')).every((r) => !oldIds.includes(r.providerId))).toBe(true);
    const [b] = await w.db.select().from(placements).where(eq(placements.instanceId, 'private-b'));
    expect(b!.ipAddress).not.toBe(a!.ipAddress); expect(w.store.records.get(b!.volumeId!)!.attrs).not.toHaveProperty('cookie');
    expect(w.store.records.get(a!.volumeId!)!.state).toBe('deleted');
    expect(await w.db.select().from(archiveKeys).where(eq(archiveKeys.instanceId, 'private-b'))).toEqual([]);
  });
  it('blocks stale recovery jobs and key creation after permanent deletion', async () => {
    await w.permanentDelete('private-a');
    const stale = await w.enqueue('private-a', 'recover');
    expect((await w.settle(stale)).state).toBe('failed');
    expect((await w.instance()).status).toBe('deleting');
    const deps = { ...w.deps(), archiveMasterKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) };
    expect(await ensureArchiveKey({ deps }, 'private-a')).toBe(false);
    await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('purged');
    expect((await w.settle(await w.enqueue('private-a', 'create'))).state).toBe('failed');
    expect((await w.instance()).status).toBe('purged');
    expect([...w.store.records.values()].every((r) => r.state === 'deleted')).toBe(true);
  });
  it('passes the real browser ownership and environment to every provider deletion', async () => {
    const owners: string[] = [];
    w.faults = (method, ctx) => { if (method === 'ensureDeleted') owners.push(`${ctx.tags['cb:env']}:${ctx.tags['cb:instance']}`); return null; };
    await w.permanentDelete('private-a'); await reaperTick(w.deps('reaper'));
    expect(owners).toHaveLength(4); expect(new Set(owners)).toEqual(new Set(['test:private-a']));
  });
  it('finishes explicit immediate cleanup even if stopping its VM failed before delete finished', async () => {
    w.faults = (method) => method === 'ensureStopped' ? 'forbidden' : null;
    expect((await w.settle(await w.enqueue('private-a', 'delete', { reason: 'immediate_cleanup', purgeNow: true }))).state).toBe('failed');
    expect((await w.instance()).purgeAfter).toBeInstanceOf(Date);
    w.faults = () => null; await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('purged');
  });
  it('still schedules cleanup after a delete was left in an old failure state', async () => {
    await w.db.update(browserInstances).set({ status: 'needs_attention', desiredState: 'deleted', deletedAt: w.clock, purgeAfter: w.clock }).where(eq(browserInstances.id, 'private-a'));
    await reaperTick(w.deps('reaper')); expect((await w.instance()).status).toBe('purged');
  });
});
