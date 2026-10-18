import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  Accepted,
  Backup,
  ConnectInfo,
  CreateInstanceBody,
  DEFAULT_IDLE_TIMEOUT_S,
  IDLE_TIMEOUT_OPTIONS_S,
  Instance,
  InstanceStorage,
  InstanceUsage,
  IpChangeRequestBody,
  IpCheck,
  Me,
  Operation,
  Problem,
  REGION_INFO,
  Region,
  ResizeStorageBody,
  BALANCE_GRACE_MS,
  TRIAL,
  UpdateInstanceBody,
  ViewerSession,
  signViewerToken,
  type BrowserLocale,
  type RegionId,
} from '@cloudbrowser/contracts';
import { turnIceServers } from '../turn.js';
import { billingRequired, eventRow, newId, schema, userCaps } from '@cloudbrowser/db';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import type { AppEnv } from '../env.js';
import { admitCreate, admitIpChange, admitSpend, admitStart, billingAccount, claimTrial, entitlementsFor, isTrial, regionAcceptingNew, trialSecondsLeft, usage } from '../limits.js';
import { currentBurn, regionPrice, requirePrice, storageLimits } from '../pricing.js';
import { instanceUsage, monthOf } from '../usage.js';
import { billingRoute } from './billing.js';
import { enqueueOperation, notifyUser, replayed, requireIdempotencyKey } from '../ops.js';
import { problem } from '../problem.js';
import { toInstances, toOperation } from '../views.js';
import { eventsRoute } from './events.js';

const { browserInstances, regions, operations, viewerSessions, instanceHealth, placements, events, auditLog, backups, agentCredentials, archiveKeys, agentCommands } = schema;

/** AWS allows one change to a volume every 6 hours. */
const RESIZE_COOLDOWN_MS = 6 * 3_600_000;
/** The first agent that grows the file system and reports disk usage. */
const RESIZE_AGENT_VERSION = '0.2.0';
const newerOrEqual = (v: string | null, min: string) => {
  if (!v) return false;
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

export const v1 = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) {
      throw problem(400, 'validation_failed', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
  },
});

const IdParam = z.object({ id: z.string().min(1).max(64) });
const IdempotencyHeader = z.object({ 'idempotency-key': z.string().optional() });
const problemResponse = (description: string) => ({
  content: { 'application/problem+json': { schema: Problem } },
  description,
});
const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const accepted = { 202: jsonResponse(Accepted, 'Accepted; follow progress over SSE or GET /v1/operations/{id}') };
const errors = {
  400: problemResponse('Invalid request'),
  401: problemResponse('Not signed in'),
  404: problemResponse('Not found'),
  409: problemResponse('Conflict'),
};

type Vars = { get<K extends keyof AppEnv['Variables']>(key: K): AppEnv['Variables'][K] };

async function ownedInstance(c: Vars, id: string) {
  const db = c.get('db');
  const user = c.get('user');
  const [row] = await db
    .select()
    .from(browserInstances)
    .where(and(eq(browserInstances.id, id), eq(browserInstances.userId, user.id), ne(browserInstances.status, 'purged')));
  if (!row) throw problem(404, 'not_found');
  return row;
}

async function oneInstance(db: AppEnv['Variables']['db'], id: string) {
  const [row] = await db.select().from(browserInstances).where(eq(browserInstances.id, id));
  return (await toInstances(db, [row!]))[0]!;
}

// --- me & regions ------------------------------------------------------------------------------

v1.openapi(
  createRoute({ method: 'get', path: '/me', tags: ['account'], responses: { 200: jsonResponse(Me, 'Current user'), 401: errors[401] } }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    return c.json({ user, entitlements: await entitlementsFor(db, user.id), usage: await usage(db, user.id) }, 200);
  },
);

v1.openapi(
  createRoute({ method: 'get', path: '/regions', tags: ['regions'], responses: { 200: jsonResponse(z.array(Region), 'Regions') } }),
  async (c) => {
    const db = c.get('db');
    const rows = await db.select().from(regions).orderBy(asc(regions.id));
    const out = await Promise.all(
      rows
        .filter((r) => r.id in REGION_INFO)
        .map(async (r) => ({
          id: r.id as RegionId,
          name: r.name,
          country: r.country as Region['country'],
          city: r.city,
          timezone: r.timezone,
          enabled: r.enabled,
          acceptingNew: r.enabled && (await regionAcceptingNew(db, r.id)),
          probeUrl: r.probeUrl,
        })),
    );
    return c.json(out, 200);
  },
);

// --- instances ---------------------------------------------------------------------------------

