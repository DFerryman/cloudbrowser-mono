-- Two-factor sign-in with an authenticator app (Better Auth two-factor plugin, TOTP).
ALTER TABLE `user` ADD `two_factor_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE `two_factor` (
  `id` text PRIMARY KEY NOT NULL,
  `secret` text NOT NULL,
  `backup_codes` text NOT NULL,
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `verified` integer DEFAULT true NOT NULL,
  `failed_verification_count` integer DEFAULT 0 NOT NULL,
  `locked_until` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `two_factor_user_idx` ON `two_factor` (`user_id`);
