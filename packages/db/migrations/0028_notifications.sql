-- Notifications: what each user and operator notice last said, so it is sent once per occurrence
-- and user emails keep a minimum spacing (see apps/api/src/notifications).
CREATE TABLE `notification_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Reward-credited emails. Rewards credited before this release were already shown in the app.
ALTER TABLE `promotion_completions` ADD `notified_at` integer;
--> statement-breakpoint
UPDATE `promotion_completions` SET `notified_at` = `credited_at` WHERE `credited_at` IS NOT NULL;
