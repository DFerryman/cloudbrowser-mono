# Deploying to Cloudflare

Everything in the control plane runs on Cloudflare. Five Workers share one D1 database:

| Worker | Config | Public? | Triggers | Cloudflare products |
|---|---|---|---|---|
| `cloudbrowser` (api + web) | `apps/api/wrangler.jsonc` | Yes: your app domain | HTTP, Queue (billing), cron every 5 min | Static assets, D1, Email Service, Queues (producer + billing consumer), Durable Object binding, Rate Limiting |
| `cloudbrowser-engine` | `apps/engine/wrangler.jsonc` | No | Queue, cron every minute, service binding | D1, Queues (consumer + producer), Durable Object `EventHub`, R2 (presigned archive URLs) |
| `cloudbrowser-reaper` | `apps/engine/wrangler.reaper.jsonc` | No | cron every minute | D1, Durable Object binding, R2 (deletes archives) |
| `cloudbrowser-reconciler` | `apps/reconciler/wrangler.jsonc` | No | cron every 5 min | D1 |
| `cloudbrowser-gateway` | `apps/gateway/wrangler.jsonc` | Yes: `connect.` domain | HTTP (WebSocket), Queue | Durable Object `InstanceGateway`, Queues (consumer), service binding to the api's `Internal` entrypoint, D1 |

## Prerequisites

- **Workers Paid plan.** Email Service can only send to arbitrary recipients on Workers Paid
  (3,000 emails/month included). Queues, Durable Objects, D1 and Rate Limiting also work on Free,
  but SSE streams and a 1-minute cron fit Paid better.
- **Your domain on Cloudflare DNS**, needed by Email Service and for the custom domain.

## 1. Create the resources

```bash
pnpm install
cd apps/api
pnpm exec wrangler login
pnpm exec wrangler d1 create cloudbrowser
pnpm exec wrangler queues create cloudbrowser-operations
pnpm exec wrangler queues create cloudbrowser-agent-commands
pnpm exec wrangler queues create cloudbrowser-billing
pnpm exec wrangler r2 bucket create cloudbrowser-archives
```

Copy the D1 `database_id` into **all five** configs (each has the placeholder
`00000000-0000-0000-0000-000000000000`): `apps/api/wrangler.jsonc`, `apps/engine/wrangler.jsonc`,
`apps/engine/wrangler.reaper.jsonc`, `apps/reconciler/wrangler.jsonc`, `apps/gateway/wrangler.jsonc`.

## 2. Email Service (sign-in codes)

Dashboard → **Email Service** → **Email Sending** → onboard your domain (e.g. `example.com`). It
adds the SPF/DKIM/DMARC records to your Cloudflare DNS. Until a domain is onboarded, the binding can
only send to verified destination addresses in your account, which is enough for a first test.

## 3. Configuration

`apps/api/wrangler.jsonc` → `vars`:

| Var | Set to |
|---|---|
| `APP_URL` | Your public origin, e.g. `https://app.example.com`. It is the auth base URL and the only trusted origin. |
| `ENVIRONMENT` | `production` (`development` also prints sign-in codes to the log). |
| `EMAIL_FROM` | A sender on the onboarded domain, e.g. `no-reply@example.com`. |

Secrets and keys:

```bash
cd apps/api
openssl rand -base64 48 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
node ../../scripts/gen-viewer-keys.mjs        # prints an Ed25519 key pair for viewer tokens
pnpm exec wrangler secret put VIEWER_TOKEN_PRIVATE_KEY      # paste the private JWK
cd ../engine
openssl rand -base64 48 | pnpm exec wrangler secret put BOOTSTRAP_SECRET   # derives agent bootstrap tokens
```

