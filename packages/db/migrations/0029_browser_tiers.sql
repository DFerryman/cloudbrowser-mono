-- Machine tiers (contracts TIERS): every browser so far is Basic (2 vCPU / 4 GB, up to 25 fps).
-- Premium runs on 4 vCPU / 8 GB and streams at up to 60 fps. A browser's tier never changes.
ALTER TABLE `browser_instances` ADD `tier` text NOT NULL DEFAULT 'basic';
--> statement-breakpoint
CREATE TRIGGER `browser_instances_tier_immutable`
BEFORE UPDATE OF `tier` ON `browser_instances`
WHEN NEW.`tier` IS NOT OLD.`tier`
BEGIN
  SELECT RAISE(ABORT, 'tier is immutable');
END;
--> statement-breakpoint
-- Premium is off until an operator turns it on (console → Limits), after the AWS stack allows its
-- machine types and the browser image with the 60 fps stream is published (docs/aws.md).
INSERT OR IGNORE INTO `caps` (`scope`, `metric`, `limit`) VALUES ('user:default', 'premium', 0);
--> statement-breakpoint
-- Inventory per tier. The reconciler now stores the room every dimension but vCPUs allows in
-- `capacity` (browsers), the vCPUs the account can give its browsers in `vcpu_capacity`, and
-- what one browser of each tier needs. NULL vcpu_capacity: written by an older reconciler, whose
-- `capacity` already counted Basic vCPUs; Premium then has no stock.
ALTER TABLE `aws_provider_regions` ADD `vcpu_capacity` integer;
--> statement-breakpoint
ALTER TABLE `aws_provider_regions` ADD `basic_vcpus` integer NOT NULL DEFAULT 2;
--> statement-breakpoint
ALTER TABLE `aws_provider_regions` ADD `premium_vcpus` integer NOT NULL DEFAULT 4;
--> statement-breakpoint
-- 1 once the region offers a Premium machine in one of the browser network's zones.
ALTER TABLE `aws_provider_regions` ADD `premium_offered` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DROP TRIGGER IF EXISTS aws_inventory_create_guard;
--> statement-breakpoint
DROP VIEW IF EXISTS aws_region_inventory;
--> statement-breakpoint
DROP VIEW IF EXISTS aws_browser_commitments;
--> statement-breakpoint
-- Every browser that holds AWS resources, or will: asleep ones keep their IP and disk and need
-- their vCPUs back to wake. A failed create holds its slot until the reaper confirms cleanup.
CREATE VIEW aws_browser_commitments AS
SELECT b.id, b.region_id, b.tier
FROM browser_instances b JOIN regions r ON r.id=b.region_id
WHERE r.executor='aws-ec2' AND b.status!='purged' AND (b.status!='failed' OR b.provider_released_at IS NULL);
--> statement-breakpoint
-- New browsers each tier can still get: one slot of every other dimension, and the tier's vCPUs
-- out of what committed browsers of both tiers leave.
CREATE VIEW aws_region_inventory AS
SELECT region_id, checked_at, status, availability, premium_offered,
  MAX(0, MIN(capacity - browsers,
    CASE WHEN vcpu_capacity IS NULL THEN capacity - browsers ELSE (vcpu_capacity - vcpus_held) / basic_vcpus END)) AS quota_available,
  CASE WHEN vcpu_capacity IS NULL OR premium_offered = 0 THEN 0
    ELSE MAX(0, MIN(capacity - browsers, (vcpu_capacity - vcpus_held) / premium_vcpus)) END AS premium_available
FROM (
  SELECT a.region_id, a.checked_at, a.status, a.capacity, a.vcpu_capacity, a.basic_vcpus, a.premium_vcpus, a.premium_offered,
    (SELECT COUNT(*) FROM aws_browser_commitments c WHERE c.region_id=a.region_id) AS browsers,
    (SELECT COALESCE(SUM(CASE WHEN c.tier='premium' THEN a.premium_vcpus ELSE a.basic_vcpus END), 0)
      FROM aws_browser_commitments c WHERE c.region_id=a.region_id) AS vcpus_held,
    CASE WHEN a.status!='ready' OR r.enabled=0 OR a.checked_at IS NULL OR a.checked_at < (unixepoch()*1000-1200000)
      OR p.fetched_at IS NULL OR p.fetched_at < (unixepoch()*1000-172800000) OR p.sheet IS NULL THEN 'unavailable'
      ELSE 'ready' END AS availability
  FROM aws_provider_regions a JOIN regions r ON r.id=a.region_id
  LEFT JOIN provider_prices p ON p.region_id=a.region_id
);
--> statement-breakpoint
-- Checked inside the create's own D1 transaction, after every earlier create committed: when
-- two people take the last slot at once, the second insert sees the first and is refused.
CREATE TRIGGER aws_inventory_create_guard BEFORE INSERT ON browser_instances
WHEN EXISTS(SELECT 1 FROM aws_provider_regions WHERE region_id=NEW.region_id)
BEGIN
  SELECT RAISE(ABORT,'aws_inventory_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM aws_region_inventory WHERE region_id=NEW.region_id AND availability='ready'
      AND (CASE WHEN COALESCE(NEW.tier,'basic')='premium' THEN premium_available ELSE quota_available END) > 0
  );
END;
