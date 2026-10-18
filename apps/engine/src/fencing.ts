import type { Db } from '@cloudbrowser/db';
import { sql, type SQL } from 'drizzle-orm';
import type { StepEnv } from './context.js';

/** The lease is also a write fence, not just a scheduler hint. Canceling a job closes this gate. */
export function operationFence(env: Pick<StepEnv, 'deps' | 'op'>): SQL {
  return sql`exists (select 1 from operations where id = ${env.op.id} and finished_at is null and lease_owner = ${env.deps.workerId})`;
}

/** INSERT ... SELECT keeps the ownership check and write in one D1 statement. */
export function fencedInsert(db: Db, table: string, values: Record<string, unknown>, fence: SQL, conflict: SQL = sql`on conflict do nothing`) {
  const entries = Object.entries(values);
  const encoded = (v: unknown) => v instanceof Date ? v.getTime() : typeof v === 'boolean' ? Number(v) : v && typeof v === 'object' ? JSON.stringify(v) : v;
  return db.run(sql`insert into ${sql.identifier(table)} (${sql.join(entries.map(([k]) => sql.identifier(k)), sql`, `)})
    select ${sql.join(entries.map(([, v]) => sql`${encoded(v)}`), sql`, `)} where ${fence} ${conflict}`);
}
