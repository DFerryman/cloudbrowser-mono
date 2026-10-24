# Deploying to Cloudflare

Everything in the control plane runs on Cloudflare. Five Workers share one D1 database:

| Worker | Config | Public? | Triggers | Cloudflare products |
|---|---|---|---|---|
| `cloudbrowser` (api + web) | `apps/api/wrangler.jsonc` | Yes: your app domain | HTTP, Queue (billing), cron every 5 min | Static assets, D1, Email Service, Queues (producer + billing consumer), Durable Object binding, Rate Limiting |
| `cloudbrowser-engine` | `apps/engine/wrangler.jsonc` | No | Queue, cron every minute, service binding | D1, Queues (consumer + producer), Durable Object `EventHub`, R2 (presigned archive URLs) |
| `cloudbrowser-reaper` | `apps/engine/wrangler.reaper.jsonc` | No | cron every minute | D1, Durable Object binding, R2 (deletes archives) |
| `cloudbrowser-reconciler` | `apps/reconciler/wrangler.jsonc` | No | cron every 5 min, Queue (`cloudbrowser-aws-provider`) | D1, Queues (producer + consumer) |
| `cloudbrowser-gateway` | `apps/gateway/wrangler.jsonc` | Yes: `connect.` domain | HTTP (WebSocket: viewers and agent tunnels; coding agents' MCP endpoint `/mcp/:id` and upload URLs `/u/:token`), Queue | Durable Object `InstanceGateway`, Queues (consumer), service binding to the api's `Internal` entrypoint, D1, Rate Limiting (`MCP_LIMITER`) |

## Prerequisites

For an API/frontend-only release, use a clean checkout of the latest `main`:

```bash
git checkout main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm --filter @cloudbrowser/api run deploy
```

The API deploy command rejects other branches, uncommitted changes, or a HEAD different from
`origin/main`. It rebuilds the frontend and verifies its source commit before calling Wrangler.
The deployed `/build-info.json` reports the commit and branch with `Cache-Control: no-store`;
the same commit is recorded in the Cloudflare version message. Do not deploy an old `dist/`
directory or bypass this command with a direct `wrangler deploy`.

The deploy command keeps additional runtime variables configured in the Cloudflare dashboard.
Variables declared in `apps/api/wrangler.jsonc` still take precedence, so keep its Creem API
base and top-up product IDs set to the live values; use `.dev.vars` for local test-mode values.
Existing secrets are retained by deployments. Stripe's settings are secrets only (section 3b), so
deployments never overwrite them.

The API's Custom Domains (`nevazu.com`, `www.nevazu.com`, and `admin.console.nevazu.com`) are
declared in `apps/api/wrangler.jsonc`, including managed DNS and HTTPS certificates. The zone's
`http_request_dynamic_redirect` rule is recorded in `deploy/cloudflare-www-redirect.json` and
must be enabled for `www` to redirect to `https://nevazu.com`, retaining the path and query.
Read the existing zone ruleset before applying that rule and preserve unrelated rules.

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
pnpm exec wrangler queues create cloudbrowser-aws-provider
pnpm exec wrangler r2 bucket create cloudbrowser-archives
```

Copy the D1 `database_id` into **all five** configs (each has the placeholder
`00000000-0000-0000-0000-000000000000`): `apps/api/wrangler.jsonc`, `apps/engine/wrangler.jsonc`,
`apps/engine/wrangler.reaper.jsonc`, `apps/reconciler/wrangler.jsonc`, `apps/gateway/wrangler.jsonc`.

The api Worker runs next to the database (`placement` in `apps/api/wrangler.jsonc`), since its
handlers make several queries one after another. Keep that region next to where D1 put the
primary (`wrangler d1 info cloudbrowser` shows it; this deployment's is in Eastern North America,
about 10 ms per query from `aws:us-east-2`). The gateway stays at the edge: its viewers' input
and its Durable Objects, which sit near the VMs, must not detour through the database's region.

## 2. Email Service (sign-in codes and registration links)

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
| `TURNSTILE_SITE_KEY` | Optional. Site key of a Cloudflare Turnstile widget for your hostname (Dashboard → Turnstile → Add widget, mode *Managed*). With the secret below, every sign-in and sign-up request that sends an email needs a Turnstile token. To disable it, remove both this var and `TURNSTILE_SECRET_KEY`. |

Nevazu's edge security rules are recorded in `deploy/cloudflare-auth-security.json`. The
`nevazu_require_human` full-page Managed Challenge rule is disabled. Login, sign-up and registration
completion pages skip Browser Integrity Check and Security Level challenges so visitors are not
challenged once before the app and again by Turnstile. The public pages and the texts for crawlers
(robots.txt, sitemap.xml, llms.txt, markdown) skip them too, so search engines and AI assistants
can read them (section 5b). Managed WAF and DDoS protections still apply.
The app checks Turnstile only when requesting an email; method lookup, passkeys, code entry and
TOTP do not start another challenge. On `connect.<domain>` the same skip covers the authenticated
protocols, none of which is a browser that could answer a challenge: `/health`, the agent tunnel,
viewer streams, the coding agents' MCP endpoint (`/mcp/`, any method) and upload URLs (`/u/`). A
zone without this skip challenges `POST /mcp/…` and `PUT /u/…` and breaks every coding agent.

Secrets and keys:

```bash
cd apps/api
openssl rand -base64 48 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY          # optional: the Turnstile widget's secret
node ../../scripts/gen-viewer-keys.mjs        # prints an Ed25519 key pair for viewer tokens
pnpm exec wrangler secret put VIEWER_TOKEN_PRIVATE_KEY      # paste the private JWK
cd ../engine
openssl rand -base64 48 | pnpm exec wrangler secret put BOOTSTRAP_SECRET   # derives agent bootstrap tokens
```

- `apps/gateway/wrangler.jsonc` → `VIEWER_TOKEN_PUBLIC_KEY`: the public JWK (not secret).
- `apps/gateway/wrangler.jsonc` → `MCP_ALLOWED_ORIGINS`: browser origins allowed to call the MCP
  endpoint, comma-separated (`https://tools.example.com`). Leave it empty: coding agents send no
  `Origin`, and every web page is refused. The `ratelimits` entry `MCP_LIMITER` (namespace `1101`,
  120 per minute) limits calls per access key and failed authentications per address; it needs no
  setup beyond the deploy.
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
  your account (change them if you already use those). Limits: 5 sign-in and sign-up requests per
  minute per IP and per email (requests without a valid Turnstile token are refused before they
  count); 60 API writes per minute per user.
- `ENV_NAME` (`prod`/`staging`) in the engine, reaper and reconciler configs: the `cb:env` tag on
  provider resources, same value in all three.

## 3b. Prices and billing with Stripe or Creem

**Prices** come from the AWS Price List API; nothing is configured here. The engine refreshes
each AWS region's sheet every 12 hours (the runtime IAM user needs `pricing:GetProducts`, in the
CloudFormation template since this release). Set the **markup** (customer price = AWS cost ×
markup, default 120%), the minimum balance to start browsers and the low-balance warning in the
operator console → *Pricing & margin*, which also shows each region's cost and price and can
refresh prices now.

