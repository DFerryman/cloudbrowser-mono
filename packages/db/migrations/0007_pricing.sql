-- Prices and prepaid billing (page 6). Provider prices are read from the AWS Price List API by the
-- engine; customers pay them times the markup in `pricing_settings` from a prepaid balance.
-- The subscription tables were never used in production (Creem was not configured) and go.
DROP TABLE IF EXISTS `subscriptions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `checkout_attempts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `active_usage`;
--> statement-breakpoint
DELETE FROM `caps` WHERE `scope` LIKE 'billing:%' OR `metric` = 'hours_per_month';
--> statement-breakpoint
CREATE TABLE `provider_prices` (
	`region_id` text PRIMARY KEY NOT NULL,
	`executor` text NOT NULL,
	`provider_region` text NOT NULL,
	`sheet` text,
	`fetched_at` integer,
	`last_error` text,
	`last_error_at` integer,
	FOREIGN KEY (`region_id`) REFERENCES `regions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pricing_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`markup_percent` integer NOT NULL,
	`min_balance_micros` integer NOT NULL,
	`low_balance_micros` integer NOT NULL,
	`payment_fee_bps` integer DEFAULT 0 NOT NULL,
	`payment_fee_fixed_cents` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
INSERT INTO `pricing_settings` (`id`, `markup_percent`, `min_balance_micros`, `low_balance_micros`, `updated_at`)
VALUES (1, 120, 1000000, 2000000, unixepoch() * 1000);
--> statement-breakpoint
CREATE TABLE `billing_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance_micros` integer DEFAULT 0 NOT NULL,
	`exhausted_at` integer,
	`frozen_at` integer,
	`frozen_reason` text,
	`low_notified_at` integer,
	`trial_used_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `balance_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_micros` integer NOT NULL,
	`reference` text NOT NULL,
	`product_id` text,
	`description` text,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	`applied_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_transactions_reference_unique` ON `balance_transactions` (`reference`);
--> statement-breakpoint
CREATE INDEX `balance_tx_user_idx` ON `balance_transactions` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`instance_id` text NOT NULL,
	`user_id` text NOT NULL,
	`region_id` text NOT NULL,
	`item` text NOT NULL,
	`day` text NOT NULL,
	`unit_price_micros` integer NOT NULL,
	`unit_cost_micros` integer NOT NULL,
	`quantity` real NOT NULL,
	`amount_micros` integer NOT NULL,
	`cost_micros` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`instance_id`, `item`, `day`, `unit_price_micros`, `unit_cost_micros`),
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `usage_user_day_idx` ON `usage_records` (`user_id`,`day`);
--> statement-breakpoint
CREATE TABLE `topup_packs` (
	`product_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `topup_checkouts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`checkout_id` text,
	`credited_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Existing browsers keep their 20 GB volumes and their daily snapshots; new ones start at 10 GB
-- with snapshots off until the user turns them on.
ALTER TABLE `browser_instances` ADD `storage_gb` integer DEFAULT 10 NOT NULL;
--> statement-breakpoint
ALTER TABLE `browser_instances` ADD `backups_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `browser_instances` SET `storage_gb` = 20, `backups_enabled` = 1;
--> statement-breakpoint
-- The one free trial browser per user (page 6).
ALTER TABLE `browser_instances` ADD `trial_state` text;
--> statement-breakpoint
ALTER TABLE `browser_instances` ADD `trial_used_s` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `browser_instances` ADD `trial_reclaim_at` integer;
--> statement-breakpoint
ALTER TABLE `instance_health` ADD `base_metered_at` integer;
--> statement-breakpoint
ALTER TABLE `instance_health` ADD `disk_used_bytes` integer;
--> statement-breakpoint
ALTER TABLE `instance_health` ADD `disk_total_bytes` integer;
--> statement-breakpoint
ALTER TABLE `instance_health` ADD `disk_reported_at` integer;
--> statement-breakpoint
ALTER TABLE `instance_health` ADD `net_tx_bytes` integer;
--> statement-breakpoint
ALTER TABLE `instance_health` ADD `net_tx_billed_bytes` integer;
--> statement-breakpoint
ALTER TABLE `instance_health` ADD `agent_version` text;
--> statement-breakpoint
-- A new browser's data volume and the most it can grow to (users can add storage, page 4).
INSERT OR REPLACE INTO `caps` (`scope`, `metric`, `limit`) VALUES
  ('user:default', 'storage_gb', 10),
  ('user:default', 'storage_max_gb', 100);
