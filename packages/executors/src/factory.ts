import { ExecutorError, type CredentialMode, type Executor, type ExecutorKind } from './executor.js';
import { FakeExecutor, type FaultPlan } from './fake/fake-executor.js';
import { D1FakeStore } from './fake/store.js';

export interface ExecutorEnv {
  /** Only used by the `fake` executor, for its provider-side state. */
  FAKE_PROVIDER_DB?: D1Database;
  /** Simulated provider latency in ms for the fake executor. */
  FAKE_DELAY_MS?: string;
  /**
   * Random fault injection for manual chaos testing, e.g.
   * `{"ensureRunning":{"class":"capacity","rate":0.5}}`.
   */
  FAKE_FAULTS?: string;
}

type FaultConfig = Record<string, { class: string; rate: number }>;

function faultsFromEnv(raw: string | undefined): FaultPlan | undefined {
  if (!raw) return undefined;
  const cfg = JSON.parse(raw) as FaultConfig;
  return (method) => {
    const f = cfg[method];
    return f && Math.random() < f.rate ? (f.class as ReturnType<FaultPlan>) : null;
  };
}

/** Each process builds its executors with its own credential mode. */
export function createExecutor(kind: ExecutorKind, mode: CredentialMode, env: ExecutorEnv): Executor {
  switch (kind) {
    case 'fake': {
      if (!env.FAKE_PROVIDER_DB) throw new ExecutorError('invalid', 'FAKE_PROVIDER_DB binding is missing');
      return new FakeExecutor({
        store: new D1FakeStore(env.FAKE_PROVIDER_DB),
        mode,
        delayMs: Number(env.FAKE_DELAY_MS ?? 0),
        faults: faultsFromEnv(env.FAKE_FAULTS),
      });
    }
    case 'aws-ec2':
    case 'oci-compute':
    case 'fly-machines':
      // Built in Phase 1, after the provider trial (page 8).
      throw new ExecutorError('invalid', `executor ${kind} is not implemented yet`);
  }
}
