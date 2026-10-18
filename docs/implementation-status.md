# Implementation status

Mapped to the Notion plan's roadmap (page 8). This repo is **Phase 0 · Foundations**, built for a
Cloudflare deployment.

## Built

- **Monorepo** (pnpm + Turborepo), CI workflow running typecheck, tests and build.
- **Contracts** (`packages/contracts`): zod schemas for instances, regions, operations, errors (stable
  RFC 9457 `type` codes), sessions and events; OpenAPI 3.1 is generated from them at
  `/api/v1/openapi.json`.
- **Data model** (`packages/db`): plan page 2 tables — Better Auth tables, `browser_instances`,
  `placements`, `resources` (ledger), `ip_addresses` (permanent history), `operations` (partial unique
  index: one unfinished per instance), `operation_steps` (journal), `idempotency_keys`, `caps`,
  `control_flags`, quota/spend snapshots, `drift_findings`, `instance_health`, `viewer_sessions`,
  `events` (SSE change feed), `audit_log`. Triggers make `region_id` and an IP's owner immutable.
  Pilot caps from page 12 are seeded.
- **Executors** (`packages/executors`): the executor interface and error classes from page 10, and the
  `fake` executor with client-token idempotency, tag guardrails, credential modes (runtime cannot
  delete; reaper cannot create; read-only), and fault injection.
- **Engine** (`apps/engine`): consumes the `cloudbrowser-operations` queue; hosts the `EventHub`
  Durable Object for SSE; `create`, `start`, `stop`, `change_ip`, `delete`, `undelete`, `purge`,
  `restore` and `recover`
  with the write-ahead step journal, leases, ledger-before-call, lookup on unknown outcomes, retries
  per error class, IP screening (never reuse an address), binding check and in-Chrome IP check,
  honest states (*Waiting for capacity*, *Provider issue*, *Needs attention*, *Failed*), idle sleep,
  5-minute IP checks with fail-closed status, change-IP rollback, and a separate **reaper**
  deployment (purge after 7 days, failed-create cleanup, rejected/superseded IPs after 30 days,
  orphans after 24 h).
- **Backups and recovery** (page 4, page 10): a daily provider snapshot of each volume (cron, kept
  7 days, the newest always kept); an encrypted profile archive at each sleep (the agent closes
  Chrome, packs the profile without caches, zstd, chunked AES-256-GCM with a per-browser key, and
  PUTs it to a presigned R2 URL; the last 10 plus one a day for 14 days are kept). Snapshots restore
  while asleep (new volume from the snapshot, swapped in, IP unchanged); archives restore while
  running (the agent swaps the profile and restarts Chrome; a bad archive leaves the profile as it
  was). `recover` snapshots the volume, restores it in another zone, moves the same IP to a new
  interface and builds a new VM there; it runs automatically when a start has waited 30 minutes for
  capacity. The old VM, interface and volume are released 7 days later; the IP never is. Purge
  destroys the archive key first, so archives are unreadable before R2 deletes them.
- **Billing with Creem** (page 6): plans Personal and Pro (seat-based, 2–50 browsers) with a pure
  `planLimits` function; hosted checkout (`POST /v1/billing/checkout`), the Creem customer portal,
  Personal → Pro upgrades and Pro browser counts with explicit proration, refusing to drop below
  the browsers in use. Webhooks are HMAC-verified over the raw body, stored by event id and
  processed from a queue; every event re-fetches the subscription from Creem, so duplicates and
  order do not matter. Entitlements become caps under `billing:<user>`; access is never granted
  from the checkout redirect. Grace of 7 days for failed payments, access until period end after
  cancel, revocation on a full refund or dispute; when access ends the engine sleeps every browser
  within a minute, data and IPs are kept 30 days (emails on day 1, 14, 28), then the browsers are
  deleted. Active hours are metered per user and month; browsers sleep 10 minutes after they run
  out (warning in the session view, banner at 80%). Volume size and snapshot retention follow the
  plan. A nightly re-sync logs drift. Billing is off until Creem is configured, and the pilot keeps
  its free plan until the `billing_required` flag is set.
