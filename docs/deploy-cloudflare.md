# Deploying to Cloudflare

Everything in the control plane runs on Cloudflare. Five Workers share one D1 database:

| Worker | Config | Public? | Triggers | Cloudflare products |
|---|---|---|---|---|
| `cloudbrowser` (api + web) | `apps/api/wrangler.jsonc` | Yes: your app domain | HTTP, Queue (billing), cron every 5 min | Static assets, D1, Email Service, Queues (producer + billing consumer), Durable Object binding, Rate Limiting |
| `cloudbrowser-engine` | `apps/engine/wrangler.jsonc` | No | Queue, cron every minute, service binding | D1, Queues (consumer + producer), Durable Object `EventHub`, R2 (presigned archive URLs) |
| `cloudbrowser-reaper` | `apps/engine/wrangler.reaper.jsonc` | No | cron every 15 min | D1, Durable Object binding, R2 (deletes archives) |
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

## 3b. Billing with Creem (optional for the pilot)

The pilot runs without payments: invited users get the `user:default` caps (plan *pilot*).
Billing turns on when every value below is set; until then `/v1/billing/*` answers 503 and the
account page shows the pilot plan.

1. **Creem dashboard (test mode first):** create four products and note their ids:
   *Personal monthly* ($29/month) and *Personal yearly* ($290/year) as fixed-price products;
   *Pro monthly* ($25/month) and *Pro yearly* ($250/year) as **seat-based** products (price per
   unit, units = browsers). Submit the store for review early; it can take days.
2. **Webhook:** Developers → Webhooks → add `https://<your app domain>/api/webhooks/creem` and copy
   the signing secret. Every event type can be enabled; unknown ones are stored and ignored.
3. **API key:** Developers → API keys (test mode keys only work against `https://test-api.creem.io`).
4. `apps/api/wrangler.jsonc` → `vars`: `CREEM_API_BASE` (`https://test-api.creem.io`, later
   `https://api.creem.io`) and the four `CREEM_PRODUCT_*` ids. Secrets:

```bash
cd apps/api
pnpm exec wrangler secret put CREEM_API_KEY
pnpm exec wrangler secret put CREEM_WEBHOOK_SECRET
```

5. **Require a plan** once you sell (no free tier, page 6): users without a subscription then get
   no browsers. Leave it off during the invite-only pilot.

```sql
INSERT INTO control_flags (key, value, updated_at) VALUES ('billing_required', 'true', unixepoch() * 1000)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

What happens automatically: webhooks are verified, stored by event id and processed from the
`cloudbrowser-billing` queue (every event re-fetches the subscription from Creem, so order and
duplicates do not matter); the api's 5-minute cron retries lost events, applies period ends and
the 7-day grace for failed payments, emails users on day 1, 14 and 28 after access ends and
deletes their browsers on day 30 (restorable 7 more days); at 03:00 UTC it re-syncs every
subscription and logs drift to `audit_log` (`billing.drift`). The engine meters active hours every
minute and puts browsers to sleep 10 minutes after a plan's hours run out.

## 3c. Operator console and alerts

The console is at `https://<app domain>/admin` (page 10). Three gates, all required:

1. **Admin role** (SQL only, never from the app). Sign in once with the email first, then:

```sql
INSERT INTO admins (user_id, note, created_at)
  SELECT id, 'ops', unixepoch() * 1000 FROM user WHERE email = 'you@example.com';
```

2. **IP allowlist:** `ADMIN_IP_ALLOWLIST` in `apps/api/wrangler.jsonc` (comma-separated IPs and
   CIDRs, IPv4 and IPv6). Empty means nobody. Add the same list as a Cloudflare **WAF custom rule**
   in front of the app: *(URI Path starts with `/admin` or `/api/v1/admin`) and not (IP Source
   Address in {your list})* → **Block**. Everyone else gets a plain 404.
3. **Passkey step-up:** each admin adds a passkey in **Settings → Security** (Touch ID, Windows
   Hello or a security key), then confirms with it when opening the console. A confirmation lasts
   30 minutes per sign-in session. Passkeys are bound to the app's domain (`APP_URL`), so register
   them on the production domain.

Every change made in the console (suspend, recover, retry, stop, caps, switches, finding
resolutions, alert acknowledgements, step-ups) is written to `audit_log` with the admin as actor.

**Alerts** (circuit breaker, drift findings, spend at 80% and 100%, failed IP checks, quota or
permission errors, billing drift and disputes) are stored in `alerts`, listed in the console and
sent by the api's 5-minute cron:

```bash
cd apps/api
pnpm exec wrangler secret put ALERT_WEBHOOK_URL    # Slack-compatible incoming webhook, optional
```

and `ALERT_EMAILS` in `apps/api/wrangler.jsonc` (comma-separated; Email Service must be able to
send to them).

## 4. Migrate and deploy

```bash
pnpm db:migrate:remote
pnpm deploy   # builds web, then deploys engine + reaper, reconciler, api, in that order
```

The engine deploys first because the api and the reaper bind to its `EventHub` Durable Object and
the api binds to the engine as a service; the gateway deploys last because it binds to the api's
`Internal` entrypoint. The engine reaches the gateway only through the `cloudbrowser-agent-commands`
queue, so there is no deploy-order cycle.

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
SELECT * FROM subscriptions;                                   -- billing mirror (Creem is the source of truth)
SELECT * FROM webhook_events WHERE processed_at IS NULL;      -- Creem events not applied yet (with error)
SELECT * FROM active_usage WHERE month = strftime('%Y-%m', 'now');   -- active seconds per user
SELECT * FROM alerts WHERE acknowledged_at IS NULL;          -- open operator alerts
```

Most of these are also in the operator console (`/admin`).

For chaos testing on staging, set `FAKE_FAULTS` on the engine, e.g.
`{"ensureRunning":{"class":"capacity","rate":0.5}}`.
