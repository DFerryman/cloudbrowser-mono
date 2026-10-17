CREATE TABLE `archive_keys` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`wrapped_key` text,
	`created_at` integer NOT NULL,
	`destroyed_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`location` text,
	`size_bytes` integer,
	`generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `backups_instance_idx` ON `backups` (`instance_id`,`created_at`);