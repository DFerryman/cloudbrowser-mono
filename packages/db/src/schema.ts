/**
 * Single schema authority (page 2, "Data model").
 *
 * The plan targets PostgreSQL; this initial version runs on Cloudflare D1 (SQLite). Column ownership
 * is the same as in the plan and is noted per table. D1 has no per-service roles, so ownership is
 * enforced by code review and by each Worker only importing the repository functions it owns.
 */
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

// ---------------------------------------------------------------------------------------------
// Better Auth tables (owner: api). Field names follow Better Auth's core schema.
// ---------------------------------------------------------------------------------------------

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: ts('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** Better Auth passkey plugin (WebAuthn credentials). `publicKey` is the COSE key, base64. Owner: api. */
export const passkey = sqliteTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
    transports: text('transports'),
    createdAt: ts('created_at'),
    aaguid: text('aaguid'),
  },
  (t) => [index('passkey_user_idx').on(t.userId), index('passkey_credential_idx').on(t.credentialID)],
);

/** Pilot accounts are invite-only (page 12). Owner: operators (SQL), read by api. */
export const invites = sqliteTable('invites', {
  email: text('email').primaryKey(),
  note: text('note'),
  createdAt: ts('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// ---------------------------------------------------------------------------------------------
// Product tables
// ---------------------------------------------------------------------------------------------

/** Owner: migrations; operators. */
export const regions = sqliteTable('regions', {
  id: text('id').primaryKey(), // tyo1, usw1
  name: text('name').notNull(),
  country: text('country').notNull(),
  city: text('city').notNull(),
  timezone: text('timezone').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  executor: text('executor').notNull(), // fake | aws-ec2 | oci-compute | fly-machines
  providerRegion: text('provider_region').notNull(),
  probeUrl: text('probe_url'),
});

export type Fingerprint = {
  timezone: string;
  locale: string;
  screen: string;
  chromeMajor: number | null;
};

/**
 * Owner: api writes name, settings and desired_state; engine writes status and observed fields.
 * `region_id` never changes (enforced by a trigger in the migrations).
 */
export const browserInstances = sqliteTable(
  'browser_instances',
  {
    id: text('id').primaryKey(), // ULID
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    name: text('name').notNull(),
    regionId: text('region_id')
      .notNull()
      .references(() => regions.id),
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    desiredState: text('desired_state').notNull(),
    idleTimeoutS: integer('idle_timeout_s').notNull(),
    locale: text('locale').notNull(),
    screen: text('screen').notNull(),
    fingerprint: json<Fingerprint>('fingerprint').notNull(),
    lastActiveAt: ts('last_active_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    deletedAt: ts('deleted_at'),
    purgeAfter: ts('purge_after'),
    /** Operator kill switch (abuse, page 10): the browser sleeps and cannot start. Owner: api (admin). */
    suspendedAt: ts('suspended_at'),
    suspendedReason: text('suspended_reason'),
  },
  (t) => [index('instances_user_idx').on(t.userId), index('instances_status_idx').on(t.status)],
);

/** Owner: engine. A new generation is created only by `recover` or `restore`. */
export const placements = sqliteTable(
  'placements',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => browserInstances.id),
    generation: integer('generation').notNull(),
    executor: text('executor').notNull(),
    providerRegion: text('provider_region').notNull(),
    zone: text('zone'),
    vmId: text('vm_id'),
    volumeId: text('volume_id'),
    networkId: text('network_id'),
    ipAllocationId: text('ip_allocation_id'),
    ipAddress: text('ip_address'),
    status: text('status').notNull(), // building | current | superseded
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('placements_instance_gen_idx').on(t.instanceId, t.generation)],
);

/** The ledger of every billable provider resource (page 10). Owner: engine; reaper closes rows. */
export const resources = sqliteTable(
  'resources',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id').references(() => browserInstances.id),
    kind: text('kind').notNull(), // vm | volume | network_interface | ip | snapshot
    executor: text('executor').notNull(),
    providerId: text('provider_id'),
    /** Only for kind `ip`: the public address. */
    address: text('address'),
    region: text('region').notNull(),
    zone: text('zone'),
    createdByOp: text('created_by_op'),
    requestToken: text('request_token').notNull(),
    state: text('state').notNull(), // pending | active | superseded | rejected | deleting | deleted
    tags: json<Record<string, string>>('tags').notNull(),
    monthlyCostEstimate: integer('monthly_cost_estimate_cents').notNull().default(0),
    releaseAfter: ts('release_after'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('resources_token_idx').on(t.requestToken),
    index('resources_instance_idx').on(t.instanceId),
    index('resources_state_idx').on(t.state),
  ],
);

/** Permanent IP history: an address that was ever ours is never given to a different instance. Owner: engine. */
export const ipAddresses = sqliteTable('ip_addresses', {
  address: text('address').primaryKey(),
  executor: text('executor').notNull(),
  regionId: text('region_id').notNull(),
  instanceId: text('instance_id').notNull(),
  assignedAt: ts('assigned_at'),
  releasedAt: ts('released_at'),
});

/**
 * Owner: api inserts; engine updates progress. At most one unfinished operation per instance
 * (partial unique index below).
 */
export const operations = sqliteTable(
  'operations',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => browserInstances.id),
    userId: text('user_id'),
    kind: text('kind').notNull(),
    status: text('status').notNull(), // queued | running | waiting | succeeded | failed | canceled
    step: text('step'),
    attempt: integer('attempt').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    notBefore: ts('not_before'),
    deadlineAt: ts('deadline_at').notNull(),
    errorClass: text('error_class'),
    error: text('error'),
    params: json<Record<string, unknown>>('params'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    uniqueIndex('operations_one_unfinished_idx')
      .on(t.instanceId)
      .where(sql`finished_at IS NULL`),
    index('operations_pending_idx').on(t.finishedAt, t.notBefore),
  ],
);

/** Write-ahead step journal (page 10). Owner: engine. */
export const operationSteps = sqliteTable(
  'operation_steps',
  {
    operationId: text('operation_id')
      .notNull()
      .references(() => operations.id),
    step: text('step').notNull(),
    status: text('status').notNull(), // started | succeeded | failed
    requestToken: text('request_token').notNull(),
    result: json<Record<string, unknown>>('result'),
    attempts: integer('attempts').notNull().default(0),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.operationId, t.step] })],
);

