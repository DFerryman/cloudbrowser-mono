-- Regions where a browser already launched count as tested from the last successful create there,
-- unless a create failed in the region after it: then the region starts as not yet tested.
INSERT INTO launch_health (region_id, zone, last_success_at)
SELECT b.region_id, '', MAX(o.finished_at)
FROM operations o JOIN browser_instances b ON b.id = o.instance_id
WHERE o.kind = 'create' AND o.status = 'succeeded' AND o.finished_at IS NOT NULL
GROUP BY b.region_id
HAVING MAX(o.finished_at) > COALESCE((
  SELECT MAX(f.created_at) FROM operations f JOIN browser_instances fb ON fb.id = f.instance_id
  WHERE fb.region_id = b.region_id AND f.kind = 'create' AND f.status = 'failed'), 0)
ON CONFLICT (region_id, zone) DO NOTHING;
