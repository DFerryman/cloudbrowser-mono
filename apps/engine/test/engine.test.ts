import { createDb, operationRow, prepaidBalance, reopenRegion, reservationQuote, schema, type Db } from '@cloudbrowser/db';
import { splitUsagePeriod } from '@cloudbrowser/contracts';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { ExecutorError, FakeExecutor, MemoryFakeStore, type Executor, type FaultPlan } from '@cloudbrowser/executors';
import { and, eq, ne } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAgentBridge, GatewayAgentBridge } from '../src/agent.js';
import { placementRef, readContext, type EngineDeps, type EngineMode } from '../src/context.js';
import { reaperTick } from '../src/reaper.js';
import { runOperation } from '../src/runner.js';
import { checkInstanceIp, idleStops, requestStop } from '../src/scheduler.js';

const { browserInstances, operations, resources, ipAddresses, placements, user, backups } = schema;
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

class World {
  db: Db;
  store = new MemoryFakeStore();
  clock = new Date('2026-10-01T00:00:00Z');
  faults: FaultPlan = () => null;
  random: () => number = Math.random;
  /** `gateway` uses the real agent bridge (agent_commands); the test plays the agent. */
  agentMode: 'fake' | 'gateway' = 'fake';
  pokes: string[] = [];
  archives: { presignPut(k: string): Promise<string>; presignGet(k: string): Promise<string> } | null = null;
  deletedArchives: string[] = [];

  constructor() {
    this.db = createDb(createTestD1());
  }

  executor(mode: 'runtime' | 'reaper') {
    return new FakeExecutor({ store: this.store, mode, faults: (m, c) => this.faults(m, c), random: () => this.random() });
  }

  /** Runs the engine on another executor (e.g. aws-ec2 against an in-memory EC2). */
  executorOverride: ((mode: 'runtime' | 'reaper') => Executor) | null = null;

  deps(mode: EngineMode = 'worker'): EngineDeps {
    const pick = (m: 'runtime' | 'reaper'): Executor => this.executorOverride?.(m) ?? this.executor(m);
    const ex: Executor = pick(mode === 'reaper' ? 'reaper' : 'runtime');
    const now = () => this.clock;
    const placementOf = async (id: string) => {
      const rows = await this.db.select().from(placements).where(eq(placements.instanceId, id));
      const p = rows.find((r) => r.status === 'building') ?? rows.find((r) => r.status === 'current');
      return p ? placementRef(p) : null;
    };
    const agent =
      this.agentMode === 'gateway'
        ? new GatewayAgentBridge(this.db, async (m) => void this.pokes.push(m.instanceId), now)
        : new FakeAgentBridge(pick('runtime'), () => readContext('agent', 'test'), placementOf, now);
    return {
      db: this.db,
      mode,
      executor: () => ex,
      agent: () => agent,
      envName: 'test',
      gatewayUrl: 'wss://gw.test',
      workerId: `${mode}-test`,
      now,
      notify: () => {},
      bootstrapSecret: 'test-secret',
      sleep: async () => {},
      archives: this.archives,
      archiveMasterKey: this.archives ? MASTER_KEY : null,
      deleteArchive: async (key: string) => void this.deletedArchives.push(key),
    };
  }

  advance(ms: number) {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  async seedUser(id = 'u1') {
    await this.db.insert(user).values({ id, name: id, email: `${id}@test`, emailVerified: true, createdAt: this.clock, updatedAt: this.clock });
  }

  async newInstance(id = 'inst1', regionId = 'tyo1') {
    await this.db.insert(browserInstances).values({
      id,
      userId: 'u1',
      name: 'Work',
      regionId,
      status: 'creating',
      desiredState: 'running',
      idleTimeoutS: 600,
      locale: 'en-US',
      screen: 'auto',
      fingerprint: { timezone: 'Asia/Tokyo', locale: 'en-US', screen: 'auto', chromeMajor: null },
      createdAt: this.clock,
      updatedAt: this.clock,
    });
    return this.enqueue(id, 'create');
  }

  async enqueue(instanceId: string, kind: string) {
    const row = operationRow({ instanceId, userId: 'u1', kind, now: this.clock });
    await this.db.insert(operations).values(row);
    return row.id;
  }

  /** Runs an operation to completion, jumping the clock over deferrals. */
  async settle(opId: string, mode: EngineMode = 'worker', maxRounds = 50) {
    for (let i = 0; i < maxRounds; i++) {
      const r = await runOperation(this.deps(mode), opId);
      if (r.state === 'deferred') {
        this.clock = new Date(r.notBefore.getTime() + 1);
        continue;
      }
      return r;
    }
    throw new Error('operation did not settle');
  }

  async instance(id = 'inst1') {
    const [i] = await this.db.select().from(browserInstances).where(eq(browserInstances.id, id));
    return i!;
  }

  async placement(id = 'inst1') {
    const [p] = await this.db
      .select()
      .from(placements)
      .where(and(eq(placements.instanceId, id), eq(placements.status, 'current')));
    return p;
  }

  liveProvider() {
    return [...this.store.records.values()].filter((r) => r.state !== 'deleted');
  }

  async openLedger() {
    return this.db.select().from(resources).where(ne(resources.state, 'deleted'));
  }

  /** Ledger equals the provider: every live provider resource has exactly one open ledger row. */
  async expectLedgerMatchesProvider() {
    const ledger = await this.openLedger();
    const live = this.liveProvider();
    expect(ledger.map((r) => r.providerId).sort()).toEqual(live.map((r) => r.id).sort());
  }
}

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seedUser();
});

/** Existing provider snapshots still need restore/cleanup coverage after public snapshots retire. */
async function legacySnapshot() {
  const { snapshotVolume } = await import('../src/steps.js');
  const deps = w.deps();
  const placement = (await w.placement())!;
  await snapshotVolume({ deps, executor: deps.executor('fake'), instance: { id: 'inst1' },
    tags: (kind, generation) => ({ ...readContext('legacy-snapshot', 'test').tags, 'cb:instance': 'inst1', 'cb:gen': String(generation), 'cb:kind': kind }),
  }, placement, 'legacy', 'legacy-snapshot-fixture');
  return (await w.db.select().from(backups).where(eq(backups.kind, 'snapshot')))[0]!;
}

