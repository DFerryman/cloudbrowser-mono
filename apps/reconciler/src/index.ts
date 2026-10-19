/** The reconciler Worker: checks the ledger against each provider with read-only credentials. */
import { createDb, schema } from '@cloudbrowser/db';
import { eq } from 'drizzle-orm';
import { createExecutor, type Executor, type ExecutorEnv, type ExecutorKind } from '@cloudbrowser/executors';
import { reconcileLedger, snapshotQuotasAndSpend, type ReconcilerDeps } from './reconcile.js';
import { syncAwsProvider } from './aws-provider.js';

export interface Env extends Pick<ExecutorEnv, 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY' | 'AWS_REGIONS' | 'AWS_ROLE_ARN' | 'AWS_ROLE_EXTERNAL_ID'> {
  DB: D1Database;
  ENV_NAME?: string;
  AWS_MANAGEMENT_ROLE_ARN?: string;
  AWS_MANAGEMENT_EXTERNAL_ID?: string;
  AWS_PROVIDER_JOBS?: Queue<{ force: boolean }>;
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
          AWS_ROLE_ARN: env.AWS_ROLE_ARN,
          AWS_ROLE_EXTERNAL_ID: env.AWS_ROLE_EXTERNAL_ID,
          AWS_REGION_CONFIG_RESOLVER: async (region) => {
            const [row] = await createDb(env.DB).select().from(schema.awsProviderRegions).where(eq(schema.awsProviderRegions.providerRegion,region));
            return row?.config as import('@cloudbrowser/executors').AwsRegionConfig | null;
          },
        });
        cache.set(kind, ex);
      }
      return ex;
    },
  };
}

export default {
  async fetch(request, env) {
    if (request.method==='POST' && new URL(request.url).pathname==='/aws/refresh') {
      if (!env.AWS_PROVIDER_JOBS) return Response.json({error:'Provider sync queue is not configured'},{status:503});
      await env.AWS_PROVIDER_JOBS.send({force:true});
      return Response.json({queued:true},{status:202});
    }
    return new Response('not found', { status: 404 });
  },
  async queue(batch: MessageBatch<{force:boolean}>,env: Env) {
    for (const msg of batch.messages) {
      try { const result=await syncAwsProvider(env, msg.body.force); if ('busy' in result) msg.retry({delaySeconds:60}); else msg.ack(); }
      catch { msg.retry({delaySeconds:300}); }
    }
  },
  async scheduled(controller, env) {
    const deps = makeDeps(env);
    if (env.AWS_ACCESS_KEY_ID) {
      try { await syncAwsProvider(env); }
      catch { console.error('AWS provider sync failed; details recorded in provider state'); }
    }
    console.log('reconcile', JSON.stringify(await reconcileLedger(deps)));
    if (new Date(controller.scheduledTime).getUTCMinutes() < 5) await snapshotQuotasAndSpend(deps);
  },
} satisfies ExportedHandler<Env, {force:boolean}>;