/** One operation per (user, Idempotency-Key) for 24 h. Owner: api. */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    route: text('route').notNull(),
    operationId: text('operation_id').notNull(),
    instanceId: text('instance_id').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/**
 * All limits (page 10, "Limits"). scope is `user:default`, `user:<id>`, `region:<id>` or `global`.
 * Owner: api (from entitlements) and operators.
 */
export const caps = sqliteTable(
  'caps',
  {
    scope: text('scope').notNull(),
    metric: text('metric').notNull(),
    limit: integer('limit').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.metric] })],
);

/** Operator switches, e.g. `creation_freeze`. Owner: reconciler (trips) and operators (clear). */
export const controlFlags = sqliteTable('control_flags', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  reason: text('reason'),
  updatedAt: ts('updated_at').notNull(),
});

/** Owner: reconciler. */
export const quotaSnapshots = sqliteTable('quota_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  executor: text('executor').notNull(),
  region: text('region').notNull(),
  metric: text('metric').notNull(),
  limit: integer('limit').notNull(),
  used: integer('used').notNull(),
  takenAt: ts('taken_at').notNull(),
});

/** Owner: reconciler. Amounts in US cents. */
export const spendSnapshots = sqliteTable('spend_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  month: text('month').notNull(), // YYYY-MM
  activeMonthlyCents: integer('active_monthly_cents').notNull(),
  runningHoursCents: integer('running_hours_cents').notNull(),
  projectedCents: integer('projected_cents').notNull(),
  takenAt: ts('taken_at').notNull(),
});

