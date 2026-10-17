import { eventRow, newId, schema, sha256Hex } from '@cloudbrowser/db';
import type { ResourceKind } from '@cloudbrowser/executors';
import { and, eq, ne } from 'drizzle-orm';
import {
  placementRef,
  RestartFrom,
  StepFailed,
  type PlacementRow,
  type StepEnv,
  type StepOutcome,
} from './context.js';
import { bootstrapToken } from './agent.js';

const { browserInstances, instanceHealth, ipAddresses, placements, resources, auditLog, events, agentCredentials } = schema;

/** Default data volume size; plans set it later (page 6). */
const VOLUME_GB = 20;
const MAX_IP_ROUNDS = 3;
const OLD_IP_KEEP_DAYS = 30;

// --- ledger ------------------------------------------------------------------------------------

/** Intent first: the ledger row exists before the provider call (page 10, rule 1). */
async function ledgerPending(env: StepEnv, kind: ResourceKind, token: string, generation: number, zone: string | null) {
  const { deps, op, instance, region, executor } = env;
  await deps.db
    .insert(resources)
    .values({
      id: newId(),
      instanceId: instance.id,
      kind,
      executor: executor.kind,
      providerId: null,
      region: region.providerRegion,
      zone,
      createdByOp: op.id,
      requestToken: token,
      state: 'pending',
      tags: env.tags(kind, generation),
      monthlyCostEstimate: executor.capabilities.monthlyCostCents[kind] ?? 0,
      firstSeenAt: deps.now(),
    })
    .onConflictDoNothing();
}

async function ledgerActive(
  env: StepEnv,
  token: string,
  providerId: string,
  zone: string | null,
  address: string | null = null,
) {
  await env.deps.db
    .update(resources)
    .set({ providerId, zone, address, state: 'active', lastSeenAt: env.deps.now() })
    .where(eq(resources.requestToken, token));
}

async function loadPlacement(env: StepEnv): Promise<PlacementRow> {
  const [p] = await env.deps.db
    .select()
    .from(placements)
    .where(and(eq(placements.instanceId, env.instance.id), eq(placements.status, 'current')));
  if (!p) throw new StepFailed('This browser has no running machine yet.');
  env.placement = p;
  return p;
}

function result<T extends Record<string, unknown>>(env: StepEnv, step: string): T {
  const r = env.results[step];
  if (!r) throw new Error(`missing result of step ${step}`);
  return r as T;
}

// --- shared steps ------------------------------------------------------------------------------

async function allocateIp(env: StepEnv): Promise<StepOutcome> {
  if (env.round >= MAX_IP_ROUNDS) throw new StepFailed('No suitable IP address was available in this region.');
  const generation = env.placement?.generation ?? 1;
  const ctx = env.ctx('allocate_ip', `r${env.round}`);
  await ledgerPending(env, 'ip', ctx.token, generation, null);
  const ip = await env.executor.allocateIp(ctx, env.region.providerRegion);
  await ledgerActive(env, ctx.token, ip.allocationId, null, ip.address);
  return { result: { allocationId: ip.allocationId, address: ip.address, token: ctx.token } };
}

/**
 * The address must never have been used by another of our instances (page 3). Geolocation and
 * blocklist screening are added with the real executors.
 */
async function screenIp(env: StepEnv): Promise<StepOutcome> {
  const { address, token } = result<{ address: string; token: string }>(env, 'allocate_ip');
  const { db } = env.deps;
  await db
    .insert(ipAddresses)
    .values({ address, executor: env.executor.kind, regionId: env.region.id, instanceId: env.instance.id })
    .onConflictDoNothing();
  const [row] = await db.select().from(ipAddresses).where(eq(ipAddresses.address, address));
  if (!row || row.instanceId !== env.instance.id) {
    // Leave the allocation to the reaper and try another one.
    await db.update(resources).set({ state: 'rejected' }).where(eq(resources.requestToken, token));
    throw new RestartFrom('allocate_ip', `address ${address} was used before`);
  }
  return { result: { address } };
}

/** How long a new or woken VM may take until its agent reports `ready` (page 10: create step 8). */
const AGENT_START_TIMEOUT_MS = 10 * 60_000;
/** How long the engine waits for a command reply before giving up on it. */
const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_POLL_MS = 2_000;