- **Operator console** (page 10): `/admin` (code-split, English-only) on `/api/v1/admin/*`, behind
  the `admins` table, an IP allowlist (plus a recommended WAF rule) and a passkey step-up that lasts
  30 minutes per session. Overview (browsers by status, unfinished and failed operations, findings,
  alerts, pending webhooks, switches, spend guard, quotas), alerts with acknowledgement, operations
  with their step journals, browser search by id, name, email or IP with the full timeline
  (placements, ledger, IP history, operations, backups, audit), per-browser actions (retry, recover,
  sleep, suspend), users with plan and a per-user kill switch, the ledger, drift findings, caps and
  switches, and the audit log. Every change is audited. Users can add passkeys (Better Auth passkey
  plugin) in Settings → Security. Suspended browsers sleep within a minute and cannot start.
- **Alerts**: a shared `raiseAlert` (deduplicated while open) used by the reconciler (circuit
  breaker, findings, spend 80%/100%), the engine (failed IP checks, quota/forbidden/invalid errors)
  and billing (drift, disputes); delivered to email and a Slack-compatible webhook by the api cron.
- **AWS executor** (`packages/executors/src/aws`, guide: `docs/aws.md`): Elastic IP on its own
  network interface, encrypted gp3 data volume, VM from stock Ubuntu 24.04 with IMDSv2 and
  termination protection; ClientToken plus `cb:token` tag lookup for every create; instance-type
  fallback on capacity; snapshot, restore, volume swap and moving the IP for `recover`; deletes with
  the reaper user only; listing by tag and Service Quotas for the reconciler. Signed with SigV4
  (aws4fetch) against the EC2 Query API; tested against an in-memory EC2. A first-boot script
  installs Docker and runs the browser image (neko + Chrome, host network, WebRTC advertising the
  static IP) and the agent from `ghcr.io` images built by `.github/workflows/images.yml`. The VM
  firewall restricts only the browser's uid (no private, link-local or metadata addresses).
  CloudFormation (`infra/aws/cloudbrowser.yaml`) creates the network and three IAM users scoped to
  `cb:managed=true` resources. Not run against a real AWS account yet.
- **Reconciler** (`apps/reconciler`): ledger vs provider by tag, adoption, orphan and missing
  findings, circuit breaker, quota and spend snapshots feeding the spend guard.
- **API** (`apps/api`): the page 2 API surface except downloads — Better Auth
  email codes sent with Cloudflare Email Service (invite-only), Workers Rate Limiting on sign-in and
  writes, the IP echo endpoint, Idempotency-Key on lifecycle calls, admission checks (plan, region,
  global caps, quota headroom, spend guard, creation freeze), viewer sessions with take-over and
  idle heartbeats, IP verify, IP change requests, backups list and restore, SSE with `Last-Event-ID` resume.
- **Session gateway** (`apps/gateway`): a Worker on `connect.example.com` plus one `InstanceGateway`
  Durable Object per browser (WebSocket hibernation). Agents authenticate with a single-use
  bootstrap token (swapped for a long-lived credential) or that credential, checked through the
  api's `Internal` RPC entrypoint; viewers with a 60 s single-use Ed25519 token verified locally and
  redeemed once. It relays neko signaling and IME text, enforces one controller at a time, and
  delivers `agent_commands` (poked through the `cloudbrowser-agent-commands` queue, with every agent
  heartbeat as a backstop).
- **Agent** (`services/agent`, Go): outbound tunnel with reconnect and backoff, credential stored
  0600, `ready`/heartbeat/IP-check events, commands (`prepare_shutdown` with the profile archive,
  `restore_archive`, `ip_check`, `restart_chrome`, `set_firewall`), IP check from a throwaway Chrome browser context over CDP,
  fail-closed nftables switch, neko relay, CDP `Input.insertText` for IME. Tested against a fake
  gateway and against a real headless Chromium.
- **Engine ↔ agent**: `issue_bootstrap` stores only the token's hash; `await_agent` needs a `ready`
  report newer than the operation; `verify_ip_in_chrome` and `prepare_shutdown` are commands with
  60 s timeouts (the VM is stopped anyway without an ack); real agents self-check every 5 minutes and
  the engine pauses the network if the last check failed or is older than 15 minutes.
- **Live view plumbing**: `GET /v1/sessions/:id/connect` returns the gateway URL, a viewer token and
  Cloudflare Realtime TURN credentials for real placements (or with `LIVE_VIEW=on`).
