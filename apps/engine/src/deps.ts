import { createDb, type OperationMessage } from '@cloudbrowser/db';
import { createExecutor, type Executor, type ExecutorKind } from '@cloudbrowser/executors';
import { FakeAgentBridge, type AgentBridge } from './agent.js';
import { readContext, type EngineDeps, type EngineMode } from './context.js';

export interface Env {
  DB: D1Database;
  /** Operation dispatch (Cloudflare Queues). The worker deployment produces and consumes. */
  OPERATIONS?: Queue<OperationMessage>;
  /** Per-user SSE fan-out (Durable Object class EventHub, defined in this Worker). */
  EVENT_HUB?: DurableObjectNamespace;
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
  const agent = (kind: ExecutorKind): AgentBridge => {
    if (kind === 'fake') return new FakeAgentBridge(executor(kind), () => readContext('agent', envName));
    throw new Error(`no agent bridge for ${kind} yet`);
  };
  return {
    db: createDb(env.DB),
    mode,
    executor,
    agent,
    envName,
    gatewayUrl: env.GATEWAY_URL ?? 'wss://connect.invalid',
    workerId: `${mode}-${crypto.randomUUID()}`,
    now: () => new Date(),
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
