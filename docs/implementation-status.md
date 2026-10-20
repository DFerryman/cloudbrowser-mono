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
  Durable Object for SSE; `create`, `start`, `stop`, `delete`, `undelete`, `purge`, `restore` and
  `recover` (`change_ip` is retired: a request left by an older API ends without any step)
  with the write-ahead step journal, leases, ledger-before-call, lookup on unknown outcomes, retries
  per error class, IP screening (never reuse an address), binding check and in-Chrome IP check,
  honest states (*Waiting for capacity*, *Provider issue*, *Needs attention*, *Failed*), idle sleep,
  5-minute IP checks with fail-closed status, change-IP rollback, and a separate **reaper**
  deployment (permanent user-delete cleanup, system retention purge after 7 days, failed-create cleanup, rejected/superseded IPs after 30 days,
  orphans after 24 h).
- **Internal recovery** (page 4, page 10): user snapshots and the daily snapshot cron are removed.
  An encrypted profile archive is retained at each sleep (the agent closes
  Chrome, packs the profile without caches, zstd, chunked AES-256-GCM with a per-browser key, and
  PUTs it to a presigned R2 URL; the last 10 plus one a day for 14 days are kept). Snapshots restore
  while asleep (new volume from the snapshot, swapped in, IP unchanged); archives restore while
  running (the agent swaps the profile and restarts Chrome; a bad archive leaves the profile as it
  was). `recover` snapshots the volume, restores it in another zone, moves the same IP to a new
  interface and builds a new VM there; it runs automatically when a start has waited 30 minutes for
  capacity. The old VM, interface and volume are released 7 days later; the IP never is. Purge
  destroys the archive key first, so archives are unreadable before R2 deletes them.
- **Prices from AWS** (page 6): the engine reads each region's prices from the AWS Price List
  Query API (`pricing:GetProducts`) for its instance type: compute per hour, gp3 storage and
  snapshots per GB-month, the public IPv4 address per hour and data sent to the internet per GB.
  Sheets are stored in `provider_prices`, refreshed every 12 hours (or from the console), and a
  region without a price takes no new browsers. Customer prices are cost times a markup kept in
  `pricing_settings` and set in the console (default 120%). Every price the user is shown before
  an action (create, more storage, snapshots) carries a version; the API refuses the
  action with `price_changed` if prices moved in between.
