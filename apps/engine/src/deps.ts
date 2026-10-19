import { createDb, schema, type AgentCommandsMessage, type OperationMessage } from '@cloudbrowser/db';
import { and, eq, inArray } from 'drizzle-orm';
import { createExecutor, type Executor, type ExecutorEnv, type ExecutorKind } from '@cloudbrowser/executors';
import { FakeAgentBridge, GatewayAgentBridge, type AgentBridge } from './agent.js';
import { r2ArchiveStore } from './archives.js';
import { placementRef, readContext, type EngineDeps, type EngineMode } from './context.js';

export interface Env extends Omit<ExecutorEnv, 'FAKE_PROVIDER_DB'> {
  DB: D1Database;
  /** Operation dispatch (Cloudflare Queues). The worker deployment produces and consumes. */
  OPERATIONS?: Queue<OperationMessage>;
  /** Per-user SSE fan-out (Durable Object class EventHub, defined in this Worker). */
  EVENT_HUB?: DurableObjectNamespace;
  /** Pokes the session gateway to deliver pending agent commands. */
  AGENT_COMMANDS?: Queue<AgentCommandsMessage>;
  /** Secret that derives agent bootstrap tokens. */
  BOOTSTRAP_SECRET?: string;
  /** R2 S3-API credentials for presigning archive uploads and downloads (page 4). */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ARCHIVE_BUCKET?: string;
  /** 32 random bytes, base64: wraps per-instance archive keys. */
  ARCHIVE_MASTER_KEY?: string;
  /** R2 bucket binding of the archives (reaper deletes expired archives through it). */
  ARCHIVES?: R2Bucket;
  /**
   * `gateway` makes the fake executor's VMs use real agents through the gateway (local end-to-end
   * runs with services/agent); anything else uses the in-process fake agent.
   */
  AGENT_MODE?: string;
  ENGINE_MODE?: EngineMode;
  ENV_NAME?: string;
  GATEWAY_URL?: string;
  FAKE_DELAY_MS?: string;
  FAKE_FAULTS?: string;
}

export function makeDeps(env: Env, waitUntil: (p: Promise<unknown>) => void = () => {}): EngineDeps {
  const mode: EngineMode = env.ENGINE_MODE === 'reaper' ? 'reaper' : 'worker';
  const envName = env.ENV_NAME ?? 'dev';
  const executors = new Map<ExecutorKind, Executor>();
  const executor = (kind: ExecutorKind) => {
    let ex = executors.get(kind);
    if (!ex) {
      ex = createExecutor(kind, mode === 'reaper' ? 'reaper' : 'runtime', {
        FAKE_PROVIDER_DB: env.DB,
        FAKE_DELAY_MS: env.FAKE_DELAY_MS,
        FAKE_FAULTS: env.FAKE_FAULTS,
        // aws-ec2: this deployment's IAM user (runtime for the engine, delete-only for the reaper).
        AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        AWS_ROLE_ARN: env.AWS_ROLE_ARN,
        AWS_ROLE_EXTERNAL_ID: env.AWS_ROLE_EXTERNAL_ID,
        AWS_REGIONS: env.AWS_REGIONS,
        AWS_REGION_CONFIG_RESOLVER: async (region) => {
          const [row] = await db.select().from(schema.awsProviderRegions).where(eq(schema.awsProviderRegions.providerRegion, region));
          return row?.config as import('@cloudbrowser/executors').AwsRegionConfig | null;
        },
        APP_URL: env.APP_URL,
        AGENT_IMAGE: env.AGENT_IMAGE,
        BROWSER_IMAGE: env.BROWSER_IMAGE,
      });
      executors.set(kind, ex);
    }
    return ex;
  };
  const db = createDb(env.DB);
  const now = () => new Date();
  const gateway = new GatewayAgentBridge(
    db,
    async (msg) => {
      if (env.AGENT_COMMANDS) await env.AGENT_COMMANDS.send(msg);
    },
    now,
  );
  const placementOf = async (instanceId: string) => {
    // During a recover the replacement (building) is the one Chrome runs in.
    const rows = await db
      .select()
      .from(schema.placements)
      .where(and(eq(schema.placements.instanceId, instanceId), inArray(schema.placements.status, ['building', 'current'])));
    const p = rows.find((r) => r.status === 'building') ?? rows[0];
    return p ? placementRef(p) : null;
  };
  let fakeAgent: FakeAgentBridge | null = null;
  const agent = (kind: ExecutorKind): AgentBridge => {
    if (kind === 'fake' && env.AGENT_MODE !== 'gateway') {
      return (fakeAgent ??= new FakeAgentBridge(executor(kind), () => readContext('agent', envName), placementOf, now));
    }
    return gateway;
  };
  return {
    db,
    mode,
    executor,
    agent,
    envName,
    gatewayUrl: env.GATEWAY_URL ?? 'wss://connect.invalid',
    workerId: `${mode}-${crypto.randomUUID()}`,
    now,
    bootstrapSecret: env.BOOTSTRAP_SECRET ?? 'dev-only-bootstrap-secret',
    archiveMasterKey: env.ARCHIVE_MASTER_KEY ?? null,
    archives:
      env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ARCHIVE_BUCKET && env.ARCHIVE_MASTER_KEY
        ? r2ArchiveStore({
            accountId: env.R2_ACCOUNT_ID,
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            bucket: env.R2_ARCHIVE_BUCKET,
          })
        : null,
    deleteArchive: env.ARCHIVES ? async (key) => void (await env.ARCHIVES!.delete(key)) : undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    notify(userId) {
      const hub = env.EVENT_HUB;
      if (!hub) return;
      const stub = hub.get(hub.idFromName(userId));
      waitUntil(
        stub.fetch(`https://hub/notify?userId=${encodeURIComponent(userId)}`, { method: 'POST' }).catch((e) => console.error('notify failed', e)),
      );
    },
  };
}