- **Live view** (`packages/viewer`, session view): neko v3 signaling through the gateway, a
  receive-only RTCPeerConnection (relay-only when TURN servers are present), input on the data
  channel (pointer coalesced per frame, wheel, buttons, keys with X11 keysyms, Cmd→Ctrl on macOS,
  release-all on blur), IME text through the agent, paste (local clipboard → remote, then Ctrl+V)
  and remote clipboard → local, remote cursor drawn locally, remote screen size following the
  viewport (debounced, at most every 5 s), stats every 2 s with the toolbar indicator, reconnect with
  backoff and a fresh single-use token, take-over. Verified end to end in Chromium against a fake neko.
- **Images** (`images/`): browser image (neko v3 + Chrome, policies, fonts, flags) and Packer golden
  VM image (agent unit, nftables rules). Written, not built yet.
- **Web** (`apps/web`, `packages/ui`): design tokens from page 1, app shell, sign-in, dashboard with
  live status, create dialog (region, permanence note, advanced options, four progress steps,
  auto-open when ready), session view (44 px toolbar, region/IP chip, every state overlay, idle
  warning, fullscreen with Keyboard Lock), browser settings (identity, verify IP, request new IP,
  backups with restore, behavior, activity, delete with type-to-confirm), account page, Simplified Chinese and English.

## Deviations from the plan, and why

The plan put the control plane on AWS Tokyo. The deployment target is Cloudflare, and the rule
applied is: **use a Cloudflare service wherever it meets the requirement**. The browser VMs, their
static IPs and their volumes still come from the provider chosen by the trial (AWS EC2 / Oracle
Cloud), because Cloudflare does not offer VMs with a dedicated static egress IP.

| Plan | Implemented | Why |
|---|---|---|
| ECS Fargate services behind an ALB | Four Workers (api+web, engine, reaper, reconciler) | No servers, global edge, nothing to patch; same component split and credential separation. |
| RDS PostgreSQL | D1 (SQLite), Drizzle schema | Managed and serverless inside Cloudflare; Drizzle keeps a PostgreSQL move (e.g. via Hyperdrive) a dialect change. |
| pg-boss jobs | **Cloudflare Queues** (`cloudbrowser-operations`) + 1-minute cron sweep | Durable delivery and delayed redelivery for backoff and capacity waits. The send is not in the same transaction as the D1 write, so the cron sweep picks up any lost message within a minute. Leases and the step journal are unchanged. |
| PostgreSQL `LISTEN/NOTIFY` for SSE | **Durable Object** `EventHub` per user, `events` table in D1 as the durable feed | Writers notify the user's object; it pushes new rows to every open stream; Last-Event-ID resumes from D1. Hosted in the engine Worker, which deploys first. |
| AWS SES | **Cloudflare Email Service** (`send_email` binding) | No credentials in the Worker, same account and DNS. Needs Workers Paid to send to arbitrary recipients. |
| Rate limits per user and per IP | **Workers Rate Limiting** bindings + Better Auth's limits + D1 caps | Sign-in: 5/min per IP and per email. API writes: 60/min per user. The binding is per location and approximate, so quotas that must be exact (creates per day, IP changes per month) stay in D1 `caps`. |
| IP echo endpoint on Workers | `GET /api/echo/ip` in the api Worker | As planned: outside the browser provider. |
| Next.js 16 on ECS | Vite + React 19 SPA as Workers static assets | Same origin as `/api`; the plan forbids business logic in Next.js server code anyway. |
| Secrets Manager | Worker secrets | Only `BETTER_AUTH_SECRET` today. |
| CloudWatch | Workers Logs (`observability.enabled`) | Built in. |
| Per-service database roles | Separate Workers and bindings; ownership noted per table | D1 has no roles. |
| next-intl, locale in URL | Small typed i18n, locale in local storage | Fewer moving parts for the pilot. |
| Generated `openapi-fetch` client | Web imports the zod types from `packages/contracts` | Same contract, no codegen step yet. |
| Go session gateway on ECS with an `agent_sessions` registry | `cloudbrowser-gateway` Worker + `InstanceGateway` Durable Object per instance | Routing by instance id is what a Durable Object gives; hibernation makes idle tunnels free; no registry needed. |
| `agent.v1` / `viewer.v1` protobuf with Buf | JSON text frames, zod in `packages/contracts/src/protocol.ts`, mirrored in Go | The payload the gateway relays most (neko v3 signaling) is JSON already; no codegen toolchain for two languages. |
| Engine → gateway via `agent_commands` + `NOTIFY` | `agent_commands` + a `cloudbrowser-agent-commands` queue message | No binding from engine to gateway, so no deploy-order cycle; heartbeats are a delivery backstop. |
| S3 archives with per-instance keys wrapped by KMS | **R2** (presigned PUT/GET via the S3 API) with per-instance keys wrapped by a Worker secret (`ARCHIVE_MASTER_KEY`, AES-256-GCM) | Same envelope scheme without a KMS: the plain key exists only in the gateway's frame to the agent, never in D1. Presigned URLs keep archive bytes off the Workers. |
| pg-boss job for Creem webhooks; nightly reconciliation job | `cloudbrowser-billing` queue consumed by the api Worker; the api's 5-minute cron (lost events, period ends, notices, deletion after 30 days) and its 03:00 UTC run (re-sync from Creem) | Same asynchronous, idempotent processing with Cloudflare primitives. |
| Entitlements written into the user's `caps` | Caps under a separate `billing:<user>` scope, between the pilot defaults and operator overrides | The pilot's defaults and per-user overrides keep working unchanged; billing never overwrites an operator's override. |
| Running-hours cap enforced by the engine | The engine meters `running` time per user and month every minute (at most 5 minutes per tick if a run is missed) and sleeps browsers 10 minutes after the hours run out | The session view gets the deadline from the heartbeat and warns the user; starts are refused with `hours_exhausted`. |
| `/admin` limited by source IP at the load balancer | `ADMIN_IP_ALLOWLIST` checked in the api (404 for everyone else) plus a Cloudflare WAF rule | Two layers; the in-app check also covers preview URLs. |
| Alerts through CloudWatch alarms | `alerts` table written by every Worker, delivered by the api cron to Email Service and a chat webhook, acknowledged in the console | One place to see and acknowledge alerts; no extra service. |
| Golden VM image built with Packer | Stock Ubuntu 24.04 plus a first-boot script; the agent binary and VM files ship in a container image | Lets the first real browser run without an image build in the user's AWS account; the Packer template uses the same files and replaces the install later. |
| Browser container supervised by the agent through containerd | systemd units (`cloudbrowser-data`, `-browser`, `-agent`) with Docker; the agent stops and starts the container around archives and restores | Standard tooling on Ubuntu; same behavior. |
| Random bootstrap token stored hashed | HMAC-derived token (Worker secret `BOOTSTRAP_SECRET`), only the hash stored | `create_vm` can mint it after a crash without the token ever being written down. |

