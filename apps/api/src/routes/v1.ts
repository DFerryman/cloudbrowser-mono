import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  Accepted,
  ConnectInfo,
  ConnectionDiagnostic,
  CreateInstanceBody,
  LiveQualityReport,
  DEFAULT_IDLE_TIMEOUT_S,
  IDLE_TIMEOUT_OPTIONS_S,
  NEVER_SLEEP_TIMEOUT_S,
  NeverSleepQuote,
  Instance,
  InstanceStorage,
  InstanceUsage,
  IpCheck,
  Me,
  Operation,
  Problem,
  REGION_INFO,
  Region,
  ResizeStorageBody,
  BALANCE_GRACE_MS,
  UpdateInstanceBody,
  ViewerSession,
  AgentKey,
  AutomationStatus,
  CreateAgentKeyBody,
  SetControlBody,
  objectLocationHint,
  signViewerToken,
  type RegionId,
} from '@cloudbrowser/contracts';
import { automationStatus, createAgentKey, revokeClient, setAccess, setControl } from '../automation.js';
import { turnIceServers } from '../turn.js';
import { callerLocation, regionViews } from '../availability.js';
import { awsInventory, billingRequired, prepaidAccess, reservationQuote, reservationWrite, eventRow, newId, schema, sha256Hex, settleRunningStatements } from '@cloudbrowser/db';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AppEnv } from '../env.js';
import { admitCreate, admitInstanceSpend, admitSpend, admitStart, entitlementsFor, regionAcceptingNew, usage } from '../limits.js';
import { currentBurn, instancePrice, regionPrice, requirePrice, storageLimits } from '../pricing.js';
import { instanceUsage, monthOf } from '../usage.js';
import { billingRoute, PageQuery } from './billing.js';
import { enqueueOperation, notifyUser, replayed, requireIdempotencyKey } from '../ops.js';
import { problem, ProblemError } from '../problem.js';
import { toInstances, toOperation } from '../views.js';
import { neverSleepQuote, neverSleepRefused } from '../never-sleep.js';
import { endViewerSession, recordViewerHeartbeat } from '../viewer-presence.js';
import { eventsRoute } from './events.js';
import { promotionsRoute } from './promotions.js';
import { accountRoute } from './account.js';
import { resizeQuota } from '../storage.js';
import { deleteBrowserPermanently } from '../deletion.js';

const { browserInstances, regions, operations, viewerSessions, instanceHealth, placements, events, auditLog } = schema;

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

/** A partial creation remains resumable even if a VM was created before it was put to sleep. */
async function wakeOperation(db: AppEnv['Variables']['db'], row: typeof browserInstances.$inferSelect) {
  const [p] = await db.select({ id: placements.id }).from(placements).where(and(eq(placements.instanceId, row.id), eq(placements.status, 'current')));
  const [created] = await db.select({ id: operations.id, status: operations.status, params: operations.params }).from(operations)
    .where(and(eq(operations.instanceId, row.id), eq(operations.kind, 'create'))).orderBy(desc(operations.createdAt)).limit(1);
  if (p && (!created || created.status === 'succeeded')) return { kind: 'start' as const, params: {} as Record<string, unknown> };
  const resume = created?.params?.resumeCreateFrom ?? created?.id;
  if (typeof resume !== 'string') throw problem(409, 'invalid_state', 'This browser has no saved creation to resume.');
  const [source] = await db.select({ params: operations.params }).from(operations).where(and(eq(operations.id, resume), eq(operations.instanceId, row.id)));
  const maxVmHour = source?.params?.maxVmHour;
  return { kind: 'create' as const, params: { resumeCreateFrom: resume, storageGb: row.storageGb, ...(typeof maxVmHour === 'number' ? { maxVmHour } : {}) } };
}

/**
 * The wake already queued for a browser, if any. The browser reads sleeping until the engine picks
 * the operation up, so a second open in that gap (another click, another tab) must join it.
 */
