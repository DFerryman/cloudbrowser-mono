/**
 * Operator console API (page 10, "Operator console"): `/api/v1/admin/*`. Every route needs the
 * admin role and an allowlisted IP; everything but the step-up itself needs a passkey step-up from
 * the last 30 minutes. Every change is written to `audit_log` with the admin as actor. Internal:
 * not part of the public OpenAPI document.
 */
import { OPERATION_STEPS, type OperationKind } from '@cloudbrowser/contracts';
import { schema, type Db } from '@cloudbrowser/db';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireAdmin, requireStepUp, stepUpUntil } from '../admin/access.js';
import { acknowledgeAlert } from '../admin/alerts.js';
import { stepUpOptions, stepUpVerify } from '../admin/stepup.js';
import { notifyHub } from '../billing/sync.js';
import type { AppEnv } from '../env.js';
import { systemOperation } from '../ops.js';
import { problem } from '../problem.js';

const {
  user,
  admins,
  passkey,
  browserInstances,
  operations,
  operationSteps,
  placements,
  resources,
  ipAddresses,
  backups,
  instanceHealth,
  auditLog,
  driftFindings,
  caps,
  controlFlags,
  spendSnapshots,
  quotaSnapshots,
  alerts,
  webhookEvents,
  subscriptions,
} = schema;

export const adminRoute = new Hono<AppEnv>();
adminRoute.use('*', requireAdmin);

