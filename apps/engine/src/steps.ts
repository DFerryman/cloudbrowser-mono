import { ProviderPriceSheet, TRIAL, resourceMonthlyCostCents } from '@cloudbrowser/contracts';
import { eventRow, newArchiveKey, newId, raiseAlert, schema, settleRunningStatements, sha256Hex, userCaps, type Db } from '@cloudbrowser/db';
import { ExecutorError, type ExecutorKind, type ResourceKind } from '@cloudbrowser/executors';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  placementRef,
  readContext,
  OperationSuperseded,
  RestartFrom,
  StepFailed,
  type PlacementRow,
  type StepEnv,
  type StepOutcome,
} from './context.js';
import { bootstrapToken, type CommandReply } from './agent.js';
import { archiveObjectKey } from './archives.js';
import { fencedInsert, operationFence } from './fencing.js';

const { browserInstances, instanceHealth, ipAddresses, placements, resources, auditLog, events, agentCredentials, agentCommands, viewerSessions, backups, archiveKeys, providerPrices, regions } = schema;

/**
 * A new browser's data volume. The profile without caches is typically well under 2 GB, Chrome's
 * disk cache is bounded, and users can grow the volume at any time (page 4), so 10 GB is enough
 * to start without paying for unused space. Operators set it with the `storage_gb` cap.
 */
const VOLUME_GB = 10;

async function newVolumeGb(env: StepEnv): Promise<number> {
  // Keep the capacity the customer confirmed even if an operator changes defaults while queued.
  const quoted = env.op.params?.storageGb;
  if (typeof quoted === 'number' && Number.isInteger(quoted) && quoted > 0) return quoted;
  // The free trial runs on the smallest practical volume (page 6); it can grow after conversion.
  if (env.instance.trialState) return TRIAL.storageGb;
  return (await userCaps(env.deps.db, env.instance.userId)).get('storage_gb') ?? VOLUME_GB;
}

/** The region's last price sheet from the provider, for ledger estimates; null before the first refresh. */
export async function sheetFor(db: Db, executor: string, providerRegion: string): Promise<ProviderPriceSheet | null> {
  const rows = await db.select({ sheet: providerPrices.sheet, executor: providerPrices.executor }).from(providerPrices).where(eq(providerPrices.providerRegion, providerRegion));
  const parsed = ProviderPriceSheet.safeParse(rows.find((r) => r.executor === executor)?.sheet);
  return parsed.success ? parsed.data : null;
}

async function estimateCents(env: Pick<StepEnv, 'deps' | 'executor'>, providerRegion: string, kind: ResourceKind, sizeGb = 0) {
  const sheet = await sheetFor(env.deps.db, env.executor.kind, providerRegion);
  return sheet ? resourceMonthlyCostCents(sheet, kind, sizeGb) : 0;
}
/** A capacity fallback can only select a machine at or below the public price confirmed. */
async function vmPricing(env: StepEnv, providerRegion: string) {
  const sheet = await sheetFor(env.deps.db, env.executor.kind, providerRegion);
  if (!sheet) {
    if (env.executor.kind === 'fake') return {}; // Local simulator fixtures do not need live AWS prices.
    throw new StepFailed('Machine prices are unavailable. No new VM was launched.');
  }
  const quoted = env.op.params?.maxVmHour;
  const maxVmHour = typeof quoted === 'number' && Number.isFinite(quoted) && quoted >= 0 ? Math.min(quoted, sheet.vmHour) : sheet.vmHour;
  return { maxVmHour, instanceTypePrices: sheet.instanceTypes ?? { [sheet.instanceType]: sheet.vmHour } };
}

const MAX_IP_ROUNDS = 3;
const OLD_IP_KEEP_DAYS = 30;

// --- ledger ------------------------------------------------------------------------------------

/** Intent first: the ledger row exists before the provider call (page 10, rule 1). */
async function ledgerPending(env: StepEnv, kind: ResourceKind, token: string, generation: number, zone: string | null, sizeGb = 0) {
  const { deps, op, instance, region, executor } = env;
  const monthlyCostEstimate = await estimateCents(env, region.providerRegion, kind, sizeGb);
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
      monthlyCostEstimate,
      firstSeenAt: deps.now(),
    })
    .onConflictDoUpdate({
      target: resources.requestToken,
      set: { createdByOp: op.id, firstSeenAt: deps.now(), tags: env.tags(kind, generation) },
      setWhere: and(isNull(resources.providerId), eq(resources.state, 'pending'), operationFence(env)),
    });
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
    .set({ providerId, zone, address, state: sql`case when ${resources.state} in ('rejected', 'superseded') or (${resources.state} = 'deleted' and ${resources.providerId} is not null) then ${resources.state} else 'active' end`, lastSeenAt: env.deps.now() })
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
    await db.update(resources).set({ state: 'rejected' }).where(and(eq(resources.requestToken, token), operationFence(env)));
    throw new RestartFrom('allocate_ip', `address ${address} was used before`);
  }
  return { result: { address } };
}

/** How long a new or woken VM may take until its agent reports `ready` (page 10: create step 8). */
const AGENT_START_TIMEOUT_MS = 10 * 60_000;
/** A new VM on a stock image installs Docker and pulls the browser image on its first boot. */
const AGENT_FIRST_BOOT_TIMEOUT_MS = 16 * 60_000;
/** How long the engine waits for a command reply before giving up on it. */
const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_POLL_MS = 2_000;

async function awaitAgent(env: StepEnv): Promise<StepOutcome> {
  const p = await loadPlacement(env);
  // A create interrupted by Sleep resumes under a fresh operation, retaining its dedicated
  // resources and stable create tokens. An already-created VM may still be stopped.
  if (env.op.kind === 'create' && env.op.params?.resumeCreateFrom) await env.executor.ensureRunning(env.ctx('resume_running'), placementRef(p));
  return awaitAgentFor(env, p);
}

