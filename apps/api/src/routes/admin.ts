/**
 * Operator console API (page 10, "Operator console"): `/api/v1/admin/*`. Every route needs the
 * administrator host and a verified, allowlisted Cloudflare Access identity. Every change is
 * written to `audit_log` with the admin's stable Access subject and email. Internal:
 * not part of the public OpenAPI document.
 */
import { OPERATION_STEPS, PROMOTION_ID, PricingSettings, PromotionTaskInput, TRIAL, UsageItem, costRates, customerRates, minimumMarkupPercent, type OperationKind } from '@cloudbrowser/contracts';
import { awsInventory, blocksRegion, launchHealthByRegion, launchHealthFor, launchVerifiedAt, newId, openProviderIssue, priceSheets, pricingSettings, reopenRegion, schema, type Db } from '@cloudbrowser/db';
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { isAdminEmail } from '../admin/access.js';
import { acknowledgeAlert } from '../admin/alerts.js';
import { applyBalance, notifyHub } from '../billing/ledger.js';
import type { AppEnv } from '../env.js';
import { systemOperation } from '../ops.js';
import { pageQuery } from '../paging.js';
import { problem } from '../problem.js';

const {
  user,
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
  billingAccounts,
  balanceTransactions,
  browserReservations,
  usageRecords,
  providerPrices,
  regions,
  pricingSettings: pricingSettingsTable,
  promotionTasks,
  promotionCompletions,
} = schema;

export const adminRoute = new Hono<AppEnv>();
// index.ts applies the Access identity and exact-origin checks before mounting these routes.

async function body<T extends z.ZodType>(c: Context<AppEnv>, schemaT: T): Promise<z.infer<T>> {
  const parsed = schemaT.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw problem(400, 'validation_failed', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}

const actor = (c: Context<AppEnv>) => `admin:${c.get('user').id}`;
const audit = (db: Db, c: Context<AppEnv>, action: string, target: string, detail: Record<string, unknown>) =>
  db.insert(auditLog).values({ actor: actor(c), action, target, detail: { ...detail, email: c.get('user').email, ip: c.req.header('cf-connecting-ip') ?? null }, createdAt: new Date() });

// --- session -----------------------------------------------------------------------------------

adminRoute.get('/session', (c) => c.json({ email: c.get('user').email }));

adminRoute.get('/aws-provider', async (c) => {
  const db=c.get('db');
  const [state]=await db.select().from(schema.awsProviderState);
  const inventory=await awsInventory(db);
  const rows=await db.select().from(schema.awsProviderRegions).innerJoin(regions,eq(regions.id,schema.awsProviderRegions.regionId));
  const sheets=new Map((await db.select().from(providerPrices)).map((r)=>[r.regionId,r]));
  const held=new Map((await db.all<{region_id:string;n:number}>(sql`SELECT region_id, COUNT(*) n FROM aws_browser_commitments GROUP BY region_id`)).map((r)=>[r.region_id,Number(r.n)]));
  const health=await launchHealthByRegion(db);
  const now=new Date();
  const launch=(regionId:string)=>{
    const rows=health.get(regionId) ?? [];
    const issue=openProviderIssue(rows,now);
    return {verifiedAt:launchVerifiedAt(rows),issue:issue?{at:issue.lastFailureAt,class:issue.lastFailureClass,message:issue.lastFailure,zone:issue.zone||null,blocking:blocksRegion(issue)}:null};
  };
  return c.json({state,regions:rows.map((r)=>({...r.aws_provider_regions,name:r.regions.name,enabled:r.regions.enabled,inventory:inventory.get(r.regions.id),held:held.get(r.regions.id) ?? 0,price:{fetchedAt:sheets.get(r.regions.id)?.fetchedAt,lastError:sheets.get(r.regions.id)?.lastError},launch:launch(r.regions.id),config:undefined}))});
});
// After the cause of a provider failure is fixed (e.g. an SCP): new browsers may be created
// there again, and the next create shows whether the fix worked.
adminRoute.post('/aws-provider/regions/:id/reopen',async(c)=>{
  const {reason}=await body(c,z.object({reason:z.string().trim().min(3).max(500)}));
  const db=c.get('db');
  const regionId=c.req.param('id');
  const before=await launchHealthFor(db,regionId);
  if (!openProviderIssue(before,new Date())) throw problem(409,'invalid_state','This region has no open provider failure.');
  await db.batch([reopenRegion(db,regionId),audit(db,c,'aws-provider.region.reopen',`region:${regionId}`,{before,reason})]);
  return c.json({reopened:true});
});
adminRoute.post('/aws-provider/refresh',async(c)=>{
  if (!c.env.AWS_PROVIDER) throw problem(503,'internal','AWS Provider service is not configured.');
  const result=await c.env.AWS_PROVIDER.fetch('https://provider/aws/refresh',{method:'POST'});
  if (!result.ok) throw problem(503,'internal','AWS synchronization could not be queued.');
  await audit(c.get('db'),c,'aws-provider.refresh','aws-provider',{});
  return c.json({queued:true},202);
});

// --- overview ----------------------------------------------------------------------------------

const count = async (db: Db, q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);

adminRoute.get('/overview', async (c) => {
  const db = c.get('db');
  const now = Date.now();
  const byStatus = await db.select({ status: browserInstances.status, n: sql<number>`count(*)` }).from(browserInstances).groupBy(browserInstances.status);
  const flags = await db.select().from(controlFlags);
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
    findingsOpen: await count(db, db.select({ n: sql<number>`count(*)` }).from(driftFindings).where(eq(driftFindings.status, 'open'))),
    alertsOpen: await count(db, db.select({ n: sql<number>`count(*)` }).from(alerts).where(isNull(alerts.acknowledgedAt))),
    webhooksPending: await count(db, db.select({ n: sql<number>`count(*)` }).from(webhookEvents).where(isNull(webhookEvents.processedAt))),
  });
});

