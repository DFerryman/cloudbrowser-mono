import { createDb, schema } from '@cloudbrowser/db';
import { createTestD1 } from '@cloudbrowser/db/testing';
import { FakeExecutor, MemoryFakeStore, type OpContext } from '@cloudbrowser/executors';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { reconcileLedger, snapshotQuotasAndSpend } from '../src/reconcile.js';

const tags = (op: string) => ({ 'cb:managed': 'true', 'cb:env': 'test', 'cb:instance': 'x', 'cb:op': op, 'cb:gen': '1' }) as const;
const ctx = (token: string, op = 'unknown-op'): OpContext => ({ operationId: op, step: 's', token, tags: tags(op), deadline: Date.now() + 10_000 });

it('records unknown provider resources as orphans and trips the circuit breaker', async () => {
  const db = createDb(createTestD1());
  const store = new MemoryFakeStore();
  const runtime = new FakeExecutor({ store, mode: 'runtime' });
  for (let i = 0; i < 4; i++) await runtime.allocateIp(ctx(`t${i}`), 'ap-northeast-1');

  const deps = { db, envName: 'test', now: () => new Date(), executor: () => new FakeExecutor({ store, mode: 'readonly' }) };
  const summary = await reconcileLedger(deps);
  expect(summary.orphans).toBe(4);
  expect(summary.frozen).toBe(true);
  const [flag] = await db.select().from(schema.controlFlags).where(eq(schema.controlFlags.key, 'creation_freeze'));
  expect(flag?.value).toBe('true');

  // Findings are not duplicated on the next run.
  expect((await reconcileLedger(deps)).orphans).toBe(0);
  await snapshotQuotasAndSpend(deps);
  const quotas = await db.select().from(schema.quotaSnapshots);
  expect(quotas.find((q) => q.metric === 'static_ips')?.used).toBe(4);
});
