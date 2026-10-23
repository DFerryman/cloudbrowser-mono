import { ExecutorError, type CredentialMode, type Executor, type ExecutorKind } from './executor.js';
import { AwsExecutor, type AwsRegionConfig } from './aws/aws-executor.js';
import { assumeRoleCredentials, type AwsCredentialProvider } from './aws/authorization.js';
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
  AWS_ROLE_ARN?: string;
  AWS_ROLE_EXTERNAL_ID?: string;
  AWS_REGION_CONFIG_RESOLVER?: (region: string) => Promise<AwsRegionConfig | null>;
  /** JSON: provider region → network ids, from the CloudFormation stack's outputs. */
  AWS_REGIONS?: string;
  /** Public origin of the app; VMs check their IP against `${APP_URL}/api/echo/ip`. */
  APP_URL?: string;
  /** Container images the VMs run (built by .github/workflows/images.yml). */
  AGENT_IMAGE?: string;
  BROWSER_IMAGE?: string;
  /** `development` lets real VMs launch without the configuration they need; see `refuseLaunches`. */
  ENVIRONMENT?: string;
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

/** The calls that create a VM's resources or power it on. Stopping, deleting and reading are not among them. */
const LAUNCHES: ReadonlySet<PropertyKey> = new Set<keyof Executor>(['allocateIp', 'ensureNetworkInterface', 'ensureVolume', 'ensureVolumeFromSnapshot', 'ensureVm', 'ensureRunning']);

/**
 * An executor that refuses to create or start VMs, for a deployment that lacks configuration a
 * real VM needs; it fails before anything is created, rather than launching a VM that falls back
 * on an unsafe default. Everything else works, so a misconfigured Worker can still clean up.
 */
export function refuseLaunches(executor: Executor, reason: string): Executor {
  return new Proxy(executor, {
    get(target, prop) {
      if (LAUNCHES.has(prop)) return async () => { throw new ExecutorError('invalid', `${reason}; no VM is created or started`); };
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const sessions = new Map<string, AwsCredentialProvider>();
/**
 * One STS session per isolate for each key and role, shared by every invocation, so a busy queue
 * does not call AssumeRole per message. New secrets (a rotated key, another role) get their own.
 */
function roleSession(accessKeyId: string, secretAccessKey: string, arn: string, externalId: string | undefined) {
  const key = JSON.stringify([accessKeyId, secretAccessKey, arn, externalId ?? null]);
  let provider = sessions.get(key);
  if (!provider) {
    provider = assumeRoleCredentials({ accessKeyId, secretAccessKey }, { arn, externalId });
    // Old secrets stop being used after a rotation; keep only a few.
    if (sessions.size >= 4) sessions.delete(sessions.keys().next().value!);
    sessions.set(key, provider);
  }
  return provider;
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
      const executor = new AwsExecutor({
        mode,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        credentials: env.AWS_ROLE_ARN ? roleSession(env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_ROLE_ARN, env.AWS_ROLE_EXTERNAL_ID) : undefined,
        regions: env.AWS_REGIONS ? awsRegions(env.AWS_REGIONS) : {},
        regionConfigResolver: env.AWS_REGION_CONFIG_RESOLVER,
        appUrl: env.APP_URL ?? '',
        agentImage: env.AGENT_IMAGE || DEFAULT_AGENT_IMAGE,
        browserImage: env.BROWSER_IMAGE || DEFAULT_BROWSER_IMAGE,
      });
      // A VM checks its IP at APP_URL: launched without it, it could never pass that check.
      return mode === 'runtime' && !env.APP_URL && env.ENVIRONMENT !== 'development'
        ? refuseLaunches(executor, 'APP_URL is not set for this Worker')
        : executor;
    }
    default:
      throw new ExecutorError('invalid', `unknown executor ${String(kind)}`);
  }
}