// --- alerts ------------------------------------------------------------------------------------

adminRoute.get('/alerts', async (c) => {
  const open = c.req.query('open') !== '0';
  const page = pageQuery(c, 200);
  const rows = await c
    .get('db')
    .select()
    .from(alerts)
    .where(open ? isNull(alerts.acknowledgedAt) : undefined)
    .orderBy(desc(alerts.createdAt), desc(alerts.id))
    .limit(page.limit)
    .offset(page.offset);
  return c.json(rows);
});

adminRoute.post('/alerts/:id/ack', async (c) => {
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const [alert] = Number.isSafeInteger(id) ? await db.select({ id: alerts.id }).from(alerts).where(eq(alerts.id, id)) : [];
  if (!alert) throw problem(404, 'not_found');
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
  const page = pageQuery(c, 100);
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
    .orderBy(desc(operations.createdAt), desc(operations.id))
    .limit(page.limit)
    .offset(page.offset);
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
  const page = pageQuery(c, 100);
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
    .orderBy(desc(browserInstances.updatedAt), desc(browserInstances.id))
    .limit(page.limit)
    .offset(page.offset);
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
        auditDetail: { email: c.get('user').email },
        params: { ...(last.params ?? {}), retryOf: last.id, reason },
      });
      break;
    }
    case 'recover':
      if (!['running', 'sleeping', 'needs_attention', 'waiting_capacity', 'provider_issue'].includes(inst.status)) {
        throw problem(409, 'invalid_state', `Cannot recover a browser that is ${inst.status}.`);
      }
      operationId = await systemOperation(c.env, db, { instanceId: id, userId: inst.userId, kind: 'recover', actor: actor(c), auditDetail: { email: c.get('user').email }, params: { reason: 'operator', note: reason } });
      break;
    case 'stop':
      operationId = await systemOperation(c.env, db, {
        instanceId: id,
        userId: inst.userId,
        kind: 'stop',
        actor: actor(c),
        auditDetail: { email: c.get('user').email },
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
  const page = pageQuery(c, 300);
  const rows = await c
    .get('db')
    .select()
    .from(resources)
    .where(and(state ? eq(resources.state, state) : undefined, kind ? eq(resources.kind, kind) : undefined))
    .orderBy(desc(resources.firstSeenAt), desc(resources.id))
    .limit(page.limit)
    .offset(page.offset);
  return c.json(rows);
});

