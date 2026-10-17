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
- **Engine** (`apps/engine`): `create`, `start`, `stop`, `change_ip`, `delete`, `undelete`, `purge`
  with the write-ahead step journal, leases, ledger-before-call, lookup on unknown outcomes, retries
  per error class, IP screening (never reuse an address), binding check and in-Chrome IP check,
  honest states (*Waiting for capacity*, *Provider issue*, *Needs attention*, *Failed*), idle sleep,
  5-minute IP checks with fail-closed status, change-IP rollback, and a separate **reaper**
  deployment (purge after 7 days, failed-create cleanup, rejected/superseded IPs after 30 days,
  orphans after 24 h).
- **Reconciler** (`apps/reconciler`): ledger vs provider by tag, adoption, orphan and missing
  findings, circuit breaker, quota and spend snapshots feeding the spend guard.
- **API** (`apps/api`): the page 2 API surface except billing/backups/downloads/admin — Better Auth
  email codes (invite-only), Idempotency-Key on lifecycle calls, admission checks (plan, region,
  global caps, quota headroom, spend guard, creation freeze), viewer sessions with take-over and
  idle heartbeats, IP verify, IP change requests, SSE with `Last-Event-ID` resume.
- **Web** (`apps/web`, `packages/ui`): design tokens from page 1, app shell, sign-in, dashboard with
  live status, create dialog (region, permanence note, advanced options, four progress steps,
  auto-open when ready), session view (44 px toolbar, region/IP chip, every state overlay, idle
  warning, fullscreen with Keyboard Lock), browser settings (identity, verify IP, request new IP,
  behavior, activity, delete with type-to-confirm), account page, Simplified Chinese and English.

## Deviations from the plan (because the target is Cloudflare)

| Plan | Here | Why / path back |
|---|---|---|
| Control plane on AWS Tokyo (ECS, RDS PostgreSQL) | Workers + D1 (SQLite) | Your deployment target. Schema is Drizzle, so moving to PostgreSQL (e.g. via Hyperdrive) is a dialect change. |
| pg-boss jobs, `LISTEN/NOTIFY` | Operation rows + service-binding kick + 1-minute cron; `events` table polled by SSE | No long-running processes on Workers. Leases and the journal are unchanged. |
| Per-service database roles | Separate Workers with separate bindings; ownership noted per table | D1 has no roles. |
| Next.js 16 | Vite + React 19 SPA served as Worker static assets | Same origin as `/api`, no server code needed (the plan forbids business logic in Next.js anyway). Marketing pages can be added later. |
| next-intl, locale in URL | Small typed i18n, locale in local storage | Fewer moving parts for the pilot. |
| SES for email | Resend HTTP API | Works from Workers without AWS credentials; one file to swap. |
| Generated `openapi-fetch` client | Web imports the zod types from `packages/contracts` directly | Same contract, no codegen step yet. |

## Not built yet (next phases)

- **Real browsers**: `aws-ec2` / `oci-compute` executors and golden VM image (Phase 1, after the
  provider trial on page 11), `services/agent` (Go), `images/browser` (neko + Chrome),
  `agent_credentials` / `agent_commands`.
- **Live view**: `services/gateway` (Go), `packages/viewer` (WebRTC, IME, clipboard, uploads,
  downloads), Cloudflare Realtime TURN credentials. Until then `/sessions/:id/connect` returns
  `simulated` and the session view shows a placeholder.
- `recover` and `restore` operations, backups (provider snapshots, R2 archives with per-instance keys).
- Billing with Creem (page 6), landing and pricing pages, billing screen.
- Admin console (`/admin`), passkeys/TOTP/OAuth, rate limiting per user/IP beyond Better Auth's own
  and the caps, dashboard thumbnails, dependency-cruiser and `buf breaking` in CI.
