import { createDb, schema, type AgentCommandsMessage, type OperationMessage } from '@cloudbrowser/db';
import { and, eq } from 'drizzle-orm';
import { createExecutor, type Executor, type ExecutorKind } from '@cloudbrowser/executors';
import { FakeAgentBridge, GatewayAgentBridge, type AgentBridge } from './agent.js';
import { placementRef, readContext, type EngineDeps, type EngineMode } from './context.js';

export interface Env {
  DB: D1Database;
  /** Operation dispatch (Cloudflare Queues). The worker deployment produces and consumes. */
  OPERATIONS?: Queue<OperationMessage>;
  /** Per-user SSE fan-out (Durable Object class EventHub, defined in this Worker). */
  EVENT_HUB?: DurableObjectNamespace;
  /** Pokes the session gateway to deliver pending agent commands. */
  AGENT_COMMANDS?: Queue<AgentCommandsMessage>;
  /** Secret that derives agent bootstrap tokens. */
  BOOTSTRAP_SECRET?: string;
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
    const [p] = await db
      .select()
      .from(schema.placements)
      .where(and(eq(schema.placements.instanceId, instanceId), eq(schema.placements.status, 'current')));
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