- **Prepaid balance with Creem** (page 6): users buy one-time top-up products through Creem's
  hosted checkout; the amount credited is the verified checkout's actual paid USD amount
  excluding tax, not a later catalogue price, and each order is credited once. Webhooks are HMAC-verified, stored by event id and
  processed from a queue; refunds and disputes debit the balance and a dispute freezes the
  account. The engine meters every browser per minute into `usage_records` (compute while
  running; IP and provisioned disks while held; data out from the agent's counter). Storage
  GB-months use actual UTC calendar-month fractions; 730 hours is a display projection only.
  Seven days of fixed IP/disk costs are reserved from the total balance but remain unspent.
  Only available credit can fund normal usage. At exhaustion, input access is revoked and VMs
  stop without a grace period; the reserve funds seven days of retention before permanent purge.
  Unused retained credit is released after deletion or funded resumption. Normal usage cannot
  debit more than funded credit. Billing defaults to prepaid; explicit false is a test/pilot override.
- **Billing consistency**: an engine test drives two browsers through a month boundary, stops,
  traffic, a capped last minute and retention, and checks that the balance equals the applied
  transactions, usage debits equal charged usage, and every month, browser, day and item total
  agrees between the user's pages and the operator console. Running time settled by a stop is
  capped like metered running time after a missed run; access deadlines use the metering's
  rounding. The console's margin table includes internal snapshot cost (so rows add up), payment
  fees are estimated on the amount paid including tax, and the users list shows available and
  held credit like the user's own page.
- **Free trial** (page 6): each user may create one browser for free, once, in Sydney: 10 minutes
  of running time, a 2 GB data volume, no snapshots, 5-minute auto-sleep. It is metered at cost
  but charged nothing, sleeps when the 10 minutes are used, and is kept until its fixed seven-day
  deadline; repeated stops do not extend it. It is then deleted and purged. Adding enough credit before then converts it into a normal browser
  with the same data and IP; from then on it is charged like any other.
- **Right-sized VMs**: one dedicated VM per browser, 2 vCPU / 4 GB (`c7i-flex.large`, then
  `c6i.large` and `c5.large` on a capacity error), with a 1 GB swap file, a 1 GB shared-memory cap
  for the browser container and the agent protected from the out-of-memory killer. The VM is
  stopped while the browser sleeps. The machine size comes from the price list and is shown with
  the price.
- **Machine tiers**: a browser is Basic (2 vCPU / 4 GB, `c7i-flex.large` → `c6i.large` →
  `c5.large`, VP8 up to 25 fps) or Premium (4 vCPU / 8 GB, `c7i.xlarge` → `c6i.xlarge` →
  `c5.xlarge`, H.264 up to 60 fps on a 60 Hz desktop), chosen at creation and immutable (trigger).
  The VM's first boot passes `BROWSER_TIER`; the browser image selects `neko-premium.yaml` with
  `NEKO_CONFIG`. Premium is priced from the same AWS price list (`ProviderPriceSheet.premium`,
  its own price version), metered at its machine's price, and counted in a shared vCPU inventory
  (migration 0029). The operator switch `premium` (user:default or user:<id>, off by default)
  offers it; the free trial is always Basic. The viewer asks for up to 60 Hz and judges frame drops
  against the tier's rates. Measurements and the rollout steps are in `docs/aws.md`.
- **Storage** (page 6): new browsers get a 10 GB data volume (cap `storage_gb`); users can grow it
  up to `storage_max_gb` (100 GB) from the Storage tab, which shows used and total space and the
  monthly cost before confirming. The volume grows online (`ModifyVolume`) and agent 0.2.0 grows
  the file system. AWS permits at most four volume modifications in a rolling 24-hour period,
  and the previous modification must be complete before another starts. A mounted ext4 file
  system can grow online without restarting Chrome or the VM. User snapshot controls, public
  backup/restore routes and automatic daily snapshots are removed; existing snapshot resources
  and temporary internal recovery snapshots are still cleaned up safely and are not user charges.
- **Usage pages**: the main balance is all unspent credit, including the frozen seven-day
  resource deposit; available and frozen amounts are listed separately. Freezing is not a debit.
  Billing & usage shows top-ups, transactions and this month's spend by item, by browser and in
  a date-labelled UTC daily charge table. It has no regional price catalogue. The top-up button
  opens Creem to choose the payment amount. Each browser's Usage tab shows its own charges.
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
- **Notifications** (`apps/api/src/notifications`, guide: `docs/notifications.md`): split into
  user-facing emails (`user.ts`: sign-in codes, credit warnings, deletion notices, browser notices,
  reward confirmations, each with a repeat rule and the advisory ones with a cooldown) and
  administrator alerts (`admin.ts`: delivery, region out of inventory, user milestones, promotion
  budgets). Alert emails default to the admin allowlist when `ALERT_EMAILS` is empty.
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
  idle heartbeats, IP verify and SSE with `Last-Event-ID` resume (new-IP requests were removed;
  the route answers 410). Viewer open
  requests accept a stable Idempotency-Key so a timed-out retry cannot take over its own session.
  Paid access renewal deadlines are separate from actual credit-depletion warnings.
- **Session gateway** (`apps/gateway`): a Worker on `connect.example.com` plus one `InstanceGateway`
  Durable Object per browser (WebSocket hibernation). Agents authenticate with a single-use
  bootstrap token (swapped for a long-lived credential) or that credential, checked through the
  api's `Internal` RPC entrypoint; viewers with a 60 s single-use Ed25519 token verified locally and
  redeemed once. It relays neko signaling and IME text, enforces one controller at a time, and
  delivers `agent_commands` (poked through the `cloudbrowser-agent-commands` queue, with every agent
  heartbeat as a backstop).
- **Agent** (`services/agent`, Go): outbound tunnel with reconnect and backoff, credential stored
  0600, `ready`/heartbeat/IP-check events, commands (`prepare_shutdown` with the profile archive,
  `restore_archive`, `ip_check`, `restart_chrome`, `set_firewall`), IP check from a hidden page in a throwaway Chrome browser context over CDP (never a visible window),
  fail-closed nftables switch, neko relay, CDP `Input.insertText` for IME. Tested against a fake
  gateway and against a real headless Chromium.
- **Engine ↔ agent**: `issue_bootstrap` stores only the token's hash; `await_agent` needs a `ready`
  report newer than the operation; `verify_ip_in_chrome` and `prepare_shutdown` are commands with
  60 s timeouts (the VM is stopped anyway without an ack); real agents self-check every 5 minutes and
  the engine pauses the network if the last check failed or is older than 15 minutes.
- **Public site**: `/` (home), `/pricing` (per-region running, asleep and data rates from
  `GET /api/public/pricing`, unit rates, a monthly estimator, how prepaid charges and the held
  amount work, the free trial and an FAQ), `/docs` (the user guide; long explanations live here
  instead of on the app's pages), `/status` (`GET /api/public/status`: database, background jobs,
  and whether each offered region takes new browsers), `/terms`, `/privacy`, `/refunds`,
  `/contact` and a 404 page, all in English and Chinese. The public endpoints are GET-only, carry
  nothing per user and may be cached for a minute. The theme (system, light or dark) is applied
  before first paint by `public/theme-init.js`. Registration stays invite-only; sign-in links the
  policies and an invitation request, confirms sign-out, and skips the form when already signed in.
- **Pagination**: admin lists, credit history and viewer sessions accept `limit` and `offset`
  (defaults unchanged); clients ask for one row more than they show to know whether a next page
  exists. Browsers (12), usage by browser and by day (10), daily charges (10), credit history (10),
  activity (10) and passkeys (10) are paged in the app; console lists page by 50–100 rows on the
  server and in-memory tables by 25.
- **Two-step verification**: Better Auth's two-factor plugin, passwordless, with TOTP authenticator
  apps. Account → Security shows a QR code (rendered locally) and the setup key; the first code
  confirms it, then ten one-time backup codes are shown to copy or download. Every email-code
  sign-in then withholds the session until a TOTP or backup code is verified (five attempts per
  challenge, a 15-minute lock after ten wrong codes, an optional 30-day trusted device). Turning it
  off needs a current authenticator or backup code, replacing backup codes needs an authenticator
  code, and the setup secret is never readable again. Operators can reset it (audited).
  The second step stays at sign-in, before any session exists, rather than when opening the
  dashboard or a browser: a session created after the email code alone could already read billing
  and change settings, and checking once at the entrance keeps opening a browser fast.
- **Launch failures and zones**: a VM that EC2 terminates during launch is reported with EC2's
  state reason and relaunched under a new token (the old ClientToken only ever returned the same
  dead VM, so retries could never succeed and every such failure looked like "waiting for
  capacity"). Only `Server.InsufficientInstanceCapacity` counts as capacity; an unusable EBS key or
  similar fails at once with an alert. Data volumes are confirmed `available` before use. A new
  browser starts in a zone that offers its machine types and had no recent shortage, and on a
  capacity error moves to another zone with the same IP. The reaper no longer rescans failed
  creates whose cleanup is confirmed.
- **Region choice**: the create dialog lists regions nearest first, with latency measured from the
  user's network (an estimate until measured), *Available* / *Limited* / *Unavailable* with the
  reason, the running price and a *Fastest for you* mark; long lists collapse to the nearest five
  with search. Public pricing, status and home pages list the live regions by continent.
- **Never sleep** (`idle_timeout_s = 0`): its own operator switch (`never_sleep` cap, 1 or 0, for
  user:default or user:<id>; migration 0023 offers it by default), never a value that slips under
  `idle_timeout_max_s`. Refused for free trial browsers; on a paid deployment it also needs a
  top-up on the account and available credit for 24 hours of the account's combined spending with
  the browser always on. `GET /instances/{id}/never-sleep` quotes 24 hours of compute, IP and
  storage in the browser's region; PATCH needs that quote's priceVersion. A converting trial gets
  the 10-minute paid default. Changing the timeout restarts the idle countdown
  (`instance_health.last_input_at`). An idle stop queued before the user acts is rechecked in the
  transaction that starts it (input since it was queued, or Never sleep, cancels it and restores
  the running intent); a stop that has started finishes, and the new setting applies to the next run.
- **Funded time and stop notices**: `accountRunway` (the authorization projection, shared with
  `prepaidAccess`) gives the combined spending rate and when available credit runs out; the
  sidebar, Billing page and banner show it, and the billing sweep emails once each below 24, 6 and
  1 hours (`billing_accounts.runway_warned_hours`, re-armed at 1.25x a threshold). Running out of
  credit stops every paid browser even with no viewer; a top-up never wakes one. The email at
  exhaustion, after three days and a day before deletion names each browser, its deletion time and
  the least top-up that keeps all of them (deposits plus the minimum balance); browsers and the
  Billing page show the same. Stops by an administrator, suspension or a frozen account, and
  networks paused by the IP check, are queued in `user_notices` by the engine and emailed by the
  sweep; none of them is ever undone automatically.
- **Picture resolution and adaptive quality**: the old screen-size setting was stored but never
  applied. neko now streams a ladder of the same desktop, every level at full resolution
  (`full` 25 fps, `high` 20 fps, `medium` 15 fps, `low` 10 fps; VP8 at 2.0/1.6/1.2/0.9 Mbit/s with
  max quantizers 20/24/28/32): lower levels give up frame rate and a little fine detail, never
  resolution — earlier ladders downscaled to 75% and then 50%, which blurred text; before, `codec: h264` without pipelines
  silently fell back to neko's single default VP8 stream). There is no picture setting: the
  per-browser resolution and *Adjust to my connection* options were removed (their D1 columns stay
  unused so an older API can be rolled back to); every live view starts at `full` and adapts. The
  API still returns `videoQuality: 'full'` and `videoAuto: true` for live views opened before the
  change; both can go in a later release. A long round trip caps the level to keep 25 fps: the
  median of the last five readings above 180 ms allows `high`, above 320 ms `medium` (30 ms of
  hysteresis before a cap lifts); `low` at 15 fps is reached only when frames, loss, freezes or a
  rise in delay show the connection struggling for three readings (about 6 s). The viewer also
  measures the decoded picture against the desktop and never adapts below a level whose picture
  is under 90% of the desktop's width (`MIN_LEGIBLE_SCALE`), so browsers still on an older,
  downscaling ladder stay at `full`.
  The viewer requests the level with `signal/video`
  and adapts it from its own receive statistics (dropped frames, loss, freezes, growing RTT),
  because neko 3.0.8's estimator compares bits with bytes. The page layout follows the viewer's
  size at every level; pointer positions map to the remote screen, not the video's pixels.
  Verified against the real neko image with the real viewer: throttled to 350 kbit/s it stepped
  down to `low` within about 20 s and back to `full` about a minute after recovery. Browsers on an
  older image keep their single stream.
- **Cron isolation**: each engine cron step (idle stops, metering, trial reclamation, pending
  operations, IP checks, stopped intent) runs even if an earlier one failed, and one browser's
  provider error no longer skips the fail-closed IP check of the others; failures are reported
  together.
- **Connection path**: the session page hands its prefetched viewer token to the first connection
  attempt instead of fetching a second one; session open and connect run their independent D1
  reads and the TURN credential request in parallel; the gateway redeems a token in one statement,
  reads the session and credit together and renews an expiring one-second input lease in the
  background so signaling and typing do not stall on D1. The viewer tracks neko's screen size,
  skips no-op `screen/set` requests (neko rebuilds its encoder on every one) and makes a needed
  change during the WebRTC handshake, so the first frame already has the right size. Measured with
  real Chromium against a TURN relay: pre-gathering ICE candidates does not help, because Chrome
  only uses the candidate pool as the offerer and neko offers, so it is not used.
- **Live view plumbing**: `GET /v1/sessions/:id/connect` returns the gateway URL, a viewer token and
  Cloudflare Realtime TURN credentials for real placements (or with `LIVE_VIEW=on`).
- **Live view** (`packages/viewer`, session view): neko v3 signaling through the gateway, a
  receive-only RTCPeerConnection (relay-only when TURN servers are present), ordered WebSocket
  input (pointer, wheel, buttons, keys with X11 keysyms, Cmd→Ctrl on macOS, release-all on blur),
  paired-key IME text and paste (local clipboard → remote, then Ctrl+V)
  and remote clipboard → local, remote cursor drawn locally, remote screen size following the
  viewport (debounced, at most every 5 s), stats every 2 s with the toolbar indicator, reconnect with
  backoff and a fresh single-use token, take-over. HTTP/token and transport waits are bounded;
  stale asynchronous responses cannot overwrite a replacement session. Authorization uses one
  current D1 batch and an existing one-second grant for relay bursts; stop/delete RPC revocation
  and hard trial/funding deadlines remain enforced. Same-session reconnects do not report take-over.
- **Files into the browser** (agent 0.3.0): files and images pasted (Ctrl+V / Cmd+V, or the
  toolbar's Upload button) or dragged onto the view travel to the VM as acknowledged base64 chunks
  on the viewer socket (`FILE_TRANSFER` in contracts: up to 10 files, 50 MB, three chunks in
  flight). The agent writes them to `/data/browser/uploads` (Chrome sees `/data/uploads`; cleared at
  each wake, pruned after 24 h). A paste sets the browser's X clipboard with xclip in the browser
  container (one PNG as an image, other images re-encoded to PNG by the viewer, anything else as a
  `text/uri-list` that Chrome pastes as files), then the viewer sends Ctrl+V; neko's echo of that
  clipboard is not relayed back. A drop is CDP `Input.dispatchDragEvent` with the files at the
  drop point on the visible tab. Browsers on an older agent answer neither, and the viewer says so
  after 20 s.
- **Rotated view on phones**: a toolbar button on touch devices turns the view a quarter clockwise
  for a phone held sideways in portrait orientation; the remote screen takes the turned shape, and
  pointer, touch, wheel and drop input are mapped through the turn. The choice is remembered per
  device.
- **Promotions**: a *Promotions* entry at the bottom of the dashboard sidebar (with a count of
  pending tasks; a fifth tab on phones) lists the user's tasks with progress, and the ones they
  completed. Operators define tasks in the console (*Promotions*): English and Chinese wording, the
  in-app link for the Start button, how completion is decided (`browser_used_minutes`: one
  browser's live view open, capped at the last heartbeat + 1 minute; `browser_running_minutes`,
  `total_running_minutes`, `live_view_minutes`, `browsers_created`, `topup_usd` net of
  refunds, `two_factor_enabled`, `passkeys_added`) and its target, the reward, a start and end time,
  a budget (max. accounts), and an optional paid-top-up requirement against throwaway accounts.
  The api records each completion once (`promotion_completions`) and credits the reward as a
  `promotion` balance transaction (reference `promotion:<task>:<user>`), when the user opens the page
  and from the 5-minute cron. Seeded task: one browser used (live view open) for 20 minutes in total
  from launch earns $5, for up to 1,000 accounts.
- **Images** (`images/`): browser and agent containers are built and published to GHCR. The
  pre-built Packer golden VM image remains planned.
- **Web** (`apps/web`, `packages/ui`): design tokens from page 1, app shell, sign-in (with the
  second step), dashboard with live status, create dialog (plan choice when the free trial is
  offered, regions with price and latency, permanence note, collapsed advanced options, a cost
  summary with the full breakdown on request, actions and balance status in a footer that stays
  visible; a bottom sheet on phones), four progress steps and auto-open when ready, session view (44 px toolbar, region/IP chip, every state overlay, idle
  warning, fullscreen with Keyboard Lock), browser settings (identity, verify IP,
  backups with restore, behavior, activity, delete with type-to-confirm, also from a card's menu;
  no per-browser language: Chrome uses English), account page, Simplified Chinese and English.

## Deviations from the plan, and why

The plan put the control plane on AWS Tokyo. The deployment target is Cloudflare, and the rule
applied is: **use a Cloudflare service wherever it meets the requirement**. The browser VMs, their
static IPs and their volumes come from AWS EC2, the only provider (the decision is final), because
Cloudflare does not offer VMs with a dedicated static egress IP.

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
| Subscription plans (Personal, Pro) with an hours allowance | A prepaid balance topped up with Creem one-time products, charged per minute at AWS cost times a markup | Costs depend on the region and on what a browser keeps while asleep (IP, disks); a balance charges exactly that, with no plan maths, and the trial converts by adding credit. |
| pg-boss job for Creem webhooks; nightly reconciliation job | `cloudbrowser-billing` queue consumed by the api Worker; cron retries lost events and expires seven-day prepaid retention, plus a nightly paid-order backstop | Same asynchronous, idempotent processing with Cloudflare primitives. |
| Running-hours cap enforced by the engine | Elapsed-time metering, available credit after a seven-day fixed-resource reserve, and immediate exhaustion stop intent | Gateway alarms expire input access; paid starts require sufficient available credit and a funded reserve. |
| `/admin` limited by source IP at the load balancer | Dedicated `admin.console.nevazu.com` behind Cloudflare Access email OTP; API verifies signed JWT and exact email allowlist | No IP restriction; main-site cookies, the legacy admin table, and preview URLs cannot grant admin access. |
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

- **Real browsers**: a pre-built golden image and image signing.
- **Live view extras**: file upload and download channels, quality modes (Auto / Sharp text /
  Smooth motion), pausing video after 60 s in a hidden tab, touch gestures, sending quality
  aggregates to `viewer_sessions`. The neko event names and data-channel opcodes follow neko v3 and
  are confirmed against the pinned image when it is built.
- Agent: browser container supervision through containerd, neko credentials per wake.
- Manual backups ("Back up now") and pre-upgrade snapshots; showing a `restore` in progress as its
  own browser state.
- Landing and public pricing pages; automatic top-up; taxes shown before checkout (Creem adds them
  at checkout); growing the file system of browsers created before agent 0.2.0 (they need to be
  recreated, or the agent updated, before the Storage tab allows growth); confirming every Creem
  payload against recorded test-mode fixtures.
- Passkey sign-in (passkeys are registered and used for the admin step-up; sign-in with them is a
  small UI addition), OAuth; time-limited support share codes (page 4); dashboard
  thumbnails; dependency-cruiser and an OpenAPI diff in CI.
