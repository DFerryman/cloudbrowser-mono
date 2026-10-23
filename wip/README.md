# Work in progress: handoff (not on main)

Five fix workstreams were interrupted by a container restart before any of them finished or ran
its tests. Their partial changes are saved here as patches against `main` at 9da5f56. None is
verified. Apply one with `git apply --3way wip/<name>.patch` on a branch from `main`, finish it,
test it, and delete the patch. The web UI for the new agent connection is already committed on
this branch (commit bc97e39). It does not compile until `hosted-mcp-gateway` lands, because it
uses the new contract types `AgentKey`, `CreateAgentKeyBody` and the new `AutomationStatus` and
`AutomationClient` fields.

Already on `main` and verified:
- The touch-screen frame no longer goes black behind the More and Send keys menus (e2e
  `apps/web/e2e/session-touch-menu.mjs`).
- A VM's bootstrap token stays valid until its credential is first used.
- The live view is encoded on one x264 thread. This still needs a check on a Basic VM; see
  docs/aws.md.
- The user's iPad fix (3771876, `object-fit: fill`) is correct. The root cause: the viewer picked
  1280×800, an Xorg default VESA mode. ximagesrc tags a non-16:9 desktop with 11:10 pixels,
  Safari honours that tag and Chrome ignores it.

## Patches and what each was meant to do

### hosted-mcp-gateway: installation-free coding-agent connection (largest; finish first)

The decision, after three independent designs were judged:
- **Endpoint.** A hosted MCP endpoint on the gateway Worker, `POST https://connect.nevazu.com/mcp/:instanceId`. Streamable HTTP with stateless JSON responses: no SSE and no `Mcp-Session-Id`. GET and DELETE return 405.
- **Auth.** Per-browser access keys (`nvzk_` + 43 base62 characters), shown once. Each is stored as `sha256('bridge:'+key)` in `automation_clients.credential_hash`, so old bridge credentials keep working as keys. The key must match the browser in the URL; an expired or revoked key gets 401. A valid key for a browser that is asleep or has access turned off gets a tool error, not a 401.
- **Request checks.** An `Origin` header outside the allowlist gets 403. Batch requests get JSON-RPC error -32600. A Workers rate limiter guards the endpoint.
- **Session state.** The Durable Object holds the session in storage. It opens lazily (`automation_open`), closes after 15 minutes idle or 8 hours, and is reopened with the same id when the agent reconnects. Only one client drives at a time; a second client gets `busy_other_agent` for 60 seconds. Calls are serialized. Blobs are reassembled by blobId.
- **Screenshots and coordinates.** Screenshots are scaled to fit 1280×800 (VM protocol v2). Coordinates are mapped back from image pixels to screen pixels. Each action names its screenshot: an unknown id gets `stale_screenshot`, and the screen version and control epoch are filled in from that screenshot.
- **Files.** `upload_file` returns a single-use `PUT /u/<instanceId>.<slot>.<secret>` URL plus a curl command, or accepts base64 or text up to 512 KiB. The upload streams to the VM with the FILE_TRANSFER ack window.
- **Tools.** `screenshot`, `act`, `upload_file`, `attach_files`, `get_status` (with a `waitForControlMs` long-poll) and `end_session`. They carry full JSON Schemas and annotations.
- **API.** Migration `0035_agent_keys.sql` adds `kind`, `key_prefix`, `expires_at`, `capability`, `last_client` and `last_ip`, plus a hash index, and revokes unredeemed pairings.
  - New: `POST /instances/{id}/automation/keys`, and the internal RPCs `authenticateMcp` and `openAutomationSession`.
  - Removed: pairing and `POST /api/automation/pair`.
  - A browser's keys are revoked when it is deleted, and all of a user's keys on "sign out everywhere".
- **Removals.** The `packages/bridge` package and the WebSocket automation route.
- **Gateway fixes in the same code:**
  - Message queues and budgets per socket; an overflow or error closes only the offender.
  - No awaited work after accepting the agent socket; `deliverPending` goes through `waitUntil`.
  - Oversized agent frames are dropped, not fatal.
  - `viewer_file` joins the relayed-session frame types.
  - Viewer and instance revocation epochs are separate.
  - The control state comes from the database row after eviction.
- **Docs and zone rule.** Rewrite `docs/agent-access.md` (OAuth 2.1 is the documented next step). Update `deploy/cloudflare-auth-security.json` so the zone skip rule covers `/mcp/` and `/u/`.

### vm-agent-v2: Go agent fixes and protocol v2 (agent version 0.5.0)

Fixes:
- **Critical:** the automation's neko session was cancelled right after opening. `OpenAutomation` got a context that the code cancelled at once, so every agent screenshot or act returned `desktop_unavailable` in production.
- Neko sessions are logged out when they end; otherwise `system/init` grows past 256 KiB and kills the tunnel.
- Neko messages over 192 KiB are dropped. A large clipboard used to close the tunnel.
- Viewer writes use `WithoutCancel`.
- Held keys and buttons are released on any act that ends abnormally.
- A nil guard in picker attach. The picker types the file path into Chrome's GTK dialog.
- A symlinked upload directory is refused.
- The welcome keeps the more restrictive of the local and persisted modes.
- The desktop session is reopened with backoff.
- Acts too long to finish in the limit are rejected (`too_long`).
- A data race in `control.go`.
- Presigned URLs are redacted from logs.
- `selfCheck`:
  - runs asynchronously;
  - learns the expected IP (IMDS);
  - closes the firewall only on a mismatch or after 3 failures, and reopens it after a pass.