v1.openapi(
  createRoute({
    method: 'get',
    path: '/instances',
    tags: ['instances'],
    responses: { 200: jsonResponse(z.array(Instance), 'Browsers, including soft-deleted ones') },
  }),
  async (c) => {
    const db = c.get('db');
    const rows = await db
      .select()
      .from(browserInstances)
      .where(and(eq(browserInstances.userId, c.get('user').id), ne(browserInstances.status, 'purged')))
      .orderBy(asc(browserInstances.createdAt));
    return c.json(await toInstances(db, rows), 200);
  },
);

v1.openapi(
  createRoute({
    method: 'post',
    path: '/instances',
    tags: ['instances'],
    request: {
      headers: IdempotencyHeader,
      body: { content: { 'application/json': { schema: CreateInstanceBody } }, required: true },
    },
    responses: { ...accepted, ...errors, 403: problemResponse('Plan limit'), 503: problemResponse('Temporarily unavailable') },
  }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const key = requireIdempotencyKey(c);
    const route = 'POST /v1/instances';
    const earlier = await replayed(db, user.id, key, route);
    if (earlier) return c.json(earlier, 202);

    const body = c.req.valid('json');
    const now = new Date();
    // The free trial (page 6): only where usage is paid, only in its region, once per user.
    const trial = body.trial === true && (await entitlementsFor(db, user.id)).billing === 'prepaid';
    if (trial && body.regionId !== TRIAL.regionId) throw problem(400, 'validation_failed', `The free trial runs in ${REGION_INFO[TRIAL.regionId].city} only.`);
    await admitCreate(db, user.id, body.regionId, now, { trial });
    // The user must have been shown this region's current prices (create dialog).
    await requirePrice(db, body.regionId, body.priceVersion);
    const storageGb = trial ? TRIAL.storageGb : (await storageLimits(db, user.id)).defaultGb;
    if (body.storageGb !== storageGb) throw problem(409, 'price_changed', 'The storage included with a new browser changed. Review the new price and try again.');
    if (trial && !(await claimTrial(db, user.id, now))) throw problem(409, 'invalid_state', 'You have already used your free trial.');

    const info = REGION_INFO[body.regionId];
    const locale: BrowserLocale = body.locale ?? 'en-US';
    const screen = body.screen ?? 'auto';
    const instanceId = newId(now.getTime());
    const result = await (async () => {
      try {
        return await enqueueOperation(c, {
          instanceId,
          kind: 'create',
          key,
          route,
          params: { storageGb },
          before: [
            db.insert(browserInstances).values({
              id: instanceId,
              userId: user.id,
              name: body.name,
              regionId: body.regionId,
              status: 'creating',
              desiredState: 'running',
              storageGb,
              idleTimeoutS: trial ? TRIAL.idleTimeoutS : DEFAULT_IDLE_TIMEOUT_S,
              ...(trial ? { trialState: 'active' } : {}),
              locale,
              screen,
              fingerprint: { timezone: info.timezone, locale, screen, chromeMajor: null },
              createdAt: now,
              updatedAt: now,
            }),
          ],
          after: [
            db.insert(auditLog).values({
              actor: `user:${user.id}`,
              action: 'instance.create',
              target: `instance:${instanceId}`,
              detail: { regionId: body.regionId, priceVersion: body.priceVersion ?? null, trial },
              createdAt: now,
            }),
          ],
        });
      } catch (e) {
        // Nothing was created: the trial is still unused.
        if (trial) await db.update(schema.billingAccounts).set({ trialUsedAt: null }).where(eq(schema.billingAccounts.userId, user.id));
        throw e;
      }
    })();
    return c.json(result, 202);
  },
);

v1.openapi(
  createRoute({
    method: 'get',
    path: '/instances/{id}',
    tags: ['instances'],
    request: { params: IdParam },
    responses: { 200: jsonResponse(Instance, 'Browser'), 404: errors[404] },
  }),
  async (c) => {
    const row = await ownedInstance(c, c.req.valid('param').id);
    return c.json((await toInstances(c.get('db'), [row]))[0]!, 200);
  },
);

