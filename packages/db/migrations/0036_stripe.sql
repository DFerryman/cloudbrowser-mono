-- Stripe beside Creem (page 6; docs/deploy-cloudflare.md, "3b"). When Stripe's settings are valid
-- it takes every new top-up; Creem keeps processing its own checkouts, refunds and disputes, and
-- takes new top-ups again whenever Stripe is not configured. Every existing row belongs to Creem.
ALTER TABLE `topup_packs` ADD `provider` text NOT NULL DEFAULT 'creem';
--> statement-breakpoint
ALTER TABLE `topup_checkouts` ADD `provider` text NOT NULL DEFAULT 'creem';
--> statement-breakpoint
ALTER TABLE `webhook_events` ADD `provider` text NOT NULL DEFAULT 'creem';
--> statement-breakpoint
-- Each user's Stripe customer, linked on their first paid Stripe checkout and reused by later ones,
-- so every invoice is in one customer portal. Creem customers stay in `billing_customers`.
CREATE TABLE `stripe_customers` (
	`user_id` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_customers_stripe_customer_id_unique` ON `stripe_customers` (`stripe_customer_id`);