async function awaitAgent(env: StepEnv): Promise<StepOutcome> {
  const p = await loadPlacement(env);
  // The agent must report ready after this operation began, so a stale report from before a stop does not count.
  const status = await env.agent.status(env.instance.id, p.generation, env.op.createdAt);
  if (status === 'ready') return {};
  if (env.deps.now().getTime() - env.op.createdAt.getTime() > AGENT_START_TIMEOUT_MS) {
    throw new StepFailed('The browser did not start in time.');
  }
  return { wait: 3_000, reason: 'waiting for the agent' };
}

/** Sends a command once per step and round, then waits for its reply without blocking the worker. */
async function command(env: StepEnv, step: string, kind: Parameters<StepEnv['agent']['send']>[0]['kind'], payload: Record<string, unknown>) {
  const id = `${env.op.id}:${step}:${env.round}`;
  await env.agent.send({ id, instanceId: env.instance.id, kind, payload });
  const reply = await env.agent.reply(id);
  const timedOut = env.deps.now().getTime() - reply.createdAt.getTime() > COMMAND_TIMEOUT_MS;
  return { reply, timedOut };
}

async function verifyBinding(env: StepEnv): Promise<StepOutcome> {
  const p = await loadPlacement(env);
  const ref = placementRef(p);
  let check = await env.executor.verifyEgress(env.ctx('verify_binding'), ref);
  if (!check.ok) {
    // Repair by re-associating the same IP; never a different one (page 3, "Fail-closed").
    await env.executor.associateIp(env.ctx('verify_binding', 'reassociate'), p.providerRegion, ref.nicId, {
      allocationId: ref.ipAllocationId,
      address: ref.ipAddress,
    });
    check = await env.executor.verifyEgress(env.ctx('verify_binding', 'recheck'), ref);
  }
  if (!check.ok) {
    await env.deps.db.insert(auditLog).values({
      actor: 'engine',
      action: 'ip.binding_failed',
      target: `instance:${env.instance.id}`,
      detail: { expected: check.expected, found: check.publicAddresses },
      createdAt: env.deps.now(),
    });
    throw new StepFailed('Network paused: the dedicated IP is not the only address on this browser.');
  }
  return { result: { publicAddresses: check.publicAddresses } };
}

async function verifyIpInChrome(env: StepEnv): Promise<StepOutcome> {
  const p = await loadPlacement(env);
  const { db, now } = env.deps;
  const { reply, timedOut } = await command(env, 'verify_ip_in_chrome', 'ip_check', { expected: p.ipAddress });
  if (reply.status === 'pending') {
    if (timedOut) throw new StepFailed('Network paused: the IP check inside Chrome did not answer.');
    return { wait: COMMAND_POLL_MS, reason: 'waiting for the IP check' };
  }
  const observed = Array.isArray(reply.result?.observed) ? (reply.result.observed as string[]) : [];
  const ok = reply.status === 'succeeded' && observed.length > 0 && observed.every((a) => a === p.ipAddress);
  const lastIpCheck = { ok, expected: p.ipAddress, observed, checkedAt: now().toISOString() };
  await db
    .insert(instanceHealth)
    .values({ instanceId: env.instance.id, lastIpCheck })
    .onConflictDoUpdate({ target: instanceHealth.instanceId, set: { lastIpCheck } });
  if (!ok) {
    throw new StepFailed(`Network paused: Chrome saw ${observed.join(', ') || 'no address'} instead of ${p.ipAddress}.`);
  }
  return { result: { observed } };
}

async function ensureRunning(env: StepEnv): Promise<StepOutcome> {
  const p = await loadPlacement(env);
  await env.executor.ensureRunning(env.ctx('ensure_running'), placementRef(p));
  return {};
}

async function prepareShutdown(env: StepEnv): Promise<StepOutcome> {
  if (!(await currentPlacement(env))) return { result: { skipped: true } };
  // If the agent does not ack within 60 s, the VM is stopped anyway; Chrome's stores are
  // journaled (page 2, flow C).
  const { reply, timedOut } = await command(env, 'prepare_shutdown', 'prepare_shutdown', {});
  if (reply.status === 'pending' && !timedOut) return { wait: COMMAND_POLL_MS, reason: 'waiting for Chrome to close' };
  return { result: { acked: reply.status === 'succeeded' } };
}

