/**
 * Single schema authority (page 2, "Data model").
 *
 * The plan targets PostgreSQL; this initial version runs on Cloudflare D1 (SQLite). Column ownership
 * is the same as in the plan and is noted per table. D1 has no per-service roles, so ownership is
 * enforced by code review and by each Worker only importing the repository functions it owns.
 */
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  /** Better Auth two-factor plugin: set once an authenticator app code has been confirmed. */
  twoFactorEnabled: integer('two_factor_enabled', { mode: 'boolean' }).notNull().default(false),
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

/**
 * Better Auth two-factor plugin (TOTP authenticator apps). The secret and the backup codes are
 * encrypted with BETTER_AUTH_SECRET; `verified` is false until the first code is confirmed.
 * Failed codes count towards a temporary account lock. Owner: api.
 */
export const twoFactor = sqliteTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: integer('verified', { mode: 'boolean' }).notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
  },
  (t) => [uniqueIndex('two_factor_user_idx').on(t.userId)],
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
  id: text('id').primaryKey(), // syd1, tyo1, usw1
  name: text('name').notNull(),
  country: text('country').notNull(),
  city: text('city').notNull(),
  timezone: text('timezone').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  executor: text('executor').notNull(), // aws-ec2 | fake (the simulator)
  providerRegion: text('provider_region').notNull(),
  probeUrl: text('probe_url'),
});