async function awaitAgentFor(env: StepEnv, p: PlacementRow): Promise<StepOutcome> {
  // The agent must report ready after this operation began, so a stale report from before a stop does not count.
  const status = await env.agent.status(env.instance.id, p.generation, env.op.createdAt);
  if (status === 'ready') return {};
  const limit = env.op.kind === 'create' || env.op.kind === 'recover' ? AGENT_FIRST_BOOT_TIMEOUT_MS : AGENT_START_TIMEOUT_MS;
  if (env.deps.now().getTime() - env.op.createdAt.getTime() > limit) {
    throw new StepFailed('The browser did not start in time.');
  }
  return { wait: 3_000, reason: 'waiting for the agent' };
}

/** Sends a command once per step and round, then waits for its reply without blocking the worker. */
async function command(
  env: StepEnv,
  step: string,
  kind: Parameters<StepEnv['agent']['send']>[0]['kind'],
  payload: Record<string, unknown>,
  timeoutMs = COMMAND_TIMEOUT_MS,
) {
  const id = `${env.op.id}:${step}:${env.round}`;
  await env.agent.send({ id, instanceId: env.instance.id, kind, payload });
  const reply = await env.agent.reply(id);
  const timedOut = env.deps.now().getTime() - reply.createdAt.getTime() > timeoutMs;
  return { reply, timedOut };
}

async function verifyBinding(env: StepEnv): Promise<StepOutcome> {
  const p = await currentPlacement(env);
  if (!p && env.op.kind === 'stop') return { result: { skipped: 'creation was stopped before placement' } };
  return verifyBindingFor(env, p ?? await loadPlacement(env));
}

async function verifyBindingFor(env: StepEnv, p: PlacementRow): Promise<StepOutcome> {
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
  return verifyIpFor(env, await loadPlacement(env));
}

async function verifyIpFor(env: StepEnv, p: PlacementRow): Promise<StepOutcome> {
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

/**
 * Graceful Chrome close, then an encrypted archive of the profile to R2 (page 2, flow C; page 4).
 * If the agent does not ack within 60 s (5 min while archiving), the VM is stopped anyway; Chrome's
 * stores are journaled.
 */
async function prepareShutdown(env: StepEnv): Promise<StepOutcome> {
  const settlement = settleRunningStatements(env.deps.db, env.instance.id, env.deps.now(), operationFence(env));
  await env.deps.db.batch([settlement[0]!, ...settlement.slice(1)]);
  // Permanent deletion has already revoked the agent and archive key. Never create a fresh
  // profile copy or wait for an agent that is intentionally unable to authenticate.
  if (env.op.kind === 'delete' && env.op.params?.purgeNow === true) {
    const at = env.deps.now();
    // System trial reclamation has no API acceptance transaction. Record its purge eligibility
    // before stopping the VM too, so a failed provider stop cannot strand the deleted profile.
    await env.deps.db.update(browserInstances).set({
      status: 'deleting', desiredState: 'deleted', deletedAt: env.instance.deletedAt ?? at,
      purgeAfter: env.instance.purgeAfter && env.instance.purgeAfter <= at ? env.instance.purgeAfter : at, updatedAt: at,
    }).where(and(eq(browserInstances.id, env.instance.id), operationFence(env)));
    await revokeDeletedInstance(env);
    return { result: { skipped: true, reason: 'permanent deletion' } };
  }
  if (env.op.kind === 'stop' && env.op.params?.preemptedOperationId) return { result: { skipped: 'interrupted operation; provider stop is authoritative' } };
  const p = await currentPlacement(env);
  if (!p) return { result: { skipped: true } };
  const archive = await prepareArchive(env, p, 'sleep');
  const { reply, timedOut } = await command(
    env,
    'prepare_shutdown',
    'prepare_shutdown',
    archive ? { archive: { putUrl: archive.putUrl, objectKey: archive.objectKey } } : {},
    archive ? ARCHIVE_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
  );
  if (reply.status === 'pending' && !timedOut) return { wait: COMMAND_POLL_MS, reason: 'waiting for Chrome to close' };
  if (archive) await settleArchive(env, archive.backupId, reply);
  return { result: { acked: reply.status === 'succeeded' } };
}

async function ensureStopped(env: StepEnv): Promise<StepOutcome> {
  const places = await env.deps.db.select().from(placements).where(eq(placements.instanceId, env.instance.id));
  const ledger = await env.deps.db.select().from(resources).where(and(eq(resources.instanceId, env.instance.id), ne(resources.state, 'deleted')));
  const groups = new Map<string, { executor: ExecutorKind; region: string }>();
  for (const r of ledger) groups.set(`${r.executor}:${r.region}`, { executor: r.executor as ExecutorKind, region: r.region });
  for (const p of places) groups.set(`${p.executor}:${p.providerRegion}`, { executor: p.executor as ExecutorKind, region: p.providerRegion });
  groups.set(`${env.region.executor}:${env.region.providerRegion}`, { executor: env.region.executor as ExecutorKind, region: env.region.providerRegion });
  let stopped = 0;
  for (const group of groups.values()) {
    const executor = env.deps.executor(group.executor);
    // A provider call may have created a VM before its response reached placements/ledger.
    const inventory = await executor.listManaged(env.ctx('stop_inventory'), group.region);
    const current = places.find((p) => p.status === 'current' && p.executor === group.executor && p.providerRegion === group.region);
    const disk = current && inventory.find((r) => r.kind === 'volume' && r.providerId === current.volumeId && r.tags['cb:instance'] === env.instance.id && r.tags['cb:env'] === env.deps.envName);
    if (disk && typeof disk.sizeGb === 'number' && Number.isSafeInteger(disk.sizeGb) && disk.sizeGb > 0) {
      await env.deps.db.update(browserInstances).set({ storageGb: sql`max(${browserInstances.storageGb}, ${disk.sizeGb})` })
        .where(and(eq(browserInstances.id, env.instance.id), operationFence(env)));
    }
    const ids = new Set([
      ...places.filter((p) => p.executor === group.executor && p.providerRegion === group.region && p.vmId).map((p) => p.vmId!),
      ...inventory.filter((r) => r.kind === 'vm' && r.tags['cb:instance'] === env.instance.id && r.tags['cb:env'] === env.deps.envName).map((r) => r.providerId),
    ]);
    for (const vmId of ids) {
      const p = places.find((x) => x.vmId === vmId);
      const ref = p ? placementRef(p) : { providerRegion: group.region, vmId, zone: '', volumeId: '', nicId: '', ipAllocationId: '', ipAddress: '' };
      await executor.ensureStopped(env.ctx('ensure_stopped', vmId), ref);
      stopped++;
    }
  }
  const drainUntil = Number(env.op.params?.drainUntil ?? 0);
  if (drainUntil > env.deps.now().getTime()) return { wait: Math.min(5_000, drainUntil - env.deps.now().getTime()), reason: 'confirming an earlier provider request has stopped' };
  // Re-running this step after drainUntil stops a VM that appeared after the first pass too.
  return { result: { stopped } };
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
      .where(and(eq(browserInstances.id, env.instance.id), operationFence(env))),
    db.insert(events).values(eventRow(env.instance.userId, 'instance.updated', { instanceId: env.instance.id }, at)),
  ] as const;
  if (status === 'running') {
    const startsRunning = sql`exists(select 1 from browser_instances where id = ${env.instance.id} and status <> 'running')`;
    await db.batch([
      db.insert(instanceHealth).values({
        instanceId: env.instance.id,
        meteredAt: sql`case when ${operationFence(env)} and ${startsRunning} then ${at.getTime()} else null end`,
      }).onConflictDoUpdate({ target: instanceHealth.instanceId, set: { meteredAt: at }, setWhere: and(operationFence(env), startsRunning) }),
      ...stmts,
    ]);
  } else await db.batch(stmts);
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
  const sizeGb = await newVolumeGb(env);
  await ledgerPending(env, 'volume', ctx.token, 1, zone, sizeGb);
  const vol = await env.executor.ensureVolume(ctx, env.region.providerRegion, zone, sizeGb);
  await ledgerActive(env, ctx.token, vol.volumeId, vol.zone);
  await env.deps.db.update(browserInstances).set({ storageGb: vol.sizeGb }).where(and(eq(browserInstances.id, env.instance.id), operationFence(env)));
  return { result: { volumeId: vol.volumeId, sizeGb: vol.sizeGb } };
}

