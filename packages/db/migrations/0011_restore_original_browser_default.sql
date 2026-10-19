-- Keep removal of the daily creation quota, but undo the separately requested default change.
-- Only revert the value installed by 0010; preserve any newer operator setting or user override.
UPDATE `caps` SET `limit` = 2
  WHERE `scope` = 'user:default' AND `metric` = 'instances' AND `limit` = 5;
