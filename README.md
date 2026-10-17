# cloudbrowser-mono

Persistent cloud browsers: each browser is a real Chrome in its own cloud VM with a **dedicated,
stable IP** in Tokyo or US West, **persistent encrypted data**, and a **low-latency live view**.
The design lives in the Notion plan *Persistent Cloud Browser — Implementation Plan*.

This repository holds **Phase 0 (Foundations)** of that plan, with the control plane on
Cloudflare: Workers, D1, Queues, Durable Objects, Email Service, Workers Rate Limiting and static
assets. Browsers run on the in-memory **`fake` executor**, so the whole lifecycle (create →
open → sleep → wake → change IP → delete → purge) works end to end with no cloud spend. See
[`docs/implementation-status.md`](docs/implementation-status.md) for what is built and what is next,
and [`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md) to deploy.

## Layout

```
apps/
  web/          Vite + React SPA: sign-in, dashboard, create dialog, session view, settings (zh-CN + en)
  api/          Worker: Hono REST + SSE under /api, Better Auth (email codes via Email Service),
                rate limits, IP echo; serves apps/web/dist
  engine/       Worker: queue consumer running operations (journal, leases, ledger, retries),
                EventHub Durable Object for SSE; reaper mode = only deleter
  reconciler/   Worker: ledger vs provider, orphans, circuit breaker, quota and spend snapshots
packages/
  contracts/    zod schemas shared by api and web (OpenAPI is generated from them)
  db/           Drizzle schema + D1 migrations (single schema authority)
  executors/    Executor interface + `fake` executor (aws-ec2 / oci-compute / fly-machines later)
  ui/           Design tokens and components
```

## Local development

Requirements: Node 22.13+ and pnpm 10.

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars          # set BETTER_AUTH_SECRET
pnpm db:migrate:local
pnpm --filter @cloudbrowser/api exec wrangler d1 execute cloudbrowser --local \
  --persist-to ../../.wrangler/state --command "INSERT INTO invites (email) VALUES ('you@example.com')"

pnpm --filter @cloudbrowser/web build                     # the api Worker serves apps/web/dist
cd apps/api && pnpm exec wrangler dev -c wrangler.jsonc -c ../engine/wrangler.jsonc \
  --persist-to ../../.wrangler/state
```

Open http://localhost:8787 and sign in with the invited email. `wrangler dev` simulates Email
Service sends (the message is printed in the log) and, with `ENVIRONMENT=development`, the 6-digit
code is also logged. Queues, the Durable Object and the rate limiters all run locally. For frontend work with hot reload,
also run `pnpm --filter @cloudbrowser/web dev` (Vite on :5173 proxies `/api` to :8787).

Cron handlers (idle sleep, IP checks, reaper, reconciler) can be triggered locally with
`wrangler dev --test-scheduled` and `curl "http://localhost:<port>/__scheduled?cron=*+*+*+*+*"`.

## Checks

```bash
pnpm typecheck   # all workspaces
pnpm test        # engine fault-injection + lifecycle, api end-to-end (Better Auth + engine), reconciler
pnpm build       # web bundle
```

Tests run the production `drizzle-orm/d1` code against an in-memory SQLite D1 shim
(`packages/db/src/testing.ts`), with the real migrations.
