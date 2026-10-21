-- Replace region-limited timed trials with a once-only registration credit.
-- Historical trial columns stay inert for rolling Worker deployments and old usage records.
DELETE FROM caps WHERE metric = 'trial_minutes';
--> statement-breakpoint
INSERT OR IGNORE INTO caps (scope, metric, `limit`) VALUES ('user:default', 'signup_credit_cents', 200);
--> statement-breakpoint
-- Registration creates a verified user only after the single-use email link is confirmed.
-- This trigger commits the user, credit and ledger entry atomically, without an asynchronous
-- post-registration hook or any backfill for existing users. A zero setting creates no award.
CREATE TRIGGER user_signup_credit AFTER INSERT ON user
WHEN NEW.email_verified = 1 AND coalesce((SELECT `limit` FROM caps WHERE scope = 'user:default' AND metric = 'signup_credit_cents'), 200) > 0
BEGIN
  INSERT OR IGNORE INTO billing_accounts (user_id, balance_micros, updated_at) VALUES (NEW.id, 0, NEW.created_at);
  INSERT INTO balance_transactions (id, user_id, kind, amount_micros, reference, currency, description, actor, created_at, applied_at)
  VALUES ('signup:' || NEW.id, NEW.id, 'signup',
    max(0, coalesce((SELECT `limit` FROM caps WHERE scope = 'user:default' AND metric = 'signup_credit_cents'), 200)) * 10000,
    'signup:' || NEW.id, 'USD', 'Signup credit', 'system:signup', NEW.created_at, NEW.created_at);
  UPDATE billing_accounts SET balance_micros = balance_micros + (SELECT amount_micros FROM balance_transactions WHERE reference = 'signup:' || NEW.id), updated_at = NEW.created_at
  WHERE user_id = NEW.id;
END;
