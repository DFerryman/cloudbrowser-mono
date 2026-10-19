-- Launch outcomes per region and zone (engine): new browsers avoid zones that just ran out of
-- capacity, and the region list shows whether a region can take a browser now.
CREATE TABLE launch_health (
  region_id TEXT NOT NULL,
  zone TEXT NOT NULL,
  last_success_at INTEGER,
  last_capacity_at INTEGER,
  last_failure_at INTEGER,
  last_failure_class TEXT,
  last_failure TEXT,
  PRIMARY KEY (region_id, zone)
);
--> statement-breakpoint
-- Discovery stored every AWS region with timezone UTC and the provider's long name as the city
-- (and SSM's CN for Hong Kong). Use where each region's servers actually are.
UPDATE regions SET city = 'N. Virginia', country = 'US', timezone = 'America/New_York' WHERE executor = 'aws-ec2' AND provider_region = 'us-east-1';
--> statement-breakpoint
UPDATE regions SET city = 'Ohio', country = 'US', timezone = 'America/New_York' WHERE executor = 'aws-ec2' AND provider_region = 'us-east-2';
--> statement-breakpoint
UPDATE regions SET city = 'N. California', country = 'US', timezone = 'America/Los_Angeles' WHERE executor = 'aws-ec2' AND provider_region = 'us-west-1';
--> statement-breakpoint
UPDATE regions SET city = 'Oregon', country = 'US', timezone = 'America/Los_Angeles' WHERE executor = 'aws-ec2' AND provider_region = 'us-west-2';
--> statement-breakpoint
UPDATE regions SET city = 'Montreal', country = 'CA', timezone = 'America/Toronto' WHERE executor = 'aws-ec2' AND provider_region = 'ca-central-1';
--> statement-breakpoint
UPDATE regions SET city = 'Calgary', country = 'CA', timezone = 'America/Edmonton' WHERE executor = 'aws-ec2' AND provider_region = 'ca-west-1';
--> statement-breakpoint
UPDATE regions SET city = 'Querétaro', country = 'MX', timezone = 'America/Mexico_City' WHERE executor = 'aws-ec2' AND provider_region = 'mx-central-1';
--> statement-breakpoint
UPDATE regions SET city = 'São Paulo', country = 'BR', timezone = 'America/Sao_Paulo' WHERE executor = 'aws-ec2' AND provider_region = 'sa-east-1';
--> statement-breakpoint
UPDATE regions SET city = 'Dublin', country = 'IE', timezone = 'Europe/Dublin' WHERE executor = 'aws-ec2' AND provider_region = 'eu-west-1';
--> statement-breakpoint
UPDATE regions SET city = 'London', country = 'GB', timezone = 'Europe/London' WHERE executor = 'aws-ec2' AND provider_region = 'eu-west-2';
--> statement-breakpoint
UPDATE regions SET city = 'Paris', country = 'FR', timezone = 'Europe/Paris' WHERE executor = 'aws-ec2' AND provider_region = 'eu-west-3';
--> statement-breakpoint
UPDATE regions SET city = 'Frankfurt', country = 'DE', timezone = 'Europe/Berlin' WHERE executor = 'aws-ec2' AND provider_region = 'eu-central-1';
--> statement-breakpoint
UPDATE regions SET city = 'Zurich', country = 'CH', timezone = 'Europe/Zurich' WHERE executor = 'aws-ec2' AND provider_region = 'eu-central-2';
--> statement-breakpoint
UPDATE regions SET city = 'Stockholm', country = 'SE', timezone = 'Europe/Stockholm' WHERE executor = 'aws-ec2' AND provider_region = 'eu-north-1';
--> statement-breakpoint
UPDATE regions SET city = 'Milan', country = 'IT', timezone = 'Europe/Rome' WHERE executor = 'aws-ec2' AND provider_region = 'eu-south-1';
--> statement-breakpoint
UPDATE regions SET city = 'Aragón', country = 'ES', timezone = 'Europe/Madrid' WHERE executor = 'aws-ec2' AND provider_region = 'eu-south-2';
--> statement-breakpoint
UPDATE regions SET city = 'Tel Aviv', country = 'IL', timezone = 'Asia/Jerusalem' WHERE executor = 'aws-ec2' AND provider_region = 'il-central-1';
--> statement-breakpoint
UPDATE regions SET city = 'UAE', country = 'AE', timezone = 'Asia/Dubai' WHERE executor = 'aws-ec2' AND provider_region = 'me-central-1';
--> statement-breakpoint
UPDATE regions SET city = 'Bahrain', country = 'BH', timezone = 'Asia/Bahrain' WHERE executor = 'aws-ec2' AND provider_region = 'me-south-1';
--> statement-breakpoint
UPDATE regions SET city = 'Cape Town', country = 'ZA', timezone = 'Africa/Johannesburg' WHERE executor = 'aws-ec2' AND provider_region = 'af-south-1';
--> statement-breakpoint
UPDATE regions SET city = 'Hong Kong', country = 'HK', timezone = 'Asia/Hong_Kong' WHERE executor = 'aws-ec2' AND provider_region = 'ap-east-1';
--> statement-breakpoint
UPDATE regions SET city = 'Taipei', country = 'TW', timezone = 'Asia/Taipei' WHERE executor = 'aws-ec2' AND provider_region = 'ap-east-2';
--> statement-breakpoint
UPDATE regions SET city = 'Mumbai', country = 'IN', timezone = 'Asia/Kolkata' WHERE executor = 'aws-ec2' AND provider_region = 'ap-south-1';
--> statement-breakpoint
UPDATE regions SET city = 'Hyderabad', country = 'IN', timezone = 'Asia/Kolkata' WHERE executor = 'aws-ec2' AND provider_region = 'ap-south-2';
--> statement-breakpoint
UPDATE regions SET city = 'Tokyo', country = 'JP', timezone = 'Asia/Tokyo' WHERE executor = 'aws-ec2' AND provider_region = 'ap-northeast-1';
--> statement-breakpoint
UPDATE regions SET city = 'Seoul', country = 'KR', timezone = 'Asia/Seoul' WHERE executor = 'aws-ec2' AND provider_region = 'ap-northeast-2';
--> statement-breakpoint
UPDATE regions SET city = 'Osaka', country = 'JP', timezone = 'Asia/Tokyo' WHERE executor = 'aws-ec2' AND provider_region = 'ap-northeast-3';
--> statement-breakpoint
UPDATE regions SET city = 'Singapore', country = 'SG', timezone = 'Asia/Singapore' WHERE executor = 'aws-ec2' AND provider_region = 'ap-southeast-1';
--> statement-breakpoint
UPDATE regions SET city = 'Sydney', country = 'AU', timezone = 'Australia/Sydney' WHERE executor = 'aws-ec2' AND provider_region = 'ap-southeast-2';
--> statement-breakpoint
UPDATE regions SET city = 'Jakarta', country = 'ID', timezone = 'Asia/Jakarta' WHERE executor = 'aws-ec2' AND provider_region = 'ap-southeast-3';
--> statement-breakpoint
UPDATE regions SET city = 'Melbourne', country = 'AU', timezone = 'Australia/Melbourne' WHERE executor = 'aws-ec2' AND provider_region = 'ap-southeast-4';
--> statement-breakpoint
UPDATE regions SET city = 'Kuala Lumpur', country = 'MY', timezone = 'Asia/Kuala_Lumpur' WHERE executor = 'aws-ec2' AND provider_region = 'ap-southeast-5';
--> statement-breakpoint
UPDATE regions SET city = 'Auckland', country = 'NZ', timezone = 'Pacific/Auckland' WHERE executor = 'aws-ec2' AND provider_region = 'ap-southeast-6';
--> statement-breakpoint
UPDATE regions SET city = 'Bangkok', country = 'TH', timezone = 'Asia/Bangkok' WHERE executor = 'aws-ec2' AND provider_region = 'ap-southeast-7';
--> statement-breakpoint
-- Browsers keep their region's timezone in the fingerprint.
UPDATE browser_instances SET fingerprint = json_set(fingerprint, '$.timezone', (SELECT timezone FROM regions WHERE regions.id = browser_instances.region_id))
  WHERE json_extract(fingerprint, '$.timezone') = 'UTC'
    AND region_id IN (SELECT id FROM regions WHERE executor = 'aws-ec2' AND timezone <> 'UTC');
