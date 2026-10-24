-- Consent to the Terms of Service before payment (page 6). Before a user's first top-up, and again
-- whenever TERMS_VERSION changes, the Billing page asks them to tick "I have read the Terms of
-- Service". The api records that once per user and version, in the same batch as the checkout
-- attempt, and refuses a checkout to anyone without a row for the current version. Both tables are
-- append-only: the triggers below refuse every UPDATE and DELETE, so the record stays auditable.
--
-- Each version's text, in every language, exactly as the site served it (apps/web writes it at
-- build time, its SHA-256 pinned beside TERMS_VERSION), stored the first time someone accepts it.
CREATE TABLE `terms_versions` (
	`version` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`document` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `terms_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`terms_version` text NOT NULL,
	`context` text NOT NULL,
	`topup_checkout_id` text,
	`ip` text,
	`country` text,
	`user_agent` text,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`terms_version`) REFERENCES `terms_versions`(`version`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topup_checkout_id`) REFERENCES `topup_checkouts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terms_acceptances_user_version_unique` ON `terms_acceptances` (`user_id`,`terms_version`);
--> statement-breakpoint
CREATE TRIGGER terms_versions_no_update BEFORE UPDATE ON terms_versions
BEGIN
  SELECT RAISE(ABORT, 'terms_versions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER terms_versions_no_delete BEFORE DELETE ON terms_versions
BEGIN
  SELECT RAISE(ABORT, 'terms_versions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER terms_acceptances_no_update BEFORE UPDATE ON terms_acceptances
BEGIN
  SELECT RAISE(ABORT, 'terms_acceptances is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER terms_acceptances_no_delete BEFORE DELETE ON terms_acceptances
BEGIN
  SELECT RAISE(ABORT, 'terms_acceptances is append-only');
END;
