import { createDb, operationRow, prepaidBalance, reopenRegion, reservationQuote, schema, type Db } from '@cloudbrowser/db';
import { splitUsagePeriod } from '@cloudbrowser/contracts';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { ExecutorError, FakeExecutor, MemoryFakeStore, type Executor, type FaultPlan } from '@cloudbrowser/executors';
import { and, eq, isNull, ne } from 'drizzle-orm';
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
  sqlite: ReturnType<typeof createTestD1>['sqlite'];
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
    const d1 = createTestD1();
    this.sqlite = d1.sqlite;
    // These tests fund accounts explicitly; signup awards are covered by API registration tests.
    d1.sqlite.exec("UPDATE caps SET `limit` = 0 WHERE metric = 'signup_credit_cents'");
    this.db = createDb(d1);
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

  // Fifteen complete lifecycles with real SQLite work share this timeout; CI runs other suites in parallel.
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
  }, 30_000);
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

  it.each(['input', 'lastActive', 'timeout'] as const)('rejects a stale scheduler candidate when %s changes before stop admission', async (change) => {
    w.advance(11 * 60_000);
    const deps = w.deps();
    let clockReads = 0;
    deps.now = () => {
      if (++clockReads === 2) {
        // idleStops has already read its candidate and busy operations. A viewer open/input
        // (or setting change) commits before requestStop captures its later admission time.
        w.advance(1_000);
        const activity = w.clock.getTime() - 500;
        if (change === 'input') {
          w.sqlite.prepare('INSERT INTO instance_health(instance_id,last_input_at) VALUES (?,?) ON CONFLICT(instance_id) DO UPDATE SET last_input_at=excluded.last_input_at').run('inst1', activity);
        } else if (change === 'lastActive') {
          w.sqlite.prepare('UPDATE browser_instances SET last_active_at=? WHERE id=?').run(activity, 'inst1');
        } else {
          w.sqlite.prepare('UPDATE browser_instances SET idle_timeout_s=1800 WHERE id=?').run('inst1');
        }
      }
      return w.clock;
    };
    expect(await idleStops(deps)).toEqual([]);
    expect(clockReads).toBe(2);
    expect(await w.db.select().from(operations).where(eq(operations.kind, 'stop'))).toEqual([]);
    expect(await w.instance()).toMatchObject({ status: 'running', desiredState: 'running' });
    expect(w.liveProvider().find((r) => r.kind === 'vm')?.state).toBe('running');
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
    // The user is emailed once, and a later passing check does not resume the network by itself.
    expect(await w.db.select().from(schema.userNotices)).toEqual([expect.objectContaining({ kind: 'network_paused', instanceId: 'inst1', data: { name: 'Work' } })]);
    const nic = w.store.records.get(p.networkId!)!;
    await w.store.update(p.networkId!, { attrs: { ...nic.attrs, extraPublicAddresses: [] } });
    w.advance(60_000);
    await checkInstanceIp(w.deps(), 'inst1');
    expect((await w.instance()).status).toBe('needs_attention');
    expect(await w.db.select().from(schema.userNotices)).toHaveLength(1);
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

  describe('an idle stop queued before the user changes their mind', () => {
    const vmState = () => w.liveProvider().find((r) => r.kind === 'vm')?.state;
    const queueIdleStop = async () => {
      w.advance(11 * 60_000);
      expect(await idleStops(w.deps())).toEqual(['inst1']);
      const [op] = await w.db.select().from(operations).where(eq(operations.kind, 'stop'));
      expect((await w.instance()).desiredState).toBe('stopped');
      return op!.id;
    };
    const stopRow = async (id: string) => (await w.db.select().from(operations).where(eq(operations.id, id)))[0]!;

    it('is canceled when Never sleep is turned on before the stop starts', async () => {
      const op = await queueIdleStop();
      await w.db.update(browserInstances).set({ idleTimeoutS: 0 }).where(eq(browserInstances.id, 'inst1'));
      expect(await w.settle(op)).toEqual({ state: 'canceled' });
      expect(await w.instance()).toMatchObject({ status: 'running', desiredState: 'running' });
      expect(await stopRow(op)).toMatchObject({ status: 'canceled', errorClass: 'superseded' });
      expect(vmState()).toBe('running');
      // It never sleeps for inactivity afterwards.
      w.advance(7 * 86_400_000);
      expect(await idleStops(w.deps())).toEqual([]);
    });

    it('is canceled when the browser is used before the stop starts', async () => {
      const op = await queueIdleStop();
      w.advance(1_000);
      await w.db.insert(schema.instanceHealth).values({ instanceId: 'inst1', lastInputAt: w.clock })
        .onConflictDoUpdate({ target: schema.instanceHealth.instanceId, set: { lastInputAt: w.clock } });
      expect(await w.settle(op)).toEqual({ state: 'canceled' });
      expect(await w.instance()).toMatchObject({ status: 'running', desiredState: 'running' });
      expect(vmState()).toBe('running');
    });

    it('rechecks recent input even when its timestamp predates stop creation', async () => {
      const op = await queueIdleStop();
      const queued = await stopRow(op);
      // The input happened just before admission but its agent heartbeat arrived afterwards.
      await w.db.insert(schema.instanceHealth).values({ instanceId: 'inst1', lastInputAt: new Date(queued.createdAt.getTime() - 1) })
        .onConflictDoUpdate({ target: schema.instanceHealth.instanceId, set: { lastInputAt: new Date(queued.createdAt.getTime() - 1) } });
      expect(await w.settle(op)).toEqual({ state: 'canceled' });
      expect(await w.instance()).toMatchObject({ status: 'running', desiredState: 'running' });
      expect(vmState()).toBe('running');
    });

    it.each(['lastActive', 'timeout'] as const)('rechecks the full current deadline when %s changes after queuing', async (change) => {
      const op = await queueIdleStop();
      w.advance(1_000);
      if (change === 'lastActive') {
        await w.db.update(browserInstances).set({ lastActiveAt: w.clock }).where(eq(browserInstances.id, 'inst1'));
      } else {
        // Check the timeout itself, independently from PATCH's accompanying input timestamp.
        await w.db.update(browserInstances).set({ idleTimeoutS: 1800 }).where(eq(browserInstances.id, 'inst1'));
      }
      expect(await w.settle(op)).toEqual({ state: 'canceled' });
      expect(await w.instance()).toMatchObject({ status: 'running', desiredState: 'running' });
      expect(vmState()).toBe('running');
    });

    it('defensively cancels a legacy idle stop without a pre-settlement activity baseline', async () => {
      const op = await queueIdleStop();
      await w.db.update(operations).set({ params: { reason: 'idle' } }).where(eq(operations.id, op));
      expect(await w.settle(op)).toEqual({ state: 'canceled' });
      expect(await w.instance()).toMatchObject({ status: 'running', desiredState: 'running' });
      expect(vmState()).toBe('running');
    });

    it('is canceled by a new idle setting, which counts from the moment it is saved', async () => {
      const op = await queueIdleStop();
      w.advance(1_000);
      // What PATCH writes for a changed timeout: the setting and an input time of now.
      await w.db.update(browserInstances).set({ idleTimeoutS: 1800 }).where(eq(browserInstances.id, 'inst1'));
      await w.db.insert(schema.instanceHealth).values({ instanceId: 'inst1', lastInputAt: w.clock })
        .onConflictDoUpdate({ target: schema.instanceHealth.instanceId, set: { lastInputAt: w.clock } });
      expect(await w.settle(op)).toEqual({ state: 'canceled' });
      w.advance(29 * 60_000);
      expect(await idleStops(w.deps())).toEqual([]);
      w.advance(60_000);
      expect(await idleStops(w.deps())).toEqual(['inst1']);
    });

    it('finishes once it has started, and Never sleep applies from the next run', async () => {
      const op = await queueIdleStop();
      let first = true;
      w.faults = (m) => (m === 'ensureStopped' && first ? ((first = false), 'retryable') : null);
      expect((await runOperation(w.deps(), op)).state).toBe('deferred');
      expect((await w.instance()).status).toBe('stopping');
      await w.db.update(browserInstances).set({ idleTimeoutS: 0 }).where(eq(browserInstances.id, 'inst1'));
      w.advance(3_000); // past the first retry delay (at most 2 s), well inside the stop's deadline
      expect(await w.settle(op)).toEqual({ state: 'succeeded' });
      expect((await w.instance()).status).toBe('sleeping');
      // The user wakes it (the API records the intent with the start).
      await w.db.update(browserInstances).set({ desiredState: 'running' }).where(eq(browserInstances.id, 'inst1'));
      expect(await w.settle(await w.enqueue('inst1', 'start'))).toEqual({ state: 'succeeded' });
      w.advance(7 * 86_400_000);
      expect(await idleStops(w.deps())).toEqual([]);
    });

    it('still stops a browser that stayed idle', async () => {
      const baseline = (await w.instance()).lastActiveAt?.getTime() ?? null;
      const inputAt = w.clock.getTime() - 1_000;
      await w.db.insert(schema.instanceHealth).values({ instanceId: 'inst1', lastInputAt: new Date(inputAt) })
        .onConflictDoUpdate({ target: schema.instanceHealth.instanceId, set: { lastInputAt: new Date(inputAt) } });
      await w.db.insert(schema.viewerSessions).values({ id: 'idle-evidence-session', instanceId: 'inst1', userId: 'u1',
        startedAt: w.clock, lastSeenAt: w.clock, endedAt: w.clock, presenceSeq: 4, viewing: false, presenceAt: new Date(inputAt) });
      const op = await queueIdleStop();
      const queued = await stopRow(op);
      expect(queued.params?.idleLastActiveAt).toBe(baseline);
      expect(queued.params?.idleLastInputAt).toBe(inputAt);
      expect(queued.params?.idleTimeoutS).toBe(600);
      expect(queued.params?.idleViewerPresence).toEqual({ sessionId: 'idle-evidence-session', sequence: 4,
        viewing: 0, presenceAt: inputAt, endedAt: queued.createdAt.getTime() - 11 * 60_000 });
      // Admission still settles billing as before; its timestamp must not cancel its own stop.
      expect((await w.instance()).lastActiveAt?.getTime()).toBe(queued.createdAt.getTime());
      expect(await w.settle(op)).toEqual({ state: 'succeeded' });
      expect(await w.instance()).toMatchObject({ status: 'sleeping', desiredState: 'stopped' });
      expect(vmState()).toBe('stopped');
    });
  });

  it('emails about stops by an administrator, suspension or a frozen account, never about idle or own stops', async () => {
    const notices = () => w.db.select().from(schema.userNotices);
    const stopWith = async (reason: string) => {
      expect(await requestStop(w.deps(), { id: 'inst1', userId: 'u1' }, reason)).toBe(true);
      const [op] = await w.db.select().from(operations).where(and(eq(operations.kind, 'stop'), isNull(operations.finishedAt)));
      expect(await w.settle(op!.id)).toEqual({ state: 'succeeded' });
      return op!.id;
    };
    const wake = async () => {
      await w.db.update(browserInstances).set({ desiredState: 'running' }).where(eq(browserInstances.id, 'inst1'));
      expect(await w.settle(await w.enqueue('inst1', 'start'))).toEqual({ state: 'succeeded' });
    };
    await stopWith('manual');
    await wake();
    w.advance(11 * 60_000);
    expect(await idleStops(w.deps())).toEqual(['inst1']);
    const [idle] = await w.db.select().from(operations).where(and(eq(operations.kind, 'stop'), isNull(operations.finishedAt)));
    await w.settle(idle!.id);
    expect(await notices()).toEqual([]);
    await wake();
    const operator = await stopWith('operator');
    expect(await notices()).toEqual([expect.objectContaining({ id: `stop:${operator}`, userId: 'u1', kind: 'stopped', instanceId: 'inst1', data: { name: 'Work', reason: 'operator' }, sentAt: null })]);
    // Nothing brings it back on its own: the scheduler queues no start.
    w.advance(86_400_000);
    await idleStops(w.deps());
    expect(await w.db.select().from(operations).where(isNull(operations.finishedAt))).toEqual([]);
    expect((await w.instance()).status).toBe('sleeping');
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

  describe('agent reports that fail', () => {
    let passedAt: string;
    beforeEach(async () => {
      const op = await w.newInstance();
      await runOperation(w.deps(), op);
      await agentReady();
      w.advance(3_000);
      await runOperation(w.deps(), op);
      await answer('ip_check', { observed: [(await w.placement())!.ipAddress!] });
      w.advance(3_000);
      await runOperation(w.deps(), op);
      expect((await w.instance()).status).toBe('running');
      passedAt = (await w.db.select().from(schema.instanceHealth))[0]!.lastIpCheck!.checkedAt;
    });
    // What the api stores from the agent's ip_check event.
    const report = (check: Record<string, unknown>) =>
      w.db.update(schema.instanceHealth).set({ lastIpCheck: { expected: '203.0.113.10', checkedAt: w.clock.toISOString(), ...check } as never });

    it('a check that saw nothing pauses only once none has passed for 15 minutes, and not as an IP incident', async () => {
      const { periodicIpChecks } = await import('../src/scheduler.js');
      // Chrome stopped answering: one check, then a second, see nothing.
      w.advance(5 * 60_000);
      await report({ ok: false, observed: [], detail: 'Target.createBrowserContext: context deadline exceeded', okAt: passedAt });
      await periodicIpChecks(w.deps());
      w.advance(5 * 60_000);
      await report({ ok: false, observed: [], detail: 'Target.createBrowserContext: context deadline exceeded', okAt: passedAt });
      await periodicIpChecks(w.deps());
      expect((await w.instance()).status).toBe('running');
      expect(await w.db.select().from(schema.alerts)).toEqual([]);

      // The third, 15 minutes after the last that passed: paused, about when the agent closes its firewall.
      w.advance(5 * 60_000 + 1_000);
      await report({ ok: false, observed: [], detail: 'Target.createBrowserContext: context deadline exceeded', okAt: passedAt });
      await periodicIpChecks(w.deps());
      expect(await w.instance()).toMatchObject({ status: 'needs_attention', statusReason: 'Network paused while we check your dedicated IP.' });
      expect(await w.db.select().from(schema.alerts)).toEqual([
        expect.objectContaining({ severity: 'warning', title: expect.stringContaining('No IP check passed') }),
      ]);
    });

    it('another address seen by Chrome pauses at once, as an IP incident', async () => {
      const { periodicIpChecks } = await import('../src/scheduler.js');
      w.advance(5 * 60_000);
      await report({ ok: false, observed: ['198.51.100.7'], okAt: passedAt });
      await periodicIpChecks(w.deps());
      expect((await w.instance()).status).toBe('needs_attention');
      expect(await w.db.select().from(schema.alerts)).toEqual([
        expect.objectContaining({ severity: 'critical', title: expect.stringContaining('IP check failed') }),
      ]);
    });
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

  it('stops the VM anyway when the agent never answers an archiving shutdown', async () => {
    w.agentMode = 'gateway';
    w.archives = { presignPut: async (k) => `https://r2.test/put/${k}`, presignGet: async (k) => `https://r2.test/get/${k}` };
    const stop = await w.enqueue('inst1', 'stop');
    expect((await runOperation(w.deps(), stop)).state).toBe('deferred');
    // The reply was lost with the agent's tunnel: the archive wait (5 min) must end before the
    // operation's deadline, or the browser stays on "Going to sleep" and the stop is retried.
    w.advance(5 * 60_000 + 10_000);
    expect(await w.settle(stop)).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('sleeping');
    const [b] = await w.db.select().from(backups).where(eq(backups.kind, 'archive'));
    expect(b?.status).not.toBe('complete');
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

  it('charges at most the tier’s price for a capacity fallback that costs more, and records its real cost', async () => {
    const [stored] = await w.db.select().from(schema.providerPrices).where(eq(schema.providerPrices.regionId, 'tyo1'));
    const sheet = stored!.sheet as { instanceTypes: Record<string, number> };
    await w.db.update(schema.providerPrices).set({ sheet: { ...sheet, instanceTypes: { ...sheet.instanceTypes, 'fake.fallback': 0.104, 'fake.cheaper': 0.09 } } })
      .where(eq(schema.providerPrices.regionId, 'tyo1'));
    await w.db.update(placements).set({ instanceType: 'fake.fallback' }).where(eq(placements.instanceId, 'inst1'));
    await meter();
    w.advance(5 * 60_000);
    await meter();
    expect(await usage('compute')).toMatchObject({ unitPriceMicros: 120_000, unitCostMicros: 104_000 });
    // A cheaper machine is charged at its own price.
    await w.db.delete(usageRecords);
    await w.db.update(placements).set({ instanceType: 'fake.cheaper' }).where(eq(placements.instanceId, 'inst1'));
    w.advance(5 * 60_000);
    await meter();
    expect(await usage('compute')).toMatchObject({ unitPriceMicros: 108_000, unitCostMicros: 90_000 });
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
    expect((await usage('transfer'))?.amountMicros).toBe(Math.round(2.5 * 168_000)); // ($0.09/GB AWS + $0.05/GB relay) × 120%
  });

  it('bills the minutes a VM spends shutting down as running time, and records them at cost when turned off', async () => {
    await meter();
    const sleep = async () => {
      w.agentMode = 'gateway'; // a real agent that does not answer
      const stop = await w.enqueue('inst1', 'stop');
      expect((await runOperation(w.deps(), stop)).state).toBe('deferred');
      w.advance(61_000); // the agent never acknowledges: the VM is stopped after 60 s, still billed by AWS
      expect(await w.settle(stop)).toEqual({ state: 'succeeded' });
      const [h] = await w.db.select().from(instanceHealth).where(eq(instanceHealth.instanceId, 'inst1'));
      expect(h!.transitionMs).toBeGreaterThanOrEqual(61_000);
      await meter();
      w.agentMode = 'fake';
    };
    await sleep();
    const billed = (await w.db.select().from(usageRecords).where(eq(usageRecords.item, 'compute')))[0]!;
    expect(billed).toMatchObject({ unitPriceMicros: 120_000, unitCostMicros: 100_000 });
    expect(billed.quantity * 3_600_000).toBeGreaterThanOrEqual(61_000);

    await w.db.update(settings).set({ billTransitions: false }).where(eq(settings.id, 1));
    await w.settle(await w.enqueue('inst1', 'start'));
    await sleep();
    const unbilled = (await w.db.select().from(usageRecords).where(and(eq(usageRecords.item, 'compute'), eq(usageRecords.unitPriceMicros, 0))))[0]!;
    expect(unbilled.amountMicros).toBe(0);
    expect(unbilled.costMicros).toBeGreaterThan(0); // still our cost, and in the margin report
  });

  it('bills the archive upload from the final data-out count in the shutdown reply', async () => {
    await w.db.update(instanceHealth).set({ netTxBytes: 1024 ** 3 }).where(eq(instanceHealth.instanceId, 'inst1'));
    await meter(); // the baseline
    w.agentMode = 'gateway';
    const stop = await w.enqueue('inst1', 'stop');
    expect((await runOperation(w.deps(), stop)).state).toBe('deferred');
    const [cmd] = await w.db.select().from(schema.agentCommands).where(eq(schema.agentCommands.kind, 'prepare_shutdown'));
    await w.db.update(schema.agentCommands).set({ status: 'succeeded', reply: { archived: false, netTxBytes: 3 * 1024 ** 3 } }).where(eq(schema.agentCommands.id, cmd!.id));
    w.advance(3_000);
    expect(await w.settle(stop)).toEqual({ state: 'succeeded' });
    await meter();
    expect((await usage('transfer'))?.quantity).toBe(2);
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

describe('operation lifecycle', () => {
  const { agentCommands, agentCredentials, instanceHealth, events, alerts, operationSteps } = schema;

  /** Plays the api: what it records when the agent reports `ready`. */
  async function agentReady(generation = 1) {
    await w.db.insert(instanceHealth).values({ instanceId: 'inst1', agentReadyGeneration: generation, agentReadyAt: w.clock })
      .onConflictDoUpdate({ target: instanceHealth.instanceId, set: { agentReadyGeneration: generation, agentReadyAt: w.clock } });
  }

  /** Plays the agent: answers every pending command of a kind. */
  async function answer(kind: string, result: Record<string, unknown>, ok = true) {
    const pending = await w.db.select().from(agentCommands).where(and(eq(agentCommands.kind, kind), eq(agentCommands.status, 'pending')));
    for (const c of pending) {
      await w.db.update(agentCommands).set({ status: ok ? 'succeeded' : 'failed', reply: result, completedAt: w.clock }).where(eq(agentCommands.id, c.id));
    }
    return pending.length;
  }

  /** Runs an operation while playing an agent that reports ready and sees only the dedicated IP. */
  async function settleWithAgent(op: string, generation = 1) {
    let r = await runOperation(w.deps(), op);
    for (let i = 0; i < 100 && r.state === 'deferred'; i++) {
      w.clock = new Date(r.notBefore.getTime() + 1);
      await agentReady(generation);
      await answer('ip_check', { observed: [(await w.placement())!.ipAddress!] });
      r = await runOperation(w.deps(), op);
    }
    return r;
  }

  async function opRow(id: string) {
    return (await w.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  }

  /** What the api writes for Sleep (or Delete) while `old` runs: it is cancelled and the new operation takes over. */
  async function supersede(old: string, kind: 'stop' | 'delete' = 'stop') {
    const next = operationRow({ instanceId: 'inst1', userId: 'u1', kind, params: { reason: 'user', preemptedOperationId: old }, now: w.clock });
    await w.db.batch([
      w.db.update(operations).set({ status: 'canceled', finishedAt: w.clock, leaseOwner: null, leaseExpiresAt: null, errorClass: 'superseded' }).where(eq(operations.id, old)),
      w.db.update(browserInstances).set(kind === 'stop' ? { desiredState: 'stopped', status: 'stopping' } : { desiredState: 'deleted' }).where(eq(browserInstances.id, 'inst1')),
      w.db.insert(operations).values(next),
    ]);
    return next.id;
  }

  describe('Restart from Needs attention', () => {
    beforeEach(async () => {
      w.agentMode = 'gateway';
      expect(await settleWithAgent(await w.newInstance())).toEqual({ state: 'succeeded' });
    });

    it('reboots a VM that still runs and waits for the ready report of the new boot', async () => {
      // The VM and its agent keep running; that agent reported ready once, when it connected.
      await w.db.update(browserInstances).set({ status: 'needs_attention', statusReason: 'Network paused while we check your dedicated IP.' }).where(eq(browserInstances.id, 'inst1'));
      w.advance(60_000);
      const calls: string[] = [];
      w.faults = (m) => { calls.push(m); return null; };
      // An operator's retry has no restart flag: the engine treats a start from Needs attention as one.
      const start = await w.enqueue('inst1', 'start');
      expect((await runOperation(w.deps(), start)).state).toBe('deferred');
      expect(calls.indexOf('ensureStopped')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('ensureStopped')).toBeLessThan(calls.indexOf('ensureRunning'));
      expect((await opRow(start)).params).toMatchObject({ restart: true, restartStoppedAt: w.clock.getTime() });
      expect((await w.instance()).status).toBe('starting');

      // Polling neither stops the VM again nor counts the old boot's report.
      w.advance(3_000);
      expect((await runOperation(w.deps(), start)).state).toBe('deferred');
      expect(calls.filter((m) => m === 'ensureStopped')).toHaveLength(1);
      expect(await w.db.select().from(agentCommands).where(eq(agentCommands.kind, 'ip_check'))).toHaveLength(1); // the create's
      w.advance(3_000);
      expect(await settleWithAgent(start)).toEqual({ state: 'succeeded' });
      expect(await w.instance()).toMatchObject({ status: 'running', statusReason: null });
    });

    it('a passing Check again resumes a browser an IP check paused; a check the user did not ask for does not', async () => {
      const { periodicIpChecks } = await import('../src/scheduler.js');
      w.advance(16 * 60_000);
      await periodicIpChecks(w.deps());
      expect((await w.instance()).status).toBe('needs_attention');
      const ip = (await w.placement())!.ipAddress!;
      // The agent answers while the engine waits for it.
      const deps = { ...w.deps(), sleep: async () => { await answer('ip_check', { observed: [ip] }); await answer('set_firewall', {}); } };
      expect(await checkInstanceIp(deps, 'inst1')).toMatchObject({ ok: true });
      expect((await w.instance()).status).toBe('needs_attention');
      expect(await checkInstanceIp(deps, 'inst1', { requestedByUser: true })).toMatchObject({ ok: true });
      expect(await w.instance()).toMatchObject({ status: 'running', statusReason: null });
      const [firewall] = await w.db.select().from(agentCommands).where(eq(agentCommands.kind, 'set_firewall'));
      expect(firewall?.payload).toEqual({ mode: 'normal' });

      // A browser that needs attention for another reason (a failed operation) needs Restart.
      await w.db.update(browserInstances).set({ status: 'needs_attention', statusReason: 'This took too long. We have been alerted.' }).where(eq(browserInstances.id, 'inst1'));
      await checkInstanceIp(deps, 'inst1', { requestedByUser: true });
      expect((await w.instance()).status).toBe('needs_attention');
    });
  });

  describe('a recover that does not finish', () => {
    beforeEach(async () => {
      await w.settle(await w.newInstance());
      // The agent swapped its bootstrap token for its credential (what the api records).
      await w.db.update(agentCredentials).set({ credentialHash: 'agent-1', activatedAt: w.clock, bootstrapHash: null });
    });

    const identity = async () => (await w.db.select().from(agentCredentials))[0];
    const recoverBackup = async () => (await w.db.select().from(backups).where(eq(backups.reason, 'recover')))[0];

    it('fails with the current agent’s identity restored and what it built released, never the IP or the data', async () => {
      const before = (await w.placement())!;
      w.faults = (m) => (m === 'ensureVm' ? 'invalid' : null);
      const recover = await w.enqueue('inst1', 'recover');
      expect((await w.settle(recover)).state).toBe('failed');
      expect(await identity()).toMatchObject({ generation: 1, credentialHash: 'agent-1', bootstrapHash: null });
      expect((await w.instance()).status).toBe('needs_attention');
      const built = await w.db.select().from(resources).where(and(eq(resources.createdByOp, recover), ne(resources.kind, 'snapshot')));
      expect(built.map((r) => r.kind).sort()).toEqual(['network_interface', 'vm', 'volume']); // the VM's request got no answer
      expect(built.every((r) => r.state === 'superseded')).toBe(true);

      w.faults = () => null;
      w.advance(16 * 60_000);
      await reaperTick(w.deps('reaper'));
      expect(await w.db.select().from(resources).where(and(eq(resources.createdByOp, recover), ne(resources.state, 'deleted')))).toEqual([]);
      // The recover ended and the data is on the current volume: its snapshot goes.
      expect((await recoverBackup())?.status).toBe('deleted');
      const live = w.liveProvider().map((r) => r.id);
      expect(live).toEqual(expect.arrayContaining([before.vmId, before.networkId, before.volumeId, before.ipAllocationId]));
      expect(live).toHaveLength(4);
      await w.expectLedgerMatchesProvider();

      // A restart brings the browser back with the same IP.
      expect(await w.settle(await w.enqueue('inst1', 'start'))).toEqual({ state: 'succeeded' });
      expect((await w.placement())!.ipAddress).toBe(before.ipAddress);
    });

    it('keeps its snapshot while it runs or the browser has no current volume, and expires it after 7 days otherwise', async () => {
      w.faults = (m) => (m === 'ensureVm' ? 'capacity' : null);
      const recover = await w.enqueue('inst1', 'recover');
      expect((await runOperation(w.deps(), recover)).state).toBe('deferred');
      await reaperTick(w.deps('reaper'));
      expect((await recoverBackup())?.status).toBe('complete'); // still in use
      const { expiredBackups } = await import('../src/reaper.js');
      const snap = { id: 's', kind: 'snapshot', reason: 'recover', createdAt: w.clock };
      expect(expiredBackups([snap], w.clock)).toEqual([]);
      expect(expiredBackups([{ ...snap, recoverEnded: true }], w.clock)).toEqual(['s']); // never "the newest kept"
      expect(expiredBackups([snap], new Date(w.clock.getTime() + 8 * 86_400_000), 30)).toEqual(['s']);

      await w.db.update(placements).set({ volumeId: null }).where(eq(placements.status, 'current'));
      w.advance(8 * 86_400_000);
      await reaperTick(w.deps('reaper'));
      expect((await recoverBackup())?.status).toBe('complete');
    });

    it.each(['stop', 'delete'] as const)('superseded by %s, gives the agent its identity back and releases what it built', async (kind) => {
      w.faults = (m) => (m === 'ensureVm' ? 'capacity' : null);
      const recover = await w.enqueue('inst1', 'recover');
      expect((await runOperation(w.deps(), recover)).state).toBe('deferred');
      expect(await identity()).toMatchObject({ generation: 2, credentialHash: null });
      w.faults = () => null;
      expect(await w.settle(await supersede(recover, kind))).toEqual({ state: 'succeeded' });
      expect(await identity()).toMatchObject({ generation: 1, credentialHash: 'agent-1' });
      const built = await w.db.select().from(resources).where(and(eq(resources.createdByOp, recover), ne(resources.kind, 'snapshot')));
      expect(built.length).toBeGreaterThan(0);
      expect(built.every((r) => r.state === 'superseded')).toBe(true);
    });
  });

  describe('a browser that needs attention', () => {
    beforeEach(async () => {
      await w.settle(await w.newInstance());
      await w.settle(await w.enqueue('inst1', 'stop'));
      w.advance(86_400_000);
      // A wake fails: its last activity is a day old.
      w.faults = (m) => (m === 'ensureRunning' ? 'invalid' : null);
      expect((await w.settle(await w.enqueue('inst1', 'start'))).state).toBe('failed');
      w.faults = () => null;
      expect(await w.instance()).toMatchObject({ status: 'needs_attention', desiredState: 'running' });
    });

    it('goes to sleep after its idle timeout, counted from the failure', async () => {
      expect(await idleStops(w.deps())).toEqual([]);
      w.advance(9 * 60_000);
      expect(await idleStops(w.deps())).toEqual([]);
      w.advance(2 * 60_000);
      expect(await idleStops(w.deps())).toEqual(['inst1']);
      const [stop] = await w.db.select().from(operations).where(and(eq(operations.kind, 'stop'), isNull(operations.finishedAt)));
      expect(await w.settle(stop!.id)).toEqual({ state: 'succeeded' });
      expect((await w.instance()).status).toBe('sleeping');
    });

    it('with Never sleep, after an hour, and never while an operation runs', async () => {
      await w.db.update(browserInstances).set({ idleTimeoutS: 0 }).where(eq(browserInstances.id, 'inst1'));
      w.advance(59 * 60_000);
      expect(await idleStops(w.deps())).toEqual([]);
      w.advance(2 * 60_000);
      const resize = await w.enqueue('inst1', 'resize_volume');
      expect(await idleStops(w.deps())).toEqual([]);
      await w.db.update(operations).set({ status: 'failed', finishedAt: w.clock }).where(eq(operations.id, resize));
      expect(await idleStops(w.deps())).toEqual(['inst1']);
    });
  });

  describe('provider errors and waits', () => {
    it('counts provider errors in a row, never waits for capacity, and alerts when they run out', async () => {
      const op = await w.newInstance();
      w.faults = (m) => (m === 'ensureVm' ? 'capacity' : null);
      for (let i = 0; i < 12; i++) {
        const r = await runOperation(w.deps(), op);
        expect(r.state).toBe('deferred');
        w.clock = new Date((r as { notBefore: Date }).notBefore.getTime() + 1);
      }
      // Errors are counted apart from the waits.
      let vmErrors = 0;
      w.faults = (m) => (m === 'ensureVm' && ++vmErrors <= 6 ? 'retryable' : null);
      expect((await w.settle(op)).state).toBe('succeeded');
      expect(await w.db.select().from(alerts)).toEqual([]);

      // A step that gets through starts the count again; 9 errors in a row end the operation.
      await w.db.insert(browserInstances).values({ ...(await w.instance()), id: 'inst2', status: 'creating', lastActiveAt: null });
      const second = operationRow({ instanceId: 'inst2', userId: 'u1', kind: 'create', now: w.clock });
      await w.db.insert(operations).values(second);
      let volumeErrors = 0;
      vmErrors = 0;
      w.faults = (m) => (m === 'ensureVolume' && ++volumeErrors <= 6 ? 'retryable' : m === 'ensureVm' ? (vmErrors++, 'retryable') : null);
      expect(await w.settle(second.id)).toEqual({ state: 'failed', reason: 'Too many provider errors. We have been alerted.' });
      expect(vmErrors).toBe(9);
      expect((await w.db.select().from(alerts)).map((a) => a.dedupeKey)).toEqual(['op:retries:create:tyo1']);
    });

    it('shows Creating again once a launch gets capacity, and charges nothing while the create waits', async () => {
      const { refreshPrices } = await import('../src/prices.js');
      const { meterUsage } = await import('../src/metering.js');
      await refreshPrices(w.deps());
      w.agentMode = 'gateway';
      const op = await w.newInstance();
      w.faults = (m) => (m === 'ensureVm' ? 'capacity' : null);
      let r = await runOperation(w.deps(), op);
      expect((await w.instance()).status).toBe('waiting_capacity');
      for (let i = 0; i < 5; i++) {
        await meterUsage(w.deps());
        w.clock = new Date((r as { notBefore: Date }).notBefore.getTime() + 1);
        r = await runOperation(w.deps(), op);
      }
      await meterUsage(w.deps());
      expect(await w.db.select().from(schema.usageRecords)).toEqual([]);
      w.faults = () => null;
      w.clock = new Date((r as { notBefore: Date }).notBefore.getTime() + 1);
      expect((await runOperation(w.deps(), op)).state).toBe('deferred');
      expect((await opRow(op)).step).toBe('await_agent');
      expect(await w.instance()).toMatchObject({ status: 'creating', statusReason: null });
    });

    it('gives a first boot its whole time after the launch, however long the launch waited', async () => {
      w.agentMode = 'gateway';
      const op = await w.newInstance();
      w.faults = (m) => (m === 'ensureVm' ? 'capacity' : null);
      let r = await runOperation(w.deps(), op);
      while (w.clock.getTime() - (await opRow(op)).createdAt.getTime() < 10 * 60_000) {
        w.clock = new Date((r as { notBefore: Date }).notBefore.getTime() + 1);
        r = await runOperation(w.deps(), op);
      }
      w.faults = () => null;
      w.clock = new Date((r as { notBefore: Date }).notBefore.getTime() + 1);
      r = await runOperation(w.deps(), op);
      const launchedAt = w.clock.getTime();
      expect((await opRow(op)).deadlineAt.getTime()).toBeGreaterThanOrEqual(launchedAt + 16 * 60_000);
      // The agent never reports ready.
      for (let i = 0; i < 1000 && r.state === 'deferred'; i++) {
        w.clock = new Date(r.notBefore.getTime() + 1);
        r = await runOperation(w.deps(), op);
      }
      expect(r).toEqual({ state: 'failed', reason: 'The browser did not start in time.' });
      expect(w.clock.getTime() - launchedAt).toBeGreaterThan(16 * 60_000);
    });

    it('writes no journal entry, event or notification while it polls a waiting step', async () => {
      w.agentMode = 'gateway';
      const op = await w.newInstance();
      let notified = 0;
      const deps = { ...w.deps(), notify: () => void notified++ };
      expect((await runOperation(deps, op)).state).toBe('deferred');
      const eventsBefore = (await w.db.select().from(events)).length;
      const [step] = await w.db.select().from(operationSteps).where(and(eq(operationSteps.operationId, op), eq(operationSteps.step, 'await_agent')));
      notified = 0;
      for (let i = 0; i < 5; i++) {
        w.advance(3_000);
        expect((await runOperation(deps, op)).state).toBe('deferred');
      }
      expect((await w.db.select().from(events)).length).toBe(eventsBefore);
      expect(notified).toBe(0);
      expect((await w.db.select().from(operationSteps).where(and(eq(operationSteps.operationId, op), eq(operationSteps.step, 'await_agent'))))[0]).toEqual(step);
    });
  });

  describe('the IP check inside Chrome', () => {
    beforeEach(() => {
      w.agentMode = 'gateway';
    });

    async function toIpCheck() {
      const op = await w.newInstance();
      await runOperation(w.deps(), op);
      await agentReady();
      w.advance(3_000);
      expect((await runOperation(w.deps(), op)).state).toBe('deferred');
      return op;
    }

    it('is tried again after an answer without an address or a failed one', async () => {
      const op = await toIpCheck();
      const ip = (await w.placement())!.ipAddress!;
      expect(await answer('ip_check', { observed: [] })).toBe(1);
      w.advance(3_000);
      expect((await runOperation(w.deps(), op)).state).toBe('deferred');
      w.advance(3_000);
      expect((await runOperation(w.deps(), op)).state).toBe('deferred'); // sends the second check
      expect(await answer('ip_check', { error: 'echo endpoint unreachable' }, false)).toBe(1);
      w.advance(3_000);
      expect((await runOperation(w.deps(), op)).state).toBe('deferred');
      w.advance(3_000);
      expect((await runOperation(w.deps(), op)).state).toBe('deferred');
      expect(await answer('ip_check', { observed: [ip] })).toBe(1);
      w.advance(3_000);
      expect(await runOperation(w.deps(), op)).toEqual({ state: 'succeeded' });
    });

    it('fails a create that Chrome cannot confirm three times, with a reason for a browser that never ran', async () => {
      const op = await toIpCheck();
      let r: Awaited<ReturnType<typeof runOperation>> = { state: 'deferred', notBefore: w.clock };
      for (let i = 0; i < 10 && r.state === 'deferred'; i++) {
        await answer('ip_check', { observed: [] });
        w.advance(3_000);
        r = await runOperation(w.deps(), op);
      }
      expect(r).toEqual({ state: 'failed', reason: `Chrome could not confirm the dedicated IP ${(await w.placement())!.ipAddress}.` });
      expect(await w.db.select().from(agentCommands).where(eq(agentCommands.kind, 'ip_check'))).toHaveLength(3);
    });
  });

  it('starts a create that Sleep interrupted during the first boot once, then only waits for its agent', async () => {
    w.agentMode = 'gateway';
    const create = await w.newInstance();
    expect((await runOperation(w.deps(), create)).state).toBe('deferred'); // the VM is booting
    expect(await w.settle(await supersede(create))).toEqual({ state: 'succeeded' });
    expect((await w.instance()).status).toBe('sleeping');

    const calls: string[] = [];
    w.faults = (m) => { calls.push(m); return null; };
    await w.db.update(browserInstances).set({ desiredState: 'running' }).where(eq(browserInstances.id, 'inst1'));
    const wake = operationRow({ instanceId: 'inst1', userId: 'u1', kind: 'create', params: { resumeCreateFrom: create }, now: w.clock });
    await w.db.insert(operations).values(wake);
    for (let i = 0; i < 4; i++) {
      expect((await runOperation(w.deps(), wake.id)).state).toBe('deferred');
      w.advance(3_000);
    }
    expect(calls.filter((m) => m === 'ensureRunning' || m === 'describe')).toEqual(['ensureRunning']);
    expect(await settleWithAgent(wake.id)).toEqual({ state: 'succeeded' });
    expect(w.liveProvider().filter((r) => r.kind === 'vm')).toHaveLength(1);
  });
});
