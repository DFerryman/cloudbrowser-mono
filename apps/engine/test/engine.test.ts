import { createDb, operationRow, schema, type Db } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { ExecutorError, FakeExecutor, MemoryFakeStore, type Executor, type FaultPlan } from '@cloudbrowser/executors';
import { and, eq, ne } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAgentBridge, GatewayAgentBridge } from '../src/agent.js';
import { placementRef, readContext, type EngineDeps, type EngineMode } from '../src/context.js';
import { reaperTick } from '../src/reaper.js';
import { runOperation } from '../src/runner.js';
import { checkInstanceIp, idleStops } from '../src/scheduler.js';

const { browserInstances, operations, resources, ipAddresses, placements, user } = schema;

class World {
  db: Db;
  store = new MemoryFakeStore();
  clock = new Date('2026-10-01T00:00:00Z');
  faults: FaultPlan = () => null;
  random: () => number = Math.random;
  /** `gateway` uses the real agent bridge (agent_commands); the test plays the agent. */
  agentMode: 'fake' | 'gateway' = 'fake';
  pokes: string[] = [];

  constructor() {
    this.db = createDb(createTestD1());
  }

  executor(mode: 'runtime' | 'reaper') {
    return new FakeExecutor({ store: this.store, mode, faults: (m, c) => this.faults(m, c), random: () => this.random() });
  }

  deps(mode: EngineMode = 'worker'): EngineDeps {
    const ex: Executor = this.executor(mode === 'reaper' ? 'reaper' : 'runtime');
    const now = () => this.clock;
    const placementOf = async (id: string) => {
      const p = await this.placement(id);
      return p ? placementRef(p) : null;
    };
    const agent =
      this.agentMode === 'gateway'
        ? new GatewayAgentBridge(this.db, async (m) => void this.pokes.push(m.instanceId), now)
        : new FakeAgentBridge(this.executor('runtime'), () => readContext('agent', 'test'), placementOf, now);
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

  it('changes the IP only on request, and keeps the old one for 30 days', async () => {
    const before = (await w.placement())!.ipAddress!;
    w.random = (() => {
      let x = 0.9;
      return () => (x = (x + 0.37) % 1);
    })();
    expect(await w.settle(await w.enqueue('inst1', 'change_ip'))).toEqual({ state: 'succeeded' });
    const after = (await w.placement())!.ipAddress!;
    expect(after).not.toBe(before);
    const old = await w.db.select().from(resources).where(eq(resources.state, 'superseded'));
    expect(old).toHaveLength(1);
    expect(old[0]?.address).toBe(before);

    await reaperTick(w.deps('reaper'));
    expect(w.liveProvider().filter((r) => r.kind === 'ip')).toHaveLength(2);
    w.advance(31 * 86_400_000);
    await reaperTick(w.deps('reaper'));
    expect(w.liveProvider().filter((r) => r.kind === 'ip')).toHaveLength(1);
    const [oldRow] = await w.db.select().from(ipAddresses).where(eq(ipAddresses.address, before));
    expect(oldRow?.instanceId).toBe('inst1');
    expect(oldRow?.releasedAt).not.toBeNull();
  });

  it('puts the old IP back when verifying the new one fails', async () => {
    const before = (await w.placement())!.ipAddress!;
    w.random = (() => {
      let x = 0.1;
      return () => (x = (x + 0.37) % 1);
    })();
    w.faults = (m, ctx) => (m === 'verifyEgress' && ctx.operationId !== 'agent' && ctx.step === 'verify_binding' ? 'invalid' : null);
    const r = await w.settle(await w.enqueue('inst1', 'change_ip'));
    expect(r.state).toBe('failed');
    expect((await w.placement())!.ipAddress).toBe(before);
    w.faults = () => null;
    const check = await checkInstanceIp(w.deps(), 'inst1');
    expect(check?.ok).toBe(true);
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

