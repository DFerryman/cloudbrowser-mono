-- Coding agents connect without installing anything (docs/agent-access.md): a remote MCP server on
-- the session gateway, authenticated by a per-browser access key the owner creates in Settings.
-- Keys reuse `automation_clients` and its credential hash, so credentials of the retired local
-- bridge keep working as keys. `kind` tells them apart; `key_prefix` (nvzk_ and six characters)
-- identifies a key in the list without revealing it; `capability` view keys only observe;
-- `last_client` and `last_ip` show the owner what used a key last.
ALTER TABLE `automation_clients` ADD `kind` text NOT NULL DEFAULT 'bridge';
--> statement-breakpoint
ALTER TABLE `automation_clients` ADD `key_prefix` text;
--> statement-breakpoint
ALTER TABLE `automation_clients` ADD `expires_at` integer;
--> statement-breakpoint
ALTER TABLE `automation_clients` ADD `capability` text NOT NULL DEFAULT 'control';
--> statement-breakpoint
ALTER TABLE `automation_clients` ADD `last_client` text;
--> statement-breakpoint
ALTER TABLE `automation_clients` ADD `last_ip` text;
--> statement-breakpoint
-- The gateway looks a key up by its hash on every MCP request.
CREATE INDEX `automation_clients_credential_idx` ON `automation_clients` (`credential_hash`);
--> statement-breakpoint
-- Pairing codes are gone: one that was never redeemed can no longer be, so it is revoked.
UPDATE `automation_clients` SET `revoked_at` = unixepoch() * 1000, `pairing_hash` = NULL
  WHERE `pairing_hash` IS NOT NULL AND `activated_at` IS NULL AND `revoked_at` IS NULL;
