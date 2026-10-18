-- Keep existing browser region identities intact. Enable Sydney after AWS provisioning.
INSERT INTO regions (id, name, country, city, timezone, enabled, executor, provider_region, probe_url)
VALUES ('syd1', 'Sydney', 'AU', 'Sydney', 'Australia/Sydney', 0, 'aws-ec2', 'ap-southeast-2', NULL);
--> statement-breakpoint
INSERT INTO caps (scope, metric, "limit") VALUES
  ('region:syd1', 'instances', 3),
  ('region:syd1', 'running', 3);