- `apps/gateway/wrangler.jsonc` → `VIEWER_TOKEN_PUBLIC_KEY`: the public JWK (not secret).
- `apps/api/wrangler.jsonc` and `apps/engine/wrangler.jsonc` → `GATEWAY_URL`: `wss://connect.example.com`.
- **TURN (live view):** Dashboard → Realtime → TURN → create a key, then on the api Worker set
  `TURN_KEY_ID` (var) and `TURN_KEY_API_TOKEN` (secret). Without them viewers get no relay servers.

**Profile archives (R2).** Each sleep uploads an encrypted archive of the Chrome profile; the VM
uploads straight to R2 through a 15-minute presigned URL, so the engine needs an R2 S3 API token:

1. Dashboard → R2 → **Manage API tokens** → *Create API token*: permission **Object Read & Write**,
   limited to the bucket `cloudbrowser-archives`. Note the Access Key ID and Secret Access Key.
2. `apps/engine/wrangler.jsonc` → `R2_ACCOUNT_ID`: your account id (R2 overview page).
   `R2_ARCHIVE_BUCKET` is already `cloudbrowser-archives`.
3. Secrets:

```bash
cd apps/engine
pnpm exec wrangler secret put R2_ACCESS_KEY_ID
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
openssl rand -base64 32 > /tmp/archive-master-key          # keep a copy in your password manager
pnpm exec wrangler secret put ARCHIVE_MASTER_KEY < /tmp/archive-master-key
cd ../api
pnpm exec wrangler secret put ARCHIVE_MASTER_KEY < /tmp/archive-master-key   # the same value
rm /tmp/archive-master-key
```

`ARCHIVE_MASTER_KEY` wraps each browser's own archive key; the api unwraps it only for the gateway
as it delivers an archive or restore command. Losing it makes every archive unreadable (snapshots
are unaffected); never rotate it by overwriting. Until all of these are set, archives are skipped
and only the daily provider snapshots are taken. The reaper's `ARCHIVES` R2 binding deletes
expired archives and needs no token.

Optional:
- `ratelimits` in `apps/api/wrangler.jsonc`: `namespace_id` values `1001`/`1002` must be unique in
  your account (change them if you already use those). Limits: 5 sign-in requests per minute per IP
  and per email; 60 API writes per minute per user.
- `ENV_NAME` (`prod`/`staging`) in the engine, reaper and reconciler configs: the `cb:env` tag on
  provider resources, same value in all three.

## 3b. Prices and billing with Creem

**Prices** come from the AWS Price List API; nothing is configured here. The engine refreshes
each AWS region's sheet every 12 hours (the runtime IAM user needs `pricing:GetProducts`, in the
CloudFormation template since this release). Set the **markup** (customer price = AWS cost ×
markup, default 120%), the minimum balance to start browsers and the low-balance warning in the
operator console → *Pricing & margin*, which also shows each region's cost and price and can
refresh prices now.

**Billing** is a prepaid balance. Only the one ten-minute trial may run without funded credit.
Missing payment-provider settings do not grant free paid-browser use. Top-ups turn on when every value below is set; until then
`/v1/billing/checkout` answers 503.

1. **Creem dashboard (test mode first):** create one **one-time** product in **USD** per top-up
   amount, e.g. *Credit $10*, *Credit $25*, *Credit $50*, and note their ids. The amount credited
   is the checkout's actual paid USD amount excluding tax, verified against the local checkout.
   Product catalogue changes after checkout do not change the credited amount. Submit the store
   for review early; it can take days.
2. **Webhook:** Developers → Webhooks → add `https://<your app domain>/api/webhooks/creem` and copy
   the signing secret. `checkout.completed`, `refund.created` and `dispute.created` are used;
   other events are stored and ignored.
3. **API key:** Developers → API keys (test mode keys only work against `https://test-api.creem.io`).
4. `apps/api/wrangler.jsonc` → `vars`: `CREEM_API_BASE` (`https://test-api.creem.io`, later
   `https://api.creem.io`) and `CREEM_TOPUP_PRODUCTS` (the product ids, comma-separated). Secrets:

