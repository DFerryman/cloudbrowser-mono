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
| Machines and AZ availability | DescribeInstanceTypeOfferings / DescribeInstanceTypes for each tier's types (stored per zone and tier, so a launch never asks a zone for a type it does not offer; a region without a Premium type keeps taking Basic browsers) | Every 5 minutes |
| Account quotas | Service Quotas GetServiceQuota (a limit that cannot be read keeps the last one observed, for up to a week) | Every 5 minutes |
| Consumed IPs, CPU, storage, interfaces | Paginated EC2 describe APIs, including non-project resources | Every 5 minutes |
| Unit prices | AWS Price List GetProducts, including historical machine types | Every 12 hours or manual refresh |
| Organization / linked accounts / gross cost | Organizations and Cost Explorer | Every 6 hours or manual refresh |
| Credits | Billing GetCredits, using the management role | Every 6 hours or manual refresh |

Workers use a bounded, request-scoped client pool. A Worker invocation keeps at most six connections
open and queues the rest inside the runtime, where a request's timeout already runs; so all AWS
requests of a run share one limiter of four in flight (`RequestLimiter`, `MAX_AWS_REQUESTS`), and each
request's timeout starts when it is sent. Before that, a run reading six regions at once timed requests
out before they left: Service Quotas reads came back empty ("Required AWS quota is unavailable") and
Describe calls were "aborted due to timeout", in whichever regions were read together. Service Quotas
reads retry throttling, timeouts and 5xx like the EC2 reads; a limit that still cannot be read is taken
from the region's last snapshot (each quota records `limitAt`) for up to a week, logged as
`aws_sync.quota_fallback`; usage is always read live. A region still without a limit fails with the
quotas and reasons named, e.g. `Required AWS quota is unavailable: ebs/L-7A658B76: ThrottlingException`.
Each region is claimed with its own D1 lease
(`aws_provider_regions.sync_lease_until`), so runs may overlap without reading a region twice and a
slow region never makes later runs skip the others; billing alone takes the account lease
(`aws_provider_state.sync_lease_until`). Every 5-minute run refreshes regions whose snapshot is over
4 minutes old, oldest first, six at a time, and starts none after 3 minutes, leaving the rest to the
next run. A region's `checked_at` is when its quota and usage reads began, not when the run started.
A failed read keeps the last snapshot (`last_error`, `last_error_at`, `sync_failures` record it) until
it expires; only an answer that the region cannot host browsers (no network, no supported machine)
withdraws it at once. A region whose reads failed six times in a row (one AWS never answers in time,
one without the browser network) is read again every 30 minutes rather than every run, and at once
on a forced refresh. A region an operator disabled (`regions.enabled = 0`) with no browser left in
it is not read at all until it is enabled again or a refresh is forced: nothing can be created or
started there, and inventory alerts cover enabled regions only. Each run logs JSON lines
(`aws_sync.start` with the cron's start delay, `aws_sync.region_failed`, `aws_sync.billing_skipped`,
`aws_sync.done` with refreshed, failed, taken, deferred, resting and disabled regions and the
oldest snapshot's age) and stores its summary in
`aws_provider_state.last_run`. Manual refreshes run through `cloudbrowser-aws-provider` rather than
an HTTP request's background lifetime.
The API reaches the private reconciler through a service binding. There is no public sync URL.

Region and price data are not a local fixed list. The three compatible machine types, Ubuntu
baseline, storage defaults and cache lifetimes remain application configuration. Network setup
and enabling opt-in regions are infrastructure actions, not read-only API discovery. A new region
without a network, compatible offered machine, readable quotas or current prices has no inventory.
Legacy simulator regions and immutable existing browser placements are not rewritten.

## Inventory semantics

Inventory is how many more browsers AWS can allocate to this account in a region: the smallest
room under Elastic IPs, Standard On-Demand vCPUs, gp3 GiB, regional ENIs and subnet addresses,
divided by what one browser needs, minus the browsers that hold a slot. It is counted per tier
(migration 0029): every browser needs one IP, interface, subnet address and its disks, while the
vCPUs are one pool both tiers draw from, 2 per Basic browser and 4 per Premium browser (the
`basic_vcpus` / `premium_vcpus` the reconciler reads from DescribeInstanceTypes). The reconciler
stores the other dimensions' room in `capacity` and the vCPU room in `vcpu_capacity`;
`aws_region_inventory` gives `quota_available` (Basic) and `premium_available`. A region whose
zones offer no Premium type, or whose prices have no Premium machine, has no Premium stock. It is not limited by any
budget or by spend (migration 0018 removed the budget policy). Existing project browsers hold
their slot even while asleep, so they can always wake; foreign and orphan AWS resources consume
quota. Local pending creates are counted before AWS reports them. AWS physical capacity is only
known at launch (see launch outcomes below).

`aws_region_inventory` is both the public stock calculation and the source of the transactional
creation trigger `aws_inventory_create_guard`. D1 runs one transaction at a time, and the regional
slot is rechecked inside the same batch as the browser, operation, customer deposit and
idempotency record. When two people take the last slot at once, both may pass the earlier checks,
but the second transaction sees the first browser and is refused: nothing of it is written (no
deposit, operation or idempotency record), the API answers `409 region_unavailable` with
`limit: no_stock`, and the create dialog refreshes the region list.

Quota observations expire after 20 minutes. `aws_region_inventory.reason` says why a region is
unavailable: `stale` (snapshot expired), `sync_failed`, `pending` (never refreshed), `prices` or
`disabled`; NULL when ready. Only a ready region with `quota_available` 0 is out of AWS quota. A
stale or never-refreshed region comes back within minutes: the create API answers `limit: refreshing`
and the region picker shows `refreshing`. A failing refresh or missing prices need an operator, so
those regions show `closed`. Neither is shown as `no_stock`. Operator alerts (api cron) keep the kinds apart (out of AWS quota,
refresh behind, refresh failing with its error, prices missing), report a problem only after it has
lasted 10 minutes, put every region with the same problem in one alert (critical when the refresh is
behind or failing in every AWS region), and announce a recovery once it has held 10 minutes. New purchases stop after 48 hours without a good
price refresh; existing usage retains the last known price. Failed creates hold inventory until
the reaper confirms provider cleanup; retained/deleting browsers hold it until purge. Each browser
still obeys the per-user browser limit and prepaid requirements.

## What users see before creating

AWS publishes no live on-demand capacity, so the region list combines what is known:

- **Inventory** (above): no room under AWS quotas makes a region *Unavailable*.
- **Launch outcomes** (`launch_health`, written by the engine per region and zone): a capacity
  shortage in the last 30 minutes with no successful launch since makes the region *Limited*. A VM
  or disk the provider itself failed makes it *Unavailable*:
  - *Blocked* (`forbidden`): the account may not use the region's EBS encryption key (EC2 state
    reason `Client.InvalidKMSKey.*` or `Client.InternalError`, or an encrypted volume that EBS
    deletes; a start that falls back to stopped for that reason counts too), or AWS denies a
    create step there (`UnauthorizedOperation`, `AccessDenied`, `OptInRequired`, `Blocked`; bad
    credentials and our own guardrails do not count). Every launch would
    fail until IAM, an organization SCP or the key policy changes, so no user create is spent as
    a probe: admission and the engine's first create step refuse the region until an operator
    reopens it (AWS Provider → *Reopen*, audited, or deleting the region's `launch_health` rows)
    or a launch there succeeds. The organization SCPs are kept in `infra/aws/organization-scp/`.
  - *Paused* (any other provider failure): refused for 30 minutes; the next create is the probe.

  Errors from our own configuration never pause a region. New browsers start in the zone without
  a recent shortage and move to another zone on a capacity error.
- **Tested or not**: a region where a browser VM has started (`launch_health.last_success_at`)
  is *Tested*. One that only passed the configuration checks (network, offered machines, quotas,
  prices) shows *Not yet tested* to users and operators until its first launch succeeds.
  Migration 0016 counts a region as tested from history only if its last create there succeeded.
- **Latency**: the browser times `https://dynamodb.<region>.amazonaws.com/ping` (allowed in the
  CSP) and shows a distance estimate from Cloudflare's approximate location until it has measured.
- **Location**: city, country and timezone come from `AWS_REGION_FACTS`, not SSM (SSM has no city or
  timezone and reports Hong Kong as CN). The browser's timezone follows the region (`TZ` in the
  browser container).