**Billing** is a prepaid balance. New registrations receive configurable signup credit (default $2); there is no timed trial.
Missing payment-provider settings do not grant free paid-browser use. Top-ups turn on when one payment provider below is
fully configured; until then `/v1/billing/checkout` answers 503.

**Which provider takes payments.** Stripe and Creem are configured independently
(`apps/api/src/billing/providers.ts`):

- When `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_TOPUP_PRICES` are all set and valid
  (`sk_live_…` or `rk_live_…`, `whsec_…`, `price_…` ids), **Stripe** takes every new top-up and the
  *Receipts* button opens Stripe's customer portal (Creem's, for someone who only ever paid through Creem).
- Otherwise **Creem** takes them, as before, when its four settings are set.
- Each provider processes its own webhooks, refunds and disputes whenever it is configured (Stripe:
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`), also while the other one takes top-ups. Keep
  Creem configured after Stripe takes over: Creem payments can still be refunded or disputed months
  later. Likewise, to hand top-ups back to Creem, delete **only** `STRIPE_TOPUP_PRICES` and keep the
  key, the webhook secret and Stripe's webhook endpoint for as long as Stripe payments can be
  refunded or disputed (about 120 days, longer for some cards): Stripe's refunds and disputes are
  then still applied and its customers still reach their receipts. Without the key or the webhook
  secret, Stripe events are kept unapplied until both are back (with the webhook secret gone,
  Stripe's deliveries are refused and Stripe retries them for three days).
- `GET /api/v1/billing` reports the active one in `provider` (`stripe`, `creem` or `null`).

### Stripe (UK account)

Stripe processes payments but, unlike Creem, is **not a merchant of record**: with Stripe the UK
company itself sells the credit, so VAT and sales tax, invoices and consumer law are its own
obligations. The integration (`apps/api/src/billing/stripe.ts`) therefore creates each Checkout
Session with Stripe Tax (`automatic_tax`), the full billing address (evidence of the buyer's
country), business tax-id collection (VAT numbers; reverse charge for EU businesses), a post-payment
invoice (shown in the customer portal; its footer confirms the right to withdraw, the durable
confirmation UK consumer law asks for), a required tick-box accepting the Terms and Refund Policy
and asking for the credit to be added at once (Consumer Contracts Regulations 2013; the Refund
Policy refunds unused credit to UK and EU consumers who withdraw within 14 days), and Adaptive
Pricing off, so buyers are charged and refunded the price's USD amount. Strong Customer
Authentication (3D Secure) is handled by Checkout. The credit is `amount_total` minus tax, read
from Stripe's own record of the session, once per PaymentIntent; delayed payment methods are
credited on `checkout.session.async_payment_succeeded`. Requests pin Stripe API version
`2026-09-30.endive`.

1. **Business details** (sandbox and live): Settings → Business → *Public details*: business name,
   support email and phone, statement descriptor, and the **Terms of service URL**
   `https://<your app domain>/terms` (the Terms tick-box needs it; until it is set the same words
   appear above the pay button instead and the console shows an alert) and privacy policy URL.
   Settings → Payouts: add a **USD bank account** if USD payments should be paid out without
   conversion to GBP (otherwise every charge pays Stripe's 2% conversion fee). Settings → Customer
   emails: turn on emails for successful payments and for invoices. When onboarding, describe the
   business as prepaid usage credit for your own service, non-transferable and not redeemable for
   cash: Stripe lists seller-maintained credit as a *restricted* business (extra review, possibly
   limits), and say what the dedicated IPs are for.
2. **Stripe Tax:** Settings → Tax → activate; head office (origin) address in the UK; default tax
   behaviour *Exclusive* (tax is added on top of the price, as with Creem; or set it on each
   price; it cannot be changed later); a default product tax code for an electronically supplied
   service, e.g. `txcd_10103001` (SaaS, business use) or `txcd_10000000` (general electronically
   supplied services), confirmed with your accountant, and not the gift-card code (credit is taxed
   when it is bought, not when it is spent); and a **registration** for every place you must
   collect in: the UK once VAT-registered, the EU (One Stop Shop, non-Union scheme) for EU
   consumers, and others as Stripe Tax's threshold monitoring reports them. Stripe Tax collects only
   where a registration is added. In a sandbox without Stripe Tax, set `STRIPE_AUTOMATIC_TAX=off`.
3. **Prices:** Product catalogue → one product per top-up, each with a **one-time USD price**
   (e.g. *Credit $10*, *$25*, *$50*), or a single product whose price is *Customer chooses price*
   (`custom_unit_amount`, like the current Creem product) with a minimum and maximum. Note the
   `price_…` ids. Archived prices and products are not offered.
4. **Customer portal:** Settings → Billing → *Customer portal*: keep *Invoice history* on and save
   it, once in the sandbox and once in live mode (portal sessions fail until it is saved).
5. **Webhook:** Developers → Webhooks (*Event destinations*) → add an endpoint
   `https://<your app domain>/api/webhooks/stripe` (payload *Snapshot* or *Thin*, both are
   accepted) for `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`,
   `charge.dispute.created` and `charge.dispute.funds_withdrawn`, and copy its signing secret. Other
   events are stored and ignored; payments the app did not start (no `attemptId`) are left alone.
6. **API key:** Developers → API keys: the secret key, or a restricted key with *Checkout Sessions*
   write, *Prices* (plans) read, *Products* read, *Charges and Refunds* read, *Disputes* read,
   *PaymentIntents* read, *Customer portal* write and *Customers* read.
7. **Secrets** (never `vars` in `apps/api/wrangler.jsonc`, which override the dashboard on every deploy):

```bash
cd apps/api
pnpm exec wrangler secret put STRIPE_SECRET_KEY        # sk_live_… or rk_live_…
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_… of the endpoint above
pnpm exec wrangler secret put STRIPE_TOPUP_PRICES      # price_…,price_… (comma-separated)
```

8. **Console:** *Pricing & margin* → payment fee: replace Creem's 3.9% + $0.40 with what Stripe
   charges this account, so the margin estimate and minimum markup stay right. UK pricing
   (stripe.com/gb/pricing, October 2026): 1.5% + 20p for standard UK cards, 2.8% + 20p premium UK,
   2.5% + 20p EEA, 3.15% + 20p international, plus 2% when the charge is converted to GBP; Stripe
   Tax 0.5% where you are registered; post-payment invoices 0.4% (at most $2); £20 per dispute.
   Without a USD bank account a typical international card costs about 6% + 20p in all, so a fee
   setting of 600 bps + 27 cents is a cautious start.
9. **Policies:** the Terms, Privacy and Refund pages name both providers. As the seller, also
   publish the company's legal name, registered number, registered office and VAT number. The
   Terms (section 9) promise notice of material changes before they take effect: email existing
   users about the updated Terms, Privacy and Refund policies when this release goes out.

To return to Creem, delete only the prices (`pnpm exec wrangler secret delete STRIPE_TOPUP_PRICES`);
keep `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` so later refunds and chargebacks of Stripe
payments are still applied.

Stripe also offers *Managed Payments*, in which Stripe is the merchant of record (available to UK
businesses after a review, 3.5% on top of the payment fees). It forbids the tax, invoice and
customer parameters this integration sends, so it would need its own small change; with it, Stripe
rather than the company would handle VAT registrations and returns.

### Creem

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
   available balance must fund new paid usage. Signup credit uses the same deposit and minimum-balance checks as other credit.
   An absent flag defaults to prepaid enforcement; an explicit false is a development/pilot override.

```sql
INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', unixepoch() * 1000)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

What happens automatically: webhooks are verified, stored by event id and processed from the
`cloudbrowser-billing` queue; a completed checkout is re-fetched from the provider that took it
and credited once per order (Stripe: per PaymentIntent). The engine records usage every minute using elapsed time and the AWS unit prices times
the markup. Compute and IPv4 use hours with fractional seconds; provisioned storage uses
GB-month fractions of the actual UTC billing month, split across day/month boundaries. The
730-hour convention is only a display projection, not the storage debit divisor.
Available credit excludes the refundable seven-day IP/disk reserve. At exhaustion, viewer
access is revoked and the VM is stopped without a ten-minute grace period. The reserve then
funds seven days of fixed-resource retention, after which data and the IP are permanently deleted.
An early manual deletion or funded resumption releases unused retention credit. The api's
five-minute cron retries lost events, refreshes both providers' products and sends balance notices; a nightly run
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
(`pnpm run deploy` does both). No new variables or secrets are needed: the second-factor endpoints
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
viewers while retaining the agent channel for cleanup. Normal input has at most a ten-second
authorization lease; trusted stop/delete RPCs and a takeover revoke it immediately, and alarms
enforce credit expiry even without another input event. What only a lease check notices (a
session ended without a takeover, a browser the engine stopped) is noticed within those ten
seconds. A lease in use is re-checked two seconds before it lapses, off the relay path, and the
alarm renews an idle viewer's as it lapses, so signaling, typing and a tap after a pause do not
wait on D1, which is about 330 ms away from a gateway object in Asia. Coding agents' calls keep
a one-second lease (`agent-access.md`).

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
send to them; defaults to `ADMIN_EMAIL_ALLOWLIST` when empty). Only `critical` alerts are emailed.
`info` and `warning` alerts remain in the console and go to the webhook if configured.

## 3d. Real browsers on AWS

Browsers run on the simulator until a region is switched to `aws-ec2`. The AWS account, the
CloudFormation stack, the access keys and the images are in [docs/aws.md](aws.md).

## 4. Migrate and deploy

```bash
pnpm db:migrate:remote
pnpm run deploy   # checks, builds everything, then deploys gateway, engine + reaper, reconciler and api, in that order
```

The gateway, engine, reaper and reconciler are deployed only when what Wrangler would upload for
them changed (`scripts/deploy-workers.mjs`). The script builds each one with
`wrangler deploy --dry-run --minify`, so edited comments don't count, and hashes the bundled
modules (not their source maps) together with the Worker's `wrangler*.jsonc`. Each deploy records `Deploy origin/main <commit> bundle <hash>` as
its version message, and the next run compares against it. So an edit to a shared package that a
Worker doesn't import, like the Terms version in `packages/contracts/src/legal.ts`, leaves that
Worker alone. A live version without a label (a rollback, a hand `wrangler deploy`) is always
replaced. The api is always deployed. `DEPLOY_ALL_WORKERS=1` redeploys the engine, reaper and
reconciler even when unchanged. `node scripts/deploy-workers.mjs --dry-run` prints what would
happen.

### The gateway deploy window

A gateway deploy restarts every `InstanceGateway` object. As the update reaches each object over
the next few minutes, it drops that browser's agent tunnel and every live view on it; the picture
comes back about 7 seconds later. So **gateway changes are always batched into a single deploy
window, never deployed one at a time**: every pending gateway change goes out in one combined
deploy, and live views drop once.

- Outside the window, `pnpm run deploy` (and `pnpm --filter @cloudbrowser/gateway run deploy`)
  holds a changed gateway. It prints `held for the gateway deploy window` with the commits waiting
  for it, then deploys everything else. While the live gateway has no bundle hash (it was deployed
  before they were recorded), the script can only compare files, and says its code may be
  unchanged. Tell the owner anyway; the owner checks whether the built code differs.
- The window belongs to one owner: the latency thread in the Claude project, or whoever the project
  names. Merge your gateway change, then tell the owner it is waiting. The owner announces the
  window to the other threads, runs `DEPLOY_GATEWAY_WINDOW=1 pnpm run deploy` from `main`, and
  reports the new gateway version and its rollback.
- Until the window, keep api and other Worker changes working with the gateway that is live. The
  api's calls to the gateway's `Internal` entrypoint catch their errors, so a method the live
  gateway lacks fails soft; make new calls do the same. If an api change can't work without the
  new gateway code, don't merge it until the window, and ship both in it.

**Apply the migrations before deploying any Worker**, every time. A Worker that reads a table or
column a pending migration adds fails until it exists, and every Worker shares the one database.
Write `pnpm run deploy`, not `pnpm deploy`: the latter is pnpm's own command for copying a
package, not this script. The script first runs `node scripts/deploy-api-main.mjs --check`, which
stops the deploy unless HEAD is a clean `main` equal to `origin/main` and
`wrangler d1 migrations list cloudbrowser --remote` reports no pending migrations; the api deploy
repeats both checks. Only for a deliberate exception (a Worker change that must ship before a
migration it does not use) set `ALLOW_PENDING_D1_MIGRATIONS=1` for that one command. Deploying a
single Worker by hand (`pnpm --filter … run deploy`) skips the root check, so run
`pnpm db:migrate:remote` first then too.

Migration `0034` adds coding-agent access (`docs/agent-access.md`): the per-browser `agent_access`
and `agent_control` columns and the `automation_clients` and `automation_sessions` tables. It is
additive and can be applied before the new Workers. Deploy the gateway before the api as usual: the
api reaches the gateway's `Internal` entrypoint for the new `automationControl` and
`revokeAutomation` methods. No new variables or secrets are needed; agent access is on by default
for new browsers.

Migration `0035` replaces the local bridge and its pairing codes with access keys for the
gateway's MCP endpoint: `automation_clients` gains `kind`, `key_prefix`, `expires_at`,
`capability`, `last_client` and `last_ip` and an index on `credential_hash`, and pairing codes that
were never redeemed are revoked (a redeemed bridge's credential keeps working as a key). Apply it
before deploying any Worker: the gateway's per-call check reads `expires_at` and the api reads every
new column. Then deploy as usual, gateway first. Until the api is deployed the new gateway answers
MCP calls with a temporary error, because it reaches the api's `Internal` entrypoint for
`authenticateMcp`, `openAutomationSession` and `endAutomationSession`; bridges of the old kind are
disconnected for good (their route is gone). The gateway's `ratelimits` binding is created by the
deploy. Update the zone's security rule (`deploy/cloudflare-auth-security.json`) so
`connect.<domain>` skips Browser Integrity Check and Security Level for `/mcp/` and `/u/`.

Migration `0036` adds Stripe beside Creem (section 3b): a `provider` column on `topup_packs`,
`topup_checkouts` and `webhook_events` (every existing row is Creem's) and the `stripe_customers`
table. It is additive; apply it before deploying, as always: the new api reads the new columns.
Until the three Stripe secrets are set, top-ups keep going to Creem exactly as before.

Migration `0038` adds OAuth sign-in for coding agents (`docs/agent-access.md`, "OAuth sign-in"):
the `oauth_clients`, `oauth_authorization_codes` and `oauth_spent_refresh_tokens` tables and three
nullable columns on `automation_clients`. It is additive; apply it before deploying, as always.
Sign-in is switched by the `MCP_OAUTH` var of the gateway (discovery, with `OAUTH_ISSUER` set to the
app's origin) and of the api (the web app offers it); both are `on`. The api's `OAUTH_LIMITER` rate
limit binding is created by the deploy. Sign-in also needs the zone's security rule
(`deploy/cloudflare-auth-security.json`) to skip Browser Integrity Check and Security Level for
`/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` on the app host
(`/api/oauth/` is covered by `/api/`) and `/.well-known/oauth-protected-resource/` on
`connect.<domain>`, so hosted clients such as claude.ai can discover and call them; apply it before
turning sign-in on. Rollback: set both `MCP_OAUTH` vars back to `off` and deploy; existing sign-ins
keep working until they end or are disconnected.

The api deploys last: it binds to the gateway's `Internal` entrypoint (to revoke live connections),
to the engine as a service and to its `EventHub` Durable Object. The gateway and the api call each
other only through stable RPC methods, and the engine reaches the gateway only through the
`cloudbrowser-agent-commands` queue, so the order above is safe for every change in this repo.

## 5. Domain

Workers → `cloudbrowser` → Settings → Domains & Routes → add your custom domain. Make sure
`APP_URL` matches it, then redeploy the api. Add `connect.example.com` to `cloudbrowser-gateway` the
same way. The engine, reaper and reconciler have `workers_dev: false` and no routes.

## 5b. AI crawlers and search

The public site is built so that search engines and AI assistants (ChatGPT search, Claude,
Perplexity, Gemini and Google AI Overviews, Copilot and Bing) can read, cite and recommend it
without running JavaScript.

**What is built and how it is served.** `pnpm --filter @cloudbrowser/web build` runs
`apps/web/scripts/prerender.mjs` after `vite build`. It renders the real public page components
(`src/prerender/entry.tsx`, English, no network) into the built `index.html` and writes:

| File in `apps/web/dist` | Served at | How |
|---|---|---|
| `home.html` | `/` | api Worker (`run_worker_first`), from the assets, with live regions, prices and JSON-LD offers (`apps/api/src/site.ts`) |
| `pricing.html` | `/pricing` | api Worker, with the live price table and offers |
| `docs.html`, `docs/<slug>.html`, `terms.html`, `privacy.html`, `refunds.html`, `contact.html`, `status.html` | `/docs`, `/docs/<slug>`, … | static assets (`html_handling` *auto-trailing-slash* serves `x.html` at `/x`; `/x/` and `/x.html` redirect there) |
| `index.md`, `pricing.md`, `llms.txt`, `llms-full.txt` | the same paths | api Worker, with live prices in markdown |
| `docs.md`, `docs/<slug>.md`, `terms.md`, … , `robots.txt` | the same paths | api Worker passing the asset on (`run_worker_first`), adding the `charset=utf-8` the assets binding leaves out (`text/markdown; charset=utf-8`, `text/plain; charset=utf-8`) |
| `sitemap.xml` | the same path | static assets (`application/xml`; its XML declaration names UTF-8) |

Each page has its own title, description, canonical URL (`https://nevazu.com/...`), Open Graph and
Twitter tags, a `rel="alternate"` link to its markdown and schema.org JSON-LD (Organization,
WebSite, WebApplication with an AggregateOffer of live hourly prices, TechArticle and
BreadcrumbList on docs, FAQPage on `/docs/faq`). The page text sits inside `#root`; the app's first
render replaces it (`createRoot`, not hydration). `index.html` stays the empty, `noindex` app shell
for private routes and unknown paths, so signed-in pages never show marketing content.
`/home` redirects to `/`. Prices are read once per Worker isolate for ten minutes; when they cannot
be read the built fallback text stays. `_headers` applies to responses the Worker passes on from
the assets binding, so `/` and `/pricing` keep the CSP and HSTS; private paths get
`X-Robots-Tag: noindex`. A JSON-LD block is data, not script: the CSP needs no change.

**Cloudflare settings (operator, once per zone):**

1. **Security → Settings → filter "Bot traffic" → Configure AI bot policies**: set the Search,
   Agent and Training policies to *Allow (do not block)*, and turn **Bot Preference Sync** off (or
   leave every policy on Allow). Otherwise Cloudflare's *managed robots.txt* is prepended to ours
   with `Disallow: /` for GPTBot, ClaudeBot, Google-Extended, CCBot and others. The legacy
   *Block AI bots* switch, where it is still shown, must be off.
2. **AI Crawl Control → Crawlers**: every crawler on *Allow*. A *Block* creates a WAF custom rule
   on the zone; delete such rules if any were created earlier.
3. **Bot Fight Mode** (Security → Settings → Bot traffic) cannot be skipped by WAF rules. Leave it
   off; with Super Bot Fight Mode, keep *Verified bots* on Allow and do not challenge *Definitely
   automated* traffic on the public paths.
4. Re-apply `deploy/cloudflare-auth-security.json`: its skip rule (no Browser Integrity Check or
   Security Level challenge) now also covers `/llms.txt`, `/llms-full.txt`, `/home` and every path
   ending in `.md`, besides the public pages, `/robots.txt` and `/sitemap.xml`.

**Search consoles (operator):**

- **Google Search Console**: add the `nevazu.com` domain property (DNS TXT record in Cloudflare),
  then Sitemaps → submit `https://nevazu.com/sitemap.xml`. Google-Extended (Gemini) follows the
  same robots.txt.
- **Bing Webmaster Tools**: import the site from Search Console or verify it, then submit the
  sitemap. Bing's index also feeds ChatGPT search and Copilot.
- Optional: turn on **Crawler Hints** (Caching → Configuration), which notifies IndexNow search
  engines when pages change.

**Checking** after a deploy:

```bash
curl -sA "GPTBot" https://nevazu.com/ | grep -o '<title>[^<]*'            # the home page's own title
curl -sA "ClaudeBot" https://nevazu.com/pricing | grep -c 'AggregateOffer'  # 1 when prices are live
curl -sA "PerplexityBot" https://nevazu.com/docs/faq | grep -o '<h1[^>]*>[^<]*'
curl -s https://nevazu.com/robots.txt | head -8                           # ours, no managed Disallow lines first
curl -sI https://nevazu.com/llms.txt | grep -i content-type                # text/plain; charset=utf-8
curl -sI https://nevazu.com/docs/agent-setup.md | grep -i content-type     # text/markdown; charset=utf-8
curl -s https://nevazu.com/pricing.md | head -20                          # the live price table
curl -sI https://nevazu.com/browsers | grep -i x-robots-tag                # noindex
```

A `403`, a challenge page or `Disallow` lines for AI crawlers at the top of `robots.txt` mean one
of the settings above still blocks them. Locally, `node apps/web/e2e/seo.mjs` checks the build.

### IndexNow notifications

IndexNow is enabled for `nevazu.com`. `deploy/indexnow.json` identifies its ownership key, and
the matching UTF-8 `<key>.txt` file in `apps/web/public` is served at the website root. This is
separate from `BingSiteAuth.xml`; the key file must stay publicly readable without a challenge.
The edge exception is included in `deploy/cloudflare-auth-security.json`.

Both `pnpm run deploy` and the API-only deploy command notify IndexNow **after** a successful
API/assets release. `scripts/indexnow.mjs` compares the built public pages with the previous
deployment's `/indexnow-manifest.json`. It submits added, changed and removed canonical HTML
URLs, excluding private app paths, APIs, query strings and other hosts. Compiled JS/CSS filename
changes alone do not cause notifications. The initial deployment notifies all public pages.
The manifest contains only public URLs and content hashes; it is marked `noindex` and `no-store`.

Submissions go to `https://api.indexnow.org/indexnow`, which shares them with participating
search engines. HTTP 200 means received; HTTP 202 means received with key validation pending.
Neither guarantees crawling, indexing, ranking or AI citations. Keep the XML sitemap submitted
in Google Search Console and Bing Webmaster Tools.

If notification fails, deployment remains live, the deploy command reports the notification
failure, and `.wrangler/indexnow-pending.json` retains the URLs for retry (including removed
pages). Run `pnpm indexnow:retry` without redeploying. A subsequent deployment from this checkout
also carries pending URLs forward. Preserve that retry file when moving a failed run between
machines or CI jobs. `pnpm indexnow:submit --dry-run` previews all current sitemap URLs;
`pnpm indexnow:submit` manually notifies them, for example after a substantial pricing change.
Avoid repeatedly submitting unchanged pages. Runtime price/availability refreshes are not
deployment events and do not automatically trigger notifications in this integration.

Validation: `pnpm test:indexnow` covers URL restrictions, meaningful content changes, removals,
failed-submission recovery, deployment identity and ownership checks. `pnpm test` includes it.
Protocol: <https://www.indexnow.org/documentation>.

## 6. Invite pilot users

```bash
pnpm --filter @cloudbrowser/api exec wrangler d1 execute cloudbrowser --remote \
  --command "INSERT INTO invites (email, note) VALUES ('alice@example.com', 'pilot')"
```

## 7. Operating knobs (SQL, no deploy)

Each user has one limit: the browsers they may own (`user:default` / `instances`, 3 since
migration `0019`), and every one of them may run at the same time; there is no per-user running
limit or daily creation quota. The limit is rechecked inside the create transaction
(`user_browser_limit_guard`), so simultaneous creates cannot exceed it. Change it in the operator
console under Limits → Browsers per user; a `user:<id>` / `instances` row overrides it for one user.
Regional caps, AWS quota checks, short-term global rate limits and the circuit breaker still apply.
Spend alerts inform operators and never limit creation.

```sql
SELECT * FROM caps;                                            -- pilot limits from plan page 12
UPDATE caps SET "limit" = 3 WHERE scope = 'user:default' AND metric = 'instances';
INSERT INTO caps VALUES ('user:<user id>', 'instances', 5);    -- per-user override
UPDATE control_flags SET value = 'false' WHERE key = 'creation_freeze';   -- clear the circuit breaker
SELECT * FROM drift_findings WHERE status = 'open';
SELECT * FROM billing_accounts;                                -- balances, when they ran out
SELECT * FROM balance_transactions ORDER BY created_at DESC;   -- top-ups, refunds, disputes, adjustments
SELECT * FROM webhook_events WHERE processed_at IS NULL;      -- Stripe/Creem events not applied yet (provider, error)
SELECT user_id, SUM(amount_micros) / 1e6 AS usd, SUM(cost_micros) / 1e6 AS aws_usd
  FROM usage_records WHERE day >= strftime('%Y-%m-01', 'now') GROUP BY user_id;   -- this month
SELECT region_id, fetched_at, sheet FROM provider_prices;      -- AWS prices per region
SELECT * FROM alerts WHERE acknowledged_at IS NULL;          -- open operator alerts
```

Most of these are also in the operator console (`https://admin.console.nevazu.com`).

For chaos testing on staging, set `FAKE_FAULTS` on the engine, e.g.
`{"ensureRunning":{"class":"capacity","rate":0.5}}`.


### Signup credit (migration 0032)

Deploy the signup-credit release from clean main after applying D1 migration `0032_signup_credit`.
Deploy gateway, engine, reaper and reconciler as well as API, since shared authorization and
metering no longer have timed-trial exemptions. There were no live trial browsers at rollout.
Historical SQL columns remain inert for rolling deployment compatibility; live schemas, API
contracts and UI no longer expose trial state. Existing accounts are never backfilled.

Admin → Limits → **Signup credit (USD)** sets the global `user:default / signup_credit_cents` cap.
The default is 200 cents. A value of 0 disables new awards and hides all signup-credit offers on
Home, Pricing and Sign-up (public pricing has a 60-second cache). The minimum available credit
remains $1 plus the seven-day refundable resource deposit. Promotions and top-ups can supplement
the registration credit; a $2 award alone need not cover admission in every region.

A D1 `AFTER INSERT ON user` trigger awards only verified new registrations. Account creation,
balance increment and `signup:<user id>` ledger entry are atomic. Email-link requests, repeat
sign-ins, setting changes and existing accounts do not receive additional credit. Registration
must fail atomically if its award cannot be committed; no deferred grant or backfill runs.
