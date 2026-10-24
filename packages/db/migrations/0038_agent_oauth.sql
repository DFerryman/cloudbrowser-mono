-- OAuth sign-in for coding agents, beside access keys (docs/agent-access.md, "OAuth sign-in"). An
-- agent adds the browser's MCP URL without a key and the owner approves it on nevazu.com, choosing
-- the permission and how long it lasts. The approval is an `automation_clients` row of kind `oauth`,
-- so the list, last use, sessions and every revoke path work as for keys. Apps are registered
-- (Dynamic Client Registration) or known by their Client ID Metadata Document, cached here.
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`client_uri` text,
	`redirect_uris` text NOT NULL,
	`software_id` text,
	`software_version` text,
	`created_at` integer NOT NULL,
	`fetched_at` integer,
	`last_used_at` integer
);
--> statement-breakpoint
-- One-time authorization codes: 60 s, single use, hashed.
CREATE TABLE `oauth_authorization_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`resource` text,
	`capability` text NOT NULL,
	`grant_days` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`grant_id` text,
	FOREIGN KEY (`instance_id`) REFERENCES `browser_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `oauth_authorization_codes_expires_idx` ON `oauth_authorization_codes` (`expires_at`);
--> statement-breakpoint
-- A sign-in's app, its rotating refresh token (and the one it replaced, for reuse detection) and
-- the end of its current access token. `credential_hash` holds the access token's hash and
-- `expires_at` the end the owner chose.
ALTER TABLE `automation_clients` ADD `oauth_client_id` text REFERENCES oauth_clients(id);
--> statement-breakpoint
ALTER TABLE `automation_clients` ADD `refresh_hash` text;
--> statement-breakpoint
ALTER TABLE `automation_clients` ADD `prev_refresh_hash` text;
--> statement-breakpoint
ALTER TABLE `automation_clients` ADD `refresh_rotated_at` integer;
--> statement-breakpoint
ALTER TABLE `automation_clients` ADD `access_expires_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_clients_refresh_idx` ON `automation_clients` (`refresh_hash`);
--> statement-breakpoint
CREATE INDEX `automation_clients_prev_refresh_idx` ON `automation_clients` (`prev_refresh_hash`);
