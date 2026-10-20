-- The browser settings list 60 minutes as an auto-sleep choice, but the pilot cap seeded in 0001
-- (user:default / idle_timeout_max_s = 1800) greyed it out for everyone. Usage is prepaid by the
-- minute, so an hour of idle time is charged like any other running time. A value an operator
-- changed is kept.
UPDATE `caps` SET `limit` = 3600 WHERE `scope` = 'user:default' AND `metric` = 'idle_timeout_max_s' AND `limit` = 1800;
