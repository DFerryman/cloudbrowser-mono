-- Inventory refresh reliability. The reconciler used to refresh every region in one run under a
-- single 14-minute lease, stamping each region with the run's start time: a slow run made the next
-- crons skip, and a region written late in a run looked older than it was, so snapshots expired
-- (20 minutes) while the quota was fine. Each region now has its own lease and its own observation
-- time, and the view says why a region is unavailable, so a stale snapshot is no longer reported as
-- an empty quota.
ALTER TABLE `aws_provider_regions` ADD `sync_lease_until` integer;
--> statement-breakpoint
-- The last failed refresh; the previous snapshot stays valid until it expires.
ALTER TABLE `aws_provider_regions` ADD `last_error_at` integer;
--> statement-breakpoint
ALTER TABLE `aws_provider_regions` ADD `sync_failures` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- How long the last successful regional refresh took, in milliseconds.
ALTER TABLE `aws_provider_regions` ADD `sync_ms` integer;
--> statement-breakpoint
-- The last synchronization run's summary (timings, refreshed, failed, deferred regions).
ALTER TABLE `aws_provider_state` ADD `last_run` text;
--> statement-breakpoint
DROP TRIGGER IF EXISTS aws_inventory_create_guard;
--> statement-breakpoint
DROP VIEW IF EXISTS aws_region_inventory;
--> statement-breakpoint
-- As in 0029, plus `reason`: NULL when ready, else why new browsers cannot be placed here:
-- disabled, pending (never refreshed), sync_failed (the last refresh found the region unusable or
-- never succeeded), stale (the snapshot is over 20 minutes old), prices (missing or over 2 days old).
CREATE VIEW aws_region_inventory AS
SELECT region_id, checked_at, status, CASE WHEN reason IS NULL THEN 'ready' ELSE 'unavailable' END AS availability, reason,
  premium_offered, last_error, last_error_at, sync_failures,
  MAX(0, MIN(capacity - browsers,
    CASE WHEN vcpu_capacity IS NULL THEN capacity - browsers ELSE (vcpu_capacity - vcpus_held) / basic_vcpus END)) AS quota_available,
  CASE WHEN vcpu_capacity IS NULL OR premium_offered = 0 THEN 0
    ELSE MAX(0, MIN(capacity - browsers, (vcpu_capacity - vcpus_held) / premium_vcpus)) END AS premium_available
FROM (
  SELECT a.region_id, a.checked_at, a.status, a.capacity, a.vcpu_capacity, a.basic_vcpus, a.premium_vcpus, a.premium_offered,
    a.last_error, a.last_error_at, a.sync_failures,
    (SELECT COUNT(*) FROM aws_browser_commitments c WHERE c.region_id=a.region_id) AS browsers,
    (SELECT COALESCE(SUM(CASE WHEN c.tier='premium' THEN a.premium_vcpus ELSE a.basic_vcpus END), 0)
      FROM aws_browser_commitments c WHERE c.region_id=a.region_id) AS vcpus_held,
    CASE WHEN r.enabled=0 THEN 'disabled'
      WHEN a.status!='ready' THEN CASE WHEN a.last_error IS NULL THEN 'pending' ELSE 'sync_failed' END
      WHEN a.checked_at IS NULL THEN 'pending'
      WHEN a.checked_at < (unixepoch()*1000-1200000) THEN 'stale'
      WHEN p.fetched_at IS NULL OR p.fetched_at < (unixepoch()*1000-172800000) OR p.sheet IS NULL THEN 'prices'
      ELSE NULL END AS reason
  FROM aws_provider_regions a JOIN regions r ON r.id=a.region_id
  LEFT JOIN provider_prices p ON p.region_id=a.region_id
);
--> statement-breakpoint
-- Unchanged from 0029; recreated because it reads the view.
CREATE TRIGGER aws_inventory_create_guard BEFORE INSERT ON browser_instances
WHEN EXISTS(SELECT 1 FROM aws_provider_regions WHERE region_id=NEW.region_id)
BEGIN
  SELECT RAISE(ABORT,'aws_inventory_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM aws_region_inventory WHERE region_id=NEW.region_id AND availability='ready'
      AND (CASE WHEN COALESCE(NEW.tier,'basic')='premium' THEN premium_available ELSE quota_available END) > 0
  );
END;
