import { createDb, operationRow, schema } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { ExecutorError, FakeExecutor, MemoryFakeStore, type Executor } from '@cloudbrowser/executors';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentBridge, GatewayAgentBridge } from '../src/agent.js';
import { placementRef, readContext, type EngineDeps, type EngineMode } from '../src/context.js';
import { reaperTick } from '../src/reaper.js';
import { runOperation } from '../src/runner.js';
import { HANDLERS } from '../src/steps.js';
import { enforceStoppedIntent } from '../src/enforce-stopped.js';

const { user, browserInstances, operations, operationSteps, placements, resources, agentCredentials } = schema;
function barrier() {
  let signal!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => { signal = r; });
  const wait = new Promise<void>((r) => { release = r; });
  return { entered, release, pause: async () => { signal(); await wait; } };
}
class World {
  db = createDb(createTestD1()); store = new MemoryFakeStore(); clock = new Date('2026-10-18T00:00:00Z');
  afterProvider: ((method: string) => Promise<void>) | null = null;
  beforeProvider: ((method: string) => Promise<void>) | null = null;
  calls: string[] = [];
  deps(mode: EngineMode = 'worker'): EngineDeps {
    const original = new FakeExecutor({ store: this.store, mode: mode === 'reaper' ? 'reaper' : 'runtime' });
    const executor = new Proxy(original, { get: (target, key) => {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function' || ['zones', 'pricingConfigKey'].includes(String(key))) return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        if (mode === 'worker') await this.beforeProvider?.(String(key));
        this.calls.push(String(key)); const out = await value.apply(target, args);
        if (mode === 'worker') await this.afterProvider?.(String(key)); return out;
      };
    } }) as Executor;
    const now = () => this.clock;
    const placementOf = async (id: string) => { const [p] = await this.db.select().from(placements).where(and(eq(placements.instanceId, id), eq(placements.status, 'current'))); return p ? placementRef(p) : null; };
    const agent = new FakeAgentBridge(executor, () => readContext('agent', 'test'), placementOf, now);
    return { db: this.db, mode, executor: () => executor, agent: () => agent, now, envName: 'test', gatewayUrl: 'wss://gateway.test', workerId: `${mode}-preemption`, notify() {}, bootstrapSecret: 'bootstrap-secret', sleep: async () => {}, archives: null, archiveMasterKey: null, deleteArchive: async () => {} };
  }
  async seed() {
    await this.db.insert(user).values({ id: 'owner', name: 'owner', email: 'owner@example.com', emailVerified: true, createdAt: this.clock, updatedAt: this.clock });
    await this.db.insert(browserInstances).values({ id: 'private', userId: 'owner', name: 'private', regionId: 'tyo1', status: 'creating', desiredState: 'running', idleTimeoutS: 600, locale: 'en-US', screen: 'auto', fingerprint: { timezone: 'Asia/Tokyo', locale: 'en-US', screen: 'auto', chromeMajor: null }, createdAt: this.clock, updatedAt: this.clock });
    return this.enqueue('create');
  }
  async enqueue(kind: string, params?: Record<string, unknown>) {
    const op = operationRow({ instanceId: 'private', userId: 'owner', kind, params, now: this.clock }); await this.db.insert(operations).values(op); return op.id;
  }
  async supersede(oldId: string, kind: 'delete' | 'stop', extra: Record<string, unknown> = {}) {
    const op = operationRow({ instanceId: 'private', userId: 'owner', kind, params: { preemptedOperationId: oldId, ...(kind === 'delete' ? { purgeNow: true } : {}), ...extra }, now: this.clock });
    await this.db.batch([
      this.db.update(operations).set({ status: 'canceled', finishedAt: this.clock, updatedAt: this.clock, leaseOwner: null, leaseExpiresAt: null }).where(eq(operations.id, oldId)),
      this.db.update(browserInstances).set(kind === 'delete' ? { status: 'deleting', desiredState: 'deleted', deletedAt: this.clock, purgeAfter: this.clock } : { status: 'stopping', desiredState: 'stopped' }).where(eq(browserInstances.id, 'private')),
      this.db.insert(operations).values(op),
    ]); return op.id;
  }
  async settle(op: string, mode: EngineMode = 'worker') {
    for (let n = 0; n < 100; n++) { const result = await runOperation(this.deps(mode), op); if (result.state !== 'deferred') return result; this.clock = new Date(result.notBefore.getTime() + 1); }
    throw new Error('Operation did not settle');
  }
  async instance() { return (await this.db.select().from(browserInstances))[0]!; }
}
afterEach(() => vi.restoreAllMocks());

describe('operation preemption fences in-flight workers', () => {
  it('stops and deletes an in-flight VM before placement creation, without allowing the old create to finish', async () => {
    const w = new World(), create = await w.seed(), gate = barrier();
    let once = false;
    w.afterProvider = async (method) => { if (method === 'ensureVm' && !once) { once = true; await gate.pause(); } };
    const old = runOperation(w.deps(), create); await gate.entered;
    const deletion = await w.supersede(create, 'delete');
    expect(await w.settle(deletion)).toEqual({ state: 'succeeded' });
    expect([...w.store.records.values()].find((r) => r.kind === 'vm')?.state).toBe('stopped');
    gate.release(); expect(await old).toEqual({ state: 'canceled' });
    expect(await w.db.select().from(placements)).toEqual([]);
    expect((await w.db.select().from(agentCredentials))[0]).toMatchObject({ bootstrapHash: null, credentialHash: null });
    expect((await w.db.select().from(operations).where(eq(operations.id, create)))[0]?.status).toBe('canceled');
    await reaperTick(w.deps('reaper')); expect((await w.instance()).status).toBe('purged');
    expect([...w.store.records.values()].every((r) => r.state === 'deleted')).toBe(true);
  });

  it('guards a final status write when deletion was accepted inside the old finish handler', async () => {
    const w = new World(), create = await w.seed(), gate = barrier(), finish = HANDLERS.create!.finish!;
    vi.spyOn(HANDLERS.create!, 'finish').mockImplementation(async (env) => { await gate.pause(); return finish(env); });
    const old = runOperation(w.deps(), create); await gate.entered;
    const deletion = await w.supersede(create, 'delete'); gate.release();
    expect(await old).toEqual({ state: 'canceled' }); expect((await w.instance()).status).toBe('deleting');
    expect(await w.settle(deletion)).toEqual({ state: 'succeeded' });
  });

  it('does not compensate a canceled IP change after a newer deletion wins', async () => {
    const w = new World(); await w.settle(await w.seed()); const gate = barrier();
    const job = await w.enqueue('change_ip');
    vi.spyOn(HANDLERS.change_ip!, 'verify_binding').mockImplementation(async () => { await gate.pause(); throw new ExecutorError('invalid', 'late old failure'); });
    const old = runOperation(w.deps(), job); await gate.entered;
    const moved = w.calls.filter((x) => x === 'associateIp').length;
    const deletion = await w.supersede(job, 'delete'); gate.release();
    expect(await old).toEqual({ state: 'canceled' }); expect(w.calls.filter((x) => x === 'associateIp')).toHaveLength(moved);
    expect((await w.instance()).status).toBe('deleting'); expect(await w.settle(deletion)).toEqual({ state: 'succeeded' });
  });

  it('rechecks stop after the old start request drains instead of reporting sleeping too soon', async () => {
    const w = new World(); await w.settle(await w.seed()); await w.settle(await w.enqueue('stop'));
    await w.db.update(browserInstances).set({ desiredState: 'running' });
    const start = await w.enqueue('start'), gate = barrier(); let once = false;
    w.afterProvider = async (method) => { if (method === 'ensureRunning' && !once) { once = true; await gate.pause(); } };
    const old = runOperation(w.deps(), start); await gate.entered;
    const stop = await w.supersede(start, 'stop', { drainUntil: w.clock.getTime() + 125_000 });
    expect((await runOperation(w.deps(), stop)).state).toBe('deferred'); expect((await w.instance()).status).toBe('stopping');
    gate.release(); expect(await old).toEqual({ state: 'canceled' });
    w.clock = new Date(w.clock.getTime() + 126_000); expect(await w.settle(stop)).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('sleeping'); expect([...w.store.records.values()].find((r) => r.kind === 'vm')?.state).toBe('stopped');
  });

  it('resumes partial creation after sleep using the same dedicated IP and disk under a new operation', async () => {
    const w = new World(), create = await w.seed(), gate = barrier(); let once = false;
    w.afterProvider = async (method) => { if (method === 'ensureVolume' && !once) { once = true; await gate.pause(); } };
    const old = runOperation(w.deps(), create); await gate.entered;
    const owned = [...w.store.records.values()].map((r) => r.id);
    const stop = await w.supersede(create, 'stop', { resumeCreateFrom: create }); expect(await w.settle(stop)).toEqual({ state: 'succeeded' });
    gate.release(); expect(await old).toEqual({ state: 'canceled' });
    w.clock = new Date(w.clock.getTime() + 3_600_000);
    await w.db.update(browserInstances).set({ desiredState: 'running' });
    const resume = await w.enqueue('create', { resumeCreateFrom: create, storageGb: 10 }); expect(await w.settle(resume)).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('running');
    expect([...w.store.records.values()].filter((r) => r.kind === 'ip')).toHaveLength(1);
    expect([...w.store.records.values()].filter((r) => r.kind === 'volume')).toHaveLength(1);
    expect(owned.every((id) => w.store.records.has(id))).toBe(true);
  });

  it('refreshes expired bootstrap validity when resuming an unactivated VM after a long sleep', async () => {
    const w = new World(), create = await w.seed(), gate = barrier(); let once = false;
    w.afterProvider = async (method) => { if (method === 'ensureVm' && !once) { once = true; await gate.pause(); } };
    const old = runOperation(w.deps(), create); await gate.entered;
    const [before] = await w.db.select().from(agentCredentials);
    const stop = await w.supersede(create, 'stop', { resumeCreateFrom: create }); await w.settle(stop); gate.release(); await old;
    w.clock = new Date(w.clock.getTime() + 3_600_000); await w.db.update(browserInstances).set({ desiredState: 'running' });
    expect(await w.settle(await w.enqueue('create', { resumeCreateFrom: create }))).toEqual({ state: 'succeeded' });
    const [after] = await w.db.select().from(agentCredentials);
    expect(after!.bootstrapHash).toBe(before!.bootstrapHash); expect(after!.bootstrapExpiresAt!.getTime()).toBeGreaterThan(w.clock.getTime());
    expect([...w.store.records.values()].filter((r) => r.kind === 'vm')).toHaveLength(1);
  });

  it('measures unknown resource visibility from cancellation rather than an old pending row', async () => {
    const w = new World(); await w.settle(await w.seed());
    const old = operationRow({ instanceId: 'private', userId: 'owner', kind: 'recover', now: new Date(w.clock.getTime() - 3_600_000) });
    await w.db.insert(operations).values(old);
    await w.db.insert(resources).values({ id: 'unknown', instanceId: 'private', executor: 'fake', kind: 'vm', region: 'ap-northeast-1', requestToken: 'lost-request', createdByOp: old.id, state: 'pending', tags: {}, firstSeenAt: old.createdAt });
    const deletion = await w.supersede(old.id, 'delete'); await w.settle(deletion); await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('deleting');
    w.clock = new Date(w.clock.getTime() + 16 * 60_000); await reaperTick(w.deps('reaper')); expect((await w.instance()).status).toBe('purged');
  });

  it('refreshes the pending owner when a resumed create re-submits an old request token', async () => {
    const w = new World(), create = await w.seed();
    w.beforeProvider = async (method) => { if (method === 'ensureVm') throw new ExecutorError('unknown_outcome', 'response lost'); };
    expect((await runOperation(w.deps(), create)).state).toBe('deferred');
    const stop = await w.supersede(create, 'stop', { resumeCreateFrom: create }); await w.settle(stop);
    w.clock = new Date(w.clock.getTime() + 3_600_000); await w.db.update(browserInstances).set({ desiredState: 'running' });
    const resumed = await w.enqueue('create', { resumeCreateFrom: create }), gate = barrier();
    w.beforeProvider = async (method) => { if (method === 'ensureVm') await gate.pause(); };
    const old = runOperation(w.deps(), resumed); await gate.entered;
    const [pending] = await w.db.select().from(resources).where(and(eq(resources.kind, 'vm'), eq(resources.state, 'pending')));
    expect(pending!.createdByOp).toBe(resumed); expect(pending!.firstSeenAt).toEqual(w.clock);
    const deletion = await w.supersede(resumed, 'delete'); gate.release(); expect(await old).toEqual({ state: 'canceled' });
    w.beforeProvider = null; await w.settle(deletion); await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('deleting');
    w.clock = new Date(w.clock.getTime() + 16 * 60_000); await reaperTick(w.deps('reaper')); expect((await w.instance()).status).toBe('purged');
  });

  it('rolls back a stale step journal write after its lease was taken by a new worker', async () => {
    const w = new World(), create = await w.seed(), batch = w.db.batch.bind(w.db); let stolen = false;
    w.db.batch = (async (queries: Parameters<typeof w.db.batch>[0]) => {
      if (!stolen) { stolen = true; await w.db.update(operations).set({ leaseOwner: 'replacement-worker' }).where(eq(operations.id, create)); }
      return batch(queries);
    }) as typeof w.db.batch;
    expect(await runOperation(w.deps(), create)).toEqual({ state: 'canceled' });
    expect(await w.db.select().from(operationSteps)).toEqual([]);
    expect((await w.db.select().from(operations))[0]).toMatchObject({ kind: 'create', leaseOwner: 'replacement-worker', finishedAt: null });
  });

  it('does not enqueue a late agent command from a canceled operation', async () => {
    const w = new World(), create = await w.seed();
    await w.db.update(operations).set({ status: 'canceled', finishedAt: w.clock }).where(eq(operations.id, create));
    const pokes: string[] = [];
    const bridge = new GatewayAgentBridge(w.db, async (m) => void pokes.push(m.instanceId), () => w.clock);
    await bridge.send({ id: `${create}:restore_archive:0`, instanceId: 'private', kind: 'restore_archive', payload: {} });
    expect(await w.db.select().from(schema.agentCommands)).toEqual([]); expect(pokes).toEqual([]);
  });

  it('does not extend a trial retention deadline through repeated stop requests or retries', async () => {
    const w = new World(); await w.settle(await w.seed());
    await w.db.update(browserInstances).set({ trialState: 'ended' });
    await w.settle(await w.enqueue('stop'));
    const first = (await w.instance()).trialReclaimAt;
    expect(first).toBeInstanceOf(Date);
    w.clock = new Date(w.clock.getTime() + 2 * 86_400_000);
    await w.settle(await w.enqueue('stop'));
    expect((await w.instance()).trialReclaimAt).toEqual(first);
    await w.db.update(browserInstances).set({ trialState: 'active' });
    w.clock = new Date(w.clock.getTime() + 86_400_000);
    await w.settle(await w.enqueue('stop'));
    expect((await w.instance()).trialReclaimAt).toEqual(first);
  });

  it('records a completed resize after cancellation without restoring the old running status', async () => {
    const w = new World(); await w.settle(await w.seed()); const gate = barrier(); let once = false;
    w.afterProvider = async (method) => { if (method === 'resizeVolume' && !once) { once = true; await gate.pause(); } };
    const resize = await w.enqueue('resize_volume', { sizeGb: 20 });
    const old = runOperation(w.deps(), resize); await gate.entered;
    const stop = await w.supersede(resize, 'stop'); await w.settle(stop);
    gate.release(); expect(await old).toEqual({ state: 'canceled' });
    expect(await w.instance()).toMatchObject({ status: 'sleeping', storageGb: 20 });
  });

  it('waits for the agent two-minute online filesystem growth without restarting the VM', async () => {
    const w = new World(); await w.settle(await w.seed());
    const before = w.calls.length, startedAt = w.clock;
    const deps = w.deps();
    deps.agent = () => ({
      selfReportsIpChecks: true, status: async () => 'ready', send: async () => {},
      reply: async () => ({ status: w.clock.getTime() - startedAt.getTime() < 90_000 ? 'pending' : 'succeeded', createdAt: startedAt }),
    });
    const resize = await w.enqueue('resize_volume', { sizeGb: 20 });
    expect((await runOperation(deps, resize)).state).toBe('deferred');
    w.clock = new Date(startedAt.getTime() + 61_000);
    expect((await runOperation(deps, resize)).state).toBe('deferred');
    expect(await w.db.select().from(schema.alerts)).toEqual([]);
    w.clock = new Date(startedAt.getTime() + 91_000);
    expect(await runOperation(deps, resize)).toEqual({ state: 'succeeded' });
    expect(await w.instance()).toMatchObject({ status: 'running', storageGb: 20 });
    expect(w.calls.slice(before).some((x) => ['ensureStopped', 'ensureRunning', 'ensureVm', 'snapshot'].includes(x))).toBe(false);
  });

  it('releases an unused IP allocated by an interrupted change without touching the current dedicated IP', async () => {
    const w = new World(); await w.settle(await w.seed()); const gate = barrier(); let once = false;
    const [p] = await w.db.select().from(placements);
    w.afterProvider = async (method) => { if (method === 'allocateIp' && !once) { once = true; await gate.pause(); } };
    const change = await w.enqueue('change_ip'), old = runOperation(w.deps(), change); await gate.entered;
    const stop = await w.supersede(change, 'stop'); await w.settle(stop); gate.release(); expect(await old).toEqual({ state: 'canceled' });
    await reaperTick(w.deps('reaper'));
    const ips = [...w.store.records.values()].filter((r) => r.kind === 'ip');
    expect(ips.find((ip) => ip.id === p!.ipAllocationId)?.state).not.toBe('deleted');
    expect(ips.filter((ip) => ip.id !== p!.ipAllocationId).every((ip) => ip.state === 'deleted')).toBe(true);
  });

  it('queues a fenced stop when an already-sleeping browser VM appears running later', async () => {
    const w = new World(); await w.settle(await w.seed()); await w.settle(await w.enqueue('stop'));
    await w.db.update(browserInstances).set({ desiredState: 'stopped' });
    const vm = [...w.store.records.values()].find((r) => r.kind === 'vm')!; await w.store.update(vm.id, { state: 'running' });
    expect(await enforceStoppedIntent(w.deps())).toBe(1);
    const [stop] = await w.db.select().from(operations).where(eq(operations.status, 'queued'));
    expect(stop!.params).toMatchObject({ reason: 'intent_reconcile' });
    await w.settle(stop!.id); expect(w.store.records.get(vm.id)?.state).toBe('stopped');
  });

  it('does not stop a new wake that wins after a stopped-inventory snapshot was read', async () => {
    const w = new World(); await w.settle(await w.seed()); await w.settle(await w.enqueue('stop'));
    await w.db.update(browserInstances).set({ desiredState: 'stopped' });
    const vm = [...w.store.records.values()].find((r) => r.kind === 'vm')!; await w.store.update(vm.id, { state: 'running' });
    const batch = w.db.batch.bind(w.db); let woke = false;
    w.db.batch = (async (queries: Parameters<typeof w.db.batch>[0]) => {
      if (!woke) { woke = true; await w.db.update(browserInstances).set({ desiredState: 'running' }); }
      return batch(queries);
    }) as typeof w.db.batch;
    expect(await enforceStoppedIntent(w.deps())).toBe(0);
    expect(w.store.records.get(vm.id)?.state).toBe('running');
    expect((await w.db.select().from(operations)).filter((op) => !op.finishedAt)).toEqual([]);
  });

  it('reopens physical cleanup if a delayed response exposes an owned resource after purge', async () => {
    const w = new World(); const create = await w.seed(); await w.settle(create);
    const deletion = await w.enqueue('delete', { purgeNow: true }); await w.db.update(browserInstances).set({ desiredState: 'deleted' }); await w.settle(deletion); await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('purged');
    const runtime = new FakeExecutor({ store: w.store, mode: 'runtime' });
    const ctx = readContext('late-owned-disk', 'test'); ctx.tags['cb:instance'] = 'private';
    const late = await runtime.ensureVolume(ctx, 'ap-northeast-1', 'ap-northeast-1a', 10);
    await w.db.insert(resources).values({ id: 'late', instanceId: 'private', executor: 'fake', kind: 'volume', providerId: late.volumeId, region: 'ap-northeast-1', requestToken: 'late', state: 'active', tags: ctx.tags, firstSeenAt: w.clock });
    await reaperTick(w.deps('reaper')); expect(w.store.records.get(late.volumeId)?.state).toBe('deleted'); expect((await w.instance()).status).toBe('purged');
  });
});