async function queuedWake(db: AppEnv['Variables']['db'], instanceId: string) {
  const [op] = await db.select({ id: operations.id, kind: operations.kind }).from(operations)
    .where(and(eq(operations.instanceId, instanceId), isNull(operations.finishedAt)));
  return op && ['start', 'create', 'recover'].includes(op.kind) ? op.id : null;
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
  async (c) => c.json(await regionViews(c.get('db'), callerLocation(c.req.raw)), 200),
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
    if (Object.hasOwn(await c.req.json(), 'trial')) throw problem(400, 'validation_failed', 'Timed free trials are no longer supported. Create a regular browser using your available credit.');
    const now = new Date();
    const tier = body.tier ?? 'basic';
    await admitCreate(db, user.id, body.regionId, now, { tier });
    // The user must have been shown this region's current prices for the tier (create dialog).
    const confirmedPrice = await requirePrice(db, body.regionId, body.priceVersion, tier);
    const storageGb = (await storageLimits(db, user.id)).defaultGb;
    if (body.storageGb !== storageGb) throw problem(409, 'price_changed', 'The storage included with a new browser changed. Review the new price and try again.');

    const [info] = await db.select().from(regions).where(eq(regions.id, body.regionId));
    if (!info) throw problem(409, 'region_unavailable');
    const screen = body.screen ?? 'auto';
    const instanceId = newId(now.getTime());
    const funding = (await billingRequired(db)) ? await reservationQuote(db, body.regionId, { storageGb, backupsEnabled: false }) : null;
    const result = await enqueueOperation(c, {
      instanceId,
      kind: 'create',
      key,
      route,
      params: { storageGb, maxVmHour: confirmedPrice.sheet.vmHour },
      before: [
        db.insert(browserInstances).values({
          id: instanceId,
          userId: user.id,
          name: body.name,
          regionId: body.regionId,
          tier,
          status: 'creating',
          desiredState: 'running',
          storageGb,
          backupsEnabled: false,
          idleTimeoutS: DEFAULT_IDLE_TIMEOUT_S,
          screen,
          // Coding agents may connect unless the user unticked it in the create dialog.
          agentAccess: body.agentAccess ?? true,
          fingerprint: { timezone: info.timezone, screen, chromeMajor: null },
          createdAt: now,
          updatedAt: now,
        }),
      ],
      after: [
        ...(funding ? [reservationWrite(db, user.id, instanceId, funding, now)] : []),
        db.insert(auditLog).values({
          actor: `user:${user.id}`,
          action: 'instance.create',
          target: `instance:${instanceId}`,
          detail: { regionId: body.regionId, tier, priceVersion: body.priceVersion ?? null, agentAccess: body.agentAccess ?? true },
          createdAt: now,
        }),
      ],
    });
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
    description: 'Rename or change the idle timeout. Turning on Never sleep (idleTimeoutS 0) needs an allowed quote from GET /instances/{id}/never-sleep and its priceVersion. The region can never be changed.',
    request: { params: IdParam, body: { content: { 'application/json': { schema: UpdateInstanceBody } }, required: true } },
    responses: { 200: jsonResponse(Instance, 'Updated browser'), ...errors, 403: problemResponse('Plan limit') },
  }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const row = await ownedInstance(c, c.req.valid('param').id);
    const { priceVersion, agentAccess, ...body } = c.req.valid('json');
    const idleChanged = body.idleTimeoutS !== undefined && body.idleTimeoutS !== row.idleTimeoutS;
    if (body.idleTimeoutS !== undefined) {
      if (!(IDLE_TIMEOUT_OPTIONS_S as readonly number[]).includes(body.idleTimeoutS)) {
        throw problem(400, 'validation_failed', `idleTimeoutS must be one of ${IDLE_TIMEOUT_OPTIONS_S.join(', ')}`);
      }
      if (body.idleTimeoutS !== NEVER_SLEEP_TIMEOUT_S) {
        const max = (await entitlementsFor(db, user.id)).idleTimeoutMaxS;
        if (body.idleTimeoutS > max) throw problem(403, 'plan_limit', `Your plan allows auto-sleep up to ${max / 60} minutes.`);
      } else if (idleChanged) {
        // Never sleep is its own setting with its own conditions, confirmed against the 24-hour cost shown.
        const quote = await neverSleepQuote(db, user.id, row);
        if (!quote.allowed) throw neverSleepRefused(quote);
        if (priceVersion === undefined) throw problem(400, 'validation_failed', 'Review the 24-hour cost of Never sleep before turning it on.');
        if (priceVersion !== quote.priceVersion) throw problem(409, 'price_changed', 'Prices changed since the cost was shown. Review the new cost and try again.');
      }
    }
    // Nothing changes until the whole request is valid. The access switch has its own side effects
    // (ending bridge sessions), so it is applied apart, ahead of the update and its event.
    if (agentAccess !== undefined && agentAccess !== row.agentAccess) await setAccess(db, c.env, user.id, row, agentAccess);
    const now = new Date();
    const fingerprint = {
      ...row.fingerprint,
      ...(body.screen ? { screen: body.screen } : {}),
    };
    await db.batch([
      db
        .update(browserInstances)
        .set({ ...body, backupsEnabled: false, fingerprint, updatedAt: now })
        .where(eq(browserInstances.id, row.id)),
      // A new idle setting counts from now, as if the user had just used the browser. This also
      // cancels an idle stop queued under the old setting (the engine rechecks input before stopping).
      ...(idleChanged ? [db.insert(instanceHealth).values({ instanceId: row.id, lastInputAt: now })
        .onConflictDoUpdate({ target: instanceHealth.instanceId, set: { lastInputAt: sql`max(coalesce(${instanceHealth.lastInputAt}, 0), ${now.getTime()})` } })] : []),
      db.insert(events).values(eventRow(user.id, 'instance.updated', { instanceId: row.id }, now)),
    ]);
    notifyUser(c, user.id);
    return c.json(await oneInstance(db, row.id), 200);
  },
);

