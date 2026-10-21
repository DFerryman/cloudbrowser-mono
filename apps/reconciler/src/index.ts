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
      // Regions another run is refreshing, or this one had no time for, are left to the next cron.
      try { await syncAwsProvider(env, { force: msg.body.force, trigger: 'queue' }); msg.ack(); }
      catch (e) { console.error(JSON.stringify({ event: 'aws_sync.queue_retry', attempts: msg.attempts, error: (e as Error).message })); msg.retry({delaySeconds:300}); }
    }
  },
  async scheduled(controller, env) {
    const deps = makeDeps(env);
    if (env.AWS_ACCESS_KEY_ID) {
      try { await syncAwsProvider(env, { trigger: 'cron', scheduledTime: controller.scheduledTime }); }
      catch (e) { console.error(JSON.stringify({ event: 'aws_sync.cron_failed', error: (e as Error).message })); }
    }
    // Each step is independent: a failure in one (logged) never skips the next.
    try { console.log('reconcile', JSON.stringify(await reconcileLedger(deps))); }
    catch (e) { console.error('reconcile failed', (e as Error).message); }
    if (new Date(controller.scheduledTime).getUTCMinutes() < 5) {
      try { await snapshotQuotasAndSpend(deps); }
      catch (e) { console.error('quota and spend snapshot failed', (e as Error).message); }
    }
  },
} satisfies ExportedHandler<Env, {force:boolean}>;
