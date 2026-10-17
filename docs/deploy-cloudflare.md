# Deploying to Cloudflare

Everything runs on Cloudflare. Four Workers share one D1 database:

| Worker | Config | Public? | Triggers | Cloudflare products |
|---|---|---|---|---|
| `cloudbrowser` (api + web) | `apps/api/wrangler.jsonc` | Yes: your app domain | HTTP | Static assets, D1, Email Service, Queues (producer), Durable Object binding, Rate Limiting |
| `cloudbrowser-engine` | `apps/engine/wrangler.jsonc` | No | Queue, cron every minute, service binding | D1, Queues (consumer + producer), Durable Object `EventHub` |
| `cloudbrowser-reaper` | `apps/engine/wrangler.reaper.jsonc` | No | cron every 15 min | D1, Durable Object binding |
| `cloudbrowser-reconciler` | `apps/reconciler/wrangler.jsonc` | No | cron every 5 min | D1 |

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
```

Copy the D1 `database_id` into **all four** configs (each has the placeholder
`00000000-0000-0000-0000-000000000000`): `apps/api/wrangler.jsonc`, `apps/engine/wrangler.jsonc`,
`apps/engine/wrangler.reaper.jsonc`, `apps/reconciler/wrangler.jsonc`.

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

Secret:

```bash
cd apps/api
openssl rand -base64 48 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
```

Optional:
- `ratelimits` in `apps/api/wrangler.jsonc`: `namespace_id` values `1001`/`1002` must be unique in
  your account (change them if you already use those). Limits: 5 sign-in requests per minute per IP
  and per email; 60 API writes per minute per user.
- `ENV_NAME` (`prod`/`staging`) in the engine, reaper and reconciler configs: the `cb:env` tag on
  provider resources, same value in all three.

## 4. Migrate and deploy

```bash
pnpm db:migrate:remote
pnpm deploy   # builds web, then deploys engine + reaper, reconciler, api, in that order
```

The engine deploys first because the api and the reaper bind to its `EventHub` Durable Object and
the api binds to the engine as a service.

## 5. Domain

Workers → `cloudbrowser` → Settings → Domains & Routes → add your custom domain. Make sure
`APP_URL` matches it, then redeploy the api. The other Workers have `workers_dev: false` and no
routes.

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
```

For chaos testing on staging, set `FAKE_FAULTS` on the engine, e.g.
`{"ensureRunning":{"class":"capacity","rate":0.5}}`.
