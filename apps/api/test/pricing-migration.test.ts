/** Upgrade a populated pre-pricing database, rather than testing only a fresh install. */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migrations = fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url));
let db: DatabaseSync;
let legacyRows: Record<string, unknown[]>;

function migrate(file: string) {
  const sql = readFileSync(`${migrations}/${file}`, 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) if (statement.trim()) db.exec(statement);
}

function insertBrowser(id: string) {
  db.prepare(`INSERT INTO browser_instances
    (id, user_id, name, region_id, status, desired_state, idle_timeout_s, locale, screen, fingerprint, created_at, updated_at)
    VALUES (?, 'legacy-user', 'Existing browser', 'tyo1', 'sleeping', 'stopped', 900, 'en-US', 'auto', '{}', 1000, 2000)`)
    .run(id);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(migrations).filter((f) => /^000[0-6]_.*\.sql$/.test(f)).sort()) migrate(file);
  // These fields must genuinely be absent until 0007 is applied.
  expect(db.prepare('PRAGMA table_info(browser_instances)').all().map((c) => c.name)).not.toContain('storage_gb');
  db.exec(`
    INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES ('legacy-user', 'Legacy user', 'legacy@example.com', 1, 1000, 2000);
    INSERT INTO subscriptions
      (id, user_id, plan, product_id, item_id, units, status, current_period_end, synced_at, created_at)
      VALUES ('sub-old', 'legacy-user', 'pro', 'product-old', 'item-old', 2, 'active', 3000, 2000, 1000);
    INSERT INTO checkout_attempts (id, user_id, plan, browsers, checkout_id, created_at)
      VALUES ('attempt-old', 'legacy-user', 'pro', 2, 'checkout-old', 1000);
    INSERT INTO active_usage (user_id, month, seconds, exhausted_at)
      VALUES ('legacy-user', '2026-10', 3600, 2000);
    INSERT INTO caps (scope, metric, "limit") VALUES
      ('billing:legacy-user', 'instances', 5),
      ('user:default', 'hours_per_month', 120),
      ('user:default', 'storage_gb', 20),
      ('user:default', 'storage_max_gb', 50),
      ('user:legacy-user', 'storage_gb', 35);
  `);
  insertBrowser('old-browser');
  db.exec(`
    INSERT INTO instance_health (instance_id, viewers, metered_at, last_heartbeat_at)
      VALUES ('old-browser', 2, 123000, 122000);
    INSERT INTO placements (id, instance_id, generation, executor, provider_region, vm_id, status, created_at)
      VALUES ('old-placement', 'old-browser', 1, 'aws-ec2', 'ap-northeast-1', 'i-old', 'current', 1000);
  `);
  legacyRows = Object.fromEntries(['subscriptions', 'checkout_attempts', 'active_usage'].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  db.exec('BEGIN');
  try {
    migrate('0007_pricing.sql');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

afterEach(() => db.close());

describe('pricing migration from the deployed legacy schema', () => {
  it('preserves legacy billing rows and archives the original caps before replacing defaults', () => {
    for (const [table, before] of Object.entries(legacyRows)) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
    expect(db.prepare('SELECT * FROM legacy_billing_caps ORDER BY scope, metric').all()).toEqual([
      { scope: 'billing:legacy-user', metric: 'instances', limit: 5 },
      { scope: 'user:default', metric: 'hours_per_month', limit: 120 },
      { scope: 'user:default', metric: 'storage_gb', limit: 20 },
      { scope: 'user:default', metric: 'storage_max_gb', limit: 50 },
      { scope: 'user:legacy-user', metric: 'storage_gb', limit: 35 },
    ]);
    expect(db.prepare(`SELECT * FROM caps WHERE scope LIKE 'billing:%' OR metric = 'hours_per_month'`).all()).toEqual([]);
    expect(db.prepare(`SELECT metric, "limit" FROM caps WHERE scope = 'user:default' AND metric LIKE 'storage%' ORDER BY metric`).all()).toEqual([
      { metric: 'storage_gb', limit: 10 },
      { metric: 'storage_max_gb', limit: 100 },
    ]);
    expect(db.prepare(`SELECT "limit" FROM caps WHERE scope = 'user:legacy-user' AND metric = 'storage_gb'`).get()).toEqual({ limit: 35 });
    expect(db.prepare(`SELECT "limit" FROM caps WHERE scope = 'global' AND metric = 'spend_budget_cents'`).get()).toEqual({ limit: 40000 });
  });

  it('keeps existing browsers and health data, while applying distinct defaults to new browsers', () => {
    expect(db.prepare(`SELECT storage_gb, backups_enabled, trial_state, trial_used_s, trial_reclaim_at
      FROM browser_instances WHERE id = 'old-browser'`).get()).toEqual({
      storage_gb: 20, backups_enabled: 1, trial_state: null, trial_used_s: 0, trial_reclaim_at: null,
    });
    expect(db.prepare(`SELECT viewers, metered_at, last_heartbeat_at, base_metered_at, disk_used_bytes,
      disk_total_bytes, disk_reported_at, net_tx_bytes, net_tx_billed_bytes, agent_version
      FROM instance_health WHERE instance_id = 'old-browser'`).get()).toEqual({
      viewers: 2, metered_at: 123000, last_heartbeat_at: 122000, base_metered_at: null,
      disk_used_bytes: null, disk_total_bytes: null, disk_reported_at: null,
      net_tx_bytes: null, net_tx_billed_bytes: null, agent_version: null,
    });
    expect(db.prepare(`SELECT vm_id, instance_type, root_volume_gb FROM placements WHERE id = 'old-placement'`).get()).toEqual({
      vm_id: 'i-old', instance_type: null, root_volume_gb: 16,
    });
    insertBrowser('new-browser');
    expect(db.prepare(`SELECT storage_gb, backups_enabled, trial_state, trial_used_s
      FROM browser_instances WHERE id = 'new-browser'`).get()).toEqual({ storage_gb: 10, backups_enabled: 0, trial_state: null, trial_used_s: 0 });
    expect(db.prepare(`SELECT markup_percent, min_balance_micros, low_balance_micros,
      payment_fee_bps, payment_fee_fixed_cents FROM pricing_settings WHERE id = 1`).get()).toEqual({
      markup_percent: 120, min_balance_micros: 1000000, low_balance_micros: 2000000, payment_fee_bps: 0, payment_fee_fixed_cents: 0,
    });
    expect(db.prepare('SELECT * FROM billing_accounts').all()).toEqual([]);
    db.exec(`INSERT INTO billing_accounts (user_id, updated_at) VALUES ('legacy-user', 3000)`);
    expect(db.prepare(`SELECT balance_micros, exhausted_at, frozen_at, trial_used_at FROM billing_accounts WHERE user_id = 'legacy-user'`).get()).toEqual({
      balance_micros: 0, exhausted_at: null, frozen_at: null, trial_used_at: null,
    });
    db.exec(`INSERT INTO usage_records
      (instance_id, user_id, region_id, item, day, unit_price_micros, unit_cost_micros, quantity, amount_micros, cost_micros, updated_at)
      VALUES ('old-browser', 'legacy-user', 'tyo1', 'compute', '2026-10-18', 120000, 100000, 1, 120000, 100000, 3000)`);
    expect(db.prepare('SELECT charged_micros FROM usage_records').get()).toEqual({ charged_micros: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(() => db.exec(`UPDATE browser_instances SET region_id = 'usw1' WHERE id = 'old-browser'`)).toThrow('region_id is immutable');
  });
});