/**
 * Single-use agent bootstrap token, valid 15 minutes (page 10, create step 6). It is derived from a
 * secret, so create_vm can put it in the VM's user data without the token ever being stored; only
 * its hash is kept, in `agent_credentials`.
 */
async function issueBootstrap(env: StepEnv): Promise<StepOutcome> {
  return issueBootstrapFor(env, 1);
}

/** A new bootstrap for `generation`; replacing the credential stops an older generation's agent from connecting. */
function createTokenOperation(env: StepEnv) {
  return env.op.kind === 'create' && typeof env.op.params?.resumeCreateFrom === 'string' ? env.op.params.resumeCreateFrom : env.op.id;
}

async function issueBootstrapFor(env: StepEnv, generation: number): Promise<StepOutcome> {
  const token = await bootstrapToken(env.deps.bootstrapSecret, env.instance.id, createTokenOperation(env), generation);
  if (env.op.kind === 'create' && env.op.params?.resumeCreateFrom) {
    const [existing] = await env.deps.db.select().from(agentCredentials).where(eq(agentCredentials.instanceId, env.instance.id));
    if (existing?.generation === generation && existing.credentialHash) return { result: { resumed: true } };
  }
  const at = env.deps.now();
  const expiresAt = new Date(at.getTime() + 15 * 60_000);
  const values = { generation, bootstrapHash: await sha256Hex(token), bootstrapExpiresAt: expiresAt, credentialHash: null, activatedAt: null };
  await fencedInsert(env.deps.db, 'agent_credentials', {
    instance_id: env.instance.id, created_at: at, generation, bootstrap_hash: values.bootstrapHash,
    bootstrap_expires_at: expiresAt, credential_hash: null, activated_at: null,
  }, operationFence(env), sql`on conflict(instance_id) do update set generation = excluded.generation, bootstrap_hash = excluded.bootstrap_hash,
    bootstrap_expires_at = excluded.bootstrap_expires_at, credential_hash = null, activated_at = null where ${operationFence(env)}`);
  return { result: { expiresAt: expiresAt.toISOString() } };
}

async function createVm(env: StepEnv): Promise<StepOutcome> {
  const ip = result<{ allocationId: string; address: string }>(env, 'allocate_ip');
  const { nicId, zone } = result<{ nicId: string; zone: string }>(env, 'create_nic');
  const { volumeId } = result<{ volumeId: string }>(env, 'create_volume');
  const ctx = env.ctx('create_vm');
  await ledgerPending(env, 'vm', ctx.token, 1, zone);
  const vm = await env.executor.ensureVm(ctx, env.region.providerRegion, {
    ...await vmPricing(env, env.region.providerRegion),
    zone,
    nicId,
    volumeId,
    instanceId: env.instance.id,
    bootstrapToken: await bootstrapToken(env.deps.bootstrapSecret, env.instance.id, createTokenOperation(env), 1),
    gatewayUrl: env.deps.gatewayUrl,
  });
  await ledgerActive(env, ctx.token, vm.vmId, vm.zone);
  await fencedInsert(env.deps.db, 'placements', {
      id: newId(),
      instance_id: env.instance.id,
      generation: 1,
      executor: env.executor.kind,
      provider_region: env.region.providerRegion,
      zone: vm.zone,
      vm_id: vm.vmId,
      instance_type: vm.instanceType ?? null,
      root_volume_gb: vm.rootVolumeGb ?? 16,
      volume_id: volumeId,
      network_id: nicId,
      ip_allocation_id: ip.allocationId,
      ip_address: ip.address,
      status: 'current',
      created_at: env.deps.now(),
  }, operationFence(env));
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
      .where(and(eq(placements.id, p.id), operationFence(env))),
    // The old IP stays allocated and unattached for 30 days, then the reaper releases it.
    db
      .update(resources)
      .set({ state: 'superseded', releaseAfter: new Date(now().getTime() + OLD_IP_KEEP_DAYS * 86_400_000) })
      .where(
        and(
          eq(resources.instanceId, env.instance.id),
          eq(resources.kind, 'ip'),
          eq(resources.providerId, String(previous.oldAllocationId)), operationFence(env),
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
      .where(and(eq(placements.id, p.id), operationFence(env))),
    db
      .update(resources)
      .set({ state: 'active', releaseAfter: null })
      .where(and(eq(resources.instanceId, env.instance.id), eq(resources.providerId, swapped.oldAllocationId), operationFence(env))),
    db
      .update(resources)
      .set({ state: 'rejected' })
      .where(and(eq(resources.instanceId, env.instance.id), eq(resources.providerId, next?.allocationId ?? ''), operationFence(env))),
  ]);
}

