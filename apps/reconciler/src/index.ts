/** The reconciler Worker: checks the ledger against each provider with read-only credentials. */
import { createDb } from '@cloudbrowser/db';
import { createExecutor, type Executor, type ExecutorKind } from '@cloudbrowser/executors';
import { reconcileLedger, snapshotQuotasAndSpend, type ReconcilerDeps } from './reconcile.js';

export interface Env {
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
      if (!ex) cache.set(kind, (ex = createExecutor(kind, 'readonly', { FAKE_PROVIDER_DB: env.DB })));
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