describe('create', () => {
  it('creates one VM, interface, volume and IP, verifies the IP and ends running', async () => {
    const op = await w.newInstance();
    expect(await w.settle(op)).toEqual({ state: 'succeeded' });

    const inst = await w.instance();
    expect(inst.status).toBe('running');
    const live = w.liveProvider();
    expect(live.map((r) => r.kind).sort()).toEqual(['ip', 'network_interface', 'vm', 'volume']);
    await w.expectLedgerMatchesProvider();

    const p = await w.placement();
    expect(p?.ipAddress).toMatch(/^203\.0\.113\./);
    const [ip] = await w.db.select().from(ipAddresses);
    expect(ip?.instanceId).toBe('inst1');
    expect(ip?.assignedAt).not.toBeNull();
    for (const r of live) expect(r.tags['cb:managed']).toBe('true');
  });

  it('a second worker cannot take an operation another worker holds', async () => {
    const op = await w.newInstance();
    await w.db
      .update(operations)
      .set({ leaseOwner: 'other', leaseExpiresAt: new Date(w.clock.getTime() + 60_000) })
      .where(eq(operations.id, op));
    expect(await runOperation(w.deps(), op)).toEqual({ state: 'busy' });
    w.advance(61_000);
    expect(await w.settle(op)).toEqual({ state: 'succeeded' });
    await w.expectLedgerMatchesProvider();
  });

  it.each(['allocateIp', 'ensureNetworkInterface', 'ensureVolume', 'ensureVm'] as const)(
    'resolves a timeout after success in %s by lookup, without a duplicate',
    async (method) => {
      let fired = false;
      w.faults = (m) => {
        if (m === method && !fired) {
          fired = true;
          return 'timeout_after_success';
        }
        return null;
      };
      const op = await w.newInstance();
      expect(await w.settle(op)).toEqual({ state: 'succeeded' });
      expect(w.liveProvider()).toHaveLength(4);
      await w.expectLedgerMatchesProvider();
    },
  );

  it('survives a worker crash between the provider call and the journal write', async () => {
    const op = await w.newInstance();
    // Crash: the provider call succeeds, then the process dies before writing the result.
    let crashed = false;
    w.faults = (m) => {
      if (m === 'ensureVolume' && !crashed) {
        crashed = true;
        return 'timeout_after_success';
      }
      return null;
    };
    const first = await runOperation(w.deps(), op);
    expect(first.state).toBe('deferred');
    // Simulate the lease of the dead worker expiring and a new worker resuming.
    w.advance(5 * 60_000);
    expect(await w.settle(op)).toEqual({ state: 'succeeded' });
    expect(w.liveProvider().filter((r) => r.kind === 'volume')).toHaveLength(1);
  });

  it('marks a create that hits a quota error as failed, and the reaper cleans it up', async () => {
    w.faults = (m) => (m === 'ensureVm' ? 'quota' : null);
    const op = await w.newInstance();
    const r = await w.settle(op);
    expect(r.state).toBe('failed');
    expect((await w.instance()).status).toBe('failed');
    expect(w.liveProvider().length).toBeGreaterThan(0);

    await reaperTick(w.deps('reaper'));
    expect(w.liveProvider()).toHaveLength(0);
    // A provider request with no recorded ID is kept pending through its visibility window.
    w.advance(16 * 60_000);
    await reaperTick(w.deps('reaper'));
    expect(await w.openLedger()).toHaveLength(0);
    const [ip] = await w.db.select().from(ipAddresses);
    expect(ip?.releasedAt).not.toBeNull();
  });

  it('rejects an address used by another instance and gives up after 3 tries', async () => {
    w.random = () => 0.5; // the fake provider always offers the same address
    await w.db.insert(ipAddresses).values({ address: '203.0.113.128', executor: 'fake', regionId: 'tyo1', instanceId: 'someone-else' });
    const op = await w.newInstance();
    const r = await w.settle(op);
    expect(r).toEqual({ state: 'failed', reason: 'No suitable IP address was available in this region.' });
    const rejected = await w.db.select().from(resources).where(eq(resources.state, 'rejected'));
    expect(rejected).toHaveLength(3);
    await reaperTick(w.deps('reaper'));
    expect(w.liveProvider()).toHaveLength(0);
    // The other instance's address history is untouched.
    const [other] = await w.db.select().from(ipAddresses).where(eq(ipAddresses.address, '203.0.113.128'));
    expect(other?.instanceId).toBe('someone-else');
  });

  it('property: random faults always end in one set of resources or a clean failure', async () => {
    const classes = ['retryable', 'unknown_outcome', 'timeout_after_success', null, null, null] as const;
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 15; n++) {
      w = new World();
      await w.seedUser();
      w.faults = () => classes[Math.floor(rand() * classes.length)] ?? null;
      const op = await w.newInstance();
      const r = await w.settle(op, 'worker', 200);
      if (r.state === 'succeeded') {
        expect(w.liveProvider()).toHaveLength(4);
      } else {
        w.faults = () => null;
        await reaperTick(w.deps('reaper'));
        w.advance(16 * 60_000);
        await reaperTick(w.deps('reaper'));
        expect(w.liveProvider()).toHaveLength(0);
      }
      await w.expectLedgerMatchesProvider();
    }
  });
});

describe('lifecycle', () => {
  beforeEach(async () => {
    await w.settle(await w.newInstance());
  });

  it('checks every running browser even when one IP check hits a provider error', async () => {
    await w.settle(await w.newInstance('inst2'));
    await w.db.update(schema.instanceHealth).set({ lastIpCheck: null });
    let calls = 0;
    w.faults = (m, ctx) => (m === 'verifyEgress' && ctx.operationId === 'ip-check' && calls++ === 0 ? 'retryable' : null);
    const { periodicIpChecks } = await import('../src/scheduler.js');
    await expect(periodicIpChecks(w.deps())).rejects.toThrow(/IP checks failed for 1 of 2 browsers/);
    w.faults = () => null;
    const checked = await w.db.select().from(schema.instanceHealth);
    // The first browser's check failed to run; the second one was still checked.
    expect(checked.filter((h) => h.lastIpCheck?.ok)).toHaveLength(1);
  });

  it('keeps the same IP across sleep and wake cycles', async () => {
    const ip = (await w.placement())?.ipAddress;
    for (let i = 0; i < 10; i++) {
      expect(await w.settle(await w.enqueue('inst1', 'stop'))).toEqual({ state: 'succeeded' });
      expect((await w.instance()).status).toBe('sleeping');
      expect(w.liveProvider().find((r) => r.kind === 'vm')?.state).toBe('stopped');
      expect(await w.settle(await w.enqueue('inst1', 'start'))).toEqual({ state: 'succeeded' });
      expect((await w.instance()).status).toBe('running');
      expect((await w.placement())?.ipAddress).toBe(ip);
    }
    expect(w.liveProvider()).toHaveLength(4);
  });

  it('shows Waiting for capacity, never Running, while the provider has no capacity', async () => {
    await w.settle(await w.enqueue('inst1', 'stop'));
    w.faults = (m) => (m === 'ensureRunning' ? 'capacity' : null);
    const op = await w.enqueue('inst1', 'start');
    const r = await runOperation(w.deps(), op);
    expect(r.state).toBe('deferred');
    expect((await w.instance()).status).toBe('waiting_capacity');

    w.faults = () => null;
    w.advance(61_000);
    expect(await w.settle(op)).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('running');
  });

  it('puts an idle browser to sleep', async () => {
    w.advance(11 * 60_000);
    const stopped = await idleStops(w.deps());
    expect(stopped).toEqual(['inst1']);
    const [op] = await w.db.select().from(operations).where(and(eq(operations.kind, 'stop')));
    await w.settle(op!.id);
    expect((await w.instance()).status).toBe('sleeping');
  });

  it('keeps never-sleep browsers running until inactivity sleep is enabled again', async () => {
    await w.db.update(browserInstances).set({ idleTimeoutS: 0 }).where(eq(browserInstances.id, 'inst1'));
    w.advance(30 * 24 * 60 * 60_000);
    expect(await idleStops(w.deps())).toEqual([]);
    // Disabling sleep after the scheduler's read must also cancel its stale admission.
    expect(await requestStop(w.deps(), { id: 'inst1', userId: 'u1' }, 'idle')).toBe(false);
    expect((await w.instance()).status).toBe('running');
    expect(await w.db.select().from(operations).where(eq(operations.kind, 'stop'))).toEqual([]);
    await w.db.update(browserInstances).set({ idleTimeoutS: 600 }).where(eq(browserInstances.id, 'inst1'));
    expect(await idleStops(w.deps())).toEqual(['inst1']);
  });

  it('still allows a never-sleep browser to be stopped manually', async () => {
    await w.db.update(browserInstances).set({ idleTimeoutS: 0 }).where(eq(browserInstances.id, 'inst1'));
    expect(await requestStop(w.deps(), { id: 'inst1', userId: 'u1' }, 'manual')).toBe(true);
    const [op] = await w.db.select().from(operations).where(eq(operations.kind, 'stop'));
    expect(await w.settle(op!.id)).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('sleeping');
  });

  it('pauses the network when a second public address appears', async () => {
    const p = (await w.placement())!;
    await w.executor('runtime').injectExtraPublicAddress(p.networkId!, '192.0.2.99');
    const check = await checkInstanceIp(w.deps(), 'inst1');
    expect(check?.ok).toBe(false);
    const inst = await w.instance();
    expect(inst.status).toBe('needs_attention');
    // The dedicated IP is never swapped automatically.
    expect((await w.placement())?.ipAddress).toBe(p.ipAddress);
  });

  it('ends a new-IP request left by an older API without touching the browser or its IP', async () => {
    const before = (await w.placement())!;
    const { status } = await w.instance();
    const provider = w.liveProvider().length;
    expect(await w.settle(await w.enqueue('inst1', 'change_ip'))).toMatchObject({ state: 'failed' });
    expect(await w.db.select().from(operations).where(eq(operations.kind, 'change_ip'))).toEqual([
      expect.objectContaining({ status: 'failed', error: 'This action is no longer available.' }),
    ]);
    expect((await w.instance()).status).toBe(status);
    expect((await w.placement())!.ipAddress).toBe(before.ipAddress);
    expect(w.liveProvider()).toHaveLength(provider);
  });

  it('soft-deletes, restores, and purges only after 7 days with the reaper', async () => {
    expect(await w.settle(await w.enqueue('inst1', 'delete'))).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('deleting');
    expect(await w.settle(await w.enqueue('inst1', 'undelete'))).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('sleeping');
    await w.settle(await w.enqueue('inst1', 'delete'));

    // The worker never runs a purge, even when one is queued.
    const purge = await w.enqueue('inst1', 'purge');
    expect(await runOperation(w.deps('worker'), purge)).toEqual({ state: 'busy' });
    await w.db.delete(operations).where(eq(operations.id, purge));

    await reaperTick(w.deps('reaper'));
    expect(w.liveProvider()).toHaveLength(4);

    w.advance(7 * 86_400_000 + 1);
    await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('purged');
    expect(w.liveProvider()).toHaveLength(0);
    const [ip] = await w.db.select().from(ipAddresses);
    expect(ip?.releasedAt).not.toBeNull();
  });
});