/** Owner: reconciler. */
export const driftFindings = sqliteTable(
  'drift_findings',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // orphan | missing | adopted | untagged
    executor: text('executor').notNull(),
    region: text('region').notNull(),
    providerId: text('provider_id').notNull(),
    resourceKind: text('resource_kind'),
    instanceId: text('instance_id'),
    status: text('status').notNull(), // open | resolved
    detail: text('detail'),
    createdAt: ts('created_at').notNull(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [index('drift_open_idx').on(t.status, t.providerId)],
);

/** Agent and viewer reports. Owner: api. */
export const instanceHealth = sqliteTable('instance_health', {
  instanceId: text('instance_id')
    .primaryKey()
    .references(() => browserInstances.id),
  lastHeartbeatAt: ts('last_heartbeat_at'),
  viewers: integer('viewers').notNull().default(0),
  lastInputAt: ts('last_input_at'),
  lastIpCheck: json<{
    ok: boolean;
    expected: string | null;
    observed: string[];
    checkedAt: string;
    detail?: string;
  }>('last_ip_check'),
  /** Placement generation of the agent that last reported `ready`, and when. */
  agentReadyGeneration: integer('agent_ready_generation'),
  agentReadyAt: ts('agent_ready_at'),
  /** Highest Chrome major version that opened this profile (never downgrade, page 4). */
  chromeMajor: integer('chrome_major'),
  /** Last time the engine counted this browser's running minutes (page 6, active hours). */
  meteredAt: ts('metered_at'),
});

/**
 * Each VM's identity for the gateway (page 2). The engine issues a single-use bootstrap token
 * (15 min, in the VM's user data); the api swaps it for a long-lived credential on first connect.
 * Only hashes are stored. Owner: engine (bootstrap), api (activation and rotation).
 */
export const agentCredentials = sqliteTable('agent_credentials', {
  instanceId: text('instance_id')
    .primaryKey()
    .references(() => browserInstances.id),
  generation: integer('generation').notNull(),
  bootstrapHash: text('bootstrap_hash'),
  bootstrapExpiresAt: ts('bootstrap_expires_at'),
  credentialHash: text('credential_hash'),
  createdAt: ts('created_at').notNull(),
  activatedAt: ts('activated_at'),
  rotatedAt: ts('rotated_at'),
});

/**
 * Durable commands to agents. The engine creates them and pokes the gateway through the
 * `cloudbrowser-agent-commands` queue; the gateway delivers pending ones whenever the agent is
 * connected; the api records replies. Owner: engine (create), gateway (delivered_at), api (reply).
 */
export const agentCommands = sqliteTable(
  'agent_commands',
  {
    /** Deterministic: `<operation id>:<step>:<round>`, so a retried step finds its command. */
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => browserInstances.id),
    kind: text('kind').notNull(),
    payload: json<Record<string, unknown>>('payload').notNull(),
    status: text('status').notNull(), // pending | delivered | succeeded | failed
    reply: json<Record<string, unknown>>('reply'),
    createdAt: ts('created_at').notNull(),
    deliveredAt: ts('delivered_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [index('agent_commands_pending_idx').on(t.instanceId, t.status)],
);

/** Redeemed viewer token ids: each 60 s token works once (page 2). Owner: api; pruned by the reaper. */
export const viewerTokens = sqliteTable('viewer_tokens', {
  jti: text('jti').primaryKey(),
  sessionId: text('session_id').notNull(),
  redeemedAt: ts('redeemed_at').notNull(),
});

/** Owner: api. */
export const viewerSessions = sqliteTable(
  'viewer_sessions',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => browserInstances.id),
    userId: text('user_id').notNull(),
    startedAt: ts('started_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    endedAt: ts('ended_at'),
    country: text('country'),
    userAgent: text('user_agent'),
  },
  (t) => [index('viewer_sessions_instance_idx').on(t.instanceId, t.lastSeenAt)],
);

/**
 * Change feed for SSE (stands in for PostgreSQL LISTEN/NOTIFY). Writers append; the api's
 * /v1/events stream reads rows after the client's Last-Event-ID. Pruned after 24 h by the reaper.
 */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    type: text('type').notNull(),
    data: json<Record<string, unknown>>('data').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('events_user_idx').on(t.userId, t.id)],
);

/** Owner: api (user and admin actions); engine appends operation outcomes. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actor: text('actor').notNull(), // user:<id> | engine | reaper | reconciler
    action: text('action').notNull(),
    target: text('target').notNull(),
    detail: json<Record<string, unknown>>('detail'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('audit_target_idx').on(t.target)],
);

// ---------------------------------------------------------------------------------------------
// Fake provider state. This is the *provider side* of the `fake` executor (what AWS would hold),
// not part of our data model; it only lives in this database so the fake survives between
// Worker invocations. Only packages/executors touches it.
// ---------------------------------------------------------------------------------------------

export const fakeProviderResources = sqliteTable(
  'fake_provider_resources',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    region: text('region').notNull(),
    zone: text('zone'),
    clientToken: text('client_token'),
    state: text('state').notNull(),
    attrs: json<Record<string, unknown>>('attrs').notNull(),
    tags: json<Record<string, string>>('tags').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('fake_token_idx').on(t.clientToken), index('fake_region_idx').on(t.region)],
);

/**
 * Provider snapshots and R2 archives (page 4). Owner: engine; the reaper marks expired ones deleted.
 * `location` is the snapshot id for snapshots and the R2 object key for archives.
 */
export const backups = sqliteTable(
  'backups',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => browserInstances.id),
    kind: text('kind').notNull(), // snapshot | archive
    reason: text('reason').notNull(), // daily | sleep | manual | recover | pre_upgrade
    status: text('status').notNull(), // pending | complete | failed | deleted
    location: text('location'),
    sizeBytes: integer('size_bytes'),
    generation: integer('generation').notNull(),
    createdAt: ts('created_at').notNull(),
    completedAt: ts('completed_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('backups_instance_idx').on(t.instanceId, t.createdAt)],
);

