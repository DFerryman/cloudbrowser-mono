CREATE TABLE `agent_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`reply` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_commands_pending_idx` ON `agent_commands` (`instance_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_credentials` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`bootstrap_hash` text,
	`bootstrap_expires_at` integer,
	`credential_hash` text,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`rotated_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `viewer_tokens` (
	`jti` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`redeemed_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `instance_health` ADD `agent_ready_generation` integer;--> statement-breakpoint
ALTER TABLE `instance_health` ADD `agent_ready_at` integer;--> statement-breakpoint
ALTER TABLE `instance_health` ADD `chrome_major` integer;