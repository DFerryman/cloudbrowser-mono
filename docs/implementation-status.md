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
  Durable Object for SSE; `create`, `start`, `stop`, `change_ip`, `delete`, `undelete`, `purge`
  with the write-ahead step journal, leases, ledger-before-call, lookup on unknown outcomes, retries
  per error class, IP screening (never reuse an address), binding check and in-Chrome IP check,
  honest states (*Waiting for capacity*, *Provider issue*, *Needs attention*, *Failed*), idle sleep,
  5-minute IP checks with fail-closed status, change-IP rollback, and a separate **reaper**
  deployment (purge after 7 days, failed-create cleanup, rejected/superseded IPs after 30 days,
  orphans after 24 h).
- **Reconciler** (`apps/reconciler`): ledger vs provider by tag, adoption, orphan and missing
  findings, circuit breaker, quota and spend snapshots feeding the spend guard.
- **API** (`apps/api`): the page 2 API surface except billing/backups/downloads/admin — Better Auth
  email codes sent with Cloudflare Email Service (invite-only), Workers Rate Limiting on sign-in and
  writes, the IP echo endpoint, Idempotency-Key on lifecycle calls, admission checks (plan, region,
  global caps, quota headroom, spend guard, creation freeze), viewer sessions with take-over and
  idle heartbeats, IP verify, IP change requests, SSE with `Last-Event-ID` resume.
- **Web** (`apps/web`, `packages/ui`): design tokens from page 1, app shell, sign-in, dashboard with
  live status, create dialog (region, permanence note, advanced options, four progress steps,
  auto-open when ready), session view (44 px toolbar, region/IP chip, every state overlay, idle
  warning, fullscreen with Keyboard Lock), browser settings (identity, verify IP, request new IP,
  behavior, activity, delete with type-to-confirm), account page, Simplified Chinese and English.

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

Considered and **not** used:

- **Cloudflare Workflows** for operations: the engine's journal, leases, ledger and
  one-operation-per-instance index are the safety mechanism of plan page 10 and are tested with
  fault injection; Workflows would duplicate the journal and split state between two systems.
- **Turnstile** on sign-in: it loads a third-party script from `challenges.cloudflare.com`, which the
  plan avoids because of reliability from mainland China; rate limiting and invite-only cover the
  pilot. Worth revisiting for public sign-up.
- **KV**: nothing needs a global read-mostly cache yet; sessions and limits need strong consistency.

## Not built yet (next phases)

- **Real browsers**: `aws-ec2` / `oci-compute` executors and golden VM image (Phase 1, after the
  provider trial on page 11), `services/agent` (Go), `images/browser` (neko + Chrome),
  `agent_credentials` / `agent_commands`.
- **Live view**: `services/gateway` (Go), `packages/viewer` (WebRTC, IME, clipboard, uploads,
  downloads), Cloudflare Realtime TURN credentials. Until then `/sessions/:id/connect` returns
  `simulated` and the session view shows a placeholder.
- `recover` and `restore` operations, backups (provider snapshots, R2 archives with per-instance keys).
- Billing with Creem (page 6), landing and pricing pages, billing screen.
- Admin console (`/admin`), passkeys/TOTP/OAuth, dashboard thumbnails, dependency-cruiser and `buf breaking` in CI.
