-- Account limits bound current browser instances, not the number created over a day.
-- Keep individual account overrides; update only the shared default.
INSERT INTO `caps` (`scope`, `metric`, `limit`) VALUES ('user:default', 'instances', 5)
  ON CONFLICT (`scope`, `metric`) DO UPDATE SET `limit` = excluded.`limit`;
--> statement-breakpoint
DELETE FROM `caps` WHERE `metric` = 'creates_per_day' AND `scope` LIKE 'user:%';
