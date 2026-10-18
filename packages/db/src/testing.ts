/**
 * A D1Database implementation over node:sqlite, so tests run the production drizzle-orm/d1 code
 * path without workerd. Only the subset drizzle uses is implemented.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Bound = { sql: string; params: unknown[] };

function normalize(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map(normalize));
  }
  private prepared() {
    return this.db.prepare(this.sql);
  }
  async all() {
    const results = this.prepared().all(...(this.params as never[]));
    return { results, success: true, meta: {} };
  }
  async run() {
    const r = this.prepared().run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col?: string) {
    const row = this.prepared().get(...(this.params as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    return col ? row[col] : row;
  }
  async raw() {
    const s = this.prepared();
    s.setReturnArrays(true);
    return s.all(...(this.params as never[]));
  }
  toBound(): Bound {
    return { sql: this.sql, params: this.params };
  }
}

export function createTestD1(): D1Database & { sqlite: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const migrationsDir = join(import.meta.dirname, '..', 'migrations');
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    const text = readFileSync(join(migrationsDir, file), 'utf8');
    for (const part of text.split('--> statement-breakpoint')) {
      if (part.trim()) db.exec(part);
    }
  }
  // Fixtures explicitly select the free simulator; production absence is fail-closed prepaid.
  db.exec("INSERT INTO control_flags(key,value,updated_at) VALUES ('billing_required','false',0)");
  const d1 = {
    sqlite: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) {
          const isRead = /^\s*(select|with)\b/i.test(s.sql) || /\breturning\b/i.test(s.sql);
          out.push(isRead ? await s.all() : await s.run());
        }
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump() {
      throw new Error('not implemented');
    },
    withSession() {
      throw new Error('not implemented');
    },
  };
  return d1 as unknown as D1Database & { sqlite: DatabaseSync };
}
