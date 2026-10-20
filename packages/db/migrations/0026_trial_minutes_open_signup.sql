-- The free trial's running time is an operator setting (user:default / trial_minutes), 30
-- minutes unless changed. Each trial browser keeps the allowance it was created with, so a later
-- change applies to new trials only; trials that already exist keep their ten minutes.
ALTER TABLE `browser_instances` ADD `trial_seconds` integer NOT NULL DEFAULT 600;
--> statement-breakpoint
INSERT OR IGNORE INTO `caps` (`scope`, `metric`, `limit`) VALUES ('user:default', 'trial_minutes', 30);
--> statement-breakpoint
-- Sign-up is open: anyone with an email address can sign in. The operator can turn invite_only
-- back on, which limits codes and new accounts to addresses in `invites` again.
INSERT OR IGNORE INTO `control_flags` (`key`, `value`, `reason`, `updated_at`) VALUES ('invite_only', 'false', 'Sign-up opened to everyone', unixepoch() * 1000);
