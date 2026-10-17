# Deploying to Cloudflare

Four Workers share one D1 database:

| Worker | Config | Public? | Schedule |
|---|---|---|---|
| `cloudbrowser` (api + web) | `apps/api/wrangler.jsonc` | Yes: your app domain | — |
| `cloudbrowser-engine` | `apps/engine/wrangler.jsonc` | No (service binding only) | every minute |
| `cloudbrowser-reaper` | `apps/engine/wrangler.reaper.jsonc` | No | every 15 min |
| `cloudbrowser-reconciler` | `apps/reconciler/wrangler.jsonc` | No | every 5 min |

## 1. One-time setup

```bash
pnpm install
pnpm --filter @cloudbrowser/api exec wrangler login
pnpm --filter @cloudbrowser/api exec wrangler d1 create cloudbrowser
```

Copy the printed `database_id` into **all four** configs (each has a placeholder
`00000000-0000-0000-0000-000000000000`):

- `apps/api/wrangler.jsonc`
- `apps/engine/wrangler.jsonc`
- `apps/engine/wrangler.reaper.jsonc`
- `apps/reconciler/wrangler.jsonc`

## 2. Configuration you must set

In `apps/api/wrangler.jsonc` → `vars`:

| Var | Set to |
|---|---|
| `APP_URL` | Your public origin, e.g. `https://app.example.com` (or the `*.workers.dev` URL). Must match exactly: it is the auth base URL and the only trusted origin. |
| `ENVIRONMENT` | `production` (anything but `development` disables printing sign-in codes to the log). |
| `EMAIL_FROM` | A sender on a domain verified with your email provider, e.g. `CloudBrowser <no-reply@example.com>`. |

Secrets (from `apps/api`):

```bash
openssl rand -base64 48 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put RESEND_API_KEY      # https://resend.com, domain of EMAIL_FROM verified
```

Without `RESEND_API_KEY`, production sign-in fails (codes are never logged outside development).
The plan names AWS SES; `apps/api/src/email.ts` is the one place to swap the provider.

Optionally set `ENV_NAME` (`prod`/`staging`) in the engine, reaper and reconciler configs; it is the
`cb:env` tag on provider resources and must be the same in all three.

## 3. Migrate and deploy

```bash
pnpm db:migrate:remote
pnpm deploy          # builds web, then deploys engine + reaper, reconciler, api (in that order)
```

The engine must exist before the api deploys, because the api binds to it (`services` → `ENGINE`).

## 4. Domain

Cloudflare dashboard → Workers → `cloudbrowser` → Settings → Domains & Routes → add your custom domain
(e.g. `app.example.com`). Then make sure `APP_URL` matches it and redeploy the api. The other three
Workers have `workers_dev: false` and no routes, so they are not reachable from the internet.

## 5. Invite pilot users

The pilot is invite-only (plan page 12). Add each email (lower-case):

```bash
pnpm --filter @cloudbrowser/api exec wrangler d1 execute cloudbrowser --remote \
  --command "INSERT INTO invites (email, note) VALUES ('alice@example.com', 'pilot')"
```

## 6. Operating knobs (SQL, no deploy)

```sql
-- Pilot limits (seeded from plan page 12)
SELECT * FROM caps;
UPDATE caps SET "limit" = 3 WHERE scope = 'user:default' AND metric = 'instances';
INSERT INTO caps VALUES ('user:<user id>', 'instances', 5);   -- per-user override

-- Clear the circuit breaker after investigating
UPDATE control_flags SET value = 'false' WHERE key = 'creation_freeze';

-- Findings from the reconciler
SELECT * FROM drift_findings WHERE status = 'open';
```

For chaos testing on staging, set `FAKE_FAULTS` on the engine, e.g.
`{"ensureRunning":{"class":"capacity","rate":0.5}}`, to see *Waiting for capacity* in the UI.

## Notes

- Cron triggers and D1 work on the Workers Free plan; heavy use (SSE streams are long requests,
  cron every minute) is more comfortable on Workers Paid.
- `apps/web/public/_headers` sets a strict CSP; no third-party scripts, fonts or CDNs are used.
