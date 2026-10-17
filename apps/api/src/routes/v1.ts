import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  Accepted,
  ConnectInfo,
  CreateInstanceBody,
  DEFAULT_IDLE_TIMEOUT_S,
  IDLE_TIMEOUT_OPTIONS_S,
  Instance,
  IpChangeRequestBody,
  IpCheck,
  Me,
  Operation,
  Problem,
  REGION_INFO,
  Region,
  UpdateInstanceBody,
  ViewerSession,
  type BrowserLocale,
  type RegionId,
} from '@cloudbrowser/contracts';
import { eventRow, newId, schema } from '@cloudbrowser/db';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import type { AppEnv } from '../env.js';
import { admitCreate, admitIpChange, admitStart, entitlementsFor, regionAcceptingNew, usage } from '../limits.js';
import { enqueueOperation, replayed, requireIdempotencyKey } from '../ops.js';
import { problem } from '../problem.js';
import { toInstances, toOperation } from '../views.js';
import { eventsRoute } from './events.js';

const { browserInstances, regions, operations, viewerSessions, instanceHealth, placements, events, auditLog } = schema;

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
          country: r.country as 'JP' | 'US',
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
    await admitCreate(db, user.id, body.regionId, now);

    const info = REGION_INFO[body.regionId];
    const locale: BrowserLocale = body.locale ?? 'en-US';
    const screen = body.screen ?? 'auto';
    const instanceId = newId(now.getTime());
    const result = await enqueueOperation(c, {
      instanceId,
      kind: 'create',
      key,
      route,
      before: [
        db.insert(browserInstances).values({
          id: instanceId,
          userId: user.id,
          name: body.name,
          regionId: body.regionId,
          status: 'creating',
          desiredState: 'running',
          idleTimeoutS: DEFAULT_IDLE_TIMEOUT_S,
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
          detail: { regionId: body.regionId },
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
    description: 'Rename, idle timeout, screen size or language. The region can never be changed.',
    request: { params: IdParam, body: { content: { 'application/json': { schema: UpdateInstanceBody } }, required: true } },
    responses: { 200: jsonResponse(Instance, 'Updated browser'), ...errors, 403: problemResponse('Plan limit') },
  }),
  async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const row = await ownedInstance(c, c.req.valid('param').id);
    const body = c.req.valid('json');
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
    return c.json(await oneInstance(db, row.id), 200);
  },
);

v1.openapi(
  createRoute({
    method: 'delete',
    path: '/instances/{id}',
    tags: ['instances'],
    description: 'Soft delete: the browser sleeps and can be restored for 7 days with the same data and IP.',
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
    const result = await enqueueOperation(c, {
      instanceId: row.id,
      kind: 'delete',
      key,
      route,
      before: [db.update(browserInstances).set({ desiredState: 'deleted', updatedAt: new Date() }).where(eq(browserInstances.id, row.id))],
    });
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
    if (['deleting', 'failed'].includes(row.status)) throw problem(409, 'invalid_state');

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
    if (p?.executor === 'fake') return c.json({ mode: 'simulated' as const }, 200);
    // The session gateway and TURN credentials arrive with services/gateway (page 5).
    throw problem(503, 'viewer_unavailable', 'The live view is not available yet.');
  },
);

const HeartbeatBody = z.object({ input: z.boolean() });
const HeartbeatResult = z.object({ sleepAt: z.string().nullable() });

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
    return c.json({ sleepAt: new Date(last + inst.idleTimeoutS * 1000).toISOString() }, 200);
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