v1.openapi(
  createRoute({
    method: 'get',
    path: '/instances/{id}/never-sleep',
    tags: ['instances'],
    description: 'Whether this browser may switch to Never sleep, what 24 hours of continuous running costs in its region (compute, IP and storage), and the available credit needed first.',
    request: { params: IdParam },
    responses: { 200: jsonResponse(NeverSleepQuote, 'Never sleep quote'), ...errors },
  }),
  async (c) => {
    const row = await ownedInstance(c, c.req.valid('param').id);
    return c.json(await neverSleepQuote(c.get('db'), c.get('user').id, row), 200);
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
    const result = await deleteBrowserPermanently(c, row, key, route);
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
    // Not a failed create: the reaper releases its resources, and asleep it would keep (and be charged for) them.
    allowed: ['creating', 'starting', 'stopping', 'running', 'sleeping', 'needs_attention', 'waiting_capacity', 'provider_issue', 'deleting'],
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
        await admitInstanceSpend(db, user.id, row, 'restore a deleted browser');
        if (!row.purgeAfter || row.purgeAfter <= new Date()) throw problem(409, 'invalid_state', 'The 7-day recovery window has passed.');
        const u = await usage(db, user.id);
        const ent = await entitlementsFor(db, user.id);
        if (u.browsers >= ent.maxBrowsers) throw problem(403, 'plan_limit', `Your plan allows ${ent.maxBrowsers} browsers.`);
      }
      let kind: 'start' | 'stop' | 'undelete' | 'create' = l.kind;
      const params: Record<string, unknown> = { reason: 'user' };
      if (l.action === 'start') {
        const wake = await wakeOperation(db, row); kind = wake.kind; Object.assign(params, wake.params);
        // Restart browser: its VM may still be running, so the engine reboots it (ensure_running).
        if (kind === 'start' && row.status === 'needs_attention') params.restart = true;
      }
      const now = new Date();
      const result = await enqueueOperation(c, {
        instanceId: row.id,
        kind,
        ...(l.action === 'stop' ? { priority: 'stop' as const } : {}),
        key,
        route,
        params,
        before: [
          ...(l.action === 'stop' ? settleRunningStatements(db, row.id, now) : []),
          db.update(browserInstances).set({ desiredState: l.desired, ...(l.action === 'stop' ? { status: sql`case when ${browserInstances.status} = 'sleeping' then 'sleeping' else 'stopping' end` } : {}), updatedAt: now }).where(eq(browserInstances.id, row.id)),
          ...(l.action === 'stop' ? [db.update(viewerSessions).set({ endedAt: now }).where(and(eq(viewerSessions.instanceId, row.id), isNull(viewerSessions.endedAt)))] : []),
        ],
      });
      if (l.action === 'stop') await c.env.GATEWAY?.revokeViewers?.(row.id).catch((e: unknown) => console.error('close sleeping browser viewers failed', row.id, e));
      return c.json(result, 202);
    },
  );
}

// --- coding-agent access (docs/agent-access.md) ----------------------------------------------

v1.openapi(
  createRoute({
    method: 'get',
    path: '/instances/{id}/automation',
    tags: ['automation'],
    description: 'Coding-agent access: whether it is allowed, who may drive the browser now, the MCP server URL, the access keys and the open session.',
    request: { params: IdParam },
    responses: { 200: jsonResponse(AutomationStatus, 'Coding-agent access'), ...errors },
  }),
  async (c) => c.json(await automationStatus(c.get('db'), c.env, await ownedInstance(c, c.req.valid('param').id)), 200),
);