export type Fingerprint = {
  timezone: string;
  /** Older rows only: the removed per-browser language setting. */
  locale?: string;
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
    /** Set by the reaper only after failed-create resources are confirmed absent. */
    providerReleasedAt: ts('provider_released_at'),
    desiredState: text('desired_state').notNull(),
    idleTimeoutS: integer('idle_timeout_s').notNull(),
    // The per-browser language setting was removed; Chrome uses its default (English). Older API
    // versions still write this column, so it stays until they can no longer be rolled back to.
    locale: text('locale').notNull().default('en-US'),
    screen: text('screen').notNull(),
    // The per-browser picture setting was removed; the live view adapts to the connection.
    // Older API versions still read and write these columns, so they stay for the same reason.
    videoQuality: text('video_quality').notNull().default('full'),
    videoAuto: integer('video_auto', { mode: 'boolean' }).notNull().default(true),
    fingerprint: json<Fingerprint>('fingerprint').notNull(),
    lastActiveAt: ts('last_active_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    deletedAt: ts('deleted_at'),
    purgeAfter: ts('purge_after'),
    /** Operator kill switch (abuse, page 10): the browser sleeps and cannot start. Owner: api (admin). */
    suspendedAt: ts('suspended_at'),
    suspendedReason: text('suspended_reason'),
    /** Data volume size in GB. Owner: engine (set by create and resize_volume). */
    storageGb: integer('storage_gb').notNull().default(10),
    /** Daily snapshots of the data volume (billed). Owner: api; off for new browsers. */
    backupsEnabled: integer('backups_enabled', { mode: 'boolean' }).notNull().default(false),
    /** Machine tier (contracts TIERS): basic | premium. Set at creation, never changes (trigger). */
    tier: text('tier').notNull().default('basic'),
    /** Whether paired coding agents may connect (docs/agent-access.md). Owner: api. */
    agentAccess: integer('agent_access', { mode: 'boolean' }).notNull().default(true),
    /** agent | user | privacy: who may drive the browser. Owner: api (user choices), VM via api (takeovers). */
    agentControl: text('agent_control').notNull().default('agent'),
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
    /** Observed provider type, independent of the default used for future browsers. */
    instanceType: text('instance_type'),
    /** Actual root disk size of this VM; existing deployments used 16 GB. */
    rootVolumeGb: integer('root_volume_gb').notNull().default(16),
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
  /** Last time the engine billed this browser's running minutes (page 6). Null while not running. */
  meteredAt: ts('metered_at'),
  /** Last time the engine billed what the browser holds while it exists (IP, storage, snapshots). */
  baseMeteredAt: ts('base_metered_at'),
  pendingComputeMs: integer('pending_compute_ms').notNull().default(0),
  /** Boot and shutdown time (VM up, browser not yet or no longer running) not yet billed. */
  transitionMs: integer('transition_ms').notNull().default(0),
  /** Data volume usage reported by the agent's heartbeat. */
  diskUsedBytes: integer('disk_used_bytes'),
  diskTotalBytes: integer('disk_total_bytes'),
  diskReportedAt: ts('disk_reported_at'),
  /** The VM's bytes sent since boot (agent heartbeat), and the counter value already billed. */
  netTxBytes: integer('net_tx_bytes'),
  netTxBilledBytes: integer('net_tx_billed_bytes'),
  /** Version of the agent that last reported `ready` (features such as growing storage need a minimum). */
  agentVersion: text('agent_version'),
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

/**
 * A coding agent's access to one browser (docs/agent-access.md): an access key the owner created
 * in Settings (`kind = 'key'`), or the credential of a bridge paired before keys existed
 * (`kind = 'bridge'`), which is accepted as a key. Only the hash `sha256('bridge:' + secret)` is
 * stored. The pairing columns are kept for those older rows. Owner: api.
 */
export const automationClients = sqliteTable(
  'automation_clients',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => browserInstances.id),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    /** What the bridge said about the machine it runs on, at redemption. */
    clientInfo: text('client_info'),
    pairingHash: text('pairing_hash'),
    pairingExpiresAt: ts('pairing_expires_at'),
    credentialHash: text('credential_hash'),
    /** `key` | `bridge`. */
    kind: text('kind').notNull().default('bridge'),
    /** `nvzk_` and the key's first six characters; null for bridges. */
    keyPrefix: text('key_prefix'),
    /** Null: never expires. */
    expiresAt: ts('expires_at'),
    /** `control` | `view` (screenshots and status only). */
    capability: text('capability').notNull().default('control'),
    /** The MCP client name and version (or user agent) that last used the key, at most 120 characters. */
    lastClient: text('last_client'),
    lastIp: text('last_ip'),
    createdAt: ts('created_at').notNull(),
    activatedAt: ts('activated_at'),
    lastSeenAt: ts('last_seen_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    index('automation_clients_instance_idx').on(t.instanceId, t.revokedAt),
    uniqueIndex('automation_clients_pairing_idx').on(t.pairingHash),
    index('automation_clients_credential_idx').on(t.credentialHash),
  ],
);

/** One coding-agent session the gateway opened. Owner: api (through the gateway's RPCs). */
export const automationSessions = sqliteTable(
  'automation_sessions',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => browserInstances.id),
    clientId: text('client_id')
      .notNull()
      .references(() => automationClients.id),
    userId: text('user_id').notNull(),
    generation: integer('generation').notNull(),
    startedAt: ts('started_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    endedAt: ts('ended_at'),
    endReason: text('end_reason'),
  },
  (t) => [index('automation_sessions_instance_idx').on(t.instanceId, t.endedAt)],
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
    /** -1 identifies legacy clients whose activity still comes from the agent. */
    presenceSeq: integer('presence_seq').notNull().default(-1),
    /** null means the client cannot report document visibility and uses input activity only. */
    viewing: integer('viewing', { mode: 'boolean' }),
    presenceAt: ts('presence_at'),
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
// Prices and billing (page 6). Provider prices come from the provider's price list; customers pay
// them times the markup from a prepaid balance topped up through Stripe or Creem. Owner: api, except
// `provider_prices` and `usage_records` (engine).
// ---------------------------------------------------------------------------------------------

/** What each region costs us, read from the provider's price list (AWS Price List API). Owner: engine. */
export const providerPrices = sqliteTable('provider_prices', {
  regionId: text('region_id')
    .primaryKey()
    .references(() => regions.id),
  executor: text('executor').notNull(),
  providerRegion: text('provider_region').notNull(),
  /** ProviderPriceSheet (packages/contracts/src/pricing.ts), USD. */
  sheet: json<Record<string, unknown>>('sheet'),
  /** Types and disk settings used to fetch this sheet; changing defaults invalidates it. */
  configurationKey: text('configuration_key'),
  fetchedAt: ts('fetched_at'),
  lastError: text('last_error'),
  lastErrorAt: ts('last_error_at'),
});

/** AWS observations; credentials stay in Worker secrets, never in D1 or admin responses. */
export const awsProviderState = sqliteTable('aws_provider_state', {
  id: integer('id').primaryKey(), accountId: text('account_id'), managementAccountId: text('management_account_id'), organizationId: text('organization_id'),
  connection: json<Record<string, unknown>>('connection'), billing: json<Record<string, unknown>>('billing'),
  billingAt: ts('billing_at'), catalogAt: ts('catalog_at'), lastError: text('last_error'), lastErrorAt: ts('last_error_at'),
  /** Guards the account-level work (billing); regions have their own leases. */
  syncLeaseUntil: ts('sync_lease_until').notNull(),
  /** The last synchronization run's summary, for diagnostics. */
  lastRun: json<Record<string, unknown>>('last_run'),
});
export const awsProviderRegions = sqliteTable('aws_provider_regions', {
  regionId: text('region_id').primaryKey().references(() => regions.id), providerRegion: text('provider_region').notNull().unique(),
  optInStatus: text('opt_in_status').notNull(), status: text('status').notNull(),
  config: json<Record<string, unknown>>('config'), quotas: json<{ metric: string; limit: number; used: number; limitAt?: number }[]>('quotas'),
  capacity: integer('capacity').notNull(), checkedAt: ts('checked_at'), lastError: text('last_error'),
  /** vCPUs the account can give its browsers; `capacity` then counts every other dimension. */
  vcpuCapacity: integer('vcpu_capacity'),
  basicVcpus: integer('basic_vcpus').notNull().default(2), premiumVcpus: integer('premium_vcpus').notNull().default(4),
  premiumOffered: integer('premium_offered', { mode: 'boolean' }).notNull().default(false),
  /** `checkedAt` is when this region's quota and usage reads began, not when the run started. */
  syncLeaseUntil: ts('sync_lease_until'), lastErrorAt: ts('last_error_at'),
  /** Consecutive failed refreshes; a failure keeps the last snapshot until it expires. */
  syncFailures: integer('sync_failures').notNull().default(0), syncMs: integer('sync_ms'),
});

/**
 * Launch outcomes per region and zone. Owner: engine. Steers new browsers away from zones that
 * just ran out of capacity, and tells users how a region is doing before they create there.
 * Zone '' holds failures that are not tied to one zone.
 */
export const launchHealth = sqliteTable('launch_health', {
  regionId: text('region_id').notNull(),
  zone: text('zone').notNull(),
  lastSuccessAt: ts('last_success_at'),
  lastCapacityAt: ts('last_capacity_at'),
  lastFailureAt: ts('last_failure_at'),
  lastFailureClass: text('last_failure_class'),
  lastFailure: text('last_failure'),
}, (t) => [primaryKey({ columns: [t.regionId, t.zone] })]);

/** One row (id 1): markup and balance thresholds, edited in the operator console. Owner: api (admin). */
export const pricingSettings = sqliteTable('pricing_settings', {
  id: integer('id').primaryKey(),
  /** The compute markup. */
  markupPercent: integer('markup_percent').notNull(),
  fixedMarkupPercent: integer('fixed_markup_percent').notNull().default(120),
  transferMarkupPercent: integer('transfer_markup_percent').notNull().default(120),
  relayGbMicros: integer('relay_gb_micros').notNull().default(50_000),
  billTransitions: integer('bill_transitions', { mode: 'boolean' }).notNull().default(true),
  minBalanceMicros: integer('min_balance_micros').notNull(),
  lowBalanceMicros: integer('low_balance_micros').notNull(),
  paymentFeeBps: integer('payment_fee_bps').notNull().default(0),
  paymentFeeFixedCents: integer('payment_fee_fixed_cents').notNull().default(0),
  updatedAt: ts('updated_at').notNull(),
  updatedBy: text('updated_by'),
});

/** Each user's prepaid balance in micro-dollars. The engine debits usage; the api credits top-ups. */
export const billingAccounts = sqliteTable('billing_accounts', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id),
  balanceMicros: integer('balance_micros').notNull().default(0),
  /** When the balance reached zero: running browsers sleep 10 minutes later; deleted after 30 days. */
  exhaustedAt: ts('exhausted_at'),
  /** Set after a dispute: nothing runs until support clears it. */
  frozenAt: ts('frozen_at'),
  frozenReason: text('frozen_reason'),
  /** Last low-balance email, so it is sent once per dip. */
  lowNotifiedAt: ts('low_notified_at'),
  /** The most urgent funded-time warning (24, 6 or 1 hours) sent while credit keeps falling. */
  runwayWarnedHours: integer('runway_warned_hours'),
  updatedAt: ts('updated_at').notNull(),
});