describe('credentials', () => {
  it('the runtime credentials cannot delete anything', async () => {
    await w.settle(await w.newInstance());
    const vol = w.liveProvider().find((r) => r.kind === 'volume')!;
    await expect(
      w.executor('runtime').ensureDeleted(readContext('x', 'test'), vol.region, 'volume', vol.id),
    ).rejects.toThrow(ExecutorError);
    expect(w.liveProvider()).toHaveLength(4);
  });
});

describe('real agent through the gateway', () => {
  beforeEach(() => {
    w.agentMode = 'gateway';
  });

  /** Plays the api: what it records when the agent reports `ready`. */
  async function agentReady(generation = 1) {
    await w.db
      .insert(schema.instanceHealth)
      .values({ instanceId: 'inst1', agentReadyGeneration: generation, agentReadyAt: w.clock })
      .onConflictDoUpdate({ target: schema.instanceHealth.instanceId, set: { agentReadyGeneration: generation, agentReadyAt: w.clock } });
  }

  /** Plays the agent: answers every pending command of a kind. */
  async function answer(kind: string, result: Record<string, unknown>, ok = true) {
    const pending = await w.db.select().from(schema.agentCommands).where(eq(schema.agentCommands.kind, kind));
    for (const c of pending.filter((x) => x.status === 'pending')) {
      await w.db
        .update(schema.agentCommands)
        .set({ status: ok ? 'succeeded' : 'failed', reply: result, completedAt: w.clock })
        .where(eq(schema.agentCommands.id, c.id));
    }
  }

  it('waits for the agent and the in-Chrome IP check before showing Running', async () => {
    const op = await w.newInstance();
    expect((await runOperation(w.deps(), op)).state).toBe('deferred');
    expect((await w.instance()).status).toBe('creating');

    // The VM's user data carries a bootstrap token whose hash the engine stored.
    const vm = w.liveProvider().find((r) => r.kind === 'vm')!;
    const userData = vm.attrs.userData as { bootstrapToken: string; instanceId: string };
    expect(userData.instanceId).toBe('inst1');
    const [cred] = await w.db.select().from(schema.agentCredentials);
    const { sha256Hex } = await import('@cloudbrowser/db');
    expect(cred?.bootstrapHash).toBe(await sha256Hex(userData.bootstrapToken));

    w.advance(5_000);
    await agentReady();
    expect((await runOperation(w.deps(), op)).state).toBe('deferred'); // ip_check sent, waiting for reply
    expect(w.pokes).toContain('inst1');

    const ip = (await w.placement())!.ipAddress!;
    await answer('ip_check', { observed: [ip] });
    w.advance(3_000);
    expect(await runOperation(w.deps(), op)).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('running');
  });

  it('fails closed when Chrome sees another address', async () => {
    const op = await w.newInstance();
    await runOperation(w.deps(), op);
    await agentReady();
    w.advance(3_000);
    await runOperation(w.deps(), op);
    await answer('ip_check', { observed: ['192.0.2.1'] });
    w.advance(3_000);
    const r = await runOperation(w.deps(), op);
    expect(r.state).toBe('failed');
    expect((await w.instance()).statusReason).toMatch(/Chrome saw 192\.0\.2\.1/);
  });

  it('stops the VM anyway when the agent does not acknowledge shutdown within 60 s', async () => {
    const op = await w.newInstance();
    await runOperation(w.deps(), op);
    await agentReady();
    w.advance(3_000);
    await runOperation(w.deps(), op);
    await answer('ip_check', { observed: [(await w.placement())!.ipAddress!] });
    w.advance(3_000);
    await runOperation(w.deps(), op);

    const stop = await w.enqueue('inst1', 'stop');
    expect((await runOperation(w.deps(), stop)).state).toBe('deferred');
    w.advance(61_000);
    expect(await w.settle(stop)).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('sleeping');
    const [shutdown] = await w.db.select().from(schema.agentCommands).where(eq(schema.agentCommands.kind, 'prepare_shutdown'));
    expect(shutdown?.status).toBe('pending');
  });

  it('a wake needs a fresh ready report, not the one from before the stop', async () => {
    const op = await w.newInstance();
    w.advance(-1_000); // a report older than the operation
    await agentReady();
    w.advance(2_000);
    await runOperation(w.deps(), op);
    expect((await w.instance()).status).toBe('creating');
  });

  it('pauses the network when the agent has not reported an IP check for 15 minutes', async () => {
    const op = await w.newInstance();
    await runOperation(w.deps(), op);
    await agentReady();
    w.advance(3_000);
    await runOperation(w.deps(), op);
    await answer('ip_check', { observed: [(await w.placement())!.ipAddress!] });
    w.advance(3_000);
    await runOperation(w.deps(), op);

    const { periodicIpChecks } = await import('../src/scheduler.js');
    await periodicIpChecks(w.deps());
    expect((await w.instance()).status).toBe('running');
    w.advance(16 * 60_000);
    await periodicIpChecks(w.deps());
    expect((await w.instance()).status).toBe('needs_attention');
  });
});