```bash
cd apps/api
pnpm exec wrangler secret put CREEM_API_KEY
pnpm exec wrangler secret put CREEM_WEBHOOK_SECRET
```

5. **Require prepaid usage**: after reserving seven days of IP/disk retention, the remaining
   available balance must fund new paid usage. The one free trial browser is ten minutes in Sydney.
   An absent flag defaults to prepaid enforcement; an explicit false is a development/pilot override.

```sql
INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', unixepoch() * 1000)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

What happens automatically: webhooks are verified, stored by event id and processed from the
`cloudbrowser-billing` queue; a completed checkout is re-fetched from Creem and credited once per
order. The engine records usage every minute using elapsed time and the AWS unit prices times
the markup. Compute and IPv4 use hours with fractional seconds; provisioned storage uses
GB-month fractions of the actual UTC billing month, split across day/month boundaries. The
730-hour convention is only a display projection, not the storage debit divisor.
Available credit excludes the refundable seven-day IP/disk reserve. At exhaustion, viewer
access is revoked and the VM is stopped without a ten-minute grace period. The reserve then
funds seven days of fixed-resource retention, after which data and the IP are permanently deleted.
An early manual deletion or funded resumption releases unused retention credit. The api's
five-minute cron retries lost events, refreshes products and sends balance notices; a nightly run
credits any paid order a lost webhook missed. Credit can also be added by hand in the console
(*Users* → Credit), which is recorded as an adjustment.

AWS Price List supplies public unit prices, not an AWS invoice. Usage costs and the reconciler's
monthly projection are estimates based on those prices and platform measurements/provisioned
capacity; they do not reconcile AWS credits, discounts, free tiers or actual incremental snapshot
storage. Cost Explorer/CUR billing ingestion is not included in this release. Pilot usage is
shown as an estimate; only actual balance debits count as customer revenue in the margin report.
User snapshot controls, public backup/restore routes and automatic daily snapshots are removed;
legacy snapshots and internal recovery snapshots remain eligible for cleanup. Snapshot estimates
are not customer debits. Transfer counters are sampled:
any unbacked burst beyond available credit is a platform cost, not a negative usage balance.
Unknown provider startup time or minimum-lifetime rounding is not added as an unquoted surcharge.

### Existing deployment rollout

Capture a D1 Time Travel bookmark before each migration. Keep new creates paused until the new
schema and affected Workers are live, then enforce `billing_required=true` for production.
Migration `0008` adds the per-browser refundable retention reserves and funding constraints.
Migration `0007` preserves legacy
subscription, checkout and active-usage tables and archives changed caps in `legacy_billing_caps`.
If rolling Workers back, restore those caps as well; do not assume a Worker rollback undoes SQL.
Pause new creates while updating the AWS allowed types, `AWS_REGIONS`, D1 and all Workers. Publish
the updated agent image before allowing new browsers, refresh prices, and confirm Sydney has a
complete price sheet before removing the create pause. Existing browsers retain their VM/data/IP.
Deploy the gateway before the API: the API's `GATEWAY` service binding uses the gateway's new
`Internal` entrypoint to revoke live connections immediately after deletion.

### Two-step verification (migration `0009`)

Migration `0009` adds `user.two_factor_enabled` and the `two_factor` table. It is additive, so it
can be applied before the new Workers are deployed; deploy the api and the web build afterwards
(`pnpm deploy` does both). No new variables or secrets are needed: the second-factor endpoints
share `AUTH_LIMITER` (their own per-IP key), and the authenticator secrets and backup codes are
encrypted with `BETTER_AUTH_SECRET`. **Rotating `BETTER_AUTH_SECRET` therefore invalidates every
enabled authenticator and backup code** (as well as all sessions): if it ever has to change, reset
two-step verification for the affected users in the operator console (Users → Reset 2FA) so they
can sign in with their email code and set it up again. Use the same reset, after confirming the
person's identity, for anyone who lost both their phone and their backup codes.

### Ordered input and priority stop/delete

Every input kind uses the same FIFO from the viewer through the gateway and VM relay to Neko.
The gateway serializes callbacks across D1/RPC awaits; native DOM input is not coalesced across
click/key/text boundaries. Queues are bounded and honor transport backpressure. Interruption,
overflow or relay failure visibly disables input, releases held controls where reachable, and
does not replay stale clicks or text into a new connection. Agent 0.2.1 reports failed local relays.

Stop and delete are accepted even while another operation is unfinished. Delete has highest
priority; repeated requests merge, and a late stop cannot undo deletion. Canceled work is fenced
before provider calls and lifecycle writes. AWS calls already in flight still require drain and
confirmation, so accepting intent does not claim instantaneous physical termination. Stop revokes
viewers while retaining the agent channel for cleanup. Normal input has at most a one-second
authorization lease; trusted stop/delete RPCs revoke it immediately, and alarms enforce trial or
credit expiry even without another input event. A lease in use is re-checked shortly before it
lapses, off the relay path, so signaling and typing do not wait on D1; the checks and the lease
length are the same.

### Permanent user deletion and isolation

A user's explicit delete request is permanent. It revokes the browser's agent credentials,
viewer tokens and active gateway connections and destroys its wrapped archive key. The reaper
removes all of its VMs, root/data disks, snapshots, archives and IP allocations, including
superseded and partially created resources. Cleanup failures are retried; the browser remains
`deleting` until provider deletion is confirmed. Outstanding archive upload URLs may require a
final cleanup pass after their expiry. The seven-day restore window applies only to system
billing retention, not explicit user deletion.

Each browser uses a fresh data volume and its own Elastic IP. Recovery and restore may access
only resources tagged for that same browser and environment. The IP is retained while its
allocation exists, including during sleep; after release AWS may reuse the address, without any
of the deleted browser's data or credentials.

## 3c. Operator console and alerts

The console is at `https://admin.console.nevazu.com`. The main site's `/admin` and
`/admin/console` links redirect there. Administrator authentication is independent of main-site
sessions, passkeys, and the legacy `admins` table. There is no administrator IP restriction.