v1.openapi(
  createRoute({
    method: 'patch',
    path: '/instances/{id}',
    tags: ['instances'],
    description: 'Rename, idle timeout, screen size, language or snapshot backups. The region can never be changed.',
    request: { params: IdParam, body: { content: { 'application/json': { schema: UpdateInstanceBody } }, required: true } },
    responses: { 200: jsonResponse(Instance, 'Updated browser'), ...errors, 403: problemResponse('Plan limit') },
  }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const row = await ownedInstance(c, c.req.valid('param').id);
    const { priceVersion, ...body } = c.req.valid('json');
    if (body.backupsEnabled === true && isTrial(row)) throw problem(409, 'invalid_state', 'Snapshots are not part of the free trial. Add credit to keep this browser first.');
    if (body.backupsEnabled === true && !row.backupsEnabled) {
      // Snapshots are billed per GB-month: the user must have seen the price, and be able to pay it.
      await requirePrice(db, row.regionId, priceVersion);
      await admitSpend(db, user.id, 'turn on snapshots');
    }
    if (body.idleTimeoutS !== undefined) {
      const max = (await entitlementsFor(db, user.id)).idleTimeoutMaxS;
      if (!(IDLE_TIMEOUT_OPTIONS_S as readonly number[]).includes(body.idleTimeoutS)) {
        throw problem(400, 'validation_failed', `idleTimeoutS must be one of ${IDLE_TIMEOUT_OPTIONS_S.join(', ')}`);
      }
      if (body.idleTimeoutS > max) throw problem(403, 'plan_limit', `Your plan allows auto-sleep up to ${max / 60} minutes.`);
    }
    const now = new Date();
    const fingerprint = {
      ...row.fingerprint,
      ...(body.locale ? { locale: body.locale } : {}),
      ...(body.screen ? { screen: body.screen } : {}),
    };
    await db.batch([
      db
        .update(browserInstances)
        .set({ ...body, fingerprint, updatedAt: now })
        .where(eq(browserInstances.id, row.id)),
      db.insert(events).values(eventRow(user.id, 'instance.updated', { instanceId: row.id }, now)),
    ]);
    notifyUser(c, user.id);
    return c.json(await oneInstance(db, row.id), 200);
  },
);

v1.openapi(
  createRoute({
    method: 'delete',
    path: '/instances/{id}',
    tags: ['instances'],
    description: 'Permanently delete this browser. Access is revoked immediately; its machine, disks, snapshots, archives and IP are then released. This cannot be undone.',
    request: { params: IdParam, headers: IdempotencyHeader },
    responses: { ...accepted, ...errors },
  }),
  async (c) => {
    const db = c.get('db');
    const key = requireIdempotencyKey(c);
    const route = `DELETE /v1/instances/${c.req.valid('param').id}`;
    const earlier = await replayed(db, c.get('user').id, key, route);
    if (earlier) return c.json(earlier, 202);
    const row = await ownedInstance(c, c.req.valid('param').id);
    if (row.status === 'deleting') throw problem(409, 'invalid_state', 'This browser is already deleted.');
    const now = new Date();
    const result = await enqueueOperation(c, {
      instanceId: row.id,
      kind: 'delete',
      key,
      route,
      params: { reason: 'user', purgeNow: true },
      // One transaction: accepting a permanent deletion also invalidates every route back to the
      // profile. Provider deletion is asynchronous and may be retried; access never waits for it.
      before: [
        db.update(browserInstances).set({ status: 'deleting', desiredState: 'deleted', deletedAt: now, purgeAfter: now, updatedAt: now }).where(eq(browserInstances.id, row.id)),
        db.update(viewerSessions).set({ endedAt: now }).where(and(eq(viewerSessions.instanceId, row.id), isNull(viewerSessions.endedAt))),
        db.update(agentCredentials).set({ credentialHash: null, bootstrapHash: null, bootstrapExpiresAt: null, rotatedAt: now }).where(eq(agentCredentials.instanceId, row.id)),
        db.update(archiveKeys).set({ wrappedKey: null, destroyedAt: now }).where(eq(archiveKeys.instanceId, row.id)),
        db.update(agentCommands).set({ status: 'failed', reply: { error: 'Browser permanently deleted.' }, completedAt: now }).where(and(eq(agentCommands.instanceId, row.id), isNull(agentCommands.completedAt))),
      ],
      after: [db.insert(auditLog).values({ actor: `user:${c.get('user').id}`, action: 'instance.delete_requested', target: `instance:${row.id}`, detail: { permanent: true }, createdAt: now })],
    });
    // Existing WebRTC sessions outlive their short-lived entry tokens. Close their signaling
    // sockets now as well; the gateway's per-frame database checks are the lost-RPC backstop.
    await c.env.GATEWAY?.revokeInstance(row.id).catch((e: unknown) => console.error('revoke deleted browser connections failed', row.id, e));
    return c.json(result, 202);
  },
);

/** Lifecycle actions that map to one operation each. */
const lifecycle = [
  {
    action: 'start',
    kind: 'start',
    allowed: ['sleeping', 'needs_attention'],
    desired: 'running',
    description: 'Wake a sleeping browser.',
  },
  {
    action: 'stop',
    kind: 'stop',
    allowed: ['running', 'needs_attention', 'waiting_capacity', 'provider_issue'],
    desired: 'stopped',
    description: 'Put a browser to sleep now. Data and IP are kept.',
  },
  {
    action: 'undelete',
    kind: 'undelete',
    allowed: ['deleting'],
    desired: 'stopped',
    description: 'Restore a deleted browser within 7 days.',
  },
] as const;

for (const l of lifecycle) {
  v1.openapi(
    createRoute({
      method: 'post',
      path: `/instances/{id}/${l.action}`,
      tags: ['instances'],
      description: l.description,
      request: { params: IdParam, headers: IdempotencyHeader },
      responses: { ...accepted, ...errors, 403: problemResponse('Plan limit'), 503: problemResponse('Temporarily unavailable') },
    }),
    async (c) => {
      const db = c.get('db');
      const user = c.get('user');
      const id = c.req.valid('param').id;
      const key = requireIdempotencyKey(c);
      const route = `POST /v1/instances/${id}/${l.action}`;
      const earlier = await replayed(db, user.id, key, route);
      if (earlier) return c.json(earlier, 202);
      const row = await ownedInstance(c, id);
      if (!(l.allowed as readonly string[]).includes(row.status)) {
        throw problem(409, 'invalid_state', `Cannot ${l.action} a browser that is ${row.status.replace('_', ' ')}.`);
      }
      if (l.action === 'start') await admitStart(db, user.id, row.id, row.regionId);
      if (l.action === 'undelete') {
        if (!row.purgeAfter || row.purgeAfter <= new Date()) throw problem(409, 'invalid_state', 'The 7-day recovery window has passed.');
        const u = await usage(db, user.id);
        const ent = await entitlementsFor(db, user.id);
        if (u.browsers >= ent.maxBrowsers) throw problem(403, 'plan_limit', `Your plan allows ${ent.maxBrowsers} browsers.`);
      }
      const result = await enqueueOperation(c, {
        instanceId: row.id,
        kind: l.kind,
        key,
        route,
        params: { reason: 'user' },
        before: [db.update(browserInstances).set({ desiredState: l.desired, updatedAt: new Date() }).where(eq(browserInstances.id, row.id))],
      });
      return c.json(result, 202);
    },
  );
}

// --- IP ----------------------------------------------------------------------------------------

v1.openapi(
  createRoute({
    method: 'post',
    path: '/instances/{id}/ip/verify',
    tags: ['ip'],
    description: 'Live IP check from inside Chrome.',
    request: { params: IdParam },
    responses: { 200: jsonResponse(IpCheck, 'Result of the check'), ...errors },
  }),
  async (c) => {
    const row = await ownedInstance(c, c.req.valid('param').id);
    if (row.status !== 'running' && row.status !== 'needs_attention') {
      throw problem(409, 'invalid_state', 'The IP can only be checked while the browser is running.');
    }
    const res = await c.env.ENGINE.fetch(`https://engine/instances/${row.id}/ip-check`, { method: 'POST' });
    if (!res.ok) throw problem(409, 'invalid_state', 'The IP can only be checked while the browser is running.');
    return c.json(IpCheck.parse(await res.json()), 200);
  },
);

v1.openapi(
  createRoute({
    method: 'post',
    path: '/instances/{id}/ip-change-requests',
    tags: ['ip'],
    description: 'User-confirmed request for a new IP in the same region. Never automatic.',
    request: {
      params: IdParam,
      headers: IdempotencyHeader,
      body: { content: { 'application/json': { schema: IpChangeRequestBody } }, required: true },
    },
    responses: { ...accepted, ...errors, 429: problemResponse('Monthly limit reached') },
  }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const id = c.req.valid('param').id;
    const key = requireIdempotencyKey(c);
    const route = `POST /v1/instances/${id}/ip-change-requests`;
    const earlier = await replayed(db, user.id, key, route);
    if (earlier) return c.json(earlier, 202);
    const row = await ownedInstance(c, id);
    if (row.status !== 'running' && row.status !== 'sleeping') {
      throw problem(409, 'invalid_state', 'A new IP can be requested while the browser is running or sleeping.');
    }
    if (isTrial(row)) throw problem(409, 'invalid_state', 'A new IP is not part of the free trial. Add credit to keep this browser first.');
    await requirePrice(db, row.regionId, c.req.valid('json').priceVersion);
    await admitSpend(db, user.id, 'request a new IP');
    await admitIpChange(db, user.id, new Date());
    const result = await enqueueOperation(c, {
      instanceId: row.id,
      kind: 'change_ip',
      key,
      route,
      params: { confirmedBy: user.id },
      after: [
        db.insert(auditLog).values({
          actor: `user:${user.id}`,
          action: 'ip.change_requested',
          target: `instance:${row.id}`,
          createdAt: new Date(),
        }),
      ],
    });
    return c.json(result, 202);
  },
);

// --- backups (page 4) ---------------------------------------------------------------------------

const BackupParams = z.object({ id: z.string().min(1).max(64), backupId: z.string().min(1).max(128) });

function toBackup(b: typeof backups.$inferSelect): Backup {
  return {
    id: b.id,
    kind: b.kind as Backup['kind'],
    reason: b.reason as Backup['reason'],
    status: b.status as Backup['status'],
    sizeBytes: b.sizeBytes ?? null,
    createdAt: b.createdAt.toISOString(),
    restorableWhen: b.kind === 'snapshot' ? 'sleeping' : 'running',
  };
}

v1.openapi(
  createRoute({
    method: 'get',
    path: '/instances/{id}/backups',
    tags: ['backups'],
    description: 'Daily volume snapshots and the encrypted profile archives taken at each sleep, newest first.',
    request: { params: IdParam },
    responses: { 200: jsonResponse(z.array(Backup), 'Backups'), ...errors },
  }),
  async (c) => {
    const row = await ownedInstance(c, c.req.valid('param').id);
    const rows = await c
      .get('db')
      .select()
      .from(backups)
      .where(and(eq(backups.instanceId, row.id), isNull(backups.deletedAt)))
      .orderBy(desc(backups.createdAt));
    return c.json(rows.map(toBackup), 200);
  },
);

v1.openapi(
  createRoute({
    method: 'post',
    path: '/instances/{id}/backups/{backupId}/restore',
    tags: ['backups'],
    description: 'Restore a snapshot while the browser sleeps, or an archive while it runs. The current data is replaced.',
    request: { params: BackupParams, headers: IdempotencyHeader },
    responses: { ...accepted, ...errors },
  }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const { id, backupId } = c.req.valid('param');
    const key = requireIdempotencyKey(c);
    const route = `POST /v1/instances/${id}/backups/${backupId}/restore`;
    const earlier = await replayed(db, user.id, key, route);
    if (earlier) return c.json(earlier, 202);
    const row = await ownedInstance(c, id);
    const [b] = await db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.instanceId, row.id), isNull(backups.deletedAt)));
    if (!b || b.status !== 'complete') throw problem(404, 'not_found', 'Backup not found.');
    const when = toBackup(b).restorableWhen;
    if (row.status !== when) {
      throw problem(
        409,
        'invalid_state',
        when === 'sleeping' ? 'Put the browser to sleep before restoring a snapshot.' : 'Start the browser before restoring an archive.',
      );
    }
    const result = await enqueueOperation(c, {
      instanceId: row.id,
      kind: 'restore',
      key,
      route,
      params: { backupId: b.id },
      after: [
        db.insert(auditLog).values({
          actor: `user:${user.id}`,
          action: 'backup.restore_requested',
          target: `instance:${row.id}`,
          detail: { backupId: b.id, kind: b.kind },
          createdAt: new Date(),
        }),
      ],
    });
    return c.json(result, 202);
  },
);

// --- storage and usage (pages 4 and 6) ----------------------------------------------------------

async function storageOf(c: Vars, row: typeof browserInstances.$inferSelect): Promise<InstanceStorage> {
  const db = c.get('db');
  const [h] = await db.select().from(instanceHealth).where(eq(instanceHealth.instanceId, row.id));
  const [p] = await db
    .select({ executor: placements.executor })
    .from(placements)
    .where(and(eq(placements.instanceId, row.id), eq(placements.status, 'current')));
  const [lastResize] = await db
    .select({ finishedAt: operations.finishedAt })
    .from(operations)
    .where(and(eq(operations.instanceId, row.id), eq(operations.kind, 'resize_volume'), eq(operations.status, 'succeeded')))
    .orderBy(desc(operations.finishedAt))
    .limit(1);
  const [busy] = await db.select({ id: operations.id }).from(operations).where(and(eq(operations.instanceId, row.id), isNull(operations.finishedAt)));
  const snaps = await db
    .select({ id: backups.id })
    .from(backups)
    .where(and(eq(backups.instanceId, row.id), eq(backups.kind, 'snapshot'), eq(backups.status, 'complete')));
  const { maxGb } = await storageLimits(db, row.userId);
  const price = await regionPrice(db, row.regionId);
  const nextAt = lastResize?.finishedAt ? lastResize.finishedAt.getTime() + RESIZE_COOLDOWN_MS : 0;
  const blockedReason: InstanceStorage['blockedReason'] = isTrial(row)
    ? 'trial'
    : !['running', 'sleeping'].includes(row.status)
    ? 'state'
    : busy
      ? 'busy'
      : row.storageGb >= maxGb
        ? 'max'
        : nextAt > Date.now()
          ? 'cooldown'
          : p && p.executor !== 'fake' && !newerOrEqual(h?.agentVersion ?? null, RESIZE_AGENT_VERSION)
            ? 'agent'
            : null;
  return {
    sizeGb: row.storageGb,
    rootVolumeGb: price?.sheet.rootVolumeGb ?? 0,
    maxGb,
    usedBytes: h?.diskUsedBytes ?? null,
    totalBytes: h?.diskTotalBytes ?? null,
    reportedAt: h?.diskReportedAt?.toISOString() ?? null,
    resizable: blockedReason === null,
    blockedReason,
    nextResizeAt: nextAt > Date.now() ? new Date(nextAt).toISOString() : null,
    snapshots: { count: snaps.length, retentionDays: (await userCaps(db, row.userId)).get('snapshot_retention_days') ?? 7 },
  };
}