async function body<T extends z.ZodType>(c: Context<AppEnv>, schemaT: T): Promise<z.infer<T>> {
  const parsed = schemaT.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw problem(400, 'validation_failed', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}

const actor = (c: Context<AppEnv>) => `admin:${c.get('user').id}`;
const audit = (db: Db, c: Context<AppEnv>, action: string, target: string, detail: Record<string, unknown>) =>
  db.insert(auditLog).values({ actor: actor(c), action, target, detail: { ...detail, ip: c.req.header('cf-connecting-ip') ?? null }, createdAt: new Date() });

// --- session and step-up (no step-up needed) ------------------------------------------------------

adminRoute.get('/session', async (c) => {
  const db = c.get('db');
  const until = await stepUpUntil(db, c.get('sessionId'));
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)` }).from(passkey).where(eq(passkey.userId, c.get('user').id));
  return c.json({
    email: c.get('user').email,
    passkeys: Number(n),
    stepUpUntil: until && until.getTime() > Date.now() ? until.toISOString() : null,
  });
});

adminRoute.post('/step-up/options', async (c) => c.json(await stepUpOptions(c.env, c.get('db'), c.get('user').id, c.get('sessionId'))));

adminRoute.post('/step-up/verify', async (c) => {
  const { response } = await body(c, z.object({ response: z.record(z.string(), z.unknown()) }));
  const at = await stepUpVerify(
    c.env,
    c.get('db'),
    c.get('user').id,
    c.get('sessionId'),
    response as unknown as AuthenticationResponseJSON,
    c.req.header('cf-connecting-ip') ?? null,
  );
  return c.json({ stepUpUntil: new Date(at.getTime() + 30 * 60_000).toISOString() });
});

adminRoute.use('*', requireStepUp);

// --- overview ----------------------------------------------------------------------------------

const count = async (db: Db, q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);

adminRoute.get('/overview', async (c) => {
  const db = c.get('db');
  const now = Date.now();
  const byStatus = await db.select({ status: browserInstances.status, n: sql<number>`count(*)` }).from(browserInstances).groupBy(browserInstances.status);
  const flags = await db.select().from(controlFlags);
  const [spend] = await db.select().from(spendSnapshots).orderBy(desc(spendSnapshots.takenAt)).limit(1);
  const [budget] = await db.select().from(caps).where(and(eq(caps.scope, 'global'), eq(caps.metric, 'spend_budget_cents')));
  const quotas = await db.select().from(quotaSnapshots).orderBy(desc(quotaSnapshots.takenAt)).limit(30);
  const latestQuota = new Map<string, (typeof quotas)[number]>();
  for (const q of quotas) {
    const k = `${q.executor}/${q.region}/${q.metric}`;
    if (!latestQuota.has(k)) latestQuota.set(k, q);
  }
  return c.json({
    instances: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
    users: await count(db, db.select({ n: sql<number>`count(*)` }).from(user)),
    operations: {
      unfinished: await count(db, db.select({ n: sql<number>`count(*)` }).from(operations).where(isNull(operations.finishedAt))),
      failed24h: await count(
        db,
        db
          .select({ n: sql<number>`count(*)` })
          .from(operations)
          .where(and(eq(operations.status, 'failed'), gte(operations.finishedAt, new Date(now - 86_400_000)))),
      ),
    },
    flags: Object.fromEntries(flags.map((f) => [f.key, { value: f.value, reason: f.reason, updatedAt: f.updatedAt.toISOString() }])),
    spend: spend ? { projectedCents: spend.projectedCents, budgetCents: budget?.limit ?? null, takenAt: spend.takenAt.toISOString() } : null,
    quotas: [...latestQuota.values()].map((q) => ({ executor: q.executor, region: q.region, metric: q.metric, limit: q.limit, used: q.used })),
    findingsOpen: await count(db, db.select({ n: sql<number>`count(*)` }).from(driftFindings).where(eq(driftFindings.status, 'open'))),
    alertsOpen: await count(db, db.select({ n: sql<number>`count(*)` }).from(alerts).where(isNull(alerts.acknowledgedAt))),
    webhooksPending: await count(db, db.select({ n: sql<number>`count(*)` }).from(webhookEvents).where(isNull(webhookEvents.processedAt))),
  });
});

// --- alerts ------------------------------------------------------------------------------------

adminRoute.get('/alerts', async (c) => {
  const open = c.req.query('open') !== '0';
  const rows = await c
    .get('db')
    .select()
    .from(alerts)
    .where(open ? isNull(alerts.acknowledgedAt) : undefined)
    .orderBy(desc(alerts.createdAt))
    .limit(200);
  return c.json(rows);
});

adminRoute.post('/alerts/:id/ack', async (c) => {
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  await acknowledgeAlert(db, id, actor(c));
  await audit(db, c, 'alert.acknowledged', `alert:${id}`, {});
  return c.json({ ok: true });
});

// --- operations --------------------------------------------------------------------------------

adminRoute.get('/operations', async (c) => {
  const db = c.get('db');
  const status = c.req.query('status') ?? 'all';
  const kind = c.req.query('kind');
  const instanceId = c.req.query('instanceId');
  const where = and(
    status === 'unfinished' ? isNull(operations.finishedAt) : status === 'failed' ? eq(operations.status, 'failed') : undefined,
    kind ? eq(operations.kind, kind) : undefined,
    instanceId ? eq(operations.instanceId, instanceId) : undefined,
  );
  const rows = await db
    .select({
      id: operations.id,
      instanceId: operations.instanceId,
      instanceName: browserInstances.name,
      userEmail: user.email,
      kind: operations.kind,
      status: operations.status,
      step: operations.step,
      attempt: operations.attempt,
      errorClass: operations.errorClass,
      error: operations.error,
      createdAt: operations.createdAt,
      finishedAt: operations.finishedAt,
      notBefore: operations.notBefore,
    })
    .from(operations)
    .leftJoin(browserInstances, eq(browserInstances.id, operations.instanceId))
    .leftJoin(user, eq(user.id, browserInstances.userId))
    .where(where)
    .orderBy(desc(operations.createdAt))
    .limit(100);
  return c.json(rows);
});

adminRoute.get('/operations/:id', async (c) => {
  const db = c.get('db');
  const [op] = await db.select().from(operations).where(eq(operations.id, c.req.param('id')));
  if (!op) throw problem(404, 'not_found');
  const order = (OPERATION_STEPS[op.kind as OperationKind] ?? []) as readonly string[];
  const steps = (await db.select().from(operationSteps).where(eq(operationSteps.operationId, op.id))).sort(
    (a, b) => order.indexOf(a.step) - order.indexOf(b.step),
  );
  return c.json({ operation: op, steps });
});

// --- instances ---------------------------------------------------------------------------------

adminRoute.get('/instances', async (c) => {
  const db = c.get('db');
  const q = (c.req.query('q') ?? '').trim();
  const pattern = `%${q.replace(/[%_]/g, '')}%`;
  const ipMatches = q
    ? (await db.select({ id: ipAddresses.instanceId }).from(ipAddresses).where(eq(ipAddresses.address, q))).map((r) => r.id).filter((x): x is string => !!x)
    : [];
  const rows = await db
    .select({
      id: browserInstances.id,
      name: browserInstances.name,
      status: browserInstances.status,
      regionId: browserInstances.regionId,
      userEmail: user.email,
      userId: browserInstances.userId,
      suspendedAt: browserInstances.suspendedAt,
      updatedAt: browserInstances.updatedAt,
    })
    .from(browserInstances)
    .leftJoin(user, eq(user.id, browserInstances.userId))
    .where(
      q
        ? or(
            eq(browserInstances.id, q),
            like(browserInstances.name, pattern),
            like(user.email, pattern),
            ipMatches.length ? inArray(browserInstances.id, ipMatches) : undefined,
          )
        : undefined,
    )
    .orderBy(desc(browserInstances.updatedAt))
    .limit(100);
  const ids = rows.map((r) => r.id);
  const current = ids.length
    ? await db
        .select({ instanceId: placements.instanceId, ip: placements.ipAddress })
        .from(placements)
        .where(and(inArray(placements.instanceId, ids), eq(placements.status, 'current')))
    : [];
  const ip = new Map(current.map((p) => [p.instanceId, p.ip]));
  return c.json(rows.map((r) => ({ ...r, ipAddress: ip.get(r.id) ?? null })));
});

/** Everything about one browser, for its timeline. */
adminRoute.get('/instances/:id', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const [instance] = await db.select().from(browserInstances).where(eq(browserInstances.id, id));
  if (!instance) throw problem(404, 'not_found');
  const [owner] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, instance.userId));
  return c.json({
    instance,
    owner: owner ?? null,
    health: (await db.select().from(instanceHealth).where(eq(instanceHealth.instanceId, id)))[0] ?? null,
    placements: await db.select().from(placements).where(eq(placements.instanceId, id)).orderBy(desc(placements.generation)),
    resources: await db.select().from(resources).where(eq(resources.instanceId, id)).orderBy(desc(resources.firstSeenAt)),
    ipAddresses: await db.select().from(ipAddresses).where(eq(ipAddresses.instanceId, id)),
    operations: await db.select().from(operations).where(eq(operations.instanceId, id)).orderBy(desc(operations.createdAt)).limit(50),
    backups: await db.select().from(backups).where(eq(backups.instanceId, id)).orderBy(desc(backups.createdAt)).limit(30),
    audit: await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `instance:${id}`))
      .orderBy(desc(auditLog.createdAt))
      .limit(100),
  });
});

const RETRYABLE: OperationKind[] = ['start', 'stop', 'recover', 'restore', 'delete', 'undelete'];

adminRoute.post('/instances/:id/actions', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const { action, reason } = await body(
    c,
    z.object({ action: z.enum(['retry', 'recover', 'stop', 'suspend', 'unsuspend']), reason: z.string().trim().min(3).max(500) }),
  );
  const [inst] = await db.select().from(browserInstances).where(eq(browserInstances.id, id));
  if (!inst || inst.status === 'purged') throw problem(404, 'not_found');
  const now = new Date();
  let operationId: string | null = null;

  switch (action) {
    case 'retry': {
      const [last] = await db
        .select()
        .from(operations)
        .where(and(eq(operations.instanceId, id), eq(operations.status, 'failed')))
        .orderBy(desc(operations.createdAt))
        .limit(1);
      if (!last || !RETRYABLE.includes(last.kind as OperationKind)) {
        throw problem(409, 'invalid_state', 'No failed start, stop, recover, restore, delete or undelete to retry.');
      }
      operationId = await systemOperation(c.env, db, {
        instanceId: id,
        userId: inst.userId,
        kind: last.kind as OperationKind,
        actor: actor(c),
        params: { ...(last.params ?? {}), retryOf: last.id, reason },
      });
      break;
    }
    case 'recover':
      if (!['running', 'sleeping', 'needs_attention', 'waiting_capacity', 'provider_issue'].includes(inst.status)) {
        throw problem(409, 'invalid_state', `Cannot recover a browser that is ${inst.status}.`);
      }
      operationId = await systemOperation(c.env, db, { instanceId: id, userId: inst.userId, kind: 'recover', actor: actor(c), params: { reason: 'operator', note: reason } });
      break;
    case 'stop':
      operationId = await systemOperation(c.env, db, {
        instanceId: id,
        userId: inst.userId,
        kind: 'stop',
        actor: actor(c),
        params: { reason: 'operator', note: reason },
        before: [db.update(browserInstances).set({ desiredState: 'stopped', updatedAt: now }).where(eq(browserInstances.id, id))],
      });
      break;
    case 'suspend':
    case 'unsuspend': {
      // Suspended browsers cannot start; the engine puts a running one to sleep within a minute.
      await db.batch([
        db
          .update(browserInstances)
          .set(action === 'suspend' ? { suspendedAt: now, suspendedReason: reason, updatedAt: now } : { suspendedAt: null, suspendedReason: null, updatedAt: now })
          .where(eq(browserInstances.id, id)),
        db.insert(schema.events).values({ userId: inst.userId, type: 'instance.updated', data: { instanceId: id }, createdAt: now }),
      ]);
      c.executionCtx.waitUntil(notifyHub(c.env, inst.userId));
      break;
    }
  }
  await audit(db, c, `instance.${action}`, `instance:${id}`, { reason, operationId });
  return c.json({ ok: true, operationId });
});

// --- ledger and findings -----------------------------------------------------------------------

adminRoute.get('/ledger', async (c) => {
  const state = c.req.query('state');
  const kind = c.req.query('kind');
  const rows = await c
    .get('db')
    .select()
    .from(resources)
    .where(and(state ? eq(resources.state, state) : undefined, kind ? eq(resources.kind, kind) : undefined))
    .orderBy(desc(resources.firstSeenAt))
    .limit(300);
  return c.json(rows);
});

adminRoute.get('/findings', async (c) => {
  const status = c.req.query('status') ?? 'open';
  const rows = await c
    .get('db')
    .select()
    .from(driftFindings)
    .where(status === 'all' ? undefined : eq(driftFindings.status, status))
    .orderBy(desc(driftFindings.createdAt))
    .limit(200);
  return c.json(rows);
});

adminRoute.post('/findings/:id/resolve', async (c) => {
  const db = c.get('db');
  const { note } = await body(c, z.object({ note: z.string().trim().min(3).max(500) }));
  const id = c.req.param('id');
  await db.update(driftFindings).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(driftFindings.id, id));
  await audit(db, c, 'finding.resolved', `finding:${id}`, { note });
  return c.json({ ok: true });
});

// --- caps and flags ----------------------------------------------------------------------------

adminRoute.get('/caps', async (c) => c.json(await c.get('db').select().from(caps).orderBy(caps.scope, caps.metric)));

const CapBody = z.object({
  scope: z.string().regex(/^(global|user:default|user:[\w-]+|region:[\w-]+)$/, 'scope must be global, user:default, user:<id> or region:<id>'),
  metric: z.string().regex(/^[a-z_0-9]+$/),
  limit: z.number().int().min(0).optional(),
});

adminRoute.put('/caps', async (c) => {
  const db = c.get('db');
  const { scope, metric, limit } = await body(c, CapBody);
  if (limit === undefined) throw problem(400, 'validation_failed', 'limit is required');
  const [before] = await db.select().from(caps).where(and(eq(caps.scope, scope), eq(caps.metric, metric)));
  await db.insert(caps).values({ scope, metric, limit }).onConflictDoUpdate({ target: [caps.scope, caps.metric], set: { limit } });
  await audit(db, c, 'cap.set', `cap:${scope}/${metric}`, { from: before?.limit ?? null, to: limit });
  return c.json({ ok: true });
});

adminRoute.delete('/caps', async (c) => {
  const db = c.get('db');
  const { scope, metric } = await body(c, CapBody);
  await db.delete(caps).where(and(eq(caps.scope, scope), eq(caps.metric, metric)));
  await audit(db, c, 'cap.deleted', `cap:${scope}/${metric}`, {});
  return c.json({ ok: true });
});

/** Operator switches. `creation_freeze` is also tripped by the reconciler's circuit breaker. */
const FLAGS = ['creation_freeze', 'billing_required'] as const;

adminRoute.put('/flags/:key', async (c) => {
  const db = c.get('db');
  const key = c.req.param('key');
  if (!(FLAGS as readonly string[]).includes(key)) throw problem(404, 'not_found');
  const { value, reason } = await body(c, z.object({ value: z.enum(['true', 'false']), reason: z.string().trim().min(3).max(500) }));
  const now = new Date();
  await db
    .insert(controlFlags)
    .values({ key, value, reason, updatedAt: now })
    .onConflictDoUpdate({ target: controlFlags.key, set: { value, reason, updatedAt: now } });
  await audit(db, c, `flag.${key}`, 'global', { value, reason });
  return c.json({ ok: true });
});

// --- users -------------------------------------------------------------------------------------

adminRoute.get('/users', async (c) => {
  const db = c.get('db');
  const q = (c.req.query('q') ?? '').trim().replace(/[%_]/g, '');
  const rows = await db
    .select({ id: user.id, email: user.email, createdAt: user.createdAt })
    .from(user)
    .where(q ? or(like(user.email, `%${q}%`), eq(user.id, q)) : undefined)
    .orderBy(desc(user.createdAt))
    .limit(100);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return c.json([]);
  const counts = await db
    .select({ userId: browserInstances.userId, n: sql<number>`count(*)`, suspended: sql<number>`sum(${browserInstances.suspendedAt} IS NOT NULL)` })
    .from(browserInstances)
    .where(and(inArray(browserInstances.userId, ids), sql`${browserInstances.status} <> 'purged'`))
    .groupBy(browserInstances.userId);
  const subs = await db.select().from(subscriptions).where(inArray(subscriptions.userId, ids));
  const staff = new Set((await db.select().from(admins).where(inArray(admins.userId, ids))).map((a) => a.userId));
  return c.json(
    rows.map((r) => {
      const n = counts.find((x) => x.userId === r.id);
      const s = subs.filter((x) => x.userId === r.id).sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime())[0];
      return {
        ...r,
        browsers: Number(n?.n ?? 0),
        suspended: Number(n?.suspended ?? 0),
        subscription: s ? { plan: s.plan, status: s.status, units: s.units, revoked: !!s.revokedAt } : null,
        admin: staff.has(r.id),
      };
    }),
  );
});

/** Per-user kill switch (page 10): suspends or releases every browser of the user. */
adminRoute.post('/users/:id/actions', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const { action, reason } = await body(c, z.object({ action: z.enum(['suspend', 'unsuspend']), reason: z.string().trim().min(3).max(500) }));
  const now = new Date();
  await db
    .update(browserInstances)
    .set(action === 'suspend' ? { suspendedAt: now, suspendedReason: reason, updatedAt: now } : { suspendedAt: null, suspendedReason: null, updatedAt: now })
    .where(and(eq(browserInstances.userId, id), action === 'suspend' ? isNull(browserInstances.suspendedAt) : isNotNull(browserInstances.suspendedAt)));
  await db.insert(schema.events).values({ userId: id, type: 'instance.updated', data: {}, createdAt: now });
  c.executionCtx.waitUntil(notifyHub(c.env, id));
  await audit(db, c, `user.${action}`, `user:${id}`, { reason });
  return c.json({ ok: true });
});

// --- audit -------------------------------------------------------------------------------------

adminRoute.get('/audit', async (c) => {
  const target = c.req.query('target');
  const actorQ = c.req.query('actor');
  const rows = await c
    .get('db')
    .select()
    .from(auditLog)
    .where(and(target ? eq(auditLog.target, target) : undefined, actorQ ? like(auditLog.actor, `${actorQ}%`) : undefined))
    .orderBy(desc(auditLog.createdAt))
    .limit(200);
  return c.json(rows);
});