adminRoute.get('/findings', async (c) => {
  const status = c.req.query('status') ?? 'open';
  const page = pageQuery(c, 200);
  const rows = await c
    .get('db')
    .select()
    .from(driftFindings)
    .where(status === 'all' ? undefined : eq(driftFindings.status, status))
    .orderBy(desc(driftFindings.createdAt), desc(driftFindings.id))
    .limit(page.limit)
    .offset(page.offset);
  return c.json(rows);
});

adminRoute.post('/findings/:id/resolve', async (c) => {
  const db = c.get('db');
  const { note } = await body(c, z.object({ note: z.string().trim().min(3).max(500) }));
  const id = c.req.param('id');
  const [finding] = await db.select({ id: driftFindings.id }).from(driftFindings).where(eq(driftFindings.id, id));
  if (!finding) throw problem(404, 'not_found');
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
  if (metric === 'creates_per_day') throw problem(400, 'validation_failed', 'Daily creation limits are no longer supported. Set the instances limit instead.');
  if (limit === undefined) throw problem(400, 'validation_failed', 'limit is required');
  if (metric === 'running' && scope.startsWith('user:')) throw problem(400, 'validation_failed', 'Users have one limit: instances. Every browser they own may run at once.');
  if (metric === 'never_sleep' && (!scope.startsWith('user:') || limit > 1)) throw problem(400, 'validation_failed', 'never_sleep is a switch for user:default or user:<id>: 1 offers Never sleep, 0 does not.');
  if (metric === 'trial_minutes' && (scope !== 'user:default' || limit < 1 || limit > TRIAL.maxMinutes)) throw problem(400, 'validation_failed', `trial_minutes is set for user:default only, from 1 to ${TRIAL.maxMinutes} minutes.`);
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
const FLAGS = ['creation_freeze', 'billing_required', 'invite_only'] as const;

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
  const page = pageQuery(c, 100);
  const rows = await db
    .select({ id: user.id, email: user.email, createdAt: user.createdAt, twoFactorEnabled: user.twoFactorEnabled })
    .from(user)
    .where(q ? or(like(user.email, `%${q}%`), eq(user.id, q)) : undefined)
    .orderBy(desc(user.createdAt), desc(user.id))
    .limit(page.limit)
    .offset(page.offset);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return c.json([]);
  const counts = await db
    .select({ userId: browserInstances.userId, n: sql<number>`count(*)`, suspended: sql<number>`sum(${browserInstances.suspendedAt} IS NOT NULL)` })
    .from(browserInstances)
    .where(and(inArray(browserInstances.userId, ids), sql`${browserInstances.status} <> 'purged'`))
    .groupBy(browserInstances.userId);
  const accounts = await db.select().from(billingAccounts).where(inArray(billingAccounts.userId, ids));
  const held = await db
    .select({ userId: browserReservations.userId, micros: sql<number>`coalesce(sum(${browserReservations.reservedMicros}), 0)` })
    .from(browserReservations)
    .where(inArray(browserReservations.userId, ids))
    .groupBy(browserReservations.userId);
  return c.json(
    rows.map((r) => {
      const n = counts.find((x) => x.userId === r.id);
      const a = accounts.find((x) => x.userId === r.id);
      // The same split as the user's own Billing page: the total includes the held deposits.
      const balanceMicros = a?.balanceMicros ?? 0;
      const reservedMicros = Number(held.find((x) => x.userId === r.id)?.micros ?? 0);
      return {
        ...r,
        browsers: Number(n?.n ?? 0),
        suspended: Number(n?.suspended ?? 0),
        balanceMicros,
        reservedMicros,
        availableMicros: Math.max(0, balanceMicros - reservedMicros),
        exhaustedAt: a?.exhaustedAt ?? null,
        frozenAt: a?.frozenAt ?? null,
        admin: isAdminEmail(c.env, r.email),
      };
    }),
  );
});

/** Per-user kill switch (page 10): suspends or releases every browser of the user. */
adminRoute.post('/users/:id/actions', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const { action, reason } = await body(c, z.object({ action: z.enum(['suspend', 'unsuspend']), reason: z.string().trim().min(3).max(500) }));
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!u) throw problem(404, 'not_found');
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