// --- purge (reaper only) -----------------------------------------------------------------------

const DELETE_ORDER: ResourceKind[] = ['vm', 'network_interface', 'volume', 'snapshot', 'ip'];
// AWS create calls can time out before their identifiers reach the ledger. Leave enough time for
// their tagged resources to become visible instead of pretending a missing identifier means gone.
const UNKNOWN_RESOURCE_SETTLE_MS = 15 * 60_000;
// An already-issued R2 PUT cannot be revoked. Delete now and again after every URL has expired;
// immediate destruction of the per-instance encryption key makes any late upload unreadable.
const ARCHIVE_UPLOAD_SETTLE_MS = 16 * 60_000;

type DeleteEnv = Pick<StepEnv, 'deps' | 'executor' | 'ctx'>;

/** Find owned resources even if a create response or the subsequent ledger write was lost. */
export async function discoverInstanceResources(env: DeleteEnv, instanceId: string) {
  const { db, now } = env.deps;
  const rows = await db.select().from(resources).where(eq(resources.instanceId, instanceId));
  const places = await db.select().from(placements).where(eq(placements.instanceId, instanceId));
  const [inst] = await db.select({ regionId: browserInstances.regionId }).from(browserInstances).where(eq(browserInstances.id, instanceId));
  const [region] = inst ? await db.select().from(regions).where(eq(regions.id, inst.regionId)) : [];
  const groups = new Map<string, { executor: ExecutorKind; region: string }>();
  const add = (executor: string, providerRegion: string) => groups.set(`${executor}:${providerRegion}`, { executor: executor as ExecutorKind, region: providerRegion });
  for (const r of rows) add(r.executor, r.region);
  for (const p of places) add(p.executor, p.providerRegion);
  if (region) add(region.executor, region.providerRegion);
  let live = 0;
  for (const group of groups.values()) {
    const observed = await env.deps.executor(group.executor).listManaged(readContext('reaper:discover-delete', env.deps.envName), group.region);
    for (const r of observed) {
      if (r.tags['cb:managed'] !== 'true' || r.tags['cb:env'] !== env.deps.envName || r.tags['cb:instance'] !== instanceId) continue;
      live++;
      const known = rows.find((x) => x.executor === group.executor && x.region === group.region && x.providerId === r.providerId);
      if (known) {
        if (known.state === 'deleted') await db.update(resources).set({ state: 'active', deletedAt: null, lastSeenAt: now() }).where(eq(resources.id, known.id));
        continue;
      }
      const pending = rows.find((x) => !x.providerId && x.executor === group.executor && x.region === group.region && x.kind === r.kind && r.tags['cb:token'] === x.requestToken);
      if (pending) {
        await db.update(resources).set({ providerId: r.providerId, state: 'active', lastSeenAt: now() }).where(eq(resources.id, pending.id));
        pending.providerId = r.providerId; pending.state = 'active';
        continue;
      }
      await db.insert(resources).values({
        id: newId(), instanceId, executor: group.executor, kind: r.kind, providerId: r.providerId,
        region: r.region, zone: r.zone, state: 'active', tags: r.tags, createdByOp: r.tags['cb:op'] ?? null,
        requestToken: `discovered:${group.executor}:${group.region}:${r.providerId}`,
        firstSeenAt: now(), lastSeenAt: now(),
      }).onConflictDoNothing();
    }
  }
  return live;
}

/** Deletes every selected ledger resource. A provider must confirm deletion before its row closes. */
export async function deleteLedgerResources(
  env: DeleteEnv,
  instanceId: string,
  filter: (r: typeof resources.$inferSelect) => boolean = () => true,
) {
  const { db, now } = env.deps;
  const open = (
    await db.select().from(resources).where(and(eq(resources.instanceId, instanceId), ne(resources.state, 'deleted')))
  ).filter(filter);
  open.sort((a, b) => DELETE_ORDER.indexOf(a.kind as ResourceKind) - DELETE_ORDER.indexOf(b.kind as ResourceKind));
  let deleted = 0;
  let waitingForUnknown = false;
  for (const r of open) {
    const base = env.ctx('delete', r.id);
    const ctx = { ...base, tags: { ...base.tags, 'cb:managed': 'true' as const, 'cb:env': env.deps.envName, 'cb:instance': instanceId, 'cb:kind': r.kind as ResourceKind } };
    const executor = env.deps.executor(r.executor as ExecutorKind);
    if (r.providerId) {
      await executor.ensureDeleted(ctx, r.region, r.kind as ResourceKind, r.providerId);
    } else {
      // The pending row is evidence of a possible unknown-outcome create, never proof of absence.
      const possible = (await executor.listManaged(readContext('reaper:resolve-pending-delete', env.deps.envName), r.region)).filter((x) =>
        x.kind === r.kind && x.tags['cb:env'] === env.deps.envName && x.tags['cb:instance'] === instanceId &&
        (x.tags['cb:token'] === r.requestToken || x.tags['cb:op'] === r.createdByOp),
      );
      for (const x of possible) await executor.ensureDeleted(ctx, r.region, x.kind, x.providerId);
      const [creator] = r.createdByOp ? await db.select({ status: schema.operations.status, finishedAt: schema.operations.finishedAt }).from(schema.operations).where(eq(schema.operations.id, r.createdByOp)) : [];
      const possibleSubmissionAt = Math.max(r.firstSeenAt.getTime(), creator?.status === 'canceled' ? creator.finishedAt?.getTime() ?? 0 : 0);
      if (!possible.length && now().getTime() - possibleSubmissionAt < UNKNOWN_RESOURCE_SETTLE_MS) {
        waitingForUnknown = true;
        continue;
      }
    }
    const at = now();
    await db.update(resources).set({ state: 'deleted', deletedAt: at }).where(eq(resources.id, r.id));
    if (r.kind === 'ip' && r.address) {
      // The history row stays forever; a released address is never assigned to another browser.
      await db.update(ipAddresses).set({ releasedAt: at }).where(eq(ipAddresses.address, r.address));
    }
    deleted++;
  }
  if (waitingForUnknown) throw new ExecutorError('retryable', 'Waiting to confirm a resource from an unfinished provider request is absent.');
  return deleted;
}

