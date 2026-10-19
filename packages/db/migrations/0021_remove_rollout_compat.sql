-- The API from before 0018 is retired: drop the stand-ins 0020 added for it. The view and the
-- create trigger return to their 0018 form; users keep a single limit (instances).
DROP TRIGGER IF EXISTS aws_inventory_create_guard;
--> statement-breakpoint
DROP VIEW IF EXISTS aws_region_inventory;
--> statement-breakpoint
CREATE VIEW aws_region_inventory AS
SELECT a.region_id, a.checked_at, a.status,
  MAX(0, a.capacity - (SELECT COUNT(*) FROM aws_browser_commitments c WHERE c.region_id=a.region_id)) AS quota_available,
  CASE WHEN a.status!='ready' OR r.enabled=0 OR a.checked_at IS NULL OR a.checked_at < (unixepoch()*1000-1200000)
    OR p.fetched_at IS NULL OR p.fetched_at < (unixepoch()*1000-172800000) OR p.sheet IS NULL THEN 'unavailable'
    ELSE 'ready' END AS availability
FROM aws_provider_regions a JOIN regions r ON r.id=a.region_id
LEFT JOIN provider_prices p ON p.region_id=a.region_id;
--> statement-breakpoint
-- Checked inside the create's own D1 transaction, after every earlier create committed: when
-- two people take the last slot at once, the second insert sees the first and is refused.
CREATE TRIGGER aws_inventory_create_guard BEFORE INSERT ON browser_instances
WHEN EXISTS(SELECT 1 FROM aws_provider_regions WHERE region_id=NEW.region_id)
BEGIN
  SELECT RAISE(ABORT,'aws_inventory_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM aws_region_inventory WHERE region_id=NEW.region_id AND availability='ready' AND quota_available>0
  );
END;
--> statement-breakpoint
DELETE FROM caps WHERE metric = 'running' AND scope LIKE 'user:%';