v1.openapi(
  createRoute({
    method: 'post',
    path: '/instances/{id}/automation/keys',
    tags: ['automation'],
    description: 'Creates an access key for a coding agent: it adds the returned MCP server URL with `Authorization: Bearer <key>`. The key is shown once; only its hash is stored. At most 10 active keys per browser.',
    request: { params: IdParam, body: { content: { 'application/json': { schema: CreateAgentKeyBody } }, required: true } },
    responses: { 201: jsonResponse(AgentKey, 'The new key, shown once'), ...errors },
  }),
  async (c) => {
    const row = await ownedInstance(c, c.req.valid('param').id);
    const key = await createAgentKey(c.get('db'), c.env, (p) => c.executionCtx.waitUntil(p), c.get('user').id, row, c.req.valid('json'));
    notifyUser(c, c.get('user').id);
    return c.json(key, 201);
  },
);

v1.openapi(
  createRoute({
    method: 'delete',
    path: '/instances/{id}/automation/clients/{clientId}',
    tags: ['automation'],
    description: 'Revokes an access key (or a legacy bridge credential): it stops working and the agent\'s session is closed at once.',
    request: { params: z.object({ id: z.string().min(1).max(64), clientId: z.string().min(1).max(64) }) },
    responses: { 204: { description: 'Revoked' }, ...errors },
  }),
  async (c) => {
    const { id, clientId } = c.req.valid('param');
    const row = await ownedInstance(c, id);
    if (!(await revokeClient(c.get('db'), c.env, c.get('user').id, row, clientId))) throw problem(404, 'not_found');
    return c.body(null, 204);
  },
);

v1.openapi(
  createRoute({
    method: 'post',
    path: '/instances/{id}/automation/control',
    tags: ['automation'],
    description: 'Who may drive the browser: `agent` hands control back to the connected coding agent, `user` keeps it, `privacy` also stops screenshots.',
    request: { params: IdParam, body: { content: { 'application/json': { schema: SetControlBody } }, required: true } },
    responses: { 200: jsonResponse(Instance, 'Updated browser'), ...errors },
  }),
  async (c) => {
    const db = c.get('db');
    const row = await ownedInstance(c, c.req.valid('param').id);
    const { mode } = c.req.valid('json');
    if (mode !== 'agent' || row.agentAccess) await setControl(db, c.env, c.get('user').id, row, mode);
    else throw problem(409, 'agent_access_off', 'Coding agent access is turned off for this browser.');
    notifyUser(c, c.get('user').id);
    return c.json(await oneInstance(db, row.id), 200);
  },
);

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


// Old client routes remain tombstoned; public snapshot/backup and new-IP features have been removed.
// Ownership is checked first so this response cannot reveal another user's browser.
v1.post('/instances/:id/ip-change-requests', async (c) => {
  await ownedInstance(c, c.req.param('id'));
  throw problem(410, 'not_found', 'Requesting a new IP is no longer available. A browser keeps its dedicated IP.');
});
v1.get('/instances/:id/backups', async (c) => {
  await ownedInstance(c, c.req.param('id'));
  throw problem(410, 'not_found', 'Browser backups are no longer available.');
});
v1.post('/instances/:id/backups/:backupId/restore', async (c) => {
  await ownedInstance(c, c.req.param('id'));
  throw problem(410, 'not_found', 'Browser backups are no longer available.');
});

// --- storage and usage (pages 4 and 6) ----------------------------------------------------------

async function storageOf(c: Vars, row: typeof browserInstances.$inferSelect): Promise<InstanceStorage> {
  const db = c.get('db');
  const [h] = await db.select().from(instanceHealth).where(eq(instanceHealth.instanceId, row.id));
  const [p] = await db
    .select({ executor: placements.executor })
    .from(placements)
    .where(and(eq(placements.instanceId, row.id), eq(placements.status, 'current')));
  const nextResizeAt = await resizeQuota(db, row.id);
  const [busy] = await db.select({ id: operations.id }).from(operations).where(and(eq(operations.instanceId, row.id), isNull(operations.finishedAt)));
  const { maxGb } = await storageLimits(db, row.userId);
  const price = await regionPrice(db, row.regionId);
  const blockedReason: InstanceStorage['blockedReason'] = !['running', 'sleeping'].includes(row.status)
    ? 'state'
    : busy
      ? 'busy'
      : row.storageGb >= maxGb
        ? 'max'
        : nextResizeAt
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
    nextResizeAt: nextResizeAt?.toISOString() ?? null,
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
    description: 'Grows the data volume (it can never shrink). Billed per GB-month from the moment it grows; at most four attempts per rolling 24 hours, after the previous AWS modification completes.',
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
    if (storage.blockedReason === 'cooldown') throw problem(409, 'invalid_state', 'Storage allows four resize attempts per rolling 24 hours. Try again when the current quota resets.');
    if (storage.blockedReason === 'state') throw problem(409, 'invalid_state', 'Storage can grow while the browser is running or sleeping.');
    if (storage.blockedReason === 'agent') throw problem(409, 'invalid_state', 'This browser was created before storage could grow. Create a new browser to get more space.');
    await requirePrice(db, row.regionId, priceVersion);
    await admitInstanceSpend(db, user.id, row, 'add storage', { storageGb: sizeGb });
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
    request: { params: IdParam, query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }) },
    responses: { 200: jsonResponse(InstanceUsage, 'Usage'), ...errors },
  }),
  async (c) => {
    const db = c.get('db');
    const row = await ownedInstance(c, c.req.valid('param').id);
    const now = currentBurn(await instancePrice(db, row), row);
    return c.json(await instanceUsage(db, row.id, monthOf(c.req.valid('query').month), now), 200);
  },
);

// --- sessions ----------------------------------------------------------------------------------

async function requireViewerCredit(db: import('@cloudbrowser/db').Db, userId: string, instanceId: string) {
  const access = await prepaidAccess(db, userId, instanceId);
  if (access.allowed) return access;
  await db.update(viewerSessions).set({ endedAt: new Date() }).where(and(eq(viewerSessions.instanceId, instanceId), isNull(viewerSessions.endedAt)));
  if (access.reason === 'frozen') throw problem(403, 'account_frozen', 'This account is frozen.');
  if (access.reason === 'suspended') throw problem(403, 'suspended', 'This browser is suspended. Contact support.');
  if (access.reason === 'deleted') throw problem(409, 'invalid_state', 'This browser is unavailable.');
  throw problem(402, 'insufficient_balance', 'Available prepaid credit is insufficient. Usage is stopped; data and IP are kept for seven days.');
}

const OpenSessionResult = z.object({ session: ViewerSession, operationId: z.string().nullable() });

v1.openapi(
  createRoute({
    method: 'post',
    path: '/instances/{id}/sessions',
    tags: ['sessions'],
    description: 'Open a viewer session. Wakes the browser if it is sleeping. Other open sessions are taken over. An optional Idempotency-Key safely retries the same open intent without taking over its own session.',
    request: { params: IdParam, headers: z.object({ 'idempotency-key': z.string().trim().min(1).max(200).optional() }) },
    responses: { 201: jsonResponse(OpenSessionResult, 'Session opened'), ...errors, 403: problemResponse('Plan limit') },
  }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const instanceId = c.req.valid('param').id;
    const key = c.req.valid('header')['idempotency-key'];
    const sessionId = key ? await sha256Hex(JSON.stringify(['viewer-session', user.id, instanceId, key])) : newId();
    // Opening the live view is the first call on the session page: independent reads run together.
    // The earlier-session lookup is scoped to this user and browser, so it reveals nothing if not owned.
    const [row, [earlier]] = await Promise.all([
      ownedInstance(c, instanceId),
      key ? db.select().from(viewerSessions)
        .where(and(eq(viewerSessions.id, sessionId), eq(viewerSessions.instanceId, instanceId), eq(viewerSessions.userId, user.id))) : Promise.resolve([]),
    ]);
    if (row.desiredState === 'deleted' || ['deleting', 'failed'].includes(row.status)) throw problem(409, 'invalid_state');
    if (row.desiredState === 'stopped' && ['creating', 'starting', 'stopping'].includes(row.status)) throw problem(409, 'invalid_state', 'This browser is being put to sleep.');
    if (earlier?.endedAt || (earlier && row.status === 'sleeping')) {
      throw problem(409, 'invalid_state', 'This viewer session has ended. Open a new session to use this browser here.');
    }
    // Replaying a successful open must not wake a browser, invalidate another controller, or
    // replenish credit. Credit and ownership are always checked again before returning it.
    if (earlier) {
      await requireViewerCredit(db, user.id, row.id);
      const [op] = await db.select({ id: operations.id }).from(operations)
        .where(and(eq(operations.instanceId, row.id), isNull(operations.finishedAt)));
      return c.json({ session: { id: earlier.id, instanceId: row.id, startedAt: earlier.startedAt.toISOString() }, operationId: op?.id ?? null }, 201);
    }

    let operationId: string | null = null;
    if (row.status === 'sleeping') {
      operationId = await queuedWake(db, row.id);
      if (!operationId) {
        await admitStart(db, user.id, row.id, row.regionId);
        const wake = await wakeOperation(db, row);
        try {
          const r = await enqueueOperation(c, {
            instanceId: row.id,
            kind: wake.kind,
            key: key ? `session-open:${sessionId}` : null,
            route: 'open',
            params: { reason: 'open', ...wake.params },
            before: [db.update(browserInstances).set({ desiredState: 'running', updatedAt: new Date() }).where(eq(browserInstances.id, row.id))],
          });
          operationId = r.operationId;
        } catch (e) {
          // Two opens at the same moment: the one that lost the race joins the winner's wake.
          if (!(e instanceof ProblemError && e.type === 'operation_in_progress') || !(operationId = await queuedWake(db, row.id))) throw e;
        }
      }
      await requireViewerCredit(db, user.id, row.id);
    } else {
      const [[op]] = await Promise.all([
        db.select({ id: operations.id }).from(operations).where(and(eq(operations.instanceId, row.id), isNull(operations.finishedAt))),
        requireViewerCredit(db, user.id, row.id),
      ]);
      operationId = op?.id ?? null;
    }

    const now = new Date();
    const available = sql`EXISTS (SELECT 1 FROM browser_instances WHERE id = ${row.id} AND user_id = ${user.id}
      AND desired_state = 'running' AND status NOT IN ('deleting', 'purged', 'failed'))`;
    const newIntent = sql`NOT EXISTS (SELECT 1 FROM viewer_sessions WHERE id = ${sessionId})`;
    const openActive = and(available, sql`EXISTS (SELECT 1 FROM viewer_sessions WHERE id = ${sessionId} AND ended_at IS NULL)`);
    const [, , , [opened]] = await db.batch([
      // One controller at a time. A timed-out HTTP request may still reach this transaction
      // after its retry succeeded: the existing stable id makes that old request a no-op.
      db
        .update(viewerSessions)
        .set({ endedAt: now })
        .where(and(eq(viewerSessions.instanceId, row.id), isNull(viewerSessions.endedAt), newIntent, available)),
      db.insert(viewerSessions).select(sql`SELECT ${sessionId}, ${row.id}, ${user.id}, ${now.getTime()}, ${now.getTime()}, NULL,
        ${c.req.header('cf-ipcountry') ?? null}, ${c.req.header('user-agent')?.slice(0, 300) ?? null}, -1, NULL, NULL
        WHERE ${available}`).onConflictDoNothing(),
      // Opening another viewer is input activity, not a new billable run or fresh credit.
      db.insert(instanceHealth).values({ instanceId: row.id, lastInputAt: sql`CASE WHEN ${openActive} THEN ${now.getTime()} ELSE NULL END` })
        .onConflictDoUpdate({ target: instanceHealth.instanceId, set: { lastInputAt: sql`max(coalesce(${instanceHealth.lastInputAt}, 0), ${now.getTime()})` }, setWhere: openActive }),
      // Read back in the same transaction rather than another round trip.
      db.select().from(viewerSessions)
        .where(and(eq(viewerSessions.id, sessionId), eq(viewerSessions.instanceId, row.id), eq(viewerSessions.userId, user.id))),
    ]);
    if (!opened || opened.endedAt) throw problem(409, 'invalid_state', 'This viewer session has ended. Open a new session to use this browser here.');
    return c.json({ session: { id: opened.id, instanceId: row.id, startedAt: opened.startedAt.toISOString() }, operationId }, 201);
  },
);

async function ownedSession(c: Vars, id: string) {
  const db = c.get('db');
  const user = c.get('user');
  // One round trip: the session and its browser are read together (connect and heartbeats are hot paths).
  const [row] = await db
    .select({ session: viewerSessions, inst: { userId: browserInstances.userId, status: browserInstances.status, desiredState: browserInstances.desiredState, regionId: browserInstances.regionId } })
    .from(viewerSessions)
    .leftJoin(browserInstances, eq(browserInstances.id, viewerSessions.instanceId))
    .where(and(eq(viewerSessions.id, id), eq(viewerSessions.userId, user.id)));
  if (!row) throw problem(404, 'not_found');
  const { session: s, inst } = row;
  if (!inst || inst.userId !== user.id) throw problem(404, 'not_found');
  if (inst.desiredState === 'deleted' || ['deleting', 'purged'].includes(inst.status)) throw problem(409, 'invalid_state', 'This browser has been deleted.');
  return { ...s, browserStatus: inst.status, regionId: inst.regionId };
}

v1.openapi(
  createRoute({
    method: 'post',
    path: '/sessions/{id}/diagnostics',
    tags: ['sessions'],
    description: 'Allowlisted client connection milestones. These reports do not renew a session, keep the VM awake or change billing.',
    request: { params: IdParam, body: { content: { 'application/json': { schema: ConnectionDiagnostic } }, required: true } },
    responses: { 204: { description: 'Diagnostic recorded' }, ...errors },
  }),
  async (c) => {
    // A late failure report may arrive after this session was replaced or ended.
    // Ownership still applies; a diagnostic never revives that session.
    const s = await ownedSession(c, c.req.valid('param').id);
    const report = c.req.valid('json');
    console.info('viewer connection', {
      source: 'viewer', instanceId: s.instanceId, sessionId: s.id, clientBuild: clientBuild(c),
      ...report, observedAt: new Date().toISOString(),
    });
    return c.body(null, 204);
  },
);

