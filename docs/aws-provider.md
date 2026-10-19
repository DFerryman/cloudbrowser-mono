# AWS Provider

The Access-protected operator console has an **AWS Provider** tab at `/aws-provider`.
It shows the runtime and management account identities, organization accounts and costs, project
costs by region, AWS credit balances/sharing/expiry, quota usage, available inventory, sync times
and errors. Changes to inventory policy require a reason and are audited.

## AWS sources and refresh

| Data | Source | Refresh |
|---|---|---|
| Region list / opt-in state | EC2 DescribeRegions, all regions | Every 5 minutes |
| Display name / country | SSM public global infrastructure parameters | First discovery, daily, or manual refresh |
| Browser networks | EC2 DescribeVpcs/Subnets/SecurityGroups | Every 5 minutes |
| Machines and AZ availability | DescribeInstanceTypeOfferings / DescribeInstanceTypes | Every 5 minutes |
| Account quotas | Service Quotas GetServiceQuota | Every 5 minutes |
| Consumed IPs, CPU, storage, interfaces | Paginated EC2 describe APIs, including non-project resources | Every 5 minutes |
| Unit prices | AWS Price List GetProducts, including historical machine types | Every 12 hours or manual refresh |
| Organization / linked accounts / gross cost | Organizations and Cost Explorer | Every 6 hours or manual refresh |
| Account budget | AWS Budgets DescribeBudgets (`budgets:ViewBudget`), member account role | Every 6 hours or manual refresh |
| Credits | Billing GetCredits, using the management role | Every 6 hours or manual refresh |

Workers use a bounded, request-scoped client pool. Synchronizations take a D1 lease; manual
refreshes run through `cloudbrowser-aws-provider` rather than an HTTP request's background lifetime.
The API reaches the private reconciler through a service binding. There is no public sync URL.

Region and price data are not a local fixed list. The three compatible machine types, Ubuntu
baseline, storage defaults and cache lifetimes remain application configuration. Network setup
and enabling opt-in regions are infrastructure actions, not read-only API discovery. A new region
without a network, compatible offered machine, readable quotas or current prices has no inventory.
Legacy simulator regions and immutable existing browser placements are not rewritten.

## Inventory and budget semantics

Inventory is a conservative project admission estimate, not AWS physical spare-server capacity.
Each region is bounded by available Elastic IPs, Standard On-Demand vCPUs, gp3 GiB, regional ENIs
and subnet addresses. Existing project browsers reserve resources even while asleep; foreign and
orphan AWS resources consume quota. Local pending creates are counted before AWS reports them.

`aws_region_inventory` is both the public stock calculation and the source of transactional
creation triggers. The regional slot and shared budget are rechecked inside the same D1 batch as
the browser, operation, customer deposit and idempotency record. Two regions cannot independently
spend the same last budget slot. A larger per-user default disk reserves its actual extra cost.

Budget mode uses:

```
remaining = project monthly budget - AWS month-to-date cost - current browser commitments
available(region) = min(quota room, floor(remaining / estimated new-browser monthly cost))
```

Estimates reserve a full calendar month of compute (24 hours/day initially), public IP and disk
for every browser; this intentionally overlaps month-to-date spend. Credits never increase the
budget. A console budget override applies immediately; otherwise a single unfiltered monthly
USD COST budget from AWS is used. Missing or ambiguous AWS budgets do not imply unlimited money.
Traffic is variable and AWS billing is delayed, so an estimate cannot guarantee a final bill.

Quota observations expire after 20 minutes. Budget observations expire after 26 hours and cannot
cross into a new calendar month. New purchases stop after 48 hours without a good price refresh;
existing usage retains the last known price. Failed creates hold inventory until the reaper
confirms provider cleanup; retained/deleting browsers hold it until purge. Each browser still
obeys the existing per-user limits and prepaid requirements.

## Credentials

The deployments continue to use separate existing IAM users as bootstrap identities. Each may
assume only its own role, with an ExternalId restricted in the role trust policy:

| Worker | Role |
|---|---|
| Engine | `nevazu-provider-runtime`: tagged browser creation/start/stop, explicit delete deny |
| Reaper | `nevazu-provider-reaper`: tagged cleanup, explicit creation deny |
| Reconciler | `nevazu-provider-reader`: EC2 describe, quota/price/metadata and own account budget reads |
| Reconciler organization view | `nevazu-provider-management`: organization, cost and credit reads |

Configure `AWS_ROLE_ARN` and `AWS_ROLE_EXTERNAL_ID` on each deployment, plus
`AWS_MANAGEMENT_ROLE_ARN` / `AWS_MANAGEMENT_EXTERNAL_ID` on the reconciler. Keep these in Worker
secrets; the API and browser never receive credentials. STS sessions last one hour and refresh
five minutes before expiry. Concurrent requests coalesce. A failed refresh never falls back to
expired session credentials. Revoked authorization is recorded as an error and requires repair.

The bootstrap IAM keys have no automatic AWS expiration/rotation. Operators must rotate them in
Worker secrets. Changing the key or role takes effect on the next Worker invocation. CLI/console
sign-in expiration has no effect on these production roles.

Advanced-mode organization regional restrictions need exact exceptions for the actual EC2,
network CloudFormation and read-only quota/metadata APIs. Keep the managed-account security SCP
and all unrelated regional restrictions. SCP documents are limited to 5,120 bytes; the existing
three regional Deny statements may occupy separate policies to keep exact action lists instead
of broad service exceptions. Preserve the pre-change policies for rollback.

## Deploy and verify

Apply D1 migrations 0012 and 0013, create `cloudbrowser-aws-provider`, install the role references
and deploy engine, reaper, reconciler and API/web. Existing bootstrap keys and resource tags must
remain intact. The network-only template accepts discovered `AzA`, `AzB`, `AzC`; omitted zones
create no subnet. It intentionally opens no inbound traffic and blocks outbound SMTP.

Verify the console's actual account IDs, STS refresh/expiration timestamps, billing and catalog
timestamps, per-region status, quota usage and price freshness. Query `aws_provider_state`,
`aws_provider_regions` and `aws_region_inventory` for diagnosis without reading credential
secrets or user profile data. The user region picker shows available quantities and refetches
every 30 seconds and after lifecycle mutations. Priced requests still require the price version
the customer confirmed; a changed quote is refused for review.
