-- Account closure (Terms sections 8 and 9). A user closes their own account from the Account page,
-- confirmed with an email code: every session ends, every browser is permanently deleted, and the
-- unused paid credit is refunded by an operator. Once the refund is recorded (or after 30 days),
-- the account's personal data is erased; billing records and Terms acceptances are kept, tied to
-- the anonymous user id. One row per closed account, never deleted.
--
-- status: `closing` while browsers are being deleted, `refund_due` once the refund is fixed and
-- waits for an operator, `closed` when nothing more is owed. `erased_at` is set when the personal
-- data was erased, which can come before `closed` if a refund is still owed after 30 days.
CREATE TABLE `account_closures` (
	`user_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`requested_at` integer NOT NULL,
	`browsers` integer DEFAULT 0 NOT NULL,
	`refund_micros` integer,
	`refund_plan` text,
	`refund_due_at` integer,
	`refund_recorded_at` integer,
	`refund_recorded_by` text,
	`erased_at` integer,
	`closed_at` integer,
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