v1.openapi(
  createRoute({
    method: 'get',
    path: '/instances/{id}/storage',
    tags: ['instances'],
    description: 'Data volume size, space used (reported by the browser while it runs) and whether it can grow now.',
    request: { params: IdParam },
    responses: { 200: jsonResponse(InstanceStorage, 'Storage'), ...errors },
  }),
  async (c) => c.json(await storageOf(c, await ownedInstance(c, c.req.valid('param').id)), 200),
);

v1.openapi(
  createRoute({
    method: 'post',
    path: '/instances/{id}/storage',
    tags: ['instances'],
    description: 'Grows the data volume (it can never shrink). Billed per GB-month from the moment it grows; one change every 6 hours.',
    request: { params: IdParam, headers: IdempotencyHeader, body: { content: { 'application/json': { schema: ResizeStorageBody } }, required: true } },
    responses: { ...accepted, ...errors, 402: problemResponse('Not enough credit'), 503: problemResponse('Prices unavailable') },
  }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const id = c.req.valid('param').id;
    const key = requireIdempotencyKey(c);
    const route = `POST /v1/instances/${id}/storage`;
    const earlier = await replayed(db, user.id, key, route);
    if (earlier) return c.json(earlier, 202);
    const row = await ownedInstance(c, id);
    const { sizeGb, priceVersion } = c.req.valid('json');
    const storage = await storageOf(c, row);
    if (sizeGb <= row.storageGb) throw problem(400, 'validation_failed', `Storage can only grow: choose more than ${row.storageGb} GB.`);
    if (sizeGb > storage.maxGb) throw problem(403, 'plan_limit', `Storage can grow up to ${storage.maxGb} GB.`, { limit: 'storage_max_gb' });
    if (storage.blockedReason === 'cooldown') throw problem(409, 'invalid_state', 'Storage can grow once every 6 hours. Try again later.');
    if (storage.blockedReason === 'state') throw problem(409, 'invalid_state', 'Storage can grow while the browser is running or sleeping.');
    if (storage.blockedReason === 'trial') throw problem(409, 'invalid_state', 'Add credit to keep this trial browser before adding storage.');
    if (storage.blockedReason === 'agent') throw problem(409, 'invalid_state', 'This browser was created before storage could grow. Create a new browser to get more space.');
    await requirePrice(db, row.regionId, priceVersion);
    await admitSpend(db, user.id, 'add storage');
    const result = await enqueueOperation(c, {
      instanceId: row.id,
      kind: 'resize_volume',
      key,
      route,
      params: { sizeGb, from: row.storageGb },
      after: [
        db.insert(auditLog).values({
          actor: `user:${user.id}`,
          action: 'storage.resize_requested',
          target: `instance:${row.id}`,
          detail: { from: row.storageGb, to: sizeGb, priceVersion: priceVersion ?? null },
          createdAt: new Date(),
        }),
      ],
    });
    return c.json(result, 202);
  },
);

v1.openapi(
  createRoute({
    method: 'get',
    path: '/instances/{id}/usage',
    tags: ['instances'],
    description: 'This browser’s usage and charges for a month (UTC), per item and per day, and what it costs right now.',
    request: { params: IdParam, query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }) },
    responses: { 200: jsonResponse(InstanceUsage, 'Usage'), ...errors },
  }),
  async (c) => {
    const db = c.get('db');
    const row = await ownedInstance(c, c.req.valid('param').id);
    const now = currentBurn(await regionPrice(db, row.regionId), row);
    return c.json(await instanceUsage(db, row.id, monthOf(c.req.valid('query').month), now), 200);
  },
);

// --- sessions ----------------------------------------------------------------------------------

const OpenSessionResult = z.object({ session: ViewerSession, operationId: z.string().nullable() });

v1.openapi(
  createRoute({
    method: 'post',
    path: '/instances/{id}/sessions',
    tags: ['sessions'],
    description: 'Open a viewer session. Wakes the browser if it is sleeping. Other open sessions are taken over.',
    request: { params: IdParam },
    responses: { 201: jsonResponse(OpenSessionResult, 'Session opened'), ...errors, 403: problemResponse('Plan limit') },
  }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const row = await ownedInstance(c, c.req.valid('param').id);
    if (row.desiredState === 'deleted' || ['deleting', 'failed'].includes(row.status)) throw problem(409, 'invalid_state');

    let operationId: string | null = null;
    if (row.status === 'sleeping') {
      await admitStart(db, user.id, row.id, row.regionId);
      const r = await enqueueOperation(c, {
        instanceId: row.id,
        kind: 'start',
        key: null,
        route: 'open',
        params: { reason: 'open' },
        before: [db.update(browserInstances).set({ desiredState: 'running', updatedAt: new Date() }).where(eq(browserInstances.id, row.id))],
      });
      operationId = r.operationId;
    } else {
      const [op] = await db
        .select({ id: operations.id })
        .from(operations)
        .where(and(eq(operations.instanceId, row.id), isNull(operations.finishedAt)));
      operationId = op?.id ?? null;
    }

    const now = new Date();
    const sessionId = newId(now.getTime());
    await db.batch([
      // One controller at a time: the newest session takes over.
      db
        .update(viewerSessions)
        .set({ endedAt: now })
        .where(and(eq(viewerSessions.instanceId, row.id), isNull(viewerSessions.endedAt))),
      db.insert(viewerSessions).values({
        id: sessionId,
        instanceId: row.id,
        userId: user.id,
        startedAt: now,
        lastSeenAt: now,
        country: c.req.header('cf-ipcountry') ?? null,
        userAgent: c.req.header('user-agent')?.slice(0, 300) ?? null,
      }),
      db.update(browserInstances).set({ lastActiveAt: now }).where(eq(browserInstances.id, row.id)),
    ]);
    return c.json({ session: { id: sessionId, instanceId: row.id, startedAt: now.toISOString() }, operationId }, 201);
  },
);

async function ownedSession(c: Vars, id: string) {
  const db = c.get('db');
  const user = c.get('user');
  const [s] = await db
    .select()
    .from(viewerSessions)
    .where(and(eq(viewerSessions.id, id), eq(viewerSessions.userId, user.id)));
  if (!s) throw problem(404, 'not_found');
  const [inst] = await db.select({ userId: browserInstances.userId, status: browserInstances.status, desiredState: browserInstances.desiredState }).from(browserInstances).where(eq(browserInstances.id, s.instanceId));
  if (!inst || inst.userId !== user.id) throw problem(404, 'not_found');
  if (inst.desiredState === 'deleted' || ['deleting', 'purged'].includes(inst.status)) throw problem(409, 'invalid_state', 'This browser has been deleted.');
  return s;
}

