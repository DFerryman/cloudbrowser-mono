-- Never sleep is its own operator setting (1 = offered to paid, topped-up accounts; 0 = not
-- offered), rather than an idle timeout of 0 that slips under idle_timeout_max_s.
INSERT OR IGNORE INTO `caps` (`scope`, `metric`, `limit`) VALUES ('user:default', 'never_sleep', 1);
--> statement-breakpoint
-- Free trial browsers always auto-sleep: any that chose never sleep return to the trial timeout.
UPDATE `browser_instances` SET `idle_timeout_s` = 300 WHERE `idle_timeout_s` = 0 AND `trial_state` IN ('active', 'ended');
--> statement-breakpoint
-- Funded-time warnings (24 h, 6 h, 1 h): the most urgent one sent while credit keeps falling.
ALTER TABLE `billing_accounts` ADD `runway_warned_hours` integer;
--> statement-breakpoint
-- Emails the engine cannot send itself (unexpected stops, paused networks). The api's billing
-- sweep sends and stamps them; the id is a dedupe key, so one event is mailed once.
CREATE TABLE `user_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`instance_id` text,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `user_notices_pending_idx` ON `user_notices` (`sent_at`, `created_at`);