async function revokeDeletedInstance(env: Pick<StepEnv, 'deps' | 'instance'>) {
  const { db, now } = env.deps;
  const at = now();
  await db.batch([
    db.update(agentCredentials).set({ credentialHash: null, bootstrapHash: null, bootstrapExpiresAt: null, rotatedAt: at }).where(eq(agentCredentials.instanceId, env.instance.id)),
    db.update(archiveKeys).set({ wrappedKey: null, destroyedAt: at }).where(eq(archiveKeys.instanceId, env.instance.id)),
    db.update(schema.browserReservations).set({ reservedMicros: 0, updatedAt: at }).where(eq(schema.browserReservations.instanceId, env.instance.id)),
    db.update(viewerSessions).set({ endedAt: at }).where(and(eq(viewerSessions.instanceId, env.instance.id), isNull(viewerSessions.endedAt))),
    db.update(agentCommands).set({ status: 'failed', reply: { error: 'Browser permanently deleted.' }, completedAt: at }).where(and(eq(agentCommands.instanceId, env.instance.id), isNull(agentCommands.completedAt))),
  ]);
}

async function purgeResources(env: StepEnv): Promise<StepOutcome> {
  await revokeDeletedInstance(env);
  await discoverInstanceResources(env, env.instance.id);
  const deleted = await deleteLedgerResources(env, env.instance.id);
  // Recheck after deletion as well: a lost create response can appear during the cleanup pass.
  if (await discoverInstanceResources(env, env.instance.id)) return { wait: 5_000, reason: 'confirming all browser resources have been released' };
  const copies = await env.deps.db.select().from(backups).where(eq(backups.instanceId, env.instance.id));
  const archives = copies.filter((b) => b.kind === 'archive' && b.location);
  if (archives.length && !env.deps.deleteArchive) throw new StepFailed('Archive deletion is not configured. Browser cleanup remains pending.');
  for (const b of archives) await env.deps.deleteArchive!(b.location!);
  const deletedAt = env.instance.deletedAt ?? env.op.createdAt;
  if (archives.length && env.deps.now().getTime() < deletedAt.getTime() + ARCHIVE_UPLOAD_SETTLE_MS) {
    return { wait: deletedAt.getTime() + ARCHIVE_UPLOAD_SETTLE_MS - env.deps.now().getTime(), reason: 'waiting for issued archive upload URLs to expire' };
  }
  await env.deps.db.batch([
    env.deps.db.update(placements).set({ status: 'superseded' }).where(eq(placements.instanceId, env.instance.id)),
    env.deps.db.update(backups).set({ status: 'deleted', deletedAt: env.deps.now() }).where(eq(backups.instanceId, env.instance.id)),
  ]);
  return { result: { deleted } };
}

// --- backups (page 4) --------------------------------------------------------------------------

/** Archiving a profile takes longer than a plain Chrome close. */
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;
const RESTORE_ARCHIVE_TIMEOUT_MS = 15 * 60_000;
const SUPERSEDED_KEEP_MS = 7 * 86_400_000;

/** The instance's archive key, created on first use and wrapped with the master key. */
export async function ensureArchiveKey(env: Pick<StepEnv, 'deps'>, instanceId: string) {
  const { db, archiveMasterKey, now } = env.deps;
  if (!archiveMasterKey) return false;
  const [instance] = await db.select({ status: browserInstances.status, desiredState: browserInstances.desiredState }).from(browserInstances).where(eq(browserInstances.id, instanceId));
  if (!instance || instance.desiredState === 'deleted' || ['deleting', 'purged'].includes(instance.status)) return false;
  const [row] = await db.select().from(archiveKeys).where(eq(archiveKeys.instanceId, instanceId));
  if (row?.wrappedKey) return true;
  if (row?.destroyedAt) return false;
  const { wrapped } = await newArchiveKey(archiveMasterKey);
  await fencedInsert(db, 'archive_keys', { instance_id: instanceId, wrapped_key: wrapped, created_at: now() },
    sql`exists(select 1 from browser_instances where id = ${instanceId} and desired_state <> 'deleted' and status not in ('deleting', 'purged'))`);
  return true;
}

/** Records a pending archive backup and presigns its upload; null when archives are not configured. */
async function prepareArchive(env: StepEnv, p: PlacementRow, reason: 'sleep' | 'manual') {
  const store = env.deps.archives;
  if (!store || !(await ensureArchiveKey(env, env.instance.id))) return null;
  const backupId = `${env.op.id}-archive`;
  const objectKey = archiveObjectKey(env.instance.id, backupId);
  await env.deps.db
    .insert(backups)
    .values({
      id: backupId,
      instanceId: env.instance.id,
      kind: 'archive',
      reason,
      status: 'pending',
      location: objectKey,
      generation: p.generation,
      createdAt: env.deps.now(),
    })
    .onConflictDoNothing();
  return { backupId, objectKey, putUrl: await store.presignPut(objectKey) };
}

async function settleArchive(env: StepEnv, backupId: string, reply: CommandReply) {
  const archived = reply.status === 'succeeded' && reply.result?.archived === true;
  await env.deps.db
    .update(backups)
    .set({
      status: archived ? 'complete' : 'failed',
      sizeBytes: typeof reply.result?.sizeBytes === 'number' ? reply.result.sizeBytes : null,
      completedAt: env.deps.now(),
    })
    .where(and(eq(backups.id, backupId), eq(backups.status, 'pending')));
}