Configure these layers together, before making the hostname public:

1. Create a **Cloudflare Access self-hosted application** for the entire administrator hostname.
   Select **One-time PIN** as its only identity provider. Add one Allow policy including the exact
   authorized email (`sanchai20@163.com` in this deployment), require that OTP provider, and use a
   one-hour session duration. Do not add Everyone, Bypass, or service-token policies. Access
   manages email delivery, login screens, and denial messages; this is email OTP, not MFA.
2. Set `ADMIN_URL`, `ACCESS_TEAM_DOMAIN`, and `ACCESS_AUD` in the API Worker configuration from
   that application. Set `ADMIN_EMAIL_ALLOWLIST` to the same exact email(s). The default email is
   `sanchai20@163.com`; an explicitly empty list denies everyone. These values are public
   configuration, not credentials. The Worker validates Access JWT signature, issuer, audience,
   expiry and identity, then checks the email. Missing or invalid configuration fails closed.
3. Add a **Workers Custom Domain** pointing `admin.console.nevazu.com` to `cloudbrowser`.
   Cloudflare provisions DNS and a certificate, including for this multilevel subdomain. The
   normal application stays on `APP_URL`. If changing the admin URL, also set the frontend build
   variable `VITE_ADMIN_URL` to exactly that origin; it defaults to this deployment's admin URL.

Only the administrator origin serves `/api/v1/admin/*`; that host rejects main-site authentication
and user APIs. Administrator writes require an exact matching `Origin`. Main-site cookies and
unsigned identity headers cannot grant administrator access. The old IP WAF rule must be removed
after deploying the Access-protected backend. For development, use a separate HTTPS origin behind
its own Access application and matching frontend/API configuration; localhost has no bypass.

