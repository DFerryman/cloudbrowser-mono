ALTER TABLE browser_instances ADD COLUMN provider_released_at INTEGER;
--> statement-breakpoint
CREATE TABLE aws_provider_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  inventory_mode TEXT NOT NULL DEFAULT 'budget' CHECK (inventory_mode IN ('quota','budget')),
  monthly_budget_micros INTEGER,
  estimated_hours_per_day REAL NOT NULL DEFAULT 24 CHECK (estimated_hours_per_day BETWEEN 1 AND 24),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
--> statement-breakpoint
INSERT INTO aws_provider_settings (id, updated_at) VALUES (1, 0);
--> statement-breakpoint
CREATE TABLE aws_provider_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_id TEXT,
  management_account_id TEXT,
  organization_id TEXT,
  connection TEXT,
  billing TEXT,
  billing_at INTEGER,
  catalog_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  sync_lease_until INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO aws_provider_state (id) VALUES (1);
--> statement-breakpoint
CREATE TABLE aws_provider_regions (
  region_id TEXT PRIMARY KEY REFERENCES regions(id),
  provider_region TEXT NOT NULL UNIQUE,
  opt_in_status TEXT NOT NULL,
  status TEXT NOT NULL,
  config TEXT,
  quotas TEXT,
  capacity INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  last_error TEXT
);
--> statement-breakpoint
CREATE VIEW aws_browser_commitments AS
SELECT b.id, b.region_id,
  CAST(ceil(1000000 * (
    (SELECT estimated_hours_per_day FROM aws_provider_settings WHERE id=1) *
    CAST(strftime('%d',date('now','start of month','+1 month','-1 day')) AS INTEGER) *
    COALESCE(json_extract(p.sheet,'$.vmHour'),0) +
    24 * CAST(strftime('%d',date('now','start of month','+1 month','-1 day')) AS INTEGER) *
    COALESCE(json_extract(p.sheet,'$.ipHour'),0) +
    (b.storage_gb + COALESCE(json_extract(p.sheet,'$.rootVolumeGb'),0)) *
    COALESCE(json_extract(p.sheet,'$.volumeGbMonth'),0)
  )) AS INTEGER) AS monthly_micros
FROM browser_instances b JOIN regions r ON r.id=b.region_id
LEFT JOIN provider_prices p ON p.region_id=b.region_id
WHERE r.executor='aws-ec2' AND b.status!='purged' AND (b.status!='failed' OR b.provider_released_at IS NULL);
--> statement-breakpoint
CREATE VIEW aws_region_inventory AS
SELECT a.region_id, a.checked_at, a.status,
  MAX(0, a.capacity - (SELECT COUNT(*) FROM aws_browser_commitments c WHERE c.region_id=a.region_id)) AS quota_available,
  CAST(ceil(1000000 * (
    s.estimated_hours_per_day * CAST(strftime('%d',date('now','start of month','+1 month','-1 day')) AS INTEGER) * COALESCE(json_extract(p.sheet,'$.vmHour'),0) +
    24 * CAST(strftime('%d',date('now','start of month','+1 month','-1 day')) AS INTEGER) * COALESCE(json_extract(p.sheet,'$.ipHour'),0) +
    (COALESCE((SELECT "limit" FROM caps WHERE scope='user:default' AND metric='storage_gb'),10) + COALESCE(json_extract(p.sheet,'$.rootVolumeGb'),0)) * COALESCE(json_extract(p.sheet,'$.volumeGbMonth'),0)
  )) AS INTEGER) AS monthly_unit_micros,
  MAX(0, COALESCE(s.monthly_budget_micros, CAST(json_extract(st.billing,'$.budgetMicros') AS INTEGER),0) -
    COALESCE(CAST(json_extract(st.billing,'$.spendMicros') AS INTEGER),0) -
    COALESCE((SELECT SUM(monthly_micros) FROM aws_browser_commitments),0)) AS budget_remaining_micros,
  s.inventory_mode,
  CASE WHEN a.status!='ready' OR r.enabled=0 OR a.checked_at IS NULL OR a.checked_at < (unixepoch()*1000-1200000)
    OR p.fetched_at IS NULL OR p.fetched_at < (unixepoch()*1000-172800000) OR p.sheet IS NULL THEN 'unavailable'
    WHEN s.inventory_mode='budget' AND (st.billing_at IS NULL OR st.billing_at < (unixepoch()*1000-93600000) OR json_extract(st.billing,'$.month')!=strftime('%Y-%m','now') OR json_extract(st.billing,'$.spendMicros') IS NULL) THEN 'billing_stale'
    ELSE 'ready' END AS availability
FROM aws_provider_regions a JOIN regions r ON r.id=a.region_id
CROSS JOIN aws_provider_settings s CROSS JOIN aws_provider_state st
LEFT JOIN provider_prices p ON p.region_id=a.region_id;
--> statement-breakpoint
CREATE TRIGGER aws_inventory_create_guard BEFORE INSERT ON browser_instances
WHEN EXISTS(SELECT 1 FROM aws_provider_regions WHERE region_id=NEW.region_id)
BEGIN
  SELECT RAISE(ABORT,'aws_inventory_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM aws_region_inventory WHERE region_id=NEW.region_id AND availability='ready'
      AND quota_available>0 AND monthly_unit_micros>0
      AND (inventory_mode='quota' OR budget_remaining_micros>=monthly_unit_micros)
  );
END;