/** A provider snapshot of the current volume, in the ledger and in `backups`. */
export async function snapshotVolume(
  env: { deps: StepEnv['deps']; executor: StepEnv['executor']; instance: { id: string }; op?: { id: string } | null; tags: StepEnv['tags']; assertActive?: StepEnv['assertActive'] },
  p: PlacementRow,
  reason: string,
  token: string,
) {
  const { db, now } = env.deps;
  await db
    .insert(resources)
    .values({
      id: newId(),
      instanceId: env.instance.id,
      kind: 'snapshot',
      executor: env.executor.kind,
      providerId: null,
      region: p.providerRegion,
      zone: null,
      createdByOp: env.op?.id ?? null,
      requestToken: token,
      state: 'pending',
      tags: env.tags('snapshot', p.generation),
      monthlyCostEstimate: 0,
      firstSeenAt: now(),
    })
    .onConflictDoNothing();
  const assertActive = env.assertActive ?? (async () => {
    const [inst] = await db.select({ desiredState: browserInstances.desiredState, status: browserInstances.status }).from(browserInstances).where(eq(browserInstances.id, env.instance.id));
    if (!inst || inst.desiredState === 'deleted' || ['deleting', 'purged'].includes(inst.status)) throw new OperationSuperseded();
  });
  const ctx = { operationId: env.op?.id ?? 'scheduler', step: 'snapshot', token, tags: env.tags('snapshot', p.generation), deadline: Date.now() + 120_000, assertActive };
  const snap = await env.executor.snapshot(ctx, p.providerRegion, p.volumeId ?? '');
  const at = now();
  const monthlyCostEstimate = await estimateCents(env, p.providerRegion, 'snapshot', snap.sizeGb);
  await db.batch([
    db.update(resources).set({ providerId: snap.snapshotId, state: 'active', lastSeenAt: at, monthlyCostEstimate }).where(eq(resources.requestToken, token)),
    db
      .insert(backups)
      .values({
        id: `snap-${snap.snapshotId}`,
        instanceId: env.instance.id,
        kind: 'snapshot',
        reason,
        status: 'complete',
        location: snap.snapshotId,
        sizeBytes: snap.sizeGb * 1024 ** 3,
        generation: p.generation,
        createdAt: at,
        completedAt: at,
      })
      .onConflictDoNothing(),
  ]);
  return snap;
}

async function loadBackup(env: StepEnv) {
  const backupId = String((env.op.params as { backupId?: string } | null)?.backupId ?? '');
  const [b] = await env.deps.db
    .select()
    .from(backups)
    .where(and(eq(backups.id, backupId), eq(backups.instanceId, env.instance.id), eq(backups.status, 'complete')));
  if (!b) throw new StepFailed('That backup no longer exists.');
  return b;
}

/** restore, snapshot: a new volume from the snapshot, in the VM's zone. */
async function restoreVolume(env: StepEnv): Promise<StepOutcome> {
  const b = await loadBackup(env);
  if (b.kind !== 'snapshot') return { result: { skipped: true } };
  const p = await loadPlacement(env);
  const ctx = env.ctx('restore_volume');
  // The restored volume keeps the browser's current size (bought storage is never lost).
  const size = Math.max(env.instance.storageGb, Math.ceil((b.sizeBytes ?? 0) / 1024 ** 3));
  await ledgerPending(env, 'volume', ctx.token, p.generation, p.zone, size);
  const vol = await env.executor.ensureVolumeFromSnapshot(ctx, p.providerRegion, p.zone ?? '', b.location ?? '', size);
  await ledgerActive(env, ctx.token, vol.volumeId, vol.zone);
  return { result: { volumeId: vol.volumeId } };
}

/** restore, snapshot: swap the volumes while the VM is stopped; the old one is kept 7 days. */
async function swapVolume(env: StepEnv): Promise<StepOutcome> {
  const restored = env.results.restore_volume as { volumeId?: string; skipped?: boolean } | undefined;
  if (!restored?.volumeId) return { result: { skipped: true } };
  const p = await loadPlacement(env);
  const { db, now } = env.deps;
  await env.executor.swapVolume(env.ctx('swap_volume'), placementRef(p), restored.volumeId);
  await db.batch([
    db.update(placements).set({ volumeId: restored.volumeId }).where(and(eq(placements.id, p.id), operationFence(env))),
    db
      .update(resources)
      .set({ state: 'superseded', releaseAfter: new Date(now().getTime() + SUPERSEDED_KEEP_MS) })
      .where(and(eq(resources.instanceId, env.instance.id), eq(resources.providerId, p.volumeId ?? ''), operationFence(env))),
  ]);
  return { result: { previousVolumeId: p.volumeId } };
}

/** restore, archive: the agent closes Chrome, unpacks the archive into the profile and restarts Chrome. */
async function restoreArchive(env: StepEnv): Promise<StepOutcome> {
  const b = await loadBackup(env);
  if (b.kind !== 'archive') return { result: { skipped: true } };
  if (!env.deps.archives) throw new StepFailed('Archive restore is not configured.');
  const { reply, timedOut } = await command(
    env,
    'restore_archive',
    'restore_archive',
    { archive: { getUrl: await env.deps.archives.presignGet(b.location ?? ''), objectKey: b.location } },
    RESTORE_ARCHIVE_TIMEOUT_MS,
  );
  if (reply.status === 'pending') {
    if (timedOut) throw new StepFailed('Restoring the archive took too long.');
    return { wait: COMMAND_POLL_MS * 2, reason: 'restoring the archive' };
  }
  if (reply.status === 'failed') throw new StepFailed(`Restoring the archive failed: ${reply.error ?? 'unknown error'}`);
  return { result: { restored: true } };
}

// --- recover (page 10) -------------------------------------------------------------------------

async function loadBuilding(env: StepEnv): Promise<PlacementRow> {
  const [p] = await env.deps.db
    .select()
    .from(placements)
    .where(and(eq(placements.instanceId, env.instance.id), eq(placements.status, 'building')));
  if (!p) throw new StepFailed('The replacement machine is missing.');
  return p;
}

/** Stop the old VM if it still runs (best effort), then snapshot its volume. */
async function recoverSnapshot(env: StepEnv): Promise<StepOutcome> {
  const p = await loadPlacement(env);
  await env.executor.ensureStopped(env.ctx('snapshot_volume', 'stop'), placementRef(p)).catch((e) => { if (e instanceof OperationSuperseded) throw e; });
  const snap = await snapshotVolume(env, p, 'recover', env.ctx('snapshot_volume').token);
  const zones = env.executor.zones(p.providerRegion);
  const target = zones.find((z) => z !== p.zone) ?? p.zone ?? zones[0]!;
  return { result: { snapshotId: snap.snapshotId, sizeGb: snap.sizeGb, zone: target, generation: p.generation + 1 } };
}