/**
 * Emails the engine cannot send itself (unexpected stops, paused networks). Owner: engine writes,
 * the api's billing sweep sends and sets sent_at. The id doubles as the dedupe key.
 */
export const userNotices = sqliteTable(
  'user_notices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull(),
    instanceId: text('instance_id'),
    data: json<Record<string, unknown>>('data').notNull(),
    createdAt: ts('created_at').notNull(),
    sentAt: ts('sent_at'),
  },
  (t) => [index('user_notices_pending_idx').on(t.sentAt, t.createdAt)],
);

/** Per-browser seven-day fixed-resource deposit; unspent money remains in the total balance. */
export const browserReservations = sqliteTable('browser_reservations', {
  instanceId: text('instance_id').primaryKey().references(() => browserInstances.id),
  userId: text('user_id').notNull().references(() => user.id),
  requiredMicros: integer('required_micros').notNull(),
  reservedMicros: integer('reserved_micros').notNull(),
  fixedHourMicros: integer('fixed_hour_micros').notNull(),
  rates: json<{ compute: number; ip: number; storage: number; snapshot: number; transfer: number }>('rates').notNull(),
  retentionStartedAt: ts('retention_started_at'),
  retentionEndsAt: ts('retention_ends_at'),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [index('browser_reservations_user_idx').on(t.userId)]);

/**
 * Credits and other non-usage changes to a balance. `reference` makes each one idempotent, e.g.
 * `order:<creem order id>`, `refund:<creem refund id>`; for Stripe, `order:<PaymentIntent id>`,
 * `refund:<refund id>` and `dispute:<dispute id>`. Owner: api.
 */
export const balanceTransactions = sqliteTable(
  'balance_transactions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    kind: text('kind').notNull(), // topup | refund | dispute | adjustment | promotion | signup
    amountMicros: integer('amount_micros').notNull(),
    reference: text('reference').notNull().unique(),
    productId: text('product_id'),
    /** Immutable payment facts for proportional, capped refunds and disputes. */
    orderId: text('order_id'),
    grossAmountCents: integer('gross_amount_cents'),
    currency: text('currency'),
    description: text('description'),
    actor: text('actor').notNull(),
    createdAt: ts('created_at').notNull(),
    /** Set in the same D1 batch that adds the amount to the balance, so a retry never adds it twice. */
    appliedAt: ts('applied_at'),
  },
  (t) => [index('balance_tx_user_idx').on(t.userId, t.createdAt)],
);

