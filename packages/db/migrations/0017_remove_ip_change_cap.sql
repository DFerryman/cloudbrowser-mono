-- Requesting a new IP for an existing browser was removed; its monthly cap has nothing to limit.
DELETE FROM caps WHERE metric = 'ip_changes_per_month';