function recoverPlan(env: StepEnv) {
  return result<{ snapshotId: string; sizeGb: number; zone: string; generation: number }>(env, 'snapshot_volume');
}

async function recoverVolume(env: StepEnv): Promise<StepOutcome> {
  const plan = recoverPlan(env);
  const ctx = env.ctx('restore_volume');
  await ledgerPending(env, 'volume', ctx.token, plan.generation, plan.zone, plan.sizeGb);
  const vol = await env.executor.ensureVolumeFromSnapshot(ctx, env.region.providerRegion, plan.zone, plan.snapshotId, plan.sizeGb);
  await ledgerActive(env, ctx.token, vol.volumeId, vol.zone);
  return { result: { volumeId: vol.volumeId } };
}

/** A new interface in the target zone; the same static IP moves to it (never a different IP). */
async function recoverNic(env: StepEnv): Promise<StepOutcome> {
  const plan = recoverPlan(env);
  const p = await loadPlacement(env);
  const ctx = env.ctx('create_nic');
  await ledgerPending(env, 'network_interface', ctx.token, plan.generation, plan.zone);
  const nic = await env.executor.ensureNetworkInterface(
    ctx,
    p.providerRegion,
    { allocationId: p.ipAllocationId ?? '', address: p.ipAddress ?? '' },
    plan.zone,
  );
  await ledgerActive(env, ctx.token, nic.nicId, nic.zone);
  return { result: { nicId: nic.nicId } };
}

async function recoverBootstrap(env: StepEnv): Promise<StepOutcome> {
  return issueBootstrapFor(env, recoverPlan(env).generation);
}

async function recoverVm(env: StepEnv): Promise<StepOutcome> {
  const plan = recoverPlan(env);
  const p = await loadPlacement(env);
  const { nicId } = result<{ nicId: string }>(env, 'create_nic');
  const { volumeId } = result<{ volumeId: string }>(env, 'restore_volume');
  const ctx = env.ctx('create_vm');
  await ledgerPending(env, 'vm', ctx.token, plan.generation, plan.zone);
  const vm = await env.executor.ensureVm(ctx, p.providerRegion, {
    ...await vmPricing(env, p.providerRegion),
    zone: plan.zone,
    nicId,
    volumeId,
    instanceId: env.instance.id,
    bootstrapToken: await bootstrapToken(env.deps.bootstrapSecret, env.instance.id, env.op.id, plan.generation),
    gatewayUrl: env.deps.gatewayUrl,
  });
  await ledgerActive(env, ctx.token, vm.vmId, vm.zone);
  await fencedInsert(env.deps.db, 'placements', {
      id: newId(),
      instance_id: env.instance.id,
      generation: plan.generation,
      executor: env.executor.kind,
      provider_region: p.providerRegion,
      zone: vm.zone,
      vm_id: vm.vmId,
      instance_type: vm.instanceType ?? null,
      root_volume_gb: vm.rootVolumeGb ?? 16,
      volume_id: volumeId,
      network_id: nicId,
      ip_allocation_id: p.ipAllocationId,
      ip_address: p.ipAddress,
      status: 'building',
      created_at: env.deps.now(),
  }, operationFence(env));
  return { result: { vmId: vm.vmId } };
}

/** The new generation becomes current; the old VM, interface and volume are kept 7 days, then removed. */
async function finishRecover(env: StepEnv): Promise<StepOutcome> {
  const { db, now } = env.deps;
  const old = await loadPlacement(env);
  const next = await loadBuilding(env);
  const keep = new Date(now().getTime() + SUPERSEDED_KEEP_MS);
  const oldIds = [old.vmId, old.networkId, old.volumeId].filter((x): x is string => !!x);
  await db.batch([
    db.update(placements).set({ status: 'superseded' }).where(and(eq(placements.id, old.id), operationFence(env))),
    db.update(placements).set({ status: 'current' }).where(and(eq(placements.id, next.id), operationFence(env))),
    db
      .update(resources)
      .set({ state: 'superseded', releaseAfter: keep })
      .where(and(eq(resources.instanceId, env.instance.id), inArray(resources.providerId, oldIds), operationFence(env))),
    db.insert(auditLog).values({
      actor: 'engine',
      action: 'instance.recovered',
      target: `instance:${env.instance.id}`,
      detail: { fromZone: old.zone, toZone: next.zone, generation: next.generation, ip: next.ipAddress },
      createdAt: now(),
    }),
  ]);
  env.placement = { ...next, status: 'current' };
  return finishWithStatus(env, 'running', { lastActiveAt: now() });
}

/** Canceled recovery/IP work must not leave unused paid assets allocated indefinitely. */
async function finishStop(env: StepEnv): Promise<StepOutcome> {
  const oldId = env.op.params?.preemptedOperationId;
  const [interrupted] = typeof oldId === 'string' ? await env.deps.db.select({ kind: schema.operations.kind }).from(schema.operations).where(eq(schema.operations.id, oldId)) : [];
  if (interrupted && ['recover', 'change_ip'].includes(interrupted.kind)) {
    await discoverInstanceResources(env, env.instance.id);
    const p = await currentPlacement(env);
    const keep = new Set([p?.vmId, p?.networkId, p?.volumeId, p?.ipAllocationId].filter((x): x is string => !!x));
    const leftovers = await env.deps.db.select().from(resources).where(and(eq(resources.instanceId, env.instance.id), eq(resources.createdByOp, String(oldId)), eq(resources.state, 'active')));
    for (const r of leftovers) {
      if (!r.providerId || keep.has(r.providerId) || r.kind === 'snapshot' || r.tags['cb:kind'] === 'root_volume') continue;
      await env.deps.db.update(resources).set({ state: r.kind === 'ip' ? 'rejected' : 'superseded', releaseAfter: env.deps.now() })
        .where(and(eq(resources.id, r.id), operationFence(env)));
    }
  }
  return finishWithStatus(env, 'sleeping', env.instance.trialState === 'active' || env.instance.trialState === 'ended'
    ? { trialReclaimAt: env.instance.trialReclaimAt ?? new Date(env.op.createdAt.getTime() + TRIAL.keptDays * 86_400_000) } : {});
}

