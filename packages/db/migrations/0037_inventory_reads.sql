-- Inventory reads. The view counted each region's commitments with two correlated subqueries, so
-- every read scanned browser_instances twice per region (34 regions, 99 instances: 13,302 rows read
-- for one SELECT * that returns 34). Commitments are now counted once, grouped by region, and joined
-- in (252 rows read on the same data). Columns, their order and their values are unchanged.
DROP TRIGGER IF EXISTS aws_inventory_create_guard;
--> statement-breakpoint
DROP VIEW IF EXISTS aws_region_inventory;
--> statement-breakpoint
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
    COALESCE(c.browsers, 0) AS browsers,
    COALESCE(c.premium, 0) * a.premium_vcpus + (COALESCE(c.browsers, 0) - COALESCE(c.premium, 0)) * a.basic_vcpus AS vcpus_held,
    CASE WHEN r.enabled=0 THEN 'disabled'
      WHEN a.status!='ready' THEN CASE WHEN a.last_error IS NULL THEN 'pending' ELSE 'sync_failed' END
      WHEN a.checked_at IS NULL THEN 'pending'
      WHEN a.checked_at < (unixepoch()*1000-1200000) THEN 'stale'
      WHEN p.fetched_at IS NULL OR p.fetched_at < (unixepoch()*1000-172800000) OR p.sheet IS NULL THEN 'prices'
      ELSE NULL END AS reason
  FROM aws_provider_regions a JOIN regions r ON r.id=a.region_id
  LEFT JOIN provider_prices p ON p.region_id=a.region_id
  LEFT JOIN (
    SELECT region_id, COUNT(*) AS browsers, SUM(CASE WHEN tier='premium' THEN 1 ELSE 0 END) AS premium
    FROM aws_browser_commitments GROUP BY region_id
  ) c ON c.region_id=a.region_id
);
--> statement-breakpoint
-- Unchanged from 0031; recreated because it reads the view.
CREATE TRIGGER aws_inventory_create_guard BEFORE INSERT ON browser_instances
WHEN EXISTS(SELECT 1 FROM aws_provider_regions WHERE region_id=NEW.region_id)
BEGIN
  SELECT RAISE(ABORT,'aws_inventory_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM aws_region_inventory WHERE region_id=NEW.region_id AND availability='ready'
      AND (CASE WHEN COALESCE(NEW.tier,'basic')='premium' THEN premium_available ELSE quota_available END) > 0
  );
END;