/**
 * One archive key per instance, wrapped with the master key (Worker secret ARCHIVE_MASTER_KEY,
 * standing in for KMS). Destroying it on purge makes every archive of the instance unreadable.
 * Owner: engine. The api unwraps it only to hand it to the agent inside a command, never stored.
 */
export const archiveKeys = sqliteTable('archive_keys', {
  instanceId: text('instance_id')
    .primaryKey()
    .references(() => browserInstances.id),
  wrappedKey: text('wrapped_key'),
  createdAt: ts('created_at').notNull(),
  destroyedAt: ts('destroyed_at'),
});

// ---------------------------------------------------------------------------------------------
// Billing (page 6). Creem is the source of truth; these are mirrors re-synced on every webhook.
// Owner: api.
// ---------------------------------------------------------------------------------------------

/** The Creem customer of each user, linked on `checkout.completed`. */
export const billingCustomers = sqliteTable('billing_customers', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id),
  creemCustomerId: text('creem_customer_id').notNull().unique(),
  createdAt: ts('created_at').notNull(),
});

/** Mirror of a Creem subscription, refreshed from the Creem API (never from a webhook body alone). */
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: text('id').primaryKey(), // Creem subscription id
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    plan: text('plan').notNull(), // PlanKey
    productId: text('product_id').notNull(),
    /** The subscription item carrying the units (browsers) of a seat-based product. */
    itemId: text('item_id'),
    units: integer('units').notNull().default(1),
    status: text('status').notNull(),
    currentPeriodEnd: ts('current_period_end'),
    /** First time we saw `past_due`/`unpaid`; the 7-day grace period runs from here. */
    pastDueSince: ts('past_due_since'),
    /** When access ended (expired, paused, refunded, or period end after cancel). Data is kept 30 days. */
    accessEndedAt: ts('access_ended_at'),
    /** Set by us on a full refund or a dispute: no access whatever Creem's status says. */
    revokedAt: ts('revoked_at'),
    revokedReason: text('revoked_reason'),
    syncedAt: ts('synced_at').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('subscriptions_user_idx').on(t.userId)],
);

/** Every Creem webhook, keyed by its event id: duplicates are ignored (page 6). */
export const webhookEvents = sqliteTable('webhook_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: json<Record<string, unknown>>('payload').notNull(),
  receivedAt: ts('received_at').notNull(),
  processedAt: ts('processed_at'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
});

/** One row per checkout we start; its id is Creem's `request_id`, echoed back for correlation. */
export const checkoutAttempts = sqliteTable('checkout_attempts', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  plan: text('plan').notNull(),
  browsers: integer('browsers').notNull(),
  checkoutId: text('checkout_id'),
  createdAt: ts('created_at').notNull(),
});

/**
 * Active (running) time per user and calendar month (UTC), metered by the engine every minute.
 * `exhaustedAt` is set when the plan's hours run out: running browsers sleep 10 minutes later.
 * Owner: engine.
 */
export const activeUsage = sqliteTable(
  'active_usage',
  {
    userId: text('user_id').notNull(),
    month: text('month').notNull(), // YYYY-MM
    seconds: integer('seconds').notNull().default(0),
    exhaustedAt: ts('exhausted_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.month] })],
);

// ---------------------------------------------------------------------------------------------
// Operator console (page 10). Owner: api (admin endpoints); alerts are raised by every Worker.
// ---------------------------------------------------------------------------------------------

/** Staff with access to /admin. Granted with SQL only (docs/deploy-cloudflare.md). */
export const admins = sqliteTable('admins', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  note: text('note'),
  createdAt: ts('created_at').notNull(),
});

/**
 * A passkey step-up for one sign-in session: admin endpoints need one from the last 15 minutes.
 * The challenge is stored until it is used once.
 */
export const adminStepUps = sqliteTable('admin_step_ups', {
  sessionId: text('session_id').primaryKey(),
  userId: text('user_id').notNull(),
  challenge: text('challenge'),
  challengeExpiresAt: ts('challenge_expires_at'),
  verifiedAt: ts('verified_at'),
});

/**
 * Alerts for operators (page 7, page 10): any Worker inserts a row; the api's cron sends new ones
 * to the alert email and chat webhook, and the console lists them until acknowledged.
 */
export const alerts = sqliteTable(
  'alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(), // api | engine | reaper | reconciler | billing
    severity: text('severity').notNull(), // critical | warning | info
    title: text('title').notNull(),
    detail: json<Record<string, unknown>>('detail'),
    /** Same key while unacknowledged = one alert (e.g. `freeze:circuit_breaker`). */
    dedupeKey: text('dedupe_key'),
    createdAt: ts('created_at').notNull(),
    sentAt: ts('sent_at'),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by'),
  },
  (t) => [index('alerts_open_idx').on(t.acknowledgedAt, t.createdAt)],
);