Considered and **not** used:

- **Cloudflare Workflows** for operations: the engine's journal, leases, ledger and
  one-operation-per-instance index are the safety mechanism of plan page 10 and are tested with
  fault injection; Workflows would duplicate the journal and split state between two systems.
- **Turnstile** on sign-in: it loads a third-party script from `challenges.cloudflare.com`, which the
  plan avoids because of reliability from mainland China; rate limiting and invite-only cover the
  pilot. Worth revisiting for public sign-up.
- **KV**: nothing needs a global read-mostly cache yet; sessions and limits need strong consistency.

## Not built yet (next phases)

- **Real browsers**: the first run against a real AWS account; `oci-compute` executor (Phase 1,
  page 11); a pre-built golden image and image signing.
- **Live view extras**: file upload and download channels, quality modes (Auto / Sharp text /
  Smooth motion), pausing video after 60 s in a hidden tab, touch gestures, sending quality
  aggregates to `viewer_sessions`. The neko event names and data-channel opcodes follow neko v3 and
  are confirmed against the pinned image when it is built.
- Agent: browser container supervision through containerd, neko credentials per wake.
- Manual backups ("Back up now") and pre-upgrade snapshots; showing a `restore` in progress as its
  own browser state.
- Landing and public pricing pages; hour packs and the *Always-on* add-on (after launch, page 6);
  60 fps for Pro (applied once the browser image is built); growing existing volumes online after an
  upgrade; verifying Creem's signed success-redirect parameters (not needed for access, which comes
  only from webhooks); confirming every Creem payload against recorded test-mode fixtures.
- Passkey sign-in (passkeys are registered and used for the admin step-up; sign-in with them is a
  small UI addition), TOTP, OAuth; time-limited support share codes (page 4); dashboard
  thumbnails; dependency-cruiser and an OpenAPI diff in CI.
