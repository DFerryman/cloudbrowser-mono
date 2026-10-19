-- One limit per user: the browsers they may own (default 3), all of which may run at once.
-- A separate per-user running cap no longer exists. Region and global caps are untouched.
DELETE FROM caps WHERE metric = 'running' AND scope LIKE 'user:%';
--> statement-breakpoint
INSERT INTO caps (scope, metric, "limit") VALUES ('user:default', 'instances', 3)
  ON CONFLICT (scope, metric) DO UPDATE SET "limit" = 3;
--> statement-breakpoint
-- Checked inside the create's own transaction, so two creates sent at once by the same user
-- cannot both pass when only one slot is left. A user:<id> row overrides user:default.
CREATE TRIGGER user_browser_limit_guard BEFORE INSERT ON browser_instances
BEGIN
  SELECT RAISE(ABORT, 'user_browser_limit') WHERE
    (SELECT COUNT(*) FROM browser_instances WHERE user_id = NEW.user_id AND status NOT IN ('purged', 'failed', 'deleting'))
    >= COALESCE(
      (SELECT "limit" FROM caps WHERE scope = 'user:' || NEW.user_id AND metric = 'instances'),
      (SELECT "limit" FROM caps WHERE scope = 'user:default' AND metric = 'instances'),
      0);
END;