/** Operator credit or debit on a user's balance (goodwill, pilot credit, correction). */
adminRoute.post('/users/:id/credit', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const { amountMicros, reason } = await body(
    c,
    z.object({ amountMicros: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine((v) => v !== 0, 'must not be 0'), reason: z.string().trim().min(3).max(500) }),
  );
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!u) throw problem(404, 'not_found');
  const now = new Date();
  await applyBalance(db, { userId: id, kind: 'adjustment', amountMicros, reference: `adjustment:${newId(now.getTime())}`, description: reason, actor: actor(c) }, now);
  await audit(db, c, 'user.credit', `user:${id}`, { amountMicros, reason });
  c.executionCtx.waitUntil(notifyHub(c.env, id));
  return c.json({ ok: true });
});

/**
 * Turns off a user's two-factor sign-in after they lost their authenticator and backup codes.
 * Verify their identity out of band first; their next sign-in needs only the email code.
 */
adminRoute.post('/users/:id/reset-two-factor', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const { reason } = await body(c, z.object({ reason: z.string().trim().min(3).max(500) }));
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!u) throw problem(404, 'not_found');
  await db.batch([
    db.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, id)),
    db.update(user).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(user.id, id)),
  ]);
  await audit(db, c, 'user.reset_two_factor', `user:${id}`, { reason });
  return c.json({ ok: true });
});

/** Lifts the hold placed on an account by a payment dispute. */
adminRoute.post('/users/:id/unfreeze', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const { reason } = await body(c, z.object({ reason: z.string().trim().min(3).max(500) }));
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!u) throw problem(404, 'not_found');
  await db.update(billingAccounts).set({ frozenAt: null, frozenReason: null, updatedAt: new Date() }).where(eq(billingAccounts.userId, id));
  await audit(db, c, 'user.unfreeze', `user:${id}`, { reason });
  c.executionCtx.waitUntil(notifyHub(c.env, id));
  return c.json({ ok: true });
});

// --- pricing and margin (page 6) ---------------------------------------------------------------

/** Prices per region (AWS cost and customer price), the markup settings and this month's margin. */
adminRoute.get('/pricing', async (c) => {
  const db = c.get('db');
  const settings = await pricingSettings(db);
  const sheets = await priceSheets(db);
  const stored = await db.select().from(providerPrices);
  const regionRows = await db.select().from(regions);
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const usageRows = await db
    .select({ item: usageRecords.item, amount: sql<number>`sum(${usageRecords.chargedMicros})`, cost: sql<number>`sum(${usageRecords.costMicros})` })
    .from(usageRecords)
    .where(like(usageRecords.day, `${month}-%`))
    .groupBy(usageRecords.item);
  const tx = await db
    .select({
      kind: balanceTransactions.kind,
      n: sql<number>`count(*)`,
      amount: sql<number>`sum(${balanceTransactions.amountMicros})`,
      grossCents: sql<number>`coalesce(sum(${balanceTransactions.grossAmountCents}), 0)`,
    })
    .from(balanceTransactions)
    .where(gte(balanceTransactions.createdAt, monthStart))
    .groupBy(balanceTransactions.kind);
  const [balances] = await db
    .select({ total: sql<number>`coalesce(sum(${billingAccounts.balanceMicros}), 0)`, negative: sql<number>`coalesce(sum(min(${billingAccounts.balanceMicros}, 0)), 0)` })
    .from(billingAccounts);
  const [spend] = await db.select().from(spendSnapshots).orderBy(desc(spendSnapshots.takenAt)).limit(1);
  const byItem = Object.fromEntries(
    UsageItem.options.map((i) => {
      const r = usageRows.find((x) => x.item === i);
      return [i, { revenueMicros: Number(r?.amount ?? 0), costMicros: Number(r?.cost ?? 0) }];
    }),
  );
  const revenueMicros = usageRows.reduce((a, r) => a + Number(r.amount ?? 0), 0);
  const costMicros = usageRows.reduce((a, r) => a + Number(r.cost ?? 0), 0);
  const topups = tx.find((t) => t.kind === 'topup');
  const topupMicros = Number(topups?.amount ?? 0);
  // The payment provider takes its fee from what the customer paid, tax included, not from the
  // credit (which excludes tax). Credits granted by operators have no gross amount and no fee.
  // One cent is 10,000 micro-dollars, so cents × basis points is already micro-dollars.
  const grossCents = Number(topups?.grossCents ?? 0);
  const feesMicros = Math.round(grossCents * settings.paymentFeeBps) + Number(topups?.n ?? 0) * settings.paymentFeeFixedCents * 10_000;
  return c.json({
    settings,
    regions: regionRows.map((r) => {
      const s = sheets.get(r.id);
      const row = stored.find((x) => x.regionId === r.id);
      return {
        regionId: r.id,
        name: r.name,
        enabled: r.enabled,
        executor: r.executor,
        providerRegion: r.providerRegion,
        sheet: s?.sheet ?? null,
        fetchedAt: row?.fetchedAt ?? null,
        lastError: row?.lastError ?? null,
        lastErrorAt: row?.lastErrorAt ?? null,
        cost: s ? costRates(s.sheet, settings.relayGbMicros) : null,
        price: s ? customerRates(s.sheet, settings) : null,
      };
    }),
    month: {
      month,
      revenueMicros,
      costMicros,
      grossMarginMicros: revenueMicros - costMicros,
      byItem,
      topupMicros,
      topupGrossMicros: grossCents * 10_000,
      topups: Number(topups?.n ?? 0),
      refundMicros: -Number(tx.find((t) => t.kind === 'refund')?.amount ?? 0) - Number(tx.find((t) => t.kind === 'dispute')?.amount ?? 0),
      creditMicros: Number(tx.find((t) => t.kind === 'adjustment')?.amount ?? 0) + Number(tx.find((t) => t.kind === 'promotion')?.amount ?? 0),
      estimatedFeesMicros: feesMicros,
      // AWS's own view of the month (ledger + running VMs, by the reconciler): includes what is not
      // billed to anyone (creating, deleted and failed browsers, old IPs, recover snapshots).
      projectedAwsCents: spend?.month === month ? spend.projectedCents : null,
    },
    balances: { totalMicros: Number(balances?.total ?? 0), negativeMicros: Number(balances?.negative ?? 0) },
  });
});

