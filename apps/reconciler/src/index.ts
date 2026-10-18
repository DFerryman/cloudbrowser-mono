/** The reconciler Worker: checks the ledger against each provider with read-only credentials. */
import { createDb } from '@cloudbrowser/db';
import { createExecutor, type Executor, type ExecutorEnv, type ExecutorKind } from '@cloudbrowser/executors';
import { reconcileLedger, snapshotQuotasAndSpend, type ReconcilerDeps } from './reconcile.js';

export interface Env extends Pick<ExecutorEnv, 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY' | 'AWS_REGIONS'> {
  DB: D1Database;
  ENV_NAME?: string;
}

function makeDeps(env: Env): ReconcilerDeps {
  const cache = new Map<ExecutorKind, Executor>();
  return {
    db: createDb(env.DB),
    envName: env.ENV_NAME ?? 'dev',
    now: () => new Date(),
    executor(kind) {
      let ex = cache.get(kind);
      if (!ex) {
        // aws-ec2: the read-only IAM user's key.
        ex = createExecutor(kind, 'readonly', {
          FAKE_PROVIDER_DB: env.DB,
          AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
          AWS_REGIONS: env.AWS_REGIONS,
        });
        cache.set(kind, ex);
      }
      return ex;
    },
  };
}

export default {
  async fetch() {
    return new Response('not found', { status: 404 });
  },
  async scheduled(controller, env) {
    const deps = makeDeps(env);
    console.log('reconcile', JSON.stringify(await reconcileLedger(deps)));
    if (new Date(controller.scheduledTime).getUTCMinutes() < 5) await snapshotQuotasAndSpend(deps);
  },
} satisfies ExportedHandler<Env>;
