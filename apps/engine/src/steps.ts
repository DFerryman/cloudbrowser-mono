import { eventRow, newArchiveKey, newId, schema, sha256Hex, userCaps } from '@cloudbrowser/db';
import type { ResourceKind } from '@cloudbrowser/executors';
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  placementRef,
  RestartFrom,
  StepFailed,
  type PlacementRow,
  type StepEnv,
  type StepOutcome,
} from './context.js';
import { bootstrapToken, type CommandReply } from './agent.js';
import { archiveObjectKey } from './archives.js';

const { browserInstances, instanceHealth, ipAddresses, placements, resources, auditLog, events, agentCredentials, backups, archiveKeys } = schema;

/** Default data volume size; plans set it later (page 6). */
const VOLUME_GB = 20;

/** Volume size from the owner's plan (20 GB Personal and pilot, 30 GB Pro; page 6). Never shrinks. */
async function volumeGb(env: StepEnv, atLeast = 0): Promise<number> {
  const planned = (await userCaps(env.deps.db, env.instance.userId)).get('storage_gb') ?? VOLUME_GB;
  return Math.max(planned, atLeast);
}
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
  return awaitAgentFor(env, await loadPlacement(env));
}

async function awaitAgentFor(env: StepEnv, p: PlacementRow): Promise<StepOutcome> {
  // The agent must report ready after this operation began, so a stale report from before a stop does not count.
  const status = await env.agent.status(env.instance.id, p.generation, env.op.createdAt);
  if (status === 'ready') return {};
  if (env.deps.now().getTime() - env.op.createdAt.getTime() > AGENT_START_TIMEOUT_MS) {
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
  return verifyBindingFor(env, await loadPlacement(env));
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
  const vol = await env.executor.ensureVolume(ctx, env.region.providerRegion, zone, await volumeGb(env));
  await ledgerActive(env, ctx.token, vol.volumeId, vol.zone);
  return { result: { volumeId: vol.volumeId } };
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
async function issueBootstrapFor(env: StepEnv, generation: number): Promise<StepOutcome> {
  const token = await bootstrapToken(env.deps.bootstrapSecret, env.instance.id, env.op.id, generation);
  const at = env.deps.now();
  const expiresAt = new Date(at.getTime() + 15 * 60_000);
  const values = { generation, bootstrapHash: await sha256Hex(token), bootstrapExpiresAt: expiresAt, credentialHash: null, activatedAt: null };
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
    // Destroying the archive key makes every archive unreadable, even before R2 deletes them (page 4).
    env.deps.db
      .update(archiveKeys)
      .set({ wrappedKey: null, destroyedAt: env.deps.now() })
      .where(eq(archiveKeys.instanceId, env.instance.id)),
  ]);
  const left = await env.deps.db
    .select()
    .from(backups)
    .where(and(eq(backups.instanceId, env.instance.id), ne(backups.status, 'deleted')));
  for (const b of left) {
    if (b.kind === 'archive' && b.location && env.deps.deleteArchive) await env.deps.deleteArchive(b.location);
  }
  await env.deps.db
    .update(backups)
    .set({ status: 'deleted', deletedAt: env.deps.now() })
    .where(eq(backups.instanceId, env.instance.id));
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
  const [row] = await db.select().from(archiveKeys).where(eq(archiveKeys.instanceId, instanceId));
  if (row?.wrappedKey) return true;
  if (row?.destroyedAt) return false;
  const { wrapped } = await newArchiveKey(archiveMasterKey);
  await db.insert(archiveKeys).values({ instanceId, wrappedKey: wrapped, createdAt: now() }).onConflictDoNothing();
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
  env: { deps: StepEnv['deps']; executor: StepEnv['executor']; instance: { id: string }; op?: { id: string } | null; tags: StepEnv['tags'] },
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
      monthlyCostEstimate: env.executor.capabilities.monthlyCostCents.snapshot ?? 0,
      firstSeenAt: now(),
    })
    .onConflictDoNothing();
  const ctx = { operationId: env.op?.id ?? 'scheduler', step: 'snapshot', token, tags: env.tags('snapshot', p.generation), deadline: Date.now() + 120_000 };
  const snap = await env.executor.snapshot(ctx, p.providerRegion, p.volumeId ?? '');
  const at = now();
  await db.batch([
    db.update(resources).set({ providerId: snap.snapshotId, state: 'active', lastSeenAt: at }).where(eq(resources.requestToken, token)),
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
  await ledgerPending(env, 'volume', ctx.token, p.generation, p.zone);
  const size = await volumeGb(env, Math.ceil((b.sizeBytes ?? 0) / 1024 ** 3));
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
    db.update(placements).set({ volumeId: restored.volumeId }).where(eq(placements.id, p.id)),
    db
      .update(resources)
      .set({ state: 'superseded', releaseAfter: new Date(now().getTime() + SUPERSEDED_KEEP_MS) })
      .where(and(eq(resources.instanceId, env.instance.id), eq(resources.providerId, p.volumeId ?? ''))),
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
  await env.executor.ensureStopped(env.ctx('snapshot_volume', 'stop'), placementRef(p)).catch(() => undefined);
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
  await ledgerPending(env, 'volume', ctx.token, plan.generation, plan.zone);
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
    zone: plan.zone,
    nicId,
    volumeId,
    instanceId: env.instance.id,
    bootstrapToken: await bootstrapToken(env.deps.bootstrapSecret, env.instance.id, env.op.id, plan.generation),
    gatewayUrl: env.deps.gatewayUrl,
  });
  await ledgerActive(env, ctx.token, vm.vmId, vm.zone);
  await env.deps.db
    .insert(placements)
    .values({
      id: newId(),
      instanceId: env.instance.id,
      generation: plan.generation,
      executor: env.executor.kind,
      providerRegion: p.providerRegion,
      zone: vm.zone,
      vmId: vm.vmId,
      volumeId,
      networkId: nicId,
      ipAllocationId: p.ipAllocationId,
      ipAddress: p.ipAddress,
      status: 'building',
      createdAt: env.deps.now(),
    })
    .onConflictDoNothing();
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
    db.update(placements).set({ status: 'superseded' }).where(eq(placements.id, old.id)),
    db.update(placements).set({ status: 'current' }).where(eq(placements.id, next.id)),
    db
      .update(resources)
      .set({ state: 'superseded', releaseAfter: keep })
      .where(and(eq(resources.instanceId, env.instance.id), inArray(resources.providerId, oldIds))),
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
};
