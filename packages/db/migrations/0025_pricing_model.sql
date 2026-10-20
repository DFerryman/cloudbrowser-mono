-- Pricing model (page 6). One markup per kind of cost instead of one for everything, starting at
-- the markup the operator already set so no price changes until they choose; markup_percent stays
-- the compute markup.
ALTER TABLE `pricing_settings` ADD `fixed_markup_percent` integer NOT NULL DEFAULT 120;
--> statement-breakpoint
ALTER TABLE `pricing_settings` ADD `transfer_markup_percent` integer NOT NULL DEFAULT 120;
--> statement-breakpoint
UPDATE `pricing_settings` SET `fixed_markup_percent` = `markup_percent`, `transfer_markup_percent` = `markup_percent`;
--> statement-breakpoint
-- The live view's video crosses Cloudflare's TURN relay, which bills $0.05 per GB it delivers. It
-- was not part of any price, so every streamed GB cost more than it was charged.
ALTER TABLE `pricing_settings` ADD `relay_gb_micros` integer NOT NULL DEFAULT 50000;
--> statement-breakpoint
-- AWS bills a VM while it boots and shuts down; only "running" was charged.
ALTER TABLE `pricing_settings` ADD `bill_transitions` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Creem's published fees (3.9% + $0.40), for the margin report and the minimum markup, unless set.
UPDATE `pricing_settings` SET `payment_fee_bps` = 390, `payment_fee_fixed_cents` = 40 WHERE `payment_fee_bps` = 0 AND `payment_fee_fixed_cents` = 0;
--> statement-breakpoint
-- Boot and shutdown time measured by the engine and not yet billed as running time.
ALTER TABLE `instance_health` ADD `transition_ms` integer NOT NULL DEFAULT 0;
