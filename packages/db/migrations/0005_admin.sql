CREATE TABLE `admin_step_ups` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`challenge` text,
	`challenge_expires_at` integer,
	`verified_at` integer
);
--> statement-breakpoint
CREATE TABLE `admins` (
	`user_id` text PRIMARY KEY NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`acknowledged_at` integer,
	`acknowledged_by` text
);
--> statement-breakpoint
CREATE INDEX `alerts_open_idx` ON `alerts` (`acknowledged_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_user_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credential_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
ALTER TABLE `browser_instances` ADD `suspended_at` integer;--> statement-breakpoint
ALTER TABLE `browser_instances` ADD `suspended_reason` text;