/**
 * Metered usage per browser, item, UTC day and price. The engine adds to `quantity` every minute
 * and keeps `amount_micros` = round(quantity × unit price); a price change starts a new row.
 * Owner: engine.
 */
export const usageRecords = sqliteTable(
  'usage_records',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => browserInstances.id),
    userId: text('user_id').notNull(),
    regionId: text('region_id').notNull(),
    item: text('item').notNull(), // compute | ip | storage | snapshot | transfer
    day: text('day').notNull(), // YYYY-MM-DD (UTC)
    unitPriceMicros: integer('unit_price_micros').notNull(),
    unitCostMicros: integer('unit_cost_micros').notNull(),
    quantity: real('quantity').notNull(),
    amountMicros: integer('amount_micros').notNull(),
    costMicros: integer('cost_micros').notNull(),
    /** Amount actually debited; pilot usage is never revenue. */
    chargedMicros: integer('charged_micros').notNull().default(0),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.instanceId, t.item, t.day, t.unitPriceMicros, t.unitCostMicros] }),
    index('usage_user_day_idx').on(t.userId, t.day),
  ],
);

/** The Creem customer of each user, linked on the first `checkout.completed`. */
export const billingCustomers = sqliteTable('billing_customers', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id),
  creemCustomerId: text('creem_customer_id').notNull().unique(),
  createdAt: ts('created_at').notNull(),
});

/** The Stripe customer of each user, linked on the first paid Stripe checkout and reused afterwards. */
export const stripeCustomers = sqliteTable('stripe_customers', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  createdAt: ts('created_at').notNull(),
});

