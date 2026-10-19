-- Keeps an API Worker from before 0018/0019 working until the new one is deployed. The current
-- code ignores all of this: it reads only quota_available and availability from the view, and
-- no per-user running cap. The old API computes stock as min(quota, budget / unit) unless the
-- mode is 'quota', and refuses wakes when a user has no running cap.
DROP TRIGGER IF EXISTS aws_inventory_create_guard;
--> statement-breakpoint
DROP VIEW IF EXISTS aws_region_inventory;
--> statement-breakpoint
CREATE VIEW aws_region_inventory AS
SELECT a.region_id, a.checked_at, a.status,
  MAX(0, a.capacity - (SELECT COUNT(*) FROM aws_browser_commitments c WHERE c.region_id=a.region_id)) AS quota_available,
  CASE WHEN a.status!='ready' OR r.enabled=0 OR a.checked_at IS NULL OR a.checked_at < (unixepoch()*1000-1200000)
    OR p.fetched_at IS NULL OR p.fetched_at < (unixepoch()*1000-172800000) OR p.sheet IS NULL THEN 'unavailable'
    ELSE 'ready' END AS availability,
  'quota' AS inventory_mode, 1 AS monthly_unit_micros, 0 AS budget_remaining_micros
FROM aws_provider_regions a JOIN regions r ON r.id=a.region_id
LEFT JOIN provider_prices p ON p.region_id=a.region_id;
--> statement-breakpoint
CREATE TRIGGER aws_inventory_create_guard BEFORE INSERT ON browser_instances
WHEN EXISTS(SELECT 1 FROM aws_provider_regions WHERE region_id=NEW.region_id)
BEGIN
  SELECT RAISE(ABORT,'aws_inventory_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM aws_region_inventory WHERE region_id=NEW.region_id AND availability='ready' AND quota_available>0
  );
END;
--> statement-breakpoint
-- Same as the browser limit, so the old API lets every owned browser run at once.
INSERT INTO caps (scope, metric, "limit") SELECT 'user:default', 'running', "limit" FROM caps WHERE scope = 'user:default' AND metric = 'instances'
  ON CONFLICT (scope, metric) DO UPDATE SET "limit" = excluded."limit";
