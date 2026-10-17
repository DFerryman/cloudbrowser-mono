-- Regions (page 2, "Regions"). Both start on the `fake` executor; switch `executor` and
-- `provider_region` once a real executor is chosen by the trial (page 9).
INSERT INTO `regions` (`id`, `name`, `country`, `city`, `timezone`, `enabled`, `executor`, `provider_region`, `probe_url`) VALUES
  ('tyo1', 'Tokyo', 'JP', 'Tokyo', 'Asia/Tokyo', 1, 'fake', 'ap-northeast-1', NULL),
  ('usw1', 'US West', 'US', 'West', 'America/Los_Angeles', 1, 'fake', 'us-west-2', NULL);
--> statement-breakpoint
-- Pilot limits (page 12, "Pilot limits"). Change them with SQL; no deploy needed.
INSERT INTO `caps` (`scope`, `metric`, `limit`) VALUES
  ('user:default', 'instances', 2),
  ('user:default', 'running', 1),
  ('user:default', 'creates_per_day', 3),
  ('user:default', 'ip_changes_per_month', 1),
  ('user:default', 'idle_timeout_max_s', 1800),
  ('region:tyo1', 'instances', 8),
  ('region:tyo1', 'running', 5),
  ('region:usw1', 'instances', 4),
  ('region:usw1', 'running', 3),
  ('global', 'instances', 10),
  ('global', 'running', 6),
  ('global', 'creates_per_10_min', 5),
  ('global', 'spend_budget_cents', 40000),
  ('global', 'quota_headroom_min', 2);
--> statement-breakpoint
-- An instance's region never changes (page 2, data model).
CREATE TRIGGER `browser_instances_region_immutable`
BEFORE UPDATE OF `region_id` ON `browser_instances`
WHEN NEW.`region_id` IS NOT OLD.`region_id`
BEGIN
  SELECT RAISE(ABORT, 'region_id is immutable');
END;
--> statement-breakpoint
-- An address that was ever ours is never given to a different instance (page 3).
CREATE TRIGGER `ip_addresses_instance_immutable`
BEFORE UPDATE OF `instance_id` ON `ip_addresses`
WHEN NEW.`instance_id` IS NOT OLD.`instance_id`
BEGIN
  SELECT RAISE(ABORT, 'ip_addresses.instance_id is immutable');
END;