/**
 * Top-up products: Creem products (CREEM_TOPUP_PRODUCTS) or Stripe prices (STRIPE_TOPUP_PRICES);
 * name and price are read from that provider. Only the provider taking top-ups offers its own.
 */
export const topupPacks = sqliteTable('topup_packs', {
  productId: text('product_id').primaryKey(),
  /** `stripe` | `creem` */
  provider: text('provider').notNull().default('creem'),
  name: text('name').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  fetchedAt: ts('fetched_at').notNull(),
});

/**
 * One row per top-up checkout we start; its id is echoed back for correlation (Creem's
 * `request_id`, Stripe's `client_reference_id`). `checkout_id` is the Creem checkout or Stripe
 * Checkout Session.
 */
export const topupCheckouts = sqliteTable('topup_checkouts', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  productId: text('product_id').notNull(),
  /** `stripe` | `creem`: who took the payment, and so who is asked about it later. */
  provider: text('provider').notNull().default('creem'),
  checkoutId: text('checkout_id'),
  creditedAt: ts('credited_at'),
  createdAt: ts('created_at').notNull(),
});

/**
 * Every payment webhook, keyed by its event id (Stripe's prefixed `stripe:`): duplicates are
 * ignored (page 6). Each is processed by its own provider.
 */
export const webhookEvents = sqliteTable('webhook_events', {
  id: text('id').primaryKey(),
  /** `stripe` | `creem` */
  provider: text('provider').notNull().default('creem'),
  type: text('type').notNull(),
  payload: json<Record<string, unknown>>('payload').notNull(),
  receivedAt: ts('received_at').notNull(),
  processedAt: ts('processed_at'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
});

// ---------------------------------------------------------------------------------------------
// Promotions: tasks that reward users with credit. Owner: api (operators edit tasks in the console;
// the api decides completion and credits the reward).
// ---------------------------------------------------------------------------------------------

export type LocalizedText = { en: string; 'zh-CN': string };

export const promotionTasks = sqliteTable('promotion_tasks', {
  id: text('id').primaryKey(),
  title: json<LocalizedText>('title').notNull(),
  description: json<LocalizedText>('description').notNull(),
  /** Where the task's button takes the user in the app, e.g. /browsers/new; null for no button. */
  actionUrl: text('action_url'),
  /** How completion is decided (contracts PromotionCriterion), measured against `target`. */
  criterion: text('criterion').notNull(),
  target: integer('target').notNull(),
  rewardMicros: integer('reward_micros').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Only accounts with at least one paid top-up can earn it (limits throwaway accounts). */
  requiresTopup: integer('requires_topup', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  /** Shown and counted from this time (activity before it does not count); null = always. */
  startsAt: ts('starts_at'),
  /** No new completions after this time; null = no end. */
  endsAt: ts('ends_at'),
  /** At most this many accounts earn the reward; null = no limit. */
  maxCompletions: integer('max_completions'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  updatedBy: text('updated_by'),
});

export const promotionCompletions = sqliteTable(
  'promotion_completions',
  {
    taskId: text('task_id').notNull().references(() => promotionTasks.id),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    /** The measured progress when it was completed. */
    progress: integer('progress').notNull(),
    rewardMicros: integer('reward_micros').notNull(),
    completedAt: ts('completed_at').notNull(),
    /** Set once the reward is on the balance (reference `promotion:<task>:<user>`). */
    creditedAt: ts('credited_at'),
    /** Set once the reward-credited email went out (several rewards share one email). */
    notifiedAt: ts('notified_at'),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index('promotion_completions_user_idx').on(t.userId),
    index('promotion_completions_pending_idx').on(t.creditedAt),
  ],
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
 * What the notification sweeps last told someone, so each message goes out once per occurrence
 * (e.g. `user:<id>:low_balance` = time of the last email, `admin:users_milestone` = 50,
 * `admin:inventory_empty:<region>` while that region has none). Owner: api.
 */
export const notificationState = sqliteTable('notification_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

/**
 * Alerts for operators (page 7, page 10): any Worker inserts a row; the api's cron emails critical
 * alerts and sends all severities to the chat webhook. The console lists them until acknowledged.
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
