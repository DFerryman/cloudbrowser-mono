-- Seven-day fixed-resource deposits remain part of the prepaid balance. They are only consumed
-- after usage is stopped; atomic triggers prevent two browsers reserving the same spendable money.
CREATE TABLE browser_reservations (
  instance_id text PRIMARY KEY NOT NULL REFERENCES browser_instances(id),
  user_id text NOT NULL REFERENCES user(id),
  required_micros integer NOT NULL,
  reserved_micros integer NOT NULL,
  fixed_hour_micros integer NOT NULL,
  rates text NOT NULL,
  retention_started_at integer,
  retention_ends_at integer,
  updated_at integer NOT NULL,
  CHECK (required_micros >= 0 AND reserved_micros >= 0 AND fixed_hour_micros >= 0)
);
--> statement-breakpoint
CREATE INDEX browser_reservations_user_idx ON browser_reservations(user_id);
--> statement-breakpoint
CREATE TRIGGER browser_reservations_funded_insert BEFORE INSERT ON browser_reservations
WHEN NEW.reserved_micros > 0 AND NEW.reserved_micros +
  coalesce((SELECT sum(reserved_micros) FROM browser_reservations WHERE user_id = NEW.user_id AND instance_id <> NEW.instance_id), 0) +
  CASE WHEN NEW.retention_started_at IS NULL THEN max(1, coalesce((SELECT min_balance_micros FROM pricing_settings WHERE id = 1), 1000000)) ELSE 0 END >
  coalesce((SELECT balance_micros FROM billing_accounts WHERE user_id = NEW.user_id), 0)
BEGIN SELECT RAISE(ABORT, 'insufficient_prepaid_reserve'); END;
--> statement-breakpoint
CREATE TRIGGER browser_reservations_funded_update BEFORE UPDATE ON browser_reservations
WHEN (NEW.reserved_micros > OLD.reserved_micros OR (NEW.retention_started_at IS NULL AND OLD.retention_started_at IS NOT NULL)) AND
  NEW.reserved_micros + coalesce((SELECT sum(reserved_micros) FROM browser_reservations WHERE user_id = NEW.user_id AND instance_id <> NEW.instance_id), 0) +
  CASE WHEN NEW.retention_started_at IS NULL THEN 1 ELSE 0 END >
  coalesce((SELECT balance_micros FROM billing_accounts WHERE user_id = NEW.user_id), 0)
BEGIN SELECT RAISE(ABORT, 'insufficient_prepaid_reserve'); END;
--> statement-breakpoint
-- Runtime between meter ticks is settled before sleep, so short sessions cannot evade billing.
ALTER TABLE instance_health ADD pending_compute_ms integer DEFAULT 0 NOT NULL;

--> statement-breakpoint
-- Keep fractional seconds across sleep/start cycles; reconnects never replenish trial time.
ALTER TABLE browser_instances ADD trial_used_ms integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE browser_instances SET trial_used_ms = trial_used_s * 1000;

--> statement-breakpoint
-- Retire the public daily-snapshot option without removing historic snapshots needed for cleanup.
UPDATE browser_instances SET backups_enabled = 0 WHERE backups_enabled = 1;