- `Requires=nftables.service` on the browser unit.

Protocol v2:
- `automation_open` is idempotent.
- Sessions survive a 60 s tunnel gap.
- Requests wait up to 15 s for readiness.
- `maxWidth`/`maxHeight` scale the screenshot; the meta carries `screenWidth`/`screenHeight`.
- Capabilities gain `scaledShots` and `resume`.
- `control_changed` applies only when control left the agent.
- New reasons: `off_screen`, `unknown_key` and `user_active`. The last refuses an agent claim within 10 s of real user input.

### viewer-web: live view and web fixes

- **iPad hardening.** Prefer 16:9 (square-pixel) modes, and modes at ≤30 Hz. `system/init` resets the remote screen. requestVideoFrameCallback reads the picture size. Input diagnostics are conclusive. Scratch patch: `ipad-tap/fix.diff`, from the audit.
- **Per-tier screen budget.** `TierSpec.maxScreenPixels`: Basic 1920×1080, Premium 2560×1440. A mode up to 7 px wider than the view counts as fitting, so a 1366-wide view gets 1368×768.
- **Streaming:**
  - After a blocked `play()` (WebKit autoplay), mute and retry.
  - An input failure tears down the stream and stops presence.
  - Ignore the quality-floor scale rule after a resize.
  - Restart the connection deadline on `agent_online`.
  - On a bfcache pageshow, reopen.
  - Revoke the cursor's object URL.
- **Input:**
  - Mac Cmd+key becomes an immediate stroke (macOS sends no keyup).
  - Windows AltGr characters go through `typeText`.
  - Ctrl/Cmd+V pastes the remote clipboard unless the local text is new.
  - Local pastes are capped at 128 KiB.
  - IME clipboard echoes are suppressed.
  - `onPaste` moves to the box.
  - Long soft-keyboard text is sent as one paste.
  - Mac Option/Cmd+Arrow chords are translated.
- **Web:**
  - A heartbeat 409 sets "taken over" only for a running browser.
  - `.cb-dark` tokens are fixed with `@theme inline`, so the session buttons in the light theme are no longer white on white.
  - SSE reconnects with backoff.
  - Show the error state only as `isError && !data`.
  - `onError` toasts on the session page.
  - The delete dialog renders once in rows.
  - RegionPicker overflow is fixed.
  - The default name is set after the list loads.
  - Error states for billing, never-sleep, storage, usage and passkeys.
  - Phone items in More.
  - Back uses replace.
  - Docs links open in a new tab.
  - Pilot mode in `billing/access.ts`.
  - Menus refocus the viewer when they close.

### engine-lifecycle: browser lifecycle fixes

- Restart from needs_attention does a real restart (stop, then start). A passing "Check again" returns an IP-paused browser to running.
- A failed or cancelled recover restores the previous agent credential and generation, and releases the resources it created. Recovery snapshots expire.
- needs_attention browsers auto-sleep after their idle timeout, capped at 1 h for never-sleep.
- Retryable errors are counted apart from capacity waits, and an alert is raised when the budget runs out.
- The status returns from waiting_capacity/provider_issue when a step succeeds. A create that has not succeeded is not metered.
- The first-boot timeout counts from `create_vm`.
- A transient in-Chrome IP check failure is retried, not fatal.
- Resumable provisioning in user data (per boot, with a marker).
- Stop is not allowed on `failed`.
- No event spam while polling.
- Basic capacity fallback within a 5% price tolerance.

### billing-api-deploy: billing, API and deploy safety

- A frozen account stops but never enters retention or deletion.
- Emails are marked sent only after a successful send.
- `/connect`:
  - requires a running browser;
  - is rate-limited;
  - puts a timeout on the TURN fetch and returns 503 when it fails.
- PATCH validates before it changes agent access.
- A suspended browser gets 403, not 402.
- A concurrent-create reserve race returns 402.
- **Web:** one idempotency key per create attempt; `openWhenReady` survives capacity waits; honest create-time copy.
- Fail closed on missing `BOOTSTRAP_SECRET`/`APP_URL`/`GATEWAY_URL` outside development.
- **Deploy and CI:**
  - The root `deploy` runs `deploy-api-main.mjs --check` first, plus a pending-D1-migrations preflight.
  - The docs say `pnpm run deploy` (not `pnpm deploy`), migrations before Workers, and create the queue `cloudbrowser-aws-provider`.
  - HSTS in `_headers`.
  - CI gets `permissions: contents: read`.

## Follow-ups that need measurement or an image build

- An X server config with 1600×900 and 1536×864 at 30 Hz (neko offers 1600×900 only at 25 Hz). Only 16:9 modes: Safari skews 16:10 modes.
- Force square pixels in the pipeline: `capssetter caps=video/x-raw,pixel-aspect-ratio=1/1`. Test on an image build first: a missing element stops all video.
- `veryfast` above 1080p for Premium; Main profile H.264; direct ICE instead of forced TURN; Basic memory (zram, Memory Saver).
- OAuth 2.1 for the MCP endpoint, so claude.ai and Claude Desktop connectors work without headers.