// --- resize_volume (page 4: more storage) --------------------------------------------------------

/** How long to wait between checks of a volume modification. */
const RESIZE_POLL_MS = 5_000;

/** Grows the data volume (ModifyVolume) and waits until the new size is usable. */
async function resizeVolume(env: StepEnv): Promise<StepOutcome> {
  const p = await loadPlacement(env);
  const target = Number((env.op.params as { sizeGb?: unknown } | null)?.sizeGb);
  if (!Number.isInteger(target) || target < env.instance.storageGb) throw new StepFailed('The new size must be at least the current one.');
  const r = await env.executor.resizeVolume(env.ctx('resize_volume'), p.providerRegion, p.volumeId ?? '', target);
  if (r.state === 'pending') return { wait: RESIZE_POLL_MS, reason: 'growing the volume' };
  // AWS cannot undo an accepted volume growth. A late response may arrive after Sleep canceled
  // this job: record physical capacity and cost without restoring the old lifecycle status.
  await env.deps.db.batch([
    env.deps.db.update(browserInstances).set({ storageGb: sql`max(${browserInstances.storageGb}, ${r.sizeGb})` }).where(and(
      eq(browserInstances.id, env.instance.id), ne(browserInstances.status, 'purged'),
      sql`exists(select 1 from placements where instance_id = ${env.instance.id} and volume_id = ${p.volumeId ?? ''} and status = 'current')`,
    )),
    env.deps.db.update(resources).set({ monthlyCostEstimate: await estimateCents(env, p.providerRegion, 'volume', r.sizeGb) })
      .where(and(eq(resources.instanceId, env.instance.id), eq(resources.providerId, p.volumeId ?? ''), ne(resources.state, 'deleted'))),
  ]);
  return { result: { sizeGb: r.sizeGb } };
}

/**
 * A running browser's agent grows the file system online (resize2fs); a sleeping one grows it at its
 * next start. Either way the space is billed from now, so a failure here does not undo the resize.
 */
async function growFilesystem(env: StepEnv): Promise<StepOutcome> {
  if (env.instance.status !== 'running') return { result: { grown: false, when: 'next start' } };
  // The agent allows resize2fs two minutes; include delivery time before declaring a timeout.
  const { reply, timedOut } = await command(env, 'grow_filesystem', 'grow_filesystem', {}, 150_000);
  if (reply.status === 'pending' && !timedOut) return { wait: COMMAND_POLL_MS, reason: 'growing the file system' };
  if (reply.status !== 'succeeded') await raiseAlert(env.deps.db, {
    source: 'engine', severity: 'warning', title: `Browser file system growth needs attention: ${env.instance.id}`,
    detail: { instanceId: env.instance.id, operationId: env.op.id, volumeSizeGb: env.results.resize_volume?.sizeGb, error: reply.error ?? 'Agent did not confirm file system growth before timeout.' },
    dedupeKey: `filesystem-grow:${env.instance.id}`,
  }, env.deps.now());
  return { result: { grown: reply.status === 'succeeded', ...(reply.error ? { error: reply.error } : {}) } };
}

async function finishResize(env: StepEnv): Promise<StepOutcome> {
  const { sizeGb } = result<{ sizeGb: number }>(env, 'resize_volume');
  const p = await loadPlacement(env);
  const { db, now } = env.deps;
  await db.batch([
    db
      .update(resources)
      .set({ monthlyCostEstimate: await estimateCents(env, p.providerRegion, 'volume', sizeGb) })
      .where(and(eq(resources.instanceId, env.instance.id), eq(resources.providerId, p.volumeId ?? ''), operationFence(env))),
    db.insert(auditLog).values({
      actor: env.op.userId ? `user:${env.op.userId}` : 'engine',
      action: 'storage.resized',
      target: `instance:${env.instance.id}`,
      detail: { from: env.instance.storageGb, to: sizeGb, filesystem: env.results.grow_filesystem ?? null },
      createdAt: now(),
    }),
  ]);
  return finishWithStatus(env, env.instance.status, { storageGb: sizeGb });
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
    finish: finishStop,
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
      // A reclaimed trial browser is purged at once; a deleted browser is restorable for 7 days.
      const purgeNow = (env.op.params as { purgeNow?: boolean } | null)?.purgeNow === true;
      return finishWithStatus(env, 'deleting', {
        deletedAt: at,
        purgeAfter: purgeNow ? at : new Date(at.getTime() + 7 * 86_400_000),
      });
    },
  },
  undelete: {
    finish: async (env) => {
      if (!env.instance.purgeAfter || env.instance.purgeAfter <= env.deps.now()) throw new StepFailed('This browser was permanently deleted and cannot be restored.');
      const p = await currentPlacement(env);
      if (!p) {
        await finishWithStatus(env, 'failed', { deletedAt: null, purgeAfter: null });
        return {};
      }
      return finishWithStatus(env, 'sleeping', { deletedAt: null, purgeAfter: null });
    },
  },
  restore: {
    restore_volume: restoreVolume,
    swap_volume: swapVolume,
    restore_archive: restoreArchive,
    finish: (env) => finishWithStatus(env, env.instance.status),
  },
  recover: {
    snapshot_volume: recoverSnapshot,
    restore_volume: recoverVolume,
    create_nic: recoverNic,
    issue_bootstrap: recoverBootstrap,
    create_vm: recoverVm,
    await_agent: async (env) => awaitAgentFor(env, await loadBuilding(env)),
    verify_binding: async (env) => verifyBindingFor(env, await loadBuilding(env)),
    verify_ip_in_chrome: async (env) => verifyIpFor(env, await loadBuilding(env)),
    finish: finishRecover,
  },
  purge: {
    delete_resources: purgeResources,
    finish: (env) => finishWithStatus(env, 'purged'),
  },
  resize_volume: {
    resize_volume: resizeVolume,
    grow_filesystem: growFilesystem,
    finish: finishResize,
  },
};
