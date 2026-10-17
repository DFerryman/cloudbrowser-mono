CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_target_idx` ON `audit_log` (`target`);--> statement-breakpoint
CREATE TABLE `browser_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`region_id` text NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`desired_state` text NOT NULL,
	`idle_timeout_s` integer NOT NULL,
	`locale` text NOT NULL,
	`screen` text NOT NULL,
	`fingerprint` text NOT NULL,
	`last_active_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`purge_after` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`region_id`) REFERENCES `regions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `instances_user_idx` ON `browser_instances` (`user_id`);--> statement-breakpoint
CREATE INDEX `instances_status_idx` ON `browser_instances` (`status`);--> statement-breakpoint
CREATE TABLE `caps` (
	`scope` text NOT NULL,
	`metric` text NOT NULL,
	`limit` integer NOT NULL,
	PRIMARY KEY(`scope`, `metric`)
);
--> statement-breakpoint
CREATE TABLE `control_flags` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`reason` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drift_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`executor` text NOT NULL,
	`region` text NOT NULL,
	`provider_id` text NOT NULL,
	`resource_kind` text,
	`instance_id` text,
	`status` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `drift_open_idx` ON `drift_findings` (`status`,`provider_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_user_idx` ON `events` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `fake_provider_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`region` text NOT NULL,
	`zone` text,
	`client_token` text,
	`state` text NOT NULL,
	`attrs` text NOT NULL,
	`tags` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fake_token_idx` ON `fake_provider_resources` (`client_token`);--> statement-breakpoint
CREATE INDEX `fake_region_idx` ON `fake_provider_resources` (`region`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`route` text NOT NULL,
	`operation_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `instance_health` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`last_heartbeat_at` integer,
	`viewers` integer DEFAULT 0 NOT NULL,
	`last_input_at` integer,
	`last_ip_check` text,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`email` text PRIMARY KEY NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ip_addresses` (
	`address` text PRIMARY KEY NOT NULL,
	`executor` text NOT NULL,
	`region_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`assigned_at` integer,
	`released_at` integer
);
--> statement-breakpoint
CREATE TABLE `operation_steps` (
	`operation_id` text NOT NULL,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`request_token` text NOT NULL,
	`result` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`operation_id`, `step`),
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`step` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`not_before` integer,
	`deadline_at` integer NOT NULL,
	`error_class` text,
	`error` text,
	`params` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_one_unfinished_idx` ON `operations` (`instance_id`) WHERE finished_at IS NULL;--> statement-breakpoint
CREATE INDEX `operations_pending_idx` ON `operations` (`finished_at`,`not_before`);--> statement-breakpoint
CREATE TABLE `placements` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`generation` integer NOT NULL,
	`executor` text NOT NULL,
	`provider_region` text NOT NULL,
	`zone` text,
	`vm_id` text,
	`volume_id` text,
	`network_id` text,
	`ip_allocation_id` text,
	`ip_address` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placements_instance_gen_idx` ON `placements` (`instance_id`,`generation`);--> statement-breakpoint
CREATE TABLE `quota_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`executor` text NOT NULL,
	`region` text NOT NULL,
	`metric` text NOT NULL,
	`limit` integer NOT NULL,
	`used` integer NOT NULL,
	`taken_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `regions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`country` text NOT NULL,
	`city` text NOT NULL,
	`timezone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`executor` text NOT NULL,
	`provider_region` text NOT NULL,
	`probe_url` text
);
--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text,
	`kind` text NOT NULL,
	`executor` text NOT NULL,
	`provider_id` text,
	`address` text,
	`region` text NOT NULL,
	`zone` text,
	`created_by_op` text,
	`request_token` text NOT NULL,
	`state` text NOT NULL,
	`tags` text NOT NULL,
	`monthly_cost_estimate_cents` integer DEFAULT 0 NOT NULL,
	`release_after` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resources_token_idx` ON `resources` (`request_token`);--> statement-breakpoint
CREATE INDEX `resources_instance_idx` ON `resources` (`instance_id`);--> statement-breakpoint
CREATE INDEX `resources_state_idx` ON `resources` (`state`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `spend_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`active_monthly_cents` integer NOT NULL,
	`running_hours_cents` integer NOT NULL,
	`projected_cents` integer NOT NULL,
	`taken_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `viewer_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`user_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`ended_at` integer,
	`country` text,
	`user_agent` text,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `viewer_sessions_instance_idx` ON `viewer_sessions` (`instance_id`,`last_seen_at`);