async function ensureStopped(env: StepEnv): Promise<StepOutcome> {
  const p = await currentPlacement(env);
  if (!p) return { result: { skipped: true } };
  await env.executor.ensureStopped(env.ctx('ensure_stopped'), placementRef(p));
  return {};
}

async function currentPlacement(env: StepEnv): Promise<PlacementRow | null> {
  const [p] = await env.deps.db
    .select()
    .from(placements)
    .where(and(eq(placements.instanceId, env.instance.id), eq(placements.status, 'current')));
  env.placement = p ?? null;
  return env.placement;
}

// --- finish ------------------------------------------------------------------------------------

async function finishWithStatus(
  env: StepEnv,
  status: string,
  extra: Partial<typeof browserInstances.$inferInsert> = {},
): Promise<StepOutcome> {
  const { db, now } = env.deps;
  const at = now();
  const stmts = [
    db
      .update(browserInstances)
      .set({ status, statusReason: null, updatedAt: at, ...extra })
      .where(eq(browserInstances.id, env.instance.id)),
    db.insert(events).values(eventRow(env.instance.userId, 'instance.updated', { instanceId: env.instance.id }, at)),
  ] as const;
  await db.batch(stmts);
  return {};
}

async function finishCreate(env: StepEnv): Promise<StepOutcome> {
  const { address } = result<{ address: string }>(env, 'screen_ip');
  await env.deps.db
    .update(ipAddresses)
    .set({ assignedAt: env.deps.now() })
    .where(eq(ipAddresses.address, address));
  return finishWithStatus(env, 'running', { lastActiveAt: env.deps.now() });
}

// --- create ------------------------------------------------------------------------------------

async function createNic(env: StepEnv): Promise<StepOutcome> {
  const ip = result<{ allocationId: string; address: string }>(env, 'allocate_ip');
  const ctx = env.ctx('create_nic');
  await ledgerPending(env, 'network_interface', ctx.token, 1, null);
  const nic = await env.executor.ensureNetworkInterface(ctx, env.region.providerRegion, ip);
  await ledgerActive(env, ctx.token, nic.nicId, nic.zone);
  return { result: { nicId: nic.nicId, zone: nic.zone } };
}

async function createVolume(env: StepEnv): Promise<StepOutcome> {
  const { zone } = result<{ zone: string }>(env, 'create_nic');
  const ctx = env.ctx('create_volume');
  await ledgerPending(env, 'volume', ctx.token, 1, zone);
  const vol = await env.executor.ensureVolume(ctx, env.region.providerRegion, zone, VOLUME_GB);
  await ledgerActive(env, ctx.token, vol.volumeId, vol.zone);
  return { result: { volumeId: vol.volumeId } };
}

/**
 * Single-use agent bootstrap token, valid 15 minutes (page 10, create step 6). It is derived from a
 * secret, so create_vm can put it in the VM's user data without the token ever being stored; only
 * its hash is kept, in `agent_credentials`.
 */
async function issueBootstrap(env: StepEnv): Promise<StepOutcome> {
  const token = await bootstrapToken(env.deps.bootstrapSecret, env.instance.id, env.op.id, 1);
  const at = env.deps.now();
  const expiresAt = new Date(at.getTime() + 15 * 60_000);
  const values = { generation: 1, bootstrapHash: await sha256Hex(token), bootstrapExpiresAt: expiresAt, credentialHash: null, activatedAt: null };
  await env.deps.db
    .insert(agentCredentials)
    .values({ instanceId: env.instance.id, createdAt: at, ...values })
    .onConflictDoUpdate({ target: agentCredentials.instanceId, set: values });
  return { result: { expiresAt: expiresAt.toISOString() } };
}

async function createVm(env: StepEnv): Promise<StepOutcome> {
  const ip = result<{ allocationId: string; address: string }>(env, 'allocate_ip');
  const { nicId, zone } = result<{ nicId: string; zone: string }>(env, 'create_nic');
  const { volumeId } = result<{ volumeId: string }>(env, 'create_volume');
  const ctx = env.ctx('create_vm');
  await ledgerPending(env, 'vm', ctx.token, 1, zone);
  const vm = await env.executor.ensureVm(ctx, env.region.providerRegion, {
    zone,
    nicId,
    volumeId,
    instanceId: env.instance.id,
    bootstrapToken: await bootstrapToken(env.deps.bootstrapSecret, env.instance.id, env.op.id, 1),
    gatewayUrl: env.deps.gatewayUrl,
  });
  await ledgerActive(env, ctx.token, vm.vmId, vm.zone);
  await env.deps.db
    .insert(placements)
    .values({
      id: newId(),
      instanceId: env.instance.id,
      generation: 1,
      executor: env.executor.kind,
      providerRegion: env.region.providerRegion,
      zone: vm.zone,
      vmId: vm.vmId,
      volumeId,
      networkId: nicId,
      ipAllocationId: ip.allocationId,
      ipAddress: ip.address,
      status: 'current',
      createdAt: env.deps.now(),
    })
    .onConflictDoNothing();
  return { result: { vmId: vm.vmId } };
}

// --- change_ip ---------------------------------------------------------------------------------

async function associateNewIp(env: StepEnv): Promise<StepOutcome> {
  const p = await loadPlacement(env);
  const next = result<{ allocationId: string; address: string }>(env, 'allocate_ip');
  const { db, now } = env.deps;
  const previous = env.results.associate_ip_prepared ?? {
    oldAllocationId: p.ipAllocationId,
    oldAddress: p.ipAddress,
  };
  await env.executor.associateIp(env.ctx('associate_ip'), p.providerRegion, p.networkId ?? '', next);
  await db.batch([
    db
      .update(placements)
      .set({ ipAllocationId: next.allocationId, ipAddress: next.address })
      .where(eq(placements.id, p.id)),
    // The old IP stays allocated and unattached for 30 days, then the reaper releases it.
    db
      .update(resources)
      .set({ state: 'superseded', releaseAfter: new Date(now().getTime() + OLD_IP_KEEP_DAYS * 86_400_000) })
      .where(
        and(
          eq(resources.instanceId, env.instance.id),
          eq(resources.kind, 'ip'),
          eq(resources.providerId, String(previous.oldAllocationId)),
        ),
      ),
  ]);
  return { result: previous };
}

async function verifyNewIpInChrome(env: StepEnv): Promise<StepOutcome> {
  if (env.instance.status !== 'running') return { result: { skipped: 'verified on next wake' } };
  return verifyIpInChrome(env);
}

async function finishChangeIp(env: StepEnv): Promise<StepOutcome> {
  const { address } = result<{ address: string }>(env, 'screen_ip');
  const { db, now } = env.deps;
  await db.batch([
    db.update(ipAddresses).set({ assignedAt: now() }).where(eq(ipAddresses.address, address)),
    db.insert(auditLog).values({
      actor: env.op.userId ? `user:${env.op.userId}` : 'engine',
      action: 'ip.changed',
      target: `instance:${env.instance.id}`,
      detail: { from: env.results.associate_ip?.oldAddress ?? null, to: address },
      createdAt: now(),
    }),
  ]);
  return finishWithStatus(env, env.instance.status);
}

/** Puts the old IP back when a change_ip fails after the swap (page 10). */
export async function compensateChangeIp(env: StepEnv) {
  const swapped = env.results.associate_ip as { oldAllocationId: string; oldAddress: string } | undefined;
  if (!swapped) return;
  const p = await loadPlacement(env);
  const next = env.results.allocate_ip as { allocationId: string } | undefined;
  await env.executor.associateIp(env.ctx('associate_ip', 'rollback'), p.providerRegion, p.networkId ?? '', {
    allocationId: swapped.oldAllocationId,
    address: swapped.oldAddress,
  });
  const { db } = env.deps;
  await db.batch([
    db
      .update(placements)
      .set({ ipAllocationId: swapped.oldAllocationId, ipAddress: swapped.oldAddress })
      .where(eq(placements.id, p.id)),
    db
      .update(resources)
      .set({ state: 'active', releaseAfter: null })
      .where(and(eq(resources.instanceId, env.instance.id), eq(resources.providerId, swapped.oldAllocationId))),
    db
      .update(resources)
      .set({ state: 'rejected' })
      .where(and(eq(resources.instanceId, env.instance.id), eq(resources.providerId, next?.allocationId ?? ''))),
  ]);
}

// --- purge (reaper only) -----------------------------------------------------------------------

const DELETE_ORDER: ResourceKind[] = ['vm', 'network_interface', 'volume', 'snapshot', 'ip'];

/** Deletes every ledger resource of an instance that is still open. Reaper credentials only. */
export async function deleteLedgerResources(
  env: Pick<StepEnv, 'deps' | 'executor' | 'ctx'>,
  instanceId: string,
  filter: (r: typeof resources.$inferSelect) => boolean = () => true,
) {
  const { db, now } = env.deps;
  const open = (
    await db
      .select()
      .from(resources)
      .where(and(eq(resources.instanceId, instanceId), ne(resources.state, 'deleted')))
  ).filter(filter);
  open.sort((a, b) => DELETE_ORDER.indexOf(a.kind as ResourceKind) - DELETE_ORDER.indexOf(b.kind as ResourceKind));
  for (const r of open) {
    if (r.providerId) {
      await env.executor.ensureDeleted(env.ctx('delete', r.id), r.region, r.kind as ResourceKind, r.providerId);
    }
    const at = now();
    await db.update(resources).set({ state: 'deleted', deletedAt: at }).where(eq(resources.id, r.id));
    if (r.kind === 'ip' && r.address) {
      // The address row stays forever, so it is never given to another instance.
      await db.update(ipAddresses).set({ releasedAt: at }).where(eq(ipAddresses.address, r.address));
    }
  }
  return open.length;
}

async function purgeResources(env: StepEnv): Promise<StepOutcome> {
  const deleted = await deleteLedgerResources(env, env.instance.id);
  await env.deps.db.batch([
    env.deps.db.update(placements).set({ status: 'superseded' }).where(eq(placements.instanceId, env.instance.id)),
    // The VM is gone; its agent identity is revoked so it can never connect again.
    env.deps.db
      .update(agentCredentials)
      .set({ credentialHash: null, bootstrapHash: null, rotatedAt: env.deps.now() })
      .where(eq(agentCredentials.instanceId, env.instance.id)),
  ]);
  return { result: { deleted } };
}

// --- table -------------------------------------------------------------------------------------

type Handler = (env: StepEnv) => Promise<StepOutcome>;

export const HANDLERS: Record<string, Record<string, Handler>> = {
  create: {
    allocate_ip: allocateIp,
    screen_ip: screenIp,
    create_nic: createNic,
    create_volume: createVolume,
    issue_bootstrap: issueBootstrap,
    create_vm: createVm,
    await_agent: awaitAgent,
    verify_binding: verifyBinding,
    verify_ip_in_chrome: verifyIpInChrome,
    finish: finishCreate,
  },
  start: {
    ensure_running: ensureRunning,
    await_agent: awaitAgent,
    verify_binding: verifyBinding,
    verify_ip_in_chrome: verifyIpInChrome,
    finish: (env) => finishWithStatus(env, 'running', { lastActiveAt: env.deps.now() }),
  },
  stop: {
    prepare_shutdown: prepareShutdown,
    ensure_stopped: ensureStopped,
    verify_binding: verifyBinding,
    finish: (env) => finishWithStatus(env, 'sleeping'),
  },
  change_ip: {
    allocate_ip: allocateIp,
    screen_ip: screenIp,
    associate_ip: associateNewIp,
    verify_binding: verifyBinding,
    verify_ip_in_chrome: verifyNewIpInChrome,
    finish: finishChangeIp,
  },
  delete: {
    prepare_shutdown: prepareShutdown,
    ensure_stopped: ensureStopped,
    finish: (env) => {
      const at = env.deps.now();
      return finishWithStatus(env, 'deleting', {
        deletedAt: at,
        purgeAfter: new Date(at.getTime() + 7 * 86_400_000),
      });
    },
  },
  undelete: {
    finish: async (env) => {
      const p = await currentPlacement(env);
      if (!p) {
        await finishWithStatus(env, 'failed', { deletedAt: null, purgeAfter: null });
        return {};
      }
      return finishWithStatus(env, 'sleeping', { deletedAt: null, purgeAfter: null });
    },
  },
  purge: {
    delete_resources: purgeResources,
    finish: (env) => finishWithStatus(env, 'purged'),
  },
};