The runtime role must allow both tiers' instance types where its policy lists them (Basic
`c7i-flex.large`, `c6i.large`, `c5.large`; Premium `c7i.xlarge`, `c6i.xlarge`, `c5.xlarge`). A
Premium launch that IAM or an SCP refuses fails that browser with an alert but does not mark the
region *Blocked*, so Basic browsers keep being created there.

## Credentials

The deployments continue to use separate existing IAM users as bootstrap identities. Each may
assume only its own role, with an ExternalId restricted in the role trust policy:

| Worker | Role |
|---|---|
| Engine | `nevazu-provider-runtime`: tagged browser creation/start/stop, explicit delete deny |
| Reaper | `nevazu-provider-reaper`: tagged cleanup, explicit creation deny |
| Reconciler | `nevazu-provider-reader`: EC2 describe, quota/price/metadata reads |
| Reconciler organization view | `nevazu-provider-management`: organization, cost and credit reads |

Configure `AWS_ROLE_ARN` and `AWS_ROLE_EXTERNAL_ID` on each deployment, plus
`AWS_MANAGEMENT_ROLE_ARN` / `AWS_MANAGEMENT_EXTERNAL_ID` on the reconciler. Keep these in Worker
secrets; the API and browser never receive credentials. STS sessions last one hour and renew
automatically five minutes before expiry; one session per isolate is shared by every invocation
and concurrent callers share one STS request. STS throttling, outages and network errors are
retried (three attempts, backing off); if renewal still fails, a session with more than a minute
left keeps being used, and an expired one never is. When AWS rejects a request's session
(`ExpiredToken`, `RequestExpired`), the session is renewed and the request sent once more; AWS did
nothing with the rejected request, so this is safe for creates too. A failed renewal is reported
as retryable (nothing was sent), or as forbidden when STS refuses the role. Revoked authorization
is recorded as an error and requires repair. The console's AWS page shows each role session's
expiry.

The bootstrap IAM keys have no automatic AWS expiration/rotation. Operators must rotate them in
Worker secrets. Changing the key or role takes effect on the next Worker invocation. CLI/console
sign-in expiration has no effect on these production roles.

Advanced-mode organization regional restrictions need exact exceptions for the actual EC2,
network CloudFormation and read-only quota/metadata APIs, and for the KMS calls EC2 makes as the
caller to encrypt, attach, start and restore disks (`kms:CreateGrant`, `kms:Decrypt`,
`kms:DescribeKey`, `kms:GenerateDataKeyWithoutPlaintext`, `kms:ReEncryptFrom`,
`kms:ReEncryptTo`), limited to the Nevazu account and `kms:ViaService` EC2. Without them every
encrypted disk fails outside the unrestricted regions. Keep the managed-account security SCP
and all unrelated regional restrictions. SCP documents are limited to 5,120 bytes; the existing
three regional Deny statements may occupy separate policies to keep exact action lists instead
of broad service exceptions. The current policies, their pre-change versions, a logic check and
the apply/rollback commands are in `infra/aws/organization-scp/`.

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