v1.openapi(
  createRoute({
    method: 'get',
    path: '/sessions/{id}/connect',
    tags: ['sessions'],
    description: 'Gateway URL, single-use token and TURN credentials. `simulated` while the browser runs on the fake executor.',
    request: { params: IdParam },
    responses: { 200: jsonResponse(ConnectInfo, 'How to connect'), ...errors, 503: problemResponse('Live view unavailable') },
  }),
  async (c) => {
    const db = c.get('db');
    const s = await ownedSession(c, c.req.valid('param').id);
    if (s.endedAt) throw problem(409, 'invalid_state', 'This browser is open in another tab or device.');
    const [p] = await db
      .select()
      .from(placements)
      .where(and(eq(placements.instanceId, s.instanceId), eq(placements.status, 'current')));
    if (p?.executor === 'fake' && c.env.LIVE_VIEW !== 'on') return c.json({ mode: 'simulated' as const }, 200);
    if (!c.env.GATEWAY_URL || !c.env.VIEWER_TOKEN_PRIVATE_KEY) {
      throw problem(503, 'viewer_unavailable', 'The live view is not configured.');
    }
    // A 60 s single-use token for the gateway, and short-lived TURN credentials (pages 2 and 5).
    const token = await signViewerToken(JSON.parse(c.env.VIEWER_TOKEN_PRIVATE_KEY) as JsonWebKey, {
      jti: newId(),
      sid: s.id,
      iid: s.instanceId,
      uid: s.userId,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    return c.json(
      {
        mode: 'webrtc' as const,
        gatewayUrl: `${c.env.GATEWAY_URL.replace(/\/$/, '')}/v1/stream/${s.instanceId}`,
        token,
        iceServers: await turnIceServers(c.env, 3600),
      },
      200,
    );
  },
);

const HeartbeatBody = z.object({ input: z.boolean() });
const HeartbeatResult = z.object({
  sleepAt: z.string().nullable(),
  /** `balance`: the prepaid balance is used up; the browser sleeps at `sleepAt` regardless of input. */
  reason: z.enum(['idle', 'balance', 'trial']).optional(),
});

v1.openapi(
  createRoute({
    method: 'post',
    path: '/sessions/{id}/heartbeat',
    tags: ['sessions'],
    description: 'Sent by the viewer every 15 s. `input` is true if the user interacted since the last heartbeat.',
    request: { params: IdParam, body: { content: { 'application/json': { schema: HeartbeatBody } }, required: true } },
    responses: { 200: jsonResponse(HeartbeatResult, 'When the browser will go to sleep without input'), ...errors },
  }),
  async (c) => {
    const db = c.get('db');
    const s = await ownedSession(c, c.req.valid('param').id);
    if (s.endedAt) throw problem(409, 'invalid_state', 'This browser is open in another tab or device.');
    const now = new Date();
    const { input } = c.req.valid('json');
    await db.batch([
      db.update(viewerSessions).set({ lastSeenAt: now }).where(eq(viewerSessions.id, s.id)),
      db
        .insert(instanceHealth)
        .values({ instanceId: s.instanceId, viewers: 1, lastHeartbeatAt: now, ...(input ? { lastInputAt: now } : {}) })
        .onConflictDoUpdate({
          target: instanceHealth.instanceId,
          set: { viewers: 1, lastHeartbeatAt: now, ...(input ? { lastInputAt: now } : {}) },
        }),
    ]);
    const [inst] = await db.select().from(browserInstances).where(eq(browserInstances.id, s.instanceId));
    const [h] = await db.select().from(instanceHealth).where(eq(instanceHealth.instanceId, s.instanceId));
    if (!inst || inst.status !== 'running') return c.json({ sleepAt: null }, 200);
    const last = Math.max(inst.lastActiveAt?.getTime() ?? 0, h?.lastInputAt?.getTime() ?? 0);
    const idleAt = last + inst.idleTimeoutS * 1000;
    // Balance used up: the engine puts the browser to sleep 10 minutes after it ran out (page 6).
    const { exhaustedAt } = (await billingRequired(db)) ? await billingAccount(db, inst.userId) : { exhaustedAt: null };
    // A free trial browser sleeps when its minutes are used, whatever the input.
    if (inst.trialState === 'active') {
      const trialAt = now.getTime() + trialSecondsLeft(inst) * 1000;
      if (trialAt < idleAt) return c.json({ sleepAt: new Date(trialAt).toISOString(), reason: 'trial' as const }, 200);
    }
    const balanceAt = exhaustedAt && !isTrial(inst) ? exhaustedAt.getTime() + BALANCE_GRACE_MS : Infinity;
    return balanceAt < idleAt
      ? c.json({ sleepAt: new Date(balanceAt).toISOString(), reason: 'balance' as const }, 200)
      : c.json({ sleepAt: new Date(idleAt).toISOString(), reason: 'idle' as const }, 200);
  },
);

v1.openapi(
  createRoute({
    method: 'post',
    path: '/sessions/{id}/end',
    tags: ['sessions'],
    request: { params: IdParam },
    responses: { 204: { description: 'Ended' }, ...errors },
  }),
  async (c) => {
    const s = await ownedSession(c, c.req.valid('param').id);
    if (!s.endedAt) {
      await c.get('db').update(viewerSessions).set({ endedAt: new Date() }).where(eq(viewerSessions.id, s.id));
    }
    return c.body(null, 204);
  },
);

v1.openapi(
  createRoute({
    method: 'get',
    path: '/instances/{id}/sessions',
    tags: ['sessions'],
    description: 'The last 20 viewer sessions.',
    request: { params: IdParam },
    responses: {
      200: jsonResponse(
        z.array(
          z.object({
            id: z.string(),
            startedAt: z.string(),
            endedAt: z.string().nullable(),
            country: z.string().nullable(),
            userAgent: z.string().nullable(),
          }),
        ),
        'Recent sessions',
      ),
      404: errors[404],
    },
  }),
  async (c) => {
    const row = await ownedInstance(c, c.req.valid('param').id);
    const rows = await c
      .get('db')
      .select()
      .from(viewerSessions)
      .where(eq(viewerSessions.instanceId, row.id))
      .orderBy(desc(viewerSessions.startedAt))
      .limit(20);
    return c.json(
      rows.map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        endedAt: (s.endedAt ?? (Date.now() - s.lastSeenAt.getTime() > 90_000 ? s.lastSeenAt : null))?.toISOString() ?? null,
        country: s.country,
        userAgent: s.userAgent,
      })),
      200,
    );
  },
);

// --- operations --------------------------------------------------------------------------------

v1.openapi(
  createRoute({
    method: 'get',
    path: '/operations/{id}',
    tags: ['operations'],
    request: { params: IdParam },
    responses: { 200: jsonResponse(Operation, 'Operation'), 404: errors[404] },
  }),
  async (c) => {
    const db = c.get('db');
    const [op] = await db
      .select()
      .from(operations)
      .innerJoin(browserInstances, eq(browserInstances.id, operations.instanceId))
      .where(and(eq(operations.id, c.req.valid('param').id), eq(browserInstances.userId, c.get('user').id)));
    if (!op) throw problem(404, 'not_found');
    return c.json(toOperation(op.operations), 200);
  },
);

v1.route('/', eventsRoute);
v1.route('/', billingRoute);