Every change made in the console (suspend, recover, retry, stop, caps, switches, finding
resolutions, alert acknowledgements) is written to `audit_log` with the stable Access subject as
actor and the verified email in its detail. Sign out uses `/cdn-cgi/access/logout`, which revokes
the user's Access sessions across applications. To revoke an administrator, remove the email from
both the Access policy and Worker allowlist, and revoke their existing Access sessions.

Regression checks: API tests exercise signed JWTs, disallowed emails, expired/forged tokens,
cross-origin writes and direct-host bypass attempts. `node apps/web/e2e/admin-access.mjs` exercises
frontend routing and expired/denied sessions with mocked requests; it never sends OTP emails.

**Alerts** (circuit breaker, drift findings, spend at 80% and 100%, failed IP checks, quota or
permission errors, billing drift and disputes) are stored in `alerts`, listed in the console and
sent by the api's 5-minute cron:

```bash
cd apps/api
pnpm exec wrangler secret put ALERT_WEBHOOK_URL    # Slack-compatible incoming webhook, optional
```

and `ALERT_EMAILS` in `apps/api/wrangler.jsonc` (comma-separated; Email Service must be able to
send to them).

## 3d. Real browsers on AWS

Browsers run on the simulator until a region is switched to `aws-ec2`. The AWS account, the
CloudFormation stack, the access keys and the images are in [docs/aws.md](aws.md).

## 4. Migrate and deploy

```bash
pnpm db:migrate:remote
pnpm deploy   # builds everything, then deploys gateway, engine + reaper, reconciler and api, in that order
```

The api deploys last: it binds to the gateway's `Internal` entrypoint (to revoke live connections),
to the engine as a service and to its `EventHub` Durable Object. The gateway and the api call each
other only through stable RPC methods, and the engine reaches the gateway only through the
`cloudbrowser-agent-commands` queue, so the order above is safe for every change in this repo.

## 5. Domain

Workers → `cloudbrowser` → Settings → Domains & Routes → add your custom domain. Make sure
`APP_URL` matches it, then redeploy the api. Add `connect.example.com` to `cloudbrowser-gateway` the
same way. The engine, reaper and reconciler have `workers_dev: false` and no routes.

## 6. Invite pilot users

```bash
pnpm --filter @cloudbrowser/api exec wrangler d1 execute cloudbrowser --remote \
  --command "INSERT INTO invites (email, note) VALUES ('alice@example.com', 'pilot')"
```

## 7. Operating knobs (SQL, no deploy)

```sql
SELECT * FROM caps;                                            -- pilot limits from plan page 12
UPDATE caps SET "limit" = 3 WHERE scope = 'user:default' AND metric = 'instances';
INSERT INTO caps VALUES ('user:<user id>', 'instances', 5);    -- per-user override
UPDATE control_flags SET value = 'false' WHERE key = 'creation_freeze';   -- clear the circuit breaker
SELECT * FROM drift_findings WHERE status = 'open';
SELECT * FROM billing_accounts;                                -- balances, when they ran out, trial used
SELECT * FROM balance_transactions ORDER BY created_at DESC;   -- top-ups, refunds, disputes, adjustments
SELECT * FROM webhook_events WHERE processed_at IS NULL;      -- Creem events not applied yet (with error)
SELECT user_id, SUM(amount_micros) / 1e6 AS usd, SUM(cost_micros) / 1e6 AS aws_usd
  FROM usage_records WHERE day >= strftime('%Y-%m-01', 'now') GROUP BY user_id;   -- this month
SELECT region_id, fetched_at, sheet FROM provider_prices;      -- AWS prices per region
SELECT * FROM alerts WHERE acknowledged_at IS NULL;          -- open operator alerts
```

Most of these are also in the operator console (`https://admin.console.nevazu.com`).

For chaos testing on staging, set `FAKE_FAULTS` on the engine, e.g.
`{"ensureRunning":{"class":"capacity","rate":0.5}}`.
