-- Per-user storage defaults may exceed the public inventory estimate. Reserve the actual cost
-- in the same transaction as creation, so a larger browser cannot overspend the shared budget.
CREATE TRIGGER aws_inventory_actual_cost_guard BEFORE INSERT ON browser_instances
WHEN EXISTS(SELECT 1 FROM aws_provider_regions WHERE region_id=NEW.region_id)
BEGIN
  SELECT RAISE(ABORT,'aws_inventory_unavailable') WHERE EXISTS (
    SELECT 1 FROM aws_region_inventory i JOIN provider_prices p ON p.region_id=i.region_id
    WHERE i.region_id=NEW.region_id AND i.inventory_mode='budget' AND i.budget_remaining_micros <
      i.monthly_unit_micros + MAX(0, NEW.storage_gb - COALESCE((SELECT "limit" FROM caps WHERE scope='user:default' AND metric='storage_gb'),10)) * CAST(ceil(json_extract(p.sheet,'$.volumeGbMonth')*1000000) AS INTEGER)
  );
END;