/** Analytics Engine stores numbers only: a reading the browser did not have is -1. */
const measured = (value: number | null | undefined) => value ?? -1;

/** The web app's commit (apps/web/vite.config.ts), as its requests name it; '' when absent or malformed. */
function clientBuild(c: { req: { header(name: string): string | undefined } }): string {
  const build = c.req.header('x-client-build') ?? '';
  return /^[0-9a-f]{7,40}\+?$/.test(build) ? build : '';
}

v1.openapi(
  createRoute({
    method: 'post',
    path: '/sessions/{id}/quality',
    tags: ['sessions'],
    description: 'About a minute of live-view quality, for baselines by region and country. These reports do not renew a session, keep the VM awake or change billing.',
    request: { params: IdParam, body: { content: { 'application/json': { schema: LiveQualityReport } }, required: true } },
    responses: { 204: { description: 'Report recorded' }, ...errors },
  }),
  async (c) => {
    const s = await ownedSession(c, c.req.valid('param').id);
    const r = c.req.valid('json');
    // The visitor's own edge (request.cf describes the visitor, not where this Worker runs): with
    // a proxy or VPN, the proxy's. Its country beside a slow picture is what tells them apart.
    const cf = c.req.raw.cf as { country?: string; colo?: string; asn?: number } | undefined;
    // Layout: docs/connection-diagnostics.md, "Live quality". Fields are only ever appended.
    c.env.LIVE_QUALITY?.writeDataPoint({
      indexes: [s.regionId],
      blobs: [
        s.regionId, cf?.country ?? '', cf?.colo ?? '', cf?.asn ? String(cf.asn) : '', r.quality ?? '',
        r.localCandidateType ?? '', r.relayProtocol ?? '', s.instanceId, s.id, r.attemptId, clientBuild(c),
      ],
      doubles: [
        r.durationMs, r.readings, measured(r.rttMs), measured(r.gatewayRttMs), measured(r.fps), measured(r.kbps),
        measured(r.loss), r.freezes, measured(r.freezeMs), measured(r.jitterBufferMs), measured(r.decodeMs),
        measured(r.framesDropped), measured(r.width), measured(r.height),
        measured(r.nacks), measured(r.retransmits), measured(r.plis), measured(r.keyframes), measured(r.levelChanges),
      ],
    });
    return c.body(null, 204);
  },
);

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
    // Relay credentials are only handed out for a browser that can be viewed now.
    if (s.browserStatus !== 'running') throw problem(409, 'invalid_state', 'The live view opens once the browser is running.');
    // GETs skip the write limiter; each connect mints TURN credentials, so it has its own budget.
    if (c.env.API_LIMITER && !(await c.env.API_LIMITER.limit({ key: `connect:${s.userId}` })).success) throw problem(429, 'rate_limited');
    // The credit check, the placement and the TURN credentials are independent: fetch them
    // together rather than one after another, so the viewer can start its handshake sooner.
    // Nothing is returned unless every check passes. The TURN credentials stay valid for an hour
    // although the gateway token lasts 60 s: the relay checks them again each time the allocation
    // is refreshed, so they must outlast the view they carry, not just its handshake. A view that
    // reconnects fetches new ones here, within the rate limit above.
    const turn = c.env.GATEWAY_URL && c.env.VIEWER_TOKEN_PRIVATE_KEY
      ? turnIceServers(c.env, 3600).then((servers) => ({ servers }), (error: unknown) => ({ error }))
      : null;
    const [, [p]] = await Promise.all([
      requireViewerCredit(db, s.userId, s.instanceId),
      db.select().from(placements).where(and(eq(placements.instanceId, s.instanceId), eq(placements.status, 'current'))),
    ]);
    if (p?.executor === 'fake' && c.env.LIVE_VIEW !== 'on') return c.json({ mode: 'simulated' as const }, 200);
    if (!turn || !c.env.GATEWAY_URL || !c.env.VIEWER_TOKEN_PRIVATE_KEY) {
      throw problem(503, 'viewer_unavailable', 'The live view is not configured.');
    }
    const ice = await turn;
    if ('error' in ice) {
      console.error('TURN credentials failed', ice.error);
      throw problem(503, 'viewer_unavailable', 'The live view relay is unavailable right now. Try again in a moment.');
    }
    // A viewer can be the first to reach the browser's gateway object, from another continent.
    const loc = objectLocationHint(p?.providerRegion);
    // A 60 s single-use token for the gateway, and short-lived TURN credentials (pages 2 and 5).
    const token = await signViewerToken(JSON.parse(c.env.VIEWER_TOKEN_PRIVATE_KEY) as JsonWebKey, {
      jti: newId(),
      sid: s.id,
      iid: s.instanceId,
      uid: s.userId,
      exp: Math.floor(Date.now() / 1000) + 60,
      ...(loc ? { loc } : {}),
    });
    return c.json(
      {
        mode: 'webrtc' as const,
        gatewayUrl: `${c.env.GATEWAY_URL.replace(/\/$/, '')}/v1/stream/${s.instanceId}`,
        token,
        iceServers: ice.servers,
      },
      200,
    );
  },
);

const HeartbeatBody = z.object({
  input: z.boolean(),
  presence: z.object({ sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), viewing: z.boolean().nullable() }).optional(),
});
const HeartbeatResult = z.object({
  sleepAt: z.string().nullable(),
  /** `balance`: available prepaid credit is projected to run out at `sleepAt` regardless of input. */
  reason: z.enum(['idle', 'balance']).optional(),
});

v1.openapi(
  createRoute({
    method: 'post',
    path: '/sessions/{id}/heartbeat',
    tags: ['sessions'],
    description: 'Sent by the viewer every 15 s. Input renews activity; ordered presence keeps a visible live view awake and starts the idle countdown when it becomes hidden. Null visibility uses input-only behavior.',
    request: { params: IdParam, body: { content: { 'application/json': { schema: HeartbeatBody } }, required: true } },
    responses: { 200: jsonResponse(HeartbeatResult, 'When the browser will go to sleep without input'), ...errors },
  }),
  async (c) => {
    const db = c.get('db');
    const s = await ownedSession(c, c.req.valid('param').id);
    if (s.endedAt) throw problem(409, 'invalid_state', 'This browser is open in another tab or device.');
    await requireViewerCredit(db, s.userId, s.instanceId);
    const now = new Date();
    const { input, presence } = c.req.valid('json');
    const [inst] = await db.select().from(browserInstances).where(eq(browserInstances.id, s.instanceId));
    // The transaction rechecks session ownership and ordering at the activity write, after any
    // takeover. Its readback also keeps sleepAt consistent with the durable deadline.
    const activity = await recordViewerHeartbeat(c.env.DB, s, input, presence, now);
    if (!activity.active) throw problem(409, 'invalid_state', 'This browser is open in another tab or device.');
    if (!inst || inst.status !== 'running') return c.json({ sleepAt: null }, 200);
    const last = Math.max(inst.lastActiveAt?.getTime() ?? 0, activity.lastInputAt ?? 0);
    const idleAt = inst.idleTimeoutS === NEVER_SLEEP_TIMEOUT_S ? Infinity : last + inst.idleTimeoutS * 1000;
    // A paid authorization lease is renewed every minute. Its renewal time is not a sleep
    // deadline: only a genuine depletion projection should produce a balance warning.
    const access = await prepaidAccess(db, inst.userId, inst.id, now);
    const balanceAt = access.balanceDeadlineAt?.getTime() ?? Infinity;
    if (balanceAt < idleAt) return c.json({ sleepAt: new Date(balanceAt).toISOString(), reason: 'balance' as const }, 200);
    return Number.isFinite(idleAt)
      ? c.json({ sleepAt: new Date(idleAt).toISOString(), reason: 'idle' as const }, 200)
      : c.json({ sleepAt: null }, 200);
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
      await endViewerSession(c.env.DB, s, new Date());
    }
    return c.body(null, 204);
  },
);

v1.openapi(
  createRoute({
    method: 'get',
    path: '/instances/{id}/sessions',
    tags: ['sessions'],
    description: 'Viewer sessions, newest first (20 by default; page with limit and offset).',
    request: { params: IdParam, query: PageQuery },
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
      .orderBy(desc(viewerSessions.startedAt), desc(viewerSessions.id))
      .limit(c.req.valid('query').limit ?? 20)
      .offset(c.req.valid('query').offset ?? 0);
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
v1.route('/', promotionsRoute);
v1.route('/', accountRoute);
