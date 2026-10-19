-- The global 10-minute create cap is a runaway guard for the whole service, not a per-user limit:
-- at the launch value of 5, one person setting up a handful of browsers paused creates for
-- everyone. Each user's browser limit and prepaid deposit already bound what one account can
-- create. A value an operator changed is kept.
UPDATE caps SET "limit" = 30 WHERE scope = 'global' AND metric = 'creates_per_10_min' AND "limit" = 5;