adminRoute.put('/pricing/settings', async (c) => {
  const db = c.get('db');
  const { reason, ...next } = await body(c, PricingSettings.extend({ reason: z.string().trim().min(3).max(500) }));
  // The payment provider keeps its percentage of every top-up: a markup below this sells below cost.
  const floor = minimumMarkupPercent(next.paymentFeeBps);
  for (const [field, value] of [['markupPercent', next.markupPercent], ['fixedMarkupPercent', next.fixedMarkupPercent], ['transferMarkupPercent', next.transferMarkupPercent]] as const) {
    if (value < floor) throw problem(400, 'validation_failed', `${field} must be at least ${floor}: below that, the ${next.paymentFeeBps / 100}% payment fee makes it cost more than it earns.`);
  }
  const before = await pricingSettings(db);
  const now = new Date();
  const values = { ...next, updatedAt: now, updatedBy: c.get('user').email };
  await db.insert(pricingSettingsTable).values({ id: 1, ...values }).onConflictDoUpdate({ target: pricingSettingsTable.id, set: values });
  await audit(db, c, 'pricing.settings', 'global', { before, after: next, reason });
  return c.json({ ok: true });
});

/** Reads every region's prices from AWS now (the engine otherwise refreshes them every 12 hours). */
adminRoute.post('/pricing/refresh', async (c) => {
  const res = await c.env.ENGINE.fetch('https://engine/prices/refresh', { method: 'POST' });
  if (!res.ok) throw problem(503, 'internal', 'The engine could not refresh prices.');
  const out = await res.json();
  await audit(c.get('db'), c, 'pricing.refresh', 'global', { result: out as Record<string, unknown> });
  return c.json(out);
});

// --- promotions --------------------------------------------------------------------------------

