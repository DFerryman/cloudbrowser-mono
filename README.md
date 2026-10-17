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
  gateway/      Worker: session gateway, one InstanceGateway Durable Object per browser
                (agent tunnel + viewer WebSockets, hibernation), delivers agent commands
services/
  agent/        Go: in-VM agent (gateway tunnel, Chrome over CDP, IP checks, neko relay, nftables)
images/
  browser/      neko v3 + Chrome container (policies, fonts, flags)
  vm/           Packer golden VM image (agent unit, nftables rules)
packages/
  contracts/    zod schemas shared by api and web (OpenAPI is generated from them)
  db/           Drizzle schema + D1 migrations (single schema authority)
  executors/    Executor interface + `fake` executor (aws-ec2 / oci-compute / fly-machines later)
  viewer/       Live-view client: neko v3 over the gateway, WebRTC, input, IME, clipboard, stats
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

Backups: the daily snapshot runs when the engine's 1-minute cron fires at minute 7 of an hour. Profile archives need real R2 credentials (see
`docs/deploy-cloudflare.md`); without them they are skipped locally.

### With a real agent (agent ↔ gateway ↔ engine)

```bash
echo AGENT_MODE=gateway > apps/engine/.dev.vars                 # fake VMs, real agents
cd apps/gateway && pnpm exec wrangler dev --port 8790 --inspector-port 9231 \
  --persist-to ../../.wrangler/state                            # second terminal
# create a browser in the app; it waits at "Starting Chrome", then:
scripts/dev-agent.sh <instance id>                              # third terminal
```

The agent swaps the bootstrap token from the fake VM's user data for a credential, reports
`ready`, answers the engine's IP check through the gateway and the browser turns *Running*.
For the viewer path, add keys from `node scripts/gen-viewer-keys.mjs` (private key and
`LIVE_VIEW=on` in `apps/api/.dev.vars`, public key in `apps/gateway/.dev.vars`).

### Live view end to end (real Chromium, fake neko)

With the stack above, viewer keys and `LIVE_VIEW=on`:

```bash
node packages/viewer/e2e/neko-bridge.mjs                                   # stands in for neko's WebSocket
scripts/dev-agent.sh <instance id> --neko-ws ws://127.0.0.1:8099/api/ws    # instead of the plain agent
node packages/viewer/e2e/run.mjs <instance id> <wrangler log> shot.png
```

The runner signs in to the real web app, opens the session view and checks that the fake neko's
WebRTC video plays and that mouse, click, key and scroll input arrives over the data channel.

Cron handlers (idle sleep, IP checks, reaper, reconciler) can be triggered locally with
`wrangler dev --test-scheduled` and `curl "http://localhost:<port>/__scheduled?cron=*+*+*+*+*"`.

## Checks

```bash
pnpm typecheck   # all workspaces
pnpm test        # engine fault-injection + lifecycle, api end-to-end (Better Auth + engine), reconciler
pnpm build       # web bundle
cd services/agent && go test -race ./...   # set CHROME_BIN to also run the CDP test against Chrome
```

Tests run the production `drizzle-orm/d1` code against an in-memory SQLite D1 shim
(`packages/db/src/testing.ts`), with the real migrations.
