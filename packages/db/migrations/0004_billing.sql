CREATE TABLE `active_usage` (
	`user_id` text NOT NULL,
	`month` text NOT NULL,
	`seconds` integer DEFAULT 0 NOT NULL,
	`exhausted_at` integer,
	PRIMARY KEY(`user_id`, `month`)
);
--> statement-breakpoint
CREATE TABLE `billing_customers` (
	`user_id` text PRIMARY KEY NOT NULL,
	`creem_customer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_customers_creem_customer_id_unique` ON `billing_customers` (`creem_customer_id`);--> statement-breakpoint
CREATE TABLE `checkout_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan` text NOT NULL,
	`browsers` integer NOT NULL,
	`checkout_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan` text NOT NULL,
	`product_id` text NOT NULL,
	`item_id` text,
	`units` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`current_period_end` integer,
	`past_due_since` integer,
	`access_ended_at` integer,
	`revoked_at` integer,
	`revoked_reason` text,
	`synced_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `subscriptions_user_idx` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
ALTER TABLE `instance_health` ADD `metered_at` integer;