/** Every task with how many accounts finished it and what it has paid out. */
adminRoute.get('/promotions', async (c) => {
  const db = c.get('db');
  const tasks = await db.select().from(promotionTasks).orderBy(promotionTasks.sortOrder, promotionTasks.createdAt);
  const stats = new Map((await db.all<{ task_id: string; n: number; credited: number; micros: number }>(sql`SELECT task_id, count(*) AS n,
    sum(credited_at IS NOT NULL) AS credited, sum(CASE WHEN credited_at IS NOT NULL THEN reward_micros ELSE 0 END) AS micros
    FROM promotion_completions GROUP BY task_id`)).map((r) => [r.task_id, r]));
  return c.json(tasks.map((t) => {
    const s = stats.get(t.id);
    return { ...t, completions: Number(s?.n ?? 0), credited: Number(s?.credited ?? 0), paidMicros: Number(s?.micros ?? 0) };
  }));
});

/** Creates or replaces a task. Changing the reward or target affects completions from now on only. */
adminRoute.put('/promotions/:id', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  if (!PROMOTION_ID.test(id)) throw problem(400, 'validation_failed', 'id: use 2–63 lowercase letters, digits and dashes.');
  const { reason, ...next } = await body(c, PromotionTaskInput.extend({ reason: z.string().trim().min(3).max(500) }));
  const startsAt = next.startsAt ? new Date(next.startsAt) : null;
  const endsAt = next.endsAt ? new Date(next.endsAt) : null;
  if (startsAt && endsAt && endsAt <= startsAt) throw problem(400, 'validation_failed', 'endsAt: must be after startsAt.');
  if (next.criterion === 'two_factor_enabled' && next.target !== 1) throw problem(400, 'validation_failed', 'target: two_factor_enabled is done or not, so its target is 1.');
  const [before] = await db.select().from(promotionTasks).where(eq(promotionTasks.id, id));
  const now = new Date();
  const values = { ...next, startsAt, endsAt, updatedAt: now, updatedBy: c.get('user').email };
  await db.insert(promotionTasks).values({ id, ...values, createdAt: now }).onConflictDoUpdate({ target: promotionTasks.id, set: values });
  await audit(db, c, before ? 'promotion.update' : 'promotion.create', `promotion:${id}`, { before: before ?? null, after: next, reason });
  return c.json({ ok: true });
});

/** Only a task nobody has completed can be deleted; otherwise turn it off (its history stays). */
adminRoute.delete('/promotions/:id', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const { reason } = await body(c, z.object({ reason: z.string().trim().min(3).max(500) }));
  const [before] = await db.select().from(promotionTasks).where(eq(promotionTasks.id, id));
  if (!before) throw problem(404, 'not_found');
  const [done] = await db.select({ id: promotionCompletions.userId }).from(promotionCompletions).where(eq(promotionCompletions.taskId, id)).limit(1);
  if (done) throw problem(409, 'invalid_state', 'Accounts have completed this task. Turn it off instead, so its rewards stay on record.');
  await db.batch([db.delete(promotionTasks).where(eq(promotionTasks.id, id)), audit(db, c, 'promotion.delete', `promotion:${id}`, { before, reason })]);
  return c.json({ ok: true });
});

/** Who completed a task, newest first (paged). */
adminRoute.get('/promotions/:id/completions', async (c) => {
  const page = pageQuery(c, 100);
  const rows = await c.get('db')
    .select({ userId: promotionCompletions.userId, email: user.email, progress: promotionCompletions.progress, rewardMicros: promotionCompletions.rewardMicros,
      completedAt: promotionCompletions.completedAt, creditedAt: promotionCompletions.creditedAt })
    .from(promotionCompletions)
    .leftJoin(user, eq(user.id, promotionCompletions.userId))
    .where(eq(promotionCompletions.taskId, c.req.param('id')))
    .orderBy(desc(promotionCompletions.completedAt))
    .limit(page.limit)
    .offset(page.offset);
  return c.json(rows);
});

// --- audit -------------------------------------------------------------------------------------

adminRoute.get('/audit', async (c) => {
  const target = c.req.query('target');
  const actorQ = c.req.query('actor');
  const page = pageQuery(c, 200);
  const rows = await c
    .get('db')
    .select()
    .from(auditLog)
    .where(and(target ? eq(auditLog.target, target) : undefined, actorQ ? like(auditLog.actor, `${actorQ.replace(/[%_]/g, '')}%`) : undefined))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(page.limit)
    .offset(page.offset);
  return c.json(rows);
});
