import { ExecutorError, type CredentialMode, type Executor, type ExecutorKind } from './executor.js';
import { AwsExecutor, type AwsRegionConfig } from './aws/aws-executor.js';
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
  /** `aws-ec2`: the IAM user's key for this process's mode (runtime, reaper or read-only). */
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  /** JSON: provider region → network ids, from the CloudFormation stack's outputs. */
  AWS_REGIONS?: string;
  /** Public origin of the app; VMs check their IP against `${APP_URL}/api/echo/ip`. */
  APP_URL?: string;
  /** Container images the VMs run (built by .github/workflows/images.yml). */
  AGENT_IMAGE?: string;
  BROWSER_IMAGE?: string;
}

export const DEFAULT_AGENT_IMAGE = 'ghcr.io/dferryman/cloudbrowser-agent:main';
export const DEFAULT_BROWSER_IMAGE = 'ghcr.io/dferryman/cloudbrowser-browser:main';

function awsRegions(raw: string | undefined): Record<string, AwsRegionConfig> {
  if (!raw) throw new ExecutorError('invalid', 'AWS_REGIONS is not set (paste the CloudFormation output)');
  try {
    return JSON.parse(raw) as Record<string, AwsRegionConfig>;
  } catch {
    throw new ExecutorError('invalid', 'AWS_REGIONS is not valid JSON');
  }
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
    case 'aws-ec2': {
      if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
        throw new ExecutorError('forbidden', 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set for this Worker');
      }
      return new AwsExecutor({
        mode,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        regions: awsRegions(env.AWS_REGIONS),
        appUrl: env.APP_URL ?? '',
        agentImage: env.AGENT_IMAGE || DEFAULT_AGENT_IMAGE,
        browserImage: env.BROWSER_IMAGE || DEFAULT_BROWSER_IMAGE,
      });
    }
    case 'oci-compute':
    case 'fly-machines':
      // Built in Phase 1, after the provider trial (page 8).
      throw new ExecutorError('invalid', `executor ${kind} is not implemented yet`);
  }
}
