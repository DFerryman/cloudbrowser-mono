import type { ResourceKind } from '../executor.js';

/** One resource as the fake provider holds it. */
export interface FakeRecord {
  id: string;
  kind: ResourceKind;
  region: string;
  zone: string | null;
  clientToken: string | null;
  state: string;
  attrs: Record<string, unknown>;
  tags: Record<string, string>;
  createdAt: number;
}

/** Where the fake provider keeps its state between calls. */
export interface FakeStore {
  get(id: string): Promise<FakeRecord | null>;
  findByToken(kind: ResourceKind, token: string): Promise<FakeRecord | null>;
  insert(rec: FakeRecord): Promise<void>;
  update(id: string, patch: Partial<Pick<FakeRecord, 'state' | 'attrs' | 'zone'>>): Promise<void>;
  list(region: string): Promise<FakeRecord[]>;
}

export class MemoryFakeStore implements FakeStore {
  readonly records = new Map<string, FakeRecord>();

  async get(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }
  async findByToken(kind: ResourceKind, token: string) {
    for (const r of this.records.values()) if (r.kind === kind && r.clientToken === token) return structuredClone(r);
    return null;
  }
  async insert(rec: FakeRecord) {
    this.records.set(rec.id, structuredClone(rec));
  }
  async update(id: string, patch: Partial<Pick<FakeRecord, 'state' | 'attrs' | 'zone'>>) {
    const r = this.records.get(id);
    if (r) this.records.set(id, { ...r, ...structuredClone(patch) });
  }
  async list(region: string) {
    return [...this.records.values()].filter((r) => r.region === region).map((r) => structuredClone(r));
  }
}

type Row = {
  id: string;
  kind: ResourceKind;
  region: string;
  zone: string | null;
  client_token: string | null;
  state: string;
  attrs: string;
  tags: string;
  created_at: number;
};

const fromRow = (r: Row): FakeRecord => ({
  id: r.id,
  kind: r.kind,
  region: r.region,
  zone: r.zone,
  clientToken: r.client_token,
  state: r.state,
  attrs: JSON.parse(r.attrs),
  tags: JSON.parse(r.tags),
  createdAt: r.created_at,
});

/**
 * Keeps the fake provider's state in the `fake_provider_resources` table, so it survives between
 * Worker invocations. This table models the provider's side, not our ledger.
 */
export class D1FakeStore implements FakeStore {
  constructor(private readonly d1: D1Database) {}

  async get(id: string) {
    const r = await this.d1.prepare('SELECT * FROM fake_provider_resources WHERE id = ?').bind(id).first<Row>();
    return r ? fromRow(r) : null;
  }
  async findByToken(kind: ResourceKind, token: string) {
    const r = await this.d1
      .prepare('SELECT * FROM fake_provider_resources WHERE kind = ? AND client_token = ?')
      .bind(kind, token)
      .first<Row>();
    return r ? fromRow(r) : null;
  }
  async insert(rec: FakeRecord) {
    await this.d1
      .prepare(
        'INSERT INTO fake_provider_resources (id, kind, region, zone, client_token, state, attrs, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        rec.id,
        rec.kind,
        rec.region,
        rec.zone,
        rec.clientToken,
        rec.state,
        JSON.stringify(rec.attrs),
        JSON.stringify(rec.tags),
        rec.createdAt,
      )
      .run();
  }
  async update(id: string, patch: Partial<Pick<FakeRecord, 'state' | 'attrs' | 'zone'>>) {
    const current = await this.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    await this.d1
      .prepare('UPDATE fake_provider_resources SET state = ?, attrs = ?, zone = ? WHERE id = ?')
      .bind(next.state, JSON.stringify(next.attrs), next.zone, id)
      .run();
  }
  async list(region: string) {
    const { results } = await this.d1
      .prepare('SELECT * FROM fake_provider_resources WHERE region = ?')
      .bind(region)
      .all<Row>();
    return results.map(fromRow);
  }
}