describe('backups, restore and recover', () => {
  beforeEach(async () => {
    await w.settle(await w.newInstance());
  });

  async function placements_() {
    return w.db.select().from(placements).where(eq(placements.instanceId, 'inst1'));
  }

  it('does not schedule new snapshots but can restore an existing legacy snapshot while asleep', async () => {
    const { dailySnapshots } = await import('../src/scheduler.js');
    expect(await dailySnapshots(w.deps())).toBe(0);
    await w.db.update(browserInstances).set({ backupsEnabled: true }).where(eq(browserInstances.id, 'inst1'));
    expect(await dailySnapshots(w.deps())).toBe(0); // An old database flag cannot resume the retired feature.
    const snap = await legacySnapshot();
    expect(snap?.kind).toBe('snapshot');

    const restoreWhileRunning = await w.enqueue('inst1', 'restore');
    await w.db.update(operations).set({ params: { backupId: snap!.id } }).where(eq(operations.id, restoreWhileRunning));
    // The api only allows snapshot restores while asleep; the engine's swap refuses a running VM too.
    expect((await w.settle(restoreWhileRunning)).state).toBe('failed');
    await w.db.update(browserInstances).set({ status: 'running', statusReason: null }).where(eq(browserInstances.id, 'inst1'));

    await w.settle(await w.enqueue('inst1', 'stop'));
    const before = (await w.placement())!;
    const op = await w.enqueue('inst1', 'restore');
    await w.db.update(operations).set({ params: { backupId: snap!.id } }).where(eq(operations.id, op));
    expect(await w.settle(op)).toEqual({ state: 'succeeded' });
    const after = (await w.placement())!;
    expect(after.volumeId).not.toBe(before.volumeId);
    expect(after.ipAddress).toBe(before.ipAddress);
    expect((await w.instance()).status).toBe('sleeping');
    const old = await w.db.select().from(resources).where(eq(resources.providerId, before.volumeId!));
    expect(old[0]?.state).toBe('superseded');
    await w.expectLedgerMatchesProvider();
  });

  it('recovers into another zone with the same IP and data', async () => {
    const before = (await w.placement())!;
    expect(await w.settle(await w.enqueue('inst1', 'recover'))).toEqual({ state: 'succeeded' });
    const after = (await w.placement())!;
    expect(after.generation).toBe(2);
    expect(after.zone).not.toBe(before.zone);
    expect(after.ipAddress).toBe(before.ipAddress);
    expect(after.ipAllocationId).toBe(before.ipAllocationId);
    const newVolume = w.store.records.get(after.volumeId!)!;
    expect(newVolume.attrs.fromSnapshot).toBeTruthy();
    expect((await w.instance()).status).toBe('running');
    expect((await placements_()).find((p) => p.generation === 1)?.status).toBe('superseded');
    // The IP moved: the old interface no longer has a public address.
    expect((await w.executor('runtime').verifyEgress(readContext('t', 'test'), placementRef(after))).ok).toBe(true);
    await w.expectLedgerMatchesProvider();

    // Old VM, interface and volume go 7 days later, never the IP.
    w.advance(8 * 86_400_000);
    await reaperTick(w.deps('reaper'));
    const live = w.liveProvider();
    expect(live.find((r) => r.id === before.vmId)).toBeUndefined();
    expect(live.find((r) => r.id === before.ipAllocationId)).toBeDefined();
  });

  it('hands a start over to recover after 30 minutes without capacity', async () => {
    await w.settle(await w.enqueue('inst1', 'stop'));
    w.faults = (m) => (m === 'ensureRunning' ? 'capacity' : null);
    const start = await w.enqueue('inst1', 'start');
    await runOperation(w.deps(), start);
    expect((await w.instance()).status).toBe('waiting_capacity');
    w.advance(31 * 60_000);
    expect((await runOperation(w.deps(), start)).state).toBe('failed');
    const [recover] = await w.db.select().from(operations).where(eq(operations.kind, 'recover'));
    expect(recover?.finishedAt).toBeNull();
    w.faults = () => null;
    expect(await w.settle(recover!.id)).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('running');
  });

  it('archives the profile through the agent when the browser goes to sleep', async () => {
    w.agentMode = 'gateway';
    w.archives = { presignPut: async (k) => `https://r2.test/put/${k}`, presignGet: async (k) => `https://r2.test/get/${k}` };
    const stop = await w.enqueue('inst1', 'stop');
    expect((await runOperation(w.deps(), stop)).state).toBe('deferred');
    const [cmd] = await w.db.select().from(schema.agentCommands).where(eq(schema.agentCommands.kind, 'prepare_shutdown'));
    const archive = (cmd!.payload as { archive: { putUrl: string; objectKey: string } }).archive;
    expect(archive.putUrl).toBe(`https://r2.test/put/${archive.objectKey}`);
    expect(JSON.stringify(cmd!.payload)).not.toMatch(/key"\s*:/); // the archive key is never stored in the command
    const [keyRow] = await w.db.select().from(schema.archiveKeys);
    expect(keyRow?.wrappedKey).toBeTruthy();

    await w.db
      .update(schema.agentCommands)
      .set({ status: 'succeeded', reply: { archived: true, sizeBytes: 12345 } })
      .where(eq(schema.agentCommands.id, cmd!.id));
    w.advance(3_000);
    expect(await w.settle(stop)).toEqual({ state: 'succeeded' });
    const [b] = await w.db.select().from(backups).where(eq(backups.kind, 'archive'));
    expect(b).toMatchObject({ status: 'complete', sizeBytes: 12345, reason: 'sleep' });

    // Purge destroys the archive key and deletes the archives.
    w.agentMode = 'fake';
    w.archives = null;
    await w.settle(await w.enqueue('inst1', 'delete'));
    w.advance(8 * 86_400_000);
    await reaperTick(w.deps('reaper'));
    const [destroyed] = await w.db.select().from(schema.archiveKeys);
    expect(destroyed?.wrappedKey).toBeNull();
    expect(destroyed?.destroyedAt).not.toBeNull();
    expect(w.deletedArchives).toContain(archive.objectKey);
  });

  it('keeps the newest snapshot, 7 days of snapshots, the last 10 archives and one archive a day for 14 days', async () => {
    const { expiredBackups } = await import('../src/reaper.js');
    const now = new Date('2026-10-30T12:00:00Z');
    const day = (d: number, h = 12) => new Date(Date.UTC(2026, 9, 30 - d, h));
    const list = [
      ...[0, 3, 6, 8, 10].map((d) => ({ id: `s${d}`, kind: 'snapshot', createdAt: day(d) })),
      // 12 archives today, then one each on days 1..20
      ...Array.from({ length: 12 }, (_, i) => ({ id: `a0-${i}`, kind: 'archive', createdAt: day(0, 11 - i * 0.5) })),
      ...Array.from({ length: 20 }, (_, i) => ({ id: `a${i + 1}`, kind: 'archive', createdAt: day(i + 1) })),
    ];
    const expired = new Set(expiredBackups(list, now));
    expect([...expired].filter((x) => x.startsWith('s')).sort()).toEqual(['s10', 's8']);
    expect(expired.has('a0-0')).toBe(false); // among the newest 10
    expect(expired.has('a0-11')).toBe(true); // older than the newest 10, and today already has newer ones
    expect(expired.has('a13')).toBe(false); // newest of its day, within 14 days
    expect(expired.has('a15')).toBe(true); // older than 14 days
  });
});


describe('metering and the prepaid balance', () => {
  const { pricingSettings: settings, billingAccounts, usageRecords, controlFlags, instanceHealth } = schema;
  beforeEach(async () => {
    const { refreshPrices } = await import('../src/prices.js');
    await refreshPrices(w.deps());
    await w.settle(await w.newInstance());
  });

  const stopReasons = async () =>
    (await w.db.select().from(operations).where(eq(operations.kind, 'stop'))).map((o) => (o.params as { reason?: string }).reason);
  const usage = async (item: string) => (await w.db.select().from(usageRecords).where(eq(usageRecords.item, item)))[0];
  const balance = async () => (await w.db.select().from(billingAccounts).where(eq(billingAccounts.userId, 'u1')))[0];
  const prepaid = () => w.db.insert(controlFlags).values({ key: 'billing_required', value: 'true', updatedAt: w.clock }).onConflictDoUpdate({ target: controlFlags.key, set: { value: 'true' } });
  const meter = async () => (await import('../src/metering.js')).meterUsage(w.deps());

  it('stores each region’s price sheet from the provider and prices the ledger with it', async () => {
    const [row] = await w.db.select().from(schema.providerPrices).where(eq(schema.providerPrices.regionId, 'tyo1'));
    expect(row?.sheet).toMatchObject({ source: 'simulated', vmHour: 0.1, ipHour: 0.005, volumeGbMonth: 0.08, rootVolumeGb: 16 });
    const ledger = await w.openLedger();
    expect(ledger.find((r) => r.kind === 'ip')?.monthlyCostEstimate).toBe(365); // 0.005 × 730 h
    expect(ledger.find((r) => r.kind === 'volume')?.monthlyCostEstimate).toBe(80); // 10 GB × 0.08
    // Fresh prices are not read again; a forced refresh is.
    const { refreshPrices } = await import('../src/prices.js');
    expect((await refreshPrices(w.deps())).refreshed).toEqual([]);
    expect((await refreshPrices(w.deps(), { force: true })).refreshed).toContain('tyo1');
  });

  it('charges compute while running and the IP and storage always, at cost times the markup', async () => {
    await meter(); // opens the window
    w.advance(30 * 60_000); // capped at 5 minutes per run
    await meter();
    w.advance(5 * 60_000);
    await meter();
    // 10 minutes running at $0.10/h × 120% = 20,000 micro-dollars.
    expect(await usage('compute')).toMatchObject({ unitPriceMicros: 120_000, unitCostMicros: 100_000, amountMicros: 20_000, costMicros: 16_667 });
    expect((await usage('ip'))?.amountMicros).toBe(1_000); // $0.006/h for 10 minutes
    // (10 GB data + 16 GB system) × $0.096/GB-month for 10 minutes.
    const monthHours = new Date(Date.UTC(w.clock.getUTCFullYear(), w.clock.getUTCMonth() + 1, 1)).getTime()
      - new Date(Date.UTC(w.clock.getUTCFullYear(), w.clock.getUTCMonth(), 1)).getTime();
    expect((await usage('storage'))?.amountMicros).toBe(Math.round(26 * 96_000 * (10 * 60_000) / monthHours));
    expect(await usage('snapshot')).toBeUndefined(); // off by default

    await w.settle(await w.enqueue('inst1', 'stop'));
    w.advance(5 * 60_000);
    await meter();
    w.advance(5 * 60_000);
    await meter();
    expect((await usage('compute'))?.amountMicros).toBe(20_000); // asleep: no compute
    expect((await usage('ip'))?.amountMicros).toBeGreaterThan(1_000); // the IP and disk still bill
    expect(await balance()).toBeUndefined(); // the pilot is free: nothing taken from a balance
  });

  it('bills data sent to the internet from the agent’s counter, across a reboot', async () => {
    await meter();
    await w.db.update(instanceHealth).set({ netTxBytes: 1024 ** 3 }).where(eq(instanceHealth.instanceId, 'inst1'));
    w.advance(60_000);
    await meter(); // first report: counted from here
    await w.db.update(instanceHealth).set({ netTxBytes: 3 * 1024 ** 3 }).where(eq(instanceHealth.instanceId, 'inst1'));
    w.advance(60_000);
    await meter();
    expect((await usage('transfer'))?.quantity).toBe(2);
    await w.db.update(instanceHealth).set({ netTxBytes: 1024 ** 3 / 2 }).where(eq(instanceHealth.instanceId, 'inst1')); // rebooted
    w.advance(60_000);
    await meter();
    expect((await usage('transfer'))?.quantity).toBe(2.5);
    expect((await usage('transfer'))?.amountMicros).toBe(Math.round(2.5 * 108_000)); // $0.09/GB × 120%
  });

  it('follows the markup set by the operator', async () => {
    await w.db.update(settings).set({ markupPercent: 150 }).where(eq(settings.id, 1));
    await meter();
    w.advance(60 * 60_000);
    await meter();
    expect(await usage('compute')).toMatchObject({ unitPriceMicros: 150_000, unitCostMicros: 100_000 });
  });

  it('spends only available credit, immediately stops at exhaustion and retains the funded fixed-resource deposit', async () => {
    const { applyBalance } = await import('../../api/src/billing/ledger.js');
    const quote = (await reservationQuote(w.db, 'tyo1', { storageGb: 10, backupsEnabled: false }, w.clock))!;
    await applyBalance(w.db, { userId: 'u1', kind: 'adjustment', amountMicros: quote.requiredMicros + 1_000_000, reference: 'fund-deposit', actor: 'test' }, w.clock);
    await prepaid();
    await meter();
    expect((await prepaidBalance(w.db, 'u1')).reservedMicros).toBe(quote.requiredMicros);
    await applyBalance(w.db, { userId: 'u1', kind: 'adjustment', amountMicros: -985_000, reference: 'prior-paid-usage', actor: 'test' }, w.clock);
    w.advance(5 * 60_000);
    await meter(); // 10,000 compute + IP and storage
    expect((await prepaidBalance(w.db, 'u1')).availableMicros).toBeLessThan(5_000);
    expect((await balance())!.exhaustedAt).toBeNull();
    w.advance(5 * 60_000);
    await meter(); // runs out
    expect(await prepaidBalance(w.db, 'u1')).toMatchObject({ balanceMicros: quote.requiredMicros, reservedMicros: quote.requiredMicros, availableMicros: 0 });
    expect((await balance())!.exhaustedAt).toEqual(w.clock);
    expect(await stopReasons()).toEqual(['balance']);
    const [reservation] = await w.db.select().from(schema.browserReservations);
    expect(reservation).toMatchObject({ retentionStartedAt: w.clock, retentionEndsAt: new Date(w.clock.getTime() + 7 * 86_400_000) });
    const [stop] = await w.db.select().from(operations).where(eq(operations.kind, 'stop'));
    await w.settle(stop!.id);
    w.advance(60_000);
    await meter();
    expect((await prepaidBalance(w.db, 'u1')).availableMicros).toBe(0);
    expect((await balance())!.balanceMicros).toBeLessThan(quote.requiredMicros);
    expect((await balance())!.balanceMicros).toBeGreaterThan(0);

    // A real sufficient top-up refills the deposit and clears retention atomically.
    await applyBalance(w.db, { userId: 'u1', kind: 'adjustment', amountMicros: 5_000_000, reference: 'restore-credit', actor: 'test' }, w.clock);
    expect((await balance())!.exhaustedAt).toBeNull();
    expect((await w.db.select().from(schema.browserReservations))[0]).toMatchObject({ reservedMicros: quote.requiredMicros, retentionStartedAt: null, retentionEndsAt: null });
  });

  it('puts a frozen account’s browsers to sleep at once', async () => {
    await w.db.insert(billingAccounts).values({ userId: 'u1', balanceMicros: 5_000_000, frozenAt: w.clock, frozenReason: 'dispute', updatedAt: w.clock });
    await meter();
    expect(await stopReasons()).toEqual(['frozen']);
  });

  it('records the cost of existing snapshots without charging users and deletes them when turned off', async () => {
    const { dailySnapshots } = await import('../src/scheduler.js');
    await w.db.update(browserInstances).set({ backupsEnabled: true }).where(eq(browserInstances.id, 'inst1'));
    await meter();
    w.advance(60 * 60_000);
    await meter();
    expect(await usage('snapshot')).toBeUndefined(); // on, but no snapshot yet
    expect(await dailySnapshots(w.deps())).toBe(0);
    await legacySnapshot();
    const snapshotStart = w.clock;
    w.advance(5 * 60_000);
    await meter();
    const fraction = splitUsagePeriod(snapshotStart, w.clock).reduce((sum, p) => sum + p.monthFraction, 0);
    expect(await usage('snapshot')).toMatchObject({ amountMicros: 0, chargedMicros: 0, costMicros: Math.round(10 * 50_000 * fraction) });
    expect((await usage('snapshot'))?.costMicros).toBeGreaterThan(0);

    await w.db.update(browserInstances).set({ backupsEnabled: false }).where(eq(browserInstances.id, 'inst1'));
    await reaperTick(w.deps('reaper'));
    expect((await w.db.select().from(backups).where(eq(backups.kind, 'snapshot')))[0]?.status).toBe('deleted');
    await w.expectLedgerMatchesProvider();
  });

  it('starts new browsers at 10 GB and grows the volume on request, never shrinking it', async () => {
    expect((await w.instance()).storageGb).toBe(10);
    const op = operationRow({ instanceId: 'inst1', userId: 'u1', kind: 'resize_volume', params: { sizeGb: 25 }, now: w.clock });
    await w.db.insert(operations).values(op);
    expect(await w.settle(op.id)).toEqual({ state: 'succeeded' });
    const p = (await w.placement())!;
    expect(w.store.records.get(p.volumeId!)?.attrs.sizeGb).toBe(25);
    expect((await w.instance()).storageGb).toBe(25);
    expect((await w.instance()).status).toBe('running');
    expect((await w.openLedger()).find((r) => r.providerId === p.volumeId)?.monthlyCostEstimate).toBe(200);

    const shrink = operationRow({ instanceId: 'inst1', userId: 'u1', kind: 'resize_volume', params: { sizeGb: 20 }, now: w.clock });
    await w.db.insert(operations).values(shrink);
    expect((await w.settle(shrink.id)).state).toBe('failed');
    expect((await w.instance()).status).toBe('running'); // a failed resize is not a problem with the browser
  });

  it('runs a free trial for 10 minutes at no charge, then keeps it 7 days and purges it', async () => {
    await prepaid();
    await w.db.update(browserInstances).set({ trialState: 'active', trialUsedS: 0 }).where(eq(browserInstances.id, 'inst1'));
    await meter();
    w.advance(5 * 60_000);
    await meter();
    expect((await w.instance()).trialState).toBe('active');
    expect(await stopReasons()).toEqual([]);
    w.advance(5 * 60_000);
    await meter(); // the 10 minutes are used
    expect((await w.instance()).trialState).toBe('ended');
    expect(await stopReasons()).toEqual(['trial']);
    // Metered at cost so operators see what trials cost, but charged nothing; an empty balance is not "run out".
    expect(await usage('compute')).toMatchObject({ amountMicros: 0, costMicros: 16_667 });
    expect((await balance())?.exhaustedAt ?? null).toBeNull();
    expect((await balance())?.balanceMicros ?? 0).toBe(0);

    const [stop] = await w.db.select().from(operations).where(eq(operations.kind, 'stop'));
    await w.settle(stop!.id);
    const asleep = await w.instance();
    expect(asleep.status).toBe('sleeping');
    expect(asleep.trialReclaimAt).toEqual(new Date(w.clock.getTime() + 7 * 86_400_000));

    const { reclaimTrials } = await import('../src/metering.js');
    w.advance(7 * 86_400_000 - 60_000);
    expect(await reclaimTrials(w.deps())).toBe(0);
    w.advance(60_000);
    expect(await reclaimTrials(w.deps())).toBe(1);
    const [del] = await w.db.select().from(operations).where(eq(operations.kind, 'delete'));
    expect(del?.params).toMatchObject({ reason: 'trial_expired', purgeNow: true });
    await w.settle(del!.id);
    expect((await w.instance()).status).toBe('deleting');
  });

  it('charges a converted trial like any browser', async () => {
    await prepaid();
    await w.db.update(browserInstances).set({ trialState: 'converted', trialUsedS: 600 }).where(eq(browserInstances.id, 'inst1'));
    await w.db.insert(billingAccounts).values({ userId: 'u1', balanceMicros: 5_000_000, updatedAt: w.clock });
    await meter();
    w.advance(5 * 60_000);
    await meter();
    expect((await usage('compute'))?.amountMicros).toBe(10_000);
    expect(await stopReasons()).toEqual([]);
  });

  it('keeps snapshots for the retention cap, and none once snapshots are off', async () => {
    const { expiredBackups } = await import('../src/reaper.js');
    const now = new Date('2026-10-30T00:00:00Z');
    const snaps = [0, 10].map((d) => ({ id: `s${d}`, kind: 'snapshot', reason: 'daily', createdAt: new Date(now.getTime() - d * 86_400_000) }));
    expect(expiredBackups(snaps, now)).toEqual(['s10']);
    expect(expiredBackups(snaps, now, 14)).toEqual([]);
    expect(expiredBackups(snaps, now, 7, false).sort()).toEqual(['s0', 's10']);
  });
});

describe('on the aws-ec2 executor', () => {
  it('creates, sleeps, wakes, deletes and purges a browser with real EC2 semantics', async () => {
    const { AwsExecutor } = await import('@cloudbrowser/executors');
    const { FakeEc2 } = await import('../../../packages/executors/test/fake-ec2.js');
    const ec2 = new FakeEc2();
    w.executorOverride = (mode) =>
      new AwsExecutor({
        mode,
        accessKeyId: 'AKIDTEST',
        secretAccessKey: 'secret',
        regions: { 'ap-northeast-1': { subnets: { 'ap-northeast-1a': 'subnet-a', 'ap-northeast-1c': 'subnet-c' }, securityGroupId: 'sg-1' } },
        appUrl: 'https://app.test',
        agentImage: 'agent',
        browserImage: 'browser',
        endpoint: () => 'https://ec2.test/',
        fetch: ec2.fetch,
        sleep: async () => {},
        pollMs: 1,
      });

    // Real launch admission needs a provider price sheet, including every configured fallback.
    const simulated = await w.executor('runtime').prices(readContext('prices', 'test'), 'ap-northeast-1');
    const sheet = { ...simulated, source: 'aws-price-list' as const, instanceType: 'c7i-flex.large', vmHour: 0.11, instanceTypes: { 'c7i-flex.large': 0.11, 'c6i.large': 0.1, 'c5.large': 0.1 } };
    await w.db.insert(schema.providerPrices).values({ regionId: 'tyo1', executor: 'aws-ec2', providerRegion: 'ap-northeast-1', sheet, fetchedAt: w.clock });

    expect(await w.settle(await w.newInstance())).toEqual({ state: 'succeeded' });
    const p = (await w.placement())!;
    expect(ec2.instances.get(p.vmId!)).toMatchObject({ state: 'running', protected: true });
    expect(ec2.volumes.get(p.volumeId!)).toMatchObject({ instance: p.vmId, device: '/dev/sdf' });
    expect(ec2.addresses.get(p.ipAllocationId!)).toMatchObject({ eni: p.networkId, publicIp: p.ipAddress });
    expect((await w.instance()).status).toBe('running');

    await w.settle(await w.enqueue('inst1', 'stop'));
    expect(ec2.instances.get(p.vmId!)?.state).toBe('stopped');
    expect((await w.instance()).status).toBe('sleeping');
    await w.settle(await w.enqueue('inst1', 'start'));
    expect(ec2.instances.get(p.vmId!)?.state).toBe('running');
    expect((await w.instance()).status).toBe('running');

    // Delete, then the reaper purges everything after 7 days; the runtime user never deleted anything.
    await w.settle(await w.enqueue('inst1', 'delete'));
    w.advance(8 * 86_400_000);
    await reaperTick(w.deps('reaper'));
    expect((await w.instance()).status).toBe('purged');
    expect(ec2.instances.get(p.vmId!)?.state).toBe('terminated');
    expect(ec2.addresses.size).toBe(0);
    expect([...ec2.volumes.values()]).toEqual([]);
    expect(ec2.enis.size).toBe(0);
    expect(ec2.calls.filter((c) => /^(Terminate|Delete|Release)/.test(c.action)).length).toBeGreaterThan(0);
  });

  async function onEc2() {
    const { AwsExecutor } = await import('@cloudbrowser/executors');
    const { FakeEc2 } = await import('../../../packages/executors/test/fake-ec2.js');
    const ec2 = new FakeEc2();
    w.executorOverride = (mode) =>
      new AwsExecutor({
        mode, accessKeyId: 'AKIDTEST', secretAccessKey: 'secret',
        regions: { 'ap-northeast-1': { subnets: { 'ap-northeast-1a': 'subnet-a', 'ap-northeast-1c': 'subnet-c' }, securityGroupId: 'sg-1' } },
        appUrl: 'https://app.test', agentImage: 'agent', browserImage: 'browser',
        endpoint: () => 'https://ec2.test/', fetch: ec2.fetch, sleep: async () => {}, pollMs: 1,
      });
    const simulated = await w.executor('runtime').prices(readContext('prices', 'test'), 'ap-northeast-1');
    const sheet = { ...simulated, source: 'aws-price-list' as const, instanceType: 'c7i-flex.large', vmHour: 0.11, instanceTypes: { 'c7i-flex.large': 0.11, 'c6i.large': 0.1, 'c5.large': 0.1 } };
    await w.db.insert(schema.providerPrices).values({ regionId: 'tyo1', executor: 'aws-ec2', providerRegion: 'ap-northeast-1', sheet, fetchedAt: w.clock });
    return ec2;
  }
  const health = () => w.db.select().from(schema.launchHealth);

  it('moves a new browser to another zone when its zone has no capacity, and the reaper releases what it left behind', async () => {
    const ec2 = await onEc2();
    const subnetOf = (eni: string) => ec2.enis.get(eni)?.subnet;
    ec2.fail = (a, p) => (a === 'RunInstances' && subnetOf(p['NetworkInterface.1.NetworkInterfaceId']!) === 'subnet-a' ? { code: 'InsufficientInstanceCapacity', status: 500 } : null);
    expect(await w.settle(await w.newInstance())).toEqual({ state: 'succeeded' });
    const p = (await w.placement())!;
    expect(p.zone).toBe('ap-northeast-1c');
    expect((await w.instance()).status).toBe('running');
    // Same static IP, now on the new zone's interface.
    expect(ec2.addresses.get(p.ipAllocationId!)).toMatchObject({ eni: p.networkId });
    const left = (await w.db.select().from(resources).where(eq(resources.state, 'superseded'))).map((r) => r.kind).sort();
    expect(left).toEqual(['network_interface', 'volume']);
    // One VM row: the refused launch left none pending for the reconciler to adopt into.
    expect((await w.db.select().from(resources).where(and(eq(resources.kind, 'vm'), ne(resources.state, 'deleted')))).map((r) => r.providerId)).toEqual([p.vmId]);
    expect(await health()).toEqual(expect.arrayContaining([
      expect.objectContaining({ zone: 'ap-northeast-1a', lastCapacityAt: expect.any(Date) }),
      expect.objectContaining({ zone: 'ap-northeast-1c', lastSuccessAt: expect.any(Date) }),
    ]));

    await reaperTick(w.deps('reaper'));
    expect([...ec2.enis.values()].map((e) => e.az)).toEqual(['ap-northeast-1c']);
    expect([...ec2.volumes.values()].filter((v) => v.tags['cb:kind'] === 'volume').map((v) => v.az)).toEqual(['ap-northeast-1c']);
    expect(ec2.addresses.get(p.ipAllocationId!)).toMatchObject({ eni: p.networkId });

    // The next browser starts in the zone that had room.
    await w.newInstance('inst2');
    ec2.fail = () => null;
    expect(await w.settle((await w.db.select().from(operations).where(eq(operations.instanceId, 'inst2')))[0]!.id)).toEqual({ state: 'succeeded' });
    expect((await w.placement('inst2'))!.zone).toBe('ap-northeast-1c');
  });

  it('fails at once with the provider reason when EC2 ends every launch, and marks the region', async () => {
    const ec2 = await onEc2();
    // What EC2 reports when an organization SCP denies the KMS calls it makes for the caller.
    ec2.launchFailure = () => ({ code: 'Client.InvalidKMSKey.InvalidState', message: 'The KMS key provided is in an incorrect state' });
    const result = await w.settle(await w.newInstance());
    expect(result).toMatchObject({ state: 'failed' });
    const inst = await w.instance();
    expect(inst.status).toBe('failed');
    expect(inst.status).not.toBe('waiting_capacity');
    expect(inst.statusReason).toContain('provider configuration problem');
    const [op] = await w.db.select().from(operations).where(eq(operations.instanceId, 'inst1'));
    expect(op).toMatchObject({ errorClass: 'forbidden', attempt: 0 });
    const [step] = await w.db.select().from(schema.operationSteps).where(and(eq(schema.operationSteps.operationId, op!.id), eq(schema.operationSteps.step, 'create_vm')));
    expect(step?.result).toMatchObject({ errorClass: 'forbidden', error: expect.stringContaining('incorrect state') });
    expect(await w.db.select().from(schema.alerts)).toEqual([expect.objectContaining({ severity: 'critical', title: 'forbidden error in create (tyo1)', detail: expect.objectContaining({ message: expect.stringContaining('incorrect state') }) })]);
    expect(await health()).toEqual([expect.objectContaining({ zone: 'ap-northeast-1a', lastFailureClass: 'forbidden', lastFailure: expect.stringContaining('incorrect state') })]);
    // The dead VM is not left in the ledger as an open resource.
    expect((await w.db.select().from(resources).where(eq(resources.kind, 'vm')))).toEqual([expect.objectContaining({ state: 'deleted', providerId: [...ec2.instances.keys()][0] })]);

    // The reaper releases what the failed create allocated, then leaves the browser alone.
    await reaperTick(w.deps('reaper'));
    expect((await w.instance()).providerReleasedAt).toBeInstanceOf(Date);
    expect(ec2.addresses.size + ec2.enis.size + ec2.volumes.size).toBe(0);
    const calls = ec2.calls.length;
    await reaperTick(w.deps('reaper'));
    expect(ec2.calls.length).toBe(calls);

    // The region stays blocked, past the 30-minute pause of other failures: a create queued
    // anyway (e.g. accepted by an API without the admission check) ends before any AWS call.
    w.advance(6 * 3_600_000);
    expect(await w.settle(await w.newInstance('inst2'))).toMatchObject({ state: 'failed' });
    expect(await w.instance('inst2')).toMatchObject({ status: 'failed', statusReason: expect.stringContaining("can't be created in") });
    expect(ec2.calls.length).toBe(calls);
    expect(await w.db.select().from(resources).where(eq(resources.instanceId, 'inst2'))).toEqual([]);

    // Once the cause is fixed and an operator reopens the region, the next create is the test.
    ec2.launchFailure = () => null;
    await reopenRegion(w.db, 'tyo1');
    expect(await w.settle(await w.newInstance('inst3'))).toEqual({ state: 'succeeded' });
    expect(await health()).toEqual([expect.objectContaining({ zone: 'ap-northeast-1a', lastSuccessAt: expect.any(Date), lastFailureAt: null })]);
  });

  it('blocks a region where AWS denies the account a launch action', async () => {
    const ec2 = await onEc2();
    // E.g. an organization SCP that does not list ec2:RunInstances for this region.
    ec2.fail = (a) => (a === 'RunInstances' ? { code: 'UnauthorizedOperation', status: 403 } : null);
    expect(await w.settle(await w.newInstance())).toMatchObject({ state: 'failed' });
    expect(await health()).toEqual([expect.objectContaining({ zone: 'ap-northeast-1a', lastFailureClass: 'forbidden', lastFailure: expect.stringContaining('UnauthorizedOperation') })]);
    expect((await w.instance()).statusReason).toContain('provider configuration problem');
    const calls = ec2.calls.length;
    expect(await w.settle(await w.newInstance('inst2'))).toMatchObject({ state: 'failed' });
    expect(ec2.calls.length).toBe(calls);
  });

  it('does not record a price-cap refusal as a capacity shortage or move zones for it', async () => {
    const ec2 = await onEc2();
    // The quote the user confirmed is below every machine's current price.
    const op = operationRow({ instanceId: 'inst1', userId: 'u1', kind: 'create', params: { storageGb: 10, maxVmHour: 0.01 }, now: w.clock });
    await w.newInstance();
    await w.db.update(operations).set({ params: op.params }).where(eq(operations.instanceId, 'inst1'));
    const [created] = await w.db.select().from(operations).where(eq(operations.instanceId, 'inst1'));
    await runOperation(w.deps(), created!.id);
    expect(await health()).toEqual([]);
    expect([...ec2.enis.values()].map((e) => e.az)).toEqual(['ap-northeast-1a']);
    expect(ec2.calls.some((c) => c.action === 'RunInstances')).toBe(false);
  });

  it('moves to another zone on a disk shortage, and tries a zone again once every zone was short for a while', async () => {
    const ec2 = await onEc2();
    const azOf = (eni: string) => ec2.enis.get(eni)?.az;
    let shortZones = new Set(['ap-northeast-1a', 'ap-northeast-1c']);
    ec2.fail = (a, p) => {
      if (a === 'CreateVolume' && p.AvailabilityZone === 'ap-northeast-1a' && shortZones.has('ap-northeast-1a')) return { code: 'InsufficientVolumeCapacity', status: 500 };
      if (a === 'RunInstances' && shortZones.has(azOf(p['NetworkInterface.1.NetworkInterfaceId']!)!)) return { code: 'InsufficientInstanceCapacity', status: 500 };
      return null;
    };
    const opId = await w.newInstance();
    // a: no disk; c: no machine; then it waits in c.
    let r = await runOperation(w.deps(), opId);
    expect(r).toMatchObject({ state: 'deferred' });
    expect((await w.instance()).status).toBe('waiting_capacity');
    expect([...ec2.volumes.values()].filter((v) => v.tags['cb:kind'] === 'volume').map((v) => v.az)).toEqual(['ap-northeast-1c']);
    // Zone a recovers; after five minutes the create tries it again instead of staying in c.
    shortZones = new Set(['ap-northeast-1c']);
    w.advance(6 * 60_000);
    expect(await w.settle(opId)).toEqual({ state: 'succeeded' });
    expect((await w.placement())!.zone).toBe('ap-northeast-1a');
  });

  it('relaunches with a new token after a VM ended during launch for a transient reason', async () => {
    const ec2 = await onEc2();
    let dies = 1;
    ec2.launchFailure = () => (dies-- > 0 ? { code: 'Server.InternalError', message: 'Internal error on launch' } : null);
    const opId = await w.newInstance();
    expect(await runOperation(w.deps(), opId)).toMatchObject({ state: 'deferred' });
    // The relaunch comes after the bootstrap's original 15 minutes (still within the create deadline).
    w.advance(16 * 60_000);
    expect(await w.settle(opId)).toEqual({ state: 'succeeded' });
    const [cred] = await w.db.select().from(schema.agentCredentials).where(eq(schema.agentCredentials.instanceId, 'inst1'));
    expect(cred!.bootstrapExpiresAt!.getTime()).toBeGreaterThan(w.clock.getTime());
    expect(ec2.instances.size).toBe(2);
    const p = (await w.placement())!;
    expect(ec2.instances.get(p.vmId!)?.state).toBe('running');
    expect(ec2.instances.get(p.vmId!)?.tags['cb:token']).toMatch(/:create_vm:1:l1$/);
    const vms = await w.db.select().from(resources).where(eq(resources.kind, 'vm'));
    expect(vms.map((r) => r.state).sort()).toEqual(['active', 'deleted']);
  });
});

describe.each([
  ['every minute', undefined],
  ['in the production cron\'s four-minute settlement', 4 * 60_000],
])('billing totals stay consistent, settling %s', (_name, minIntervalMs) => {
  const { billingAccounts, balanceTransactions, usageRecords, controlFlags, instanceHealth } = schema;
  const meter = async () => (await import('../src/metering.js')).meterUsage(w.deps(), { minIntervalMs });

  /** Every place that shows money must agree with the balance and the ledger of debits. */
  async function expectConsistent() {
    const { accountUsage, instanceUsage, monthTotals } = await import('../../api/src/usage.js');
    const records = await w.db.select().from(usageRecords);
    const txs = await w.db.select().from(balanceTransactions);
    const [account] = await w.db.select().from(billingAccounts).where(eq(billingAccounts.userId, 'u1'));
    const charged = records.reduce((a, r) => a + r.chargedMicros, 0);
    // The balance is exactly the applied transactions, and usage debits are exactly what usage records say was charged.
    expect(account?.balanceMicros ?? 0).toBe(txs.filter((t) => t.appliedAt).reduce((a, t) => a + t.amountMicros, 0));
    expect(-txs.filter((t) => t.kind === 'usage' && t.appliedAt).reduce((a, t) => a + t.amountMicros, 0)).toBe(charged);
    for (const r of records) {
      expect(r.chargedMicros).toBeGreaterThanOrEqual(0);
      expect(r.chargedMicros).toBeLessThanOrEqual(r.amountMicros);
      expect(r.amountMicros).toBe(Math.round(r.quantity * r.unitPriceMicros));
      expect(r.costMicros).toBe(Math.round(r.quantity * r.unitCostMicros));
    }
    const months = [...new Set(records.map((r) => r.day.slice(0, 7)))];
    let all = 0;
    for (const month of months) {
      const u = await accountUsage(w.db, 'u1', month);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      expect(sum(Object.values(u.byItem))).toBe(u.totalMicros);
      expect(sum(u.byBrowser.map((b) => b.totalMicros))).toBe(u.totalMicros);
      expect(sum(u.byDay.map((d) => d.totalMicros))).toBe(u.totalMicros);
      expect((await monthTotals(w.db, 'u1', month)).totalMicros).toBe(u.totalMicros);
      for (const b of u.byBrowser) {
        const one = await instanceUsage(w.db, b.instanceId, month, { hourMicros: 0, runningHourMicros: 0, alwaysOnMonthMicros: 0 });
        expect(one.totalMicros).toBe(b.totalMicros);
        expect(sum(one.items.map((i) => i.amountMicros))).toBe(one.totalMicros);
        expect(sum(one.byDay.map((d) => d.totalMicros))).toBe(one.totalMicros);
      }
      all += u.totalMicros;
    }
    expect(all).toBe(charged);
  }

  it('caps running time settled by a stop like running time metered after a missed run', async () => {
    const { refreshPrices } = await import('../src/prices.js');
    await refreshPrices(w.deps());
    await w.settle(await w.newInstance('inst1', 'tyo1'));
    await w.settle(await w.newInstance('inst2', 'tyo1'));
    await meter();
    w.advance(30 * 60_000); // the meter missed 30 minutes
    expect(await requestStop(w.deps(), { id: 'inst2', userId: 'u1' }, 'idle')).toBe(true); // settles inst2's running time
    await meter();
    const compute = async (id: string) => (await w.db.select().from(usageRecords).where(and(eq(usageRecords.instanceId, id), eq(usageRecords.item, 'compute'))))[0]?.amountMicros;
    expect(await compute('inst1')).toBe(10_000); // 5 minutes at $0.12/h
    expect(await compute('inst2')).toBe(await compute('inst1'));
  });

  it('agrees across balance, debits, month, browser, day and item totals through a month boundary and exhaustion', async () => {
    const { applyBalance } = await import('../../api/src/billing/ledger.js');
    const { refreshPrices } = await import('../src/prices.js');
    w.clock = new Date('2026-10-31T23:30:00Z');
    await refreshPrices(w.deps());
    await w.db.insert(controlFlags).values({ key: 'billing_required', value: 'true', updatedAt: w.clock }).onConflictDoUpdate({ target: controlFlags.key, set: { value: 'true' } });
    await applyBalance(w.db, { userId: 'u1', kind: 'adjustment', amountMicros: 20_000_000, reference: 'seed', actor: 'test' }, w.clock);
    await w.settle(await w.newInstance('inst1', 'tyo1'));
    await w.settle(await w.newInstance('inst2', 'syd1'));
    await meter();
    for (let minute = 1; minute <= 60; minute++) {
      w.advance(60_000 + 137); // never aligned to whole seconds
      if (minute === 10) await w.db.update(instanceHealth).set({ netTxBytes: 3 * 1024 ** 3 + 12_345 }).where(eq(instanceHealth.instanceId, 'inst1'));
      if (minute === 20) await w.settle(await w.enqueue('inst2', 'stop'));
      if (minute === 25) await w.db.update(instanceHealth).set({ netTxBytes: 5 * 1024 ** 3 }).where(eq(instanceHealth.instanceId, 'inst1'));
      if (minute === 40) await w.settle(await w.enqueue('inst2', 'start'));
      await meter();
    }
    await expectConsistent();
    expect(new Set((await w.db.select().from(usageRecords)).map((r) => r.day.slice(0, 7)))).toEqual(new Set(['2026-10', '2026-11']));

    // Spend down to a few cents: debits stop at available credit and the deposit then pays retention.
    const left = await prepaidBalance(w.db, 'u1');
    await applyBalance(w.db, { userId: 'u1', kind: 'adjustment', amountMicros: -(left.availableMicros - 3_000), reference: 'drain', actor: 'test' }, w.clock);
    for (let minute = 0; minute < 30; minute++) {
      w.advance(60_000);
      await meter();
      const stops = await w.db.select().from(operations).where(and(eq(operations.kind, 'stop'), eq(operations.status, 'queued')));
      for (const s of stops) await w.settle(s.id);
    }
    const after = await prepaidBalance(w.db, 'u1');
    expect(after.availableMicros).toBe(0);
    expect(after.balanceMicros).toBe(after.reservedMicros);
    expect(after.reservedMicros).toBeGreaterThan(0);
    // The last funded minute was capped at available credit, and retention then drew on the deposits.
    expect((await w.db.select().from(usageRecords)).some((r) => r.chargedMicros < r.amountMicros && r.unitPriceMicros > 0)).toBe(true);
    expect((await w.db.select().from(schema.browserReservations)).every((h) => h.retentionStartedAt && h.reservedMicros < h.requiredMicros)).toBe(true);
    await expectConsistent();
  });
});
