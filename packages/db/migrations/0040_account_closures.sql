-- Account closure (Terms sections 8 and 9). A user closes their own account from the Account page,
-- confirmed with an email code: every session ends and every browser is permanently deleted.
-- Closing refunds nothing by itself; a refund is agreed with support and paid out by hand. After 30
-- days the account's personal data is erased; billing records and Terms acceptances are kept, tied
-- to the anonymous user id. One row per closed account, never deleted.
--
-- status: `closing` while browsers are being deleted, `closed` once all are purged and the balance
-- is final. Then `balance_micros` is that balance, `paid_micros` the part of it that was paid for
-- (not signup or promotional credit), and `paid_orders` what refunding it in full would take on
-- each order: support's reference if the user asks for a refund. `erased_at` is set when the
-- personal data was erased and the balance left written off.
CREATE TABLE `account_closures` (
	`user_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`requested_at` integer NOT NULL,
	`browsers` integer DEFAULT 0 NOT NULL,
	`closed_at` integer,
	`balance_micros` integer,
	`paid_micros` integer,
	`paid_orders` text,
	`erased_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_closures_status_idx` ON `account_closures` (`status`);
--> statement-breakpoint
-- No new sign-in session for a closed account, whatever path creates it (email code, passkey, a
-- registration link, a future provider). The closure itself deletes the sessions that existed.
CREATE TRIGGER session_closed_account BEFORE INSERT ON session
WHEN EXISTS (SELECT 1 FROM account_closures WHERE user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_closed');
END;
