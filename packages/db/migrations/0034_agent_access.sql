-- Coding-agent access (docs/agent-access.md). `agent_access` is the owner's setting, chosen when
-- the browser is created (on by default) and changeable later; `agent_control` is who may drive
-- the browser: agent (a paired bridge may hold input), user (the user took over with a real input
-- and has not handed control back), privacy (as user, and no screenshots either). The VM reports
-- takeovers and the api writes the user's choices; the gateway reads both on every lease.
ALTER TABLE `browser_instances` ADD `agent_access` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `browser_instances` ADD `agent_control` text NOT NULL DEFAULT 'agent';
--> statement-breakpoint
-- A paired bridge: one row per pairing. Only hashes of the pairing code and credential are kept.
CREATE TABLE `automation_clients` (
  `id` text PRIMARY KEY NOT NULL,
  `instance_id` text NOT NULL REFERENCES `browser_instances`(`id`),
  `user_id` text NOT NULL,
  `name` text NOT NULL,
  `client_info` text,
  `pairing_hash` text,
  `pairing_expires_at` integer,
  `credential_hash` text,
  `created_at` integer NOT NULL,
  `activated_at` integer,
  `last_seen_at` integer,
  `revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `automation_clients_instance_idx` ON `automation_clients` (`instance_id`, `revoked_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_clients_pairing_idx` ON `automation_clients` (`pairing_hash`);
--> statement-breakpoint
-- One row per bridge connection admitted by the gateway (audit and the Settings page).
CREATE TABLE `automation_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `instance_id` text NOT NULL REFERENCES `browser_instances`(`id`),
  `client_id` text NOT NULL REFERENCES `automation_clients`(`id`),
  `user_id` text NOT NULL,
  `generation` integer NOT NULL,
  `started_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL,
  `ended_at` integer,
  `end_reason` text
);
--> statement-breakpoint
CREATE INDEX `automation_sessions_instance_idx` ON `automation_sessions` (`instance_id`, `ended_at`);
