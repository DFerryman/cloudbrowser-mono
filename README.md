# cloudbrowser-mono

Nevazu ([nevazu.com](https://nevazu.com)) — persistent cloud browsers: each browser is a real Chrome in its own cloud VM with a **dedicated,
stable IP** in Tokyo or US West, **persistent encrypted data**, and a **low-latency live view**.
Browsers come in two machine tiers: **Basic** (2 vCPU / 4 GB) and **Premium**
(4 vCPU / 8 GB); they differ only in CPU and memory, see [docs/aws.md](docs/aws.md#premium-4-vcpu--8-gb).
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
  web/          Vite + React SPA: public site (home, pricing, docs, status, policies), sign-in,
                dashboard, create dialog, session view, settings (zh-CN + en, light/dark/system theme)
  api/          Worker: Hono REST + SSE under /api, Better Auth (email codes via Email Service,
                optional TOTP two-step verification), rate limits, IP echo; serves apps/web/dist
  engine/       Worker: queue consumer running operations (journal, leases, ledger, retries),
                EventHub Durable Object for SSE; reaper mode = only deleter
  reconciler/   Worker: ledger vs provider, orphans, circuit breaker, quota and spend snapshots
  gateway/      Worker: session gateway, one InstanceGateway Durable Object per browser
                (agent tunnel + viewer WebSockets, hibernation), delivers agent commands
services/
  agent/        Go: in-VM agent (gateway tunnel, Chrome over CDP, IP checks, neko relay, nftables)
images/
  browser/      neko v3 + Chrome container (policies, fonts, flags)
  agent/        agent binary + VM files, copied out by a VM's first boot
  vm/           VM files (systemd units, scripts, nftables rules) and the Packer golden image
infra/
  aws/          CloudFormation: VPC, security group, runtime/reaper/read-only IAM users
packages/
  contracts/    zod schemas shared by api and web (OpenAPI is generated from them)
  db/           Drizzle schema + D1 migrations (single schema authority)
  executors/    Executor interface, `aws-ec2` (the only provider) and the `fake` simulator
  viewer/       Live-view client: neko v3 over the gateway, WebRTC, input, IME, clipboard, stats
  ui/           Design tokens and components
```

## Local development

Requirements: Node 22.13+ and pnpm 10.

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars          # set BETTER_AUTH_SECRET; APP_URL is localhost
pnpm db:migrate:local

pnpm --filter @cloudbrowser/web build                     # the api Worker serves apps/web/dist
cd apps/api && pnpm exec wrangler dev -c wrangler.jsonc -c ../engine/wrangler.jsonc \
  --persist-to ../../.wrangler/state --local-upstream localhost:8787
```

Open http://localhost:8787 for the public site, http://localhost:8787/sign-up to create an account with any email (sign-up is open unless the operator turns on the `invite_only` switch), then /sign-in. `wrangler dev` simulates Email
Service sends (the message is printed in the log) and, with `ENVIRONMENT=development`, registration
links and 6-digit codes are also logged. (`--local-upstream` keeps `wrangler dev` from rewriting the Origin header
to the production domain in `routes`, which sign-in would refuse.) Queues, the Durable Object and the rate limiters all run locally. For frontend work with hot reload,
also run `pnpm --filter @cloudbrowser/web dev` (Vite on :5173 proxies `/api` to :8787).

Snapshots: user snapshot controls and automatic daily snapshots have been removed. Internal
recovery and cleanup still handle existing provider snapshots. Profile archives need real R2 credentials (see
`docs/deploy-cloudflare.md`); without them they are skipped locally.

Billing: browsers draw per minute from a prepaid balance, at the AWS list price for their region
(read from the AWS Price List API) times the markup set in the operator console. Locally the
simulator's price sheet is used. Paid browsers also reserve seven days of fixed IP/disk costs;
the reserve remains unspent balance, and only available credit can fund use. At exhaustion,
access stops immediately and the reserve funds seven days of retention before permanent deletion.
The one free trial (30 minutes by default; operator setting `trial_minutes`) is exempt. Missing Creem settings disable top-ups, not prepaid checks.
An explicit `billing_required=false` is only a local test/pilot override. To try Creem test mode locally, put
`CREEM_API_BASE=https://test-api.creem.io`, `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET` and
`CREEM_TOPUP_PRODUCTS` (one-time product ids, comma-separated) in `apps/api/.dev.vars`, and expose
the webhook with `cloudflared tunnel --url http://localhost:8787` (webhook URL:
`<tunnel>/api/webhooks/creem`).

Operator console: [admin.console.nevazu.com](https://admin.console.nevazu.com) uses Cloudflare
Access email OTP and a separate administrator identity. Local development has no authentication
bypass; see [deployment setup](docs/deploy-cloudflare.md#3c-operator-console-and-alerts) and the
signed-JWT API tests for configuring an Access-protected development origin.

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
WebRTC video plays. User input uses one ordered WebSocket queue across mouse, touch, keyboard,
IME and clipboard events, with backpressure and visible failure instead of silent input loss.

On touch screens, tap to click and swipe with one or two fingers to scroll. Use the toolbar's
keyboard button to show or hide the software keyboard; touching the picture keeps that choice.
On touch screens the session frame is not fixed to the viewport: it is laid out within the
never-scrolling page at the visual viewport's position and size, at all times. WebKit paints a
fixed element pinned to the visual viewport but hit-tests it against the layout viewport, so
whenever the two differed (the on-screen keyboard, and an offset iOS 26 leaves behind after it
closes) taps landed below what they touched; an absolutely positioned frame is painted and
hit-tested in one place. While the keyboard is up the view moves above it and the picture shrinks
proportionally to fit; the remote desktop keeps its size. Input is mapped from the event's own
offsets within the picture. More → *Input diagnostics* (or `?debug=input`) marks where each tap is
registered, with the geometry behind it, for a screenshot. Maximize on phones and tablets (and wherever element fullscreen is
unavailable) hides the toolbar within the page and shows a floating control with the keyboard and
the way back, since WebKit allows no keyboard input in a fullscreen element on iPhone and iPad;
desktops keep true fullscreen with Keyboard Lock. More → *Reconnect live view* restarts the
connection in place, and a page that lost its connection in the background reconnects when it is
shown again. After a deployment, an open page whose lazily loaded parts are gone reloads itself
once (`vite:preloadError`); anything else lands on the app's own error page with a Reload button.
The standalone touch/input regression mounts the real viewer and interprets its Neko wire events, without
sign-in or a running VM:

```bash
node packages/viewer/e2e/touch-input.mjs   # requires Playwright and Chromium; accepts PLAYWRIGHT_PATH
```

Cron handlers (idle sleep, IP checks, reaper, reconciler) can be triggered locally with
`wrangler dev --test-scheduled` and `curl "http://localhost:<port>/__scheduled?cron=*+*+*+*+*"`.

## Real browsers

Regions start on the simulator (`fake` executor). To run real VMs on AWS, follow
[docs/aws.md](docs/aws.md).

## Checks

```bash
pnpm typecheck   # all workspaces
pnpm test        # engine fault-injection + lifecycle, api end-to-end (Better Auth + engine), reconciler
pnpm build       # web bundle
cd services/agent && go test -race ./...   # set CHROME_BIN to also run the CDP test against Chrome
```

Tests run the production `drizzle-orm/d1` code against an in-memory SQLite D1 shim
(`packages/db/src/testing.ts`), with the real migrations.
