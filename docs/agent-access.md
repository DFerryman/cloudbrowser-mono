# Coding-agent access

A coding agent (Claude Code, Cursor, Codex CLI, VS Code, Windsurf, Gemini CLI, or any MCP client)
drives a Nevazu cloud browser through the same Chrome, profile and desktop the live view shows.
Nothing is installed: the agent adds the browser's remote MCP server URL and sends an access key in
a header. The agent runs its own loop (screenshot, decide, act, look at the new screenshot) while
the user can watch in the Viewer and take control back with a single real input. Input between the
agent and the user is arbitrated in the VM, so one browser is never driven from two places at once.

## Architecture

```
Coding agent ─ HTTPS, MCP + "Authorization: Bearer nvzk_…" ─▶ Gateway Worker ─▶ InstanceGateway DO ─ tunnel ─▶ VM agent ─▶ Chrome + neko
User ─ Viewer (WebSocket signaling, WebRTC) ──────────────────────────────────▶ (same object)       (same VM agent)
```

- **Gateway Worker** (`apps/gateway`, `connect.<domain>`): `POST /mcp/:instanceId` is the MCP
  endpoint and `PUT /u/:token` takes files for one-time upload URLs. The Worker checks the request
  (origin, method, protocol version, size, rate limits), authenticates the key through the api's
  `Internal.authenticateMcp` and answers `initialize`, `ping` and `tools/list` itself. Tool calls,
  cancellations and uploads go to the browser's Durable Object.
- **InstanceGateway Durable Object**: the meeting point of the VM's tunnel and the viewers, and the
  home of the coding agent's session (`mcp/coding-agent.ts`). The session record lives in the
  object's storage, so it survives eviction and deploys; only requests in flight live in memory.
  The object speaks the automation protocol (`packages/contracts/src/automation.ts`) to the VM over
  the existing tunnel, enforces the persisted control mode and the key's capability before a
  request reaches the VM, and shares the viewers' credit check.
- **VM agent** (`services/agent`): `control.go` is the single input arbiter; `automation*.go` run
  the session: its own neko session for input and screen events, screenshots from neko's
  `screen/shot.jpg`, action steps with held-key release and cancellation, the stored-file workflow.
- **api** (`apps/api/src/automation.ts`): the `agentAccess` setting and `agentControl` mode, the
  access keys, revocation, the control choice, status, and the gateway's RPCs
  (`authenticateMcp`, `openAutomationSession`, `endAutomationSession`). Every change is audited.

## Access keys

The owner creates keys in the browser's Settings → Coding agent access
(`POST /instances/{id}/automation/keys`). A key belongs to one browser.

- **Format**: `nvzk_` and 43 base62 characters (256 bits). It is shown once, at creation. Only
  `sha256('bridge:' + key)` is stored, in `automation_clients.credential_hash` (indexed), the scheme
  the retired local bridge's credentials used, so those keep working as keys (listed as
  `kind: bridge`). The list shows `nvzk_` and the first six characters to tell keys apart.
- **Expiry**: 7, 30, 90 (default) or 365 days, or never. An expired key is refused and stays listed
  until it is revoked.
- **Capability**: `control` (screenshots, actions, files) or `view` (screenshots and status only).
- **Limits**: at most ten active keys per browser (`409 agent_key_limit`); a key can only be
  created while agent access is on (`409 agent_access_off`).
- **Notice**: the owner is emailed when a key is created, so a key made from a stolen session does
  not go unnoticed.
- **Last use**: the time, the MCP client's name and version (from `initialize`) and the address are
  recorded at most once a minute and shown next to the key.
- **Revocation** ends a key at once and closes its session: in Settings
  (`DELETE /instances/{id}/automation/clients/{clientId}`), by deleting the browser (all its keys),
  and by "Sign out everywhere" (all the user's keys, since a session being signed out may have made
  one). Turning agent access off keeps the keys but ends the session and refuses every call.

## The MCP endpoint

`POST https://connect.<domain>/mcp/<instanceId>` (a trailing slash is accepted, never redirected).
It speaks MCP's Streamable HTTP transport in its stateless form:

- Every answer is one `application/json` body. There is no event stream and no `Mcp-Session-Id`;
  `GET` and `DELETE` answer `405` with `Allow: POST`.
- Any request may come on its own: no `initialize` is needed first. `initialize` (and
  `server/discover`) negotiate the protocol version from `2025-11-25`, `2025-06-18`, `2025-03-26`
  and `2024-11-05`: the client's when supported, otherwise the newest. The result has
  `capabilities.tools.listChanged: false`, `serverInfo` (`nevazu`, "Nevazu cloud browser") and the
  server instructions. `ping` answers `{}`; an unknown method `-32601`.
- An `MCP-Protocol-Version` header that is present must name a supported version (else `400`).
- Notifications and responses answer `202` with no body. `notifications/cancelled` for a running
  `act` stops it in the VM; the act's own result then says `interrupted (canceled)`.
- One message per request: a JSON-RPC batch is `-32600`. The body is at most 1 MiB (`413`).
- An `Origin` header outside `MCP_ALLOWED_ORIGINS` (empty by default) is `403`: coding agents send
  none, and a web page must not be able to use a key it got hold of.
- **401** (with `WWW-Authenticate: Bearer realm="nevazu"` and a JSON-RPC error body) only for a
  missing, malformed, unknown, revoked or expired key, or a key made for another browser. A valid
  key for a browser that cannot take the call (asleep, access off, credit exhausted, paused by the
  user) gets a normal answer with a tool error that says why, so clients do not ask for new
  credentials.
- **Rate limits** (`MCP_LIMITER`, Workers Rate Limiting, 120 per minute): calls per key (by its
  display prefix) and failed authentications per address. An address over its budget is refused
  without an api call for a minute.

## Tools

Every tool has a full JSON Schema; `act` steps are flat objects with a `type` enum (no `oneOf`),
because clients' schema support varies. Arguments are validated again on the server with precise
errors (`Step 3 is not valid: steps.3.keys: …`). Results are an image (when there is one) and a text
that says the status, a refusal's reason and what to do about it, where an action stopped, who has
control, the screen, and the screenshot's id and size.

| Tool | Arguments | Annotations |
| --- | --- | --- |
| `screenshot` | `quality` 10–100 (80), `size` `fit` (default) or `native` | read-only |
| `act` | `steps` (1–32), `screenshotId`, `settleMs` 0–5000, `screenshot` (true), `quality`, `size` | destructive, open world |
| `upload_file` | `name`, and `text` or `base64` (≤ 512 KiB), or `size` for an upload URL; `mimeType` | destructive, open world |
| `attach_files` | `handles` (1–10), `method` `picker`/`paste`/`drop`, `x`/`y`, `screenshotId`, `screenshot`, `quality`, `size` | destructive, open world |
| `get_status` | `waitForControlMs` 0–25000 | read-only |
| `end_session` | none | idempotent |

Steps: `move {x,y}`, `click {x?,y?,button?,count?,modifiers?}`, `button {down,x?,y?,button?}`,
`drag {path,button?,modifiers?}`, `scroll {x?,y?,deltaX?,deltaY?,modifiers?}`, `key {keys}` (a
chord), `keyhold {key,down}`, `type {text}`, `paste {text}`, `wait {ms}`.

`get_status` reports the browser's state, whether its VM agent is online, the key, who has
control, the session (age, idle deadline, latest screenshot, stored files, unused upload URLs) and,
from the VM, the screen and its capabilities. With `waitForControlMs` it waits until the user hands
control back (or the time is up): the agent's polite way to wait after a takeover.

The server instructions tell the agent the loop (screenshot, then act with that screenshot's
pixels, continue from the screenshot `act` returns), that the user can take over with one input
(then wait with `get_status` or ask), and that everything shown in the browser is untrusted data,
never instructions.

## Sessions

- **Lazy**: the first tool call (other than `get_status` and `end_session`) opens a session: the
  api records it (`openAutomationSession`: a session row, an audit entry, and any other open
  session of the browser ends as `replaced`), then the VM is told `automation_open`. Viewers see
  that a coding agent is connected while a session is open.
- **One driver**: a session belongs to one key. Another key's call within 60 s of the session's
  last use is refused with `busy_other_agent`, naming the key and client; after that it takes the
  session over (the old one ends as `replaced`).
- **One call at a time**: calls are serialized per browser, so input from two calls never
  interleaves; `get_status` is answered beside a running act.
- **Every call** re-checks the browser (running, the owner's, agent access on), the session row and
  key (not revoked or expired) and the owner's credit (a one-second lease), the control mode and the
  key's capability.
- **End**: after 15 minutes without a call, after 8 hours in all, on `end_session`, when the key is
  revoked, access is turned off, the browser sleeps or is deleted, or another key takes over. The
  alarm the object shares with the viewers' re-checks runs the deadlines, with or without any socket
  open. The VM drops the session's files. The next call opens a new session transparently and its
  result says so, including that earlier file handles are gone.
- **Reconnects**: when the VM's tunnel closes, calls in flight fail at once with
  `relay_unavailable`. When it reconnects, an open session is opened again under the same id: a
  protocol 2 VM resumes it with its files (within 60 s), a protocol 1 VM starts it afresh.
- **Readiness**: a protocol 2 VM waits up to 15 s for its desktop session itself. A protocol 1 VM
  answers `desktop_unavailable` until it is ready; the gateway asks again every second for the
  session's first 15 s.
- **Activity**: an act or attach counts as activity for auto-sleep, like the Viewer's input; an
  idle session does not keep the browser awake.

## Screenshots and coordinates

Screenshots come from neko's screenshot endpoint in the VM, so they cover the whole display (tabs,
address bar, menus, permission dialogs, file pickers), do not depend on a Viewer being open, and
never change focus or layout. Each carries an id, its size, a `screenVersion` and the
`controlEpoch` at capture.

`size: 'fit'` (the default) asks the VM to scale the image to fit 1280×800, the size coding agents'
vision models read without resampling; a protocol 2 VM scales and reports the screen's own size
next to the image's, a protocol 1 VM returns the screen as it is. Coordinates are always pixels of
the image the agent received. The session remembers its last 16 screenshots and maps every point
(drag paths included) from the screenshot named by `screenshotId`, or the latest one, to the screen:
`round(x × screenWidth / imageWidth)`, clamped to the screen. The request carries that screenshot's
screen version and control epoch, so the VM refuses it (`screen_changed`, `control_changed`) if the
screen or control changed since. An unknown or evicted screenshot id is refused with
`stale_screenshot` before the VM sees anything. The screenshot an `act` returns becomes the latest.

## Files

- **Small files**: `upload_file` with `text` or `base64` (at most 512 KiB decoded) is stored in the
  session's temporary area in the VM at once and returns `{handle, name, size}`.
- **Local files of any size** (up to 50 MB): `upload_file` with the exact `size` and no content
  returns a one-time upload URL, `https://connect.<domain>/u/<instanceId>.<slot>.<secret>` (32
  random bytes; only the secret's SHA-256 is kept), valid for 10 minutes, with ready-made commands:
  `curl -fsS -T '<path>' '<url>'` and, on Windows, `curl.exe -fsS -T "<path>" "<url>"`. The upload
  needs a `Content-Length` equal to the declared size (`411`, `400`), works once (`409`), expires
  (`410`), and answers `{handle, name, size, sha256}`. It is streamed into the VM as it arrives,
  with at most three chunks unacknowledged, and never holds up the tunnel's other traffic; a VM
  error or silence answers `502` and cancels the transfer. While the browser cannot take the file
  (paused, asleep) the upload is refused and the URL stays usable.
- **Attaching**: `attach_files` delivers stored handles to the page: `picker` types the file's path
  into Chrome's open file dialog (one file per call; click the page's upload button first), `paste`
  puts the files on the clipboard and presses Ctrl+V, `drop` drops them at a point of the
  screenshot. Attaching re-checks input control at the moment it runs, so an upload that began
  under the agent cannot auto-attach after a takeover.

## Control arbitration

The VM holds who may drive the browser:

- **controller**: `none`, `agent` or `user`, who holds input right now.
- **mode** (`browser_instances.agent_control`, persisted): `agent` (the coding agent may hold
  input), `user` (the user took over and has not handed back), `privacy` (as `user`, and no
  screenshot is delivered either).
- **epoch**: incremented on every control change; a coordinate action names the epoch it was
  decided under and is refused if it moved.

A real user input (click, key, scroll, paste, dropped file) switches control atomically: the epoch
advances, the running action is cancelled, keys and buttons the agent left held are released, and
the same input is then executed; the user never clicks twice. Pointer movement alone is not a
takeover and is withheld while the agent drives, so the hover state the agent is looking at does
not change. A takeover is persisted as the mode and replayed to the VM in the gateway's `welcome`,
so a reconnect or restart never silently returns control to the agent; only an explicit hand-back
(the live view's banner or Settings) does. The gateway refuses `act`, `attach_files` and
`upload_file` under `user` and `privacy`, and screenshots under `privacy`, before the VM sees them.

## Security

- Access is per browser, on by default, and can be unchecked at creation or turned off later.
- Keys are bearer secrets of 256 bits, shown once, stored hashed, bound to one browser, optionally
  expiring or view-only, revocable at once, and announced by email. Old credentials, old browser
  generations and old control epochs stop working.
- The endpoint has no CORS for arbitrary origins: an `Origin` outside the allowlist is refused, so
  a web page cannot drive a browser with a key it learned (CSRF, DNS rebinding).
- Malformed instance ids, keys, agent secrets and viewer tokens are refused before any api call;
  failed attempts are rate limited per address.
- Keys, headers, upload tokens, screenshots and typed text are never logged: connection logs carry
  only identifiers and fixed stage names, and the Worker's invocation logs (which contain URLs) are
  off.
- The external interface is only the six tools: no arbitrary script, no cookie export, no local
  path in the VM. The browser's own nftables and Chrome policy still fence off local files, private
  addresses and the metadata service.
- Connections, sessions, key changes, control changes and their reasons are audited without input
  text, page content, credentials or screenshots.

## Residual risks

- **Keys at rest on the user's machine.** Most clients keep the header in a configuration file in
  plain text (VS Code keeps it in its secret storage; Codex reads it from an environment variable).
  Anyone with the key can drive the browser until it expires or is revoked. Short expiries,
  view-only keys where acting is not needed, and the creation email narrow this; OAuth (below)
  removes long-lived secrets from configuration files.
- **Upload URLs are in the model's context.** A prompt injection could make the agent reveal one;
  the URL accepts one file of the declared size within 10 minutes into temporary storage, and only
  the key can attach it.
- **The profile's permissions.** Reusing the authenticated profile means the agent can exercise
  the account's permissions through web pages: reading, sending, deleting, sharing, submitting.
  Screenshots are themselves data access. Prompt injection and mistaken business actions are not
  eliminated: give an agent only tasks you would do yourself, watch in the Viewer, and prefer a
  browser whose sign-ins are scoped to the agent's work.
- **The gateway terminates TLS** and is inside the trust boundary, exactly as for the Viewer.
- **Rate limits are approximate**: Workers Rate Limiting counts per location, and the
  failed-attempt block is per isolate.
- **Clients without custom headers**: claude.ai and Claude Desktop connectors need OAuth. Until
  then Claude Desktop can use a local `mcp-remote` (Node) with the header, which is an install.

## Client setup

The agent sets itself up; the user handles only the secret
(`apps/web/src/features/instances/agent-setup.ts`, shown in the Coding agent panel):

1. The user creates a key and saves it in an environment variable named after the browser,
   `NEVAZU_<BROWSER>_KEY` (`echo 'export …' >> ~/.zshrc`, or `setx` on Windows).
2. The user pastes the **handoff** into their agent: a standard `mcpServers` entry
   (`"type": "http"`, the URL, `"Authorization": "Bearer ${NEVAZU_<BROWSER>_KEY}"`) and a link to
   `https://nevazu.com/docs/agent-setup.md`, the per-client steps as markdown (the docs article
   `agent-setup`, generated from the same snippets). The agent picks the section for the client it
   is, merges the server into its user-level configuration, and checks with `get_status`.

`<name>` is `nevazu-<browser name>`, so several browsers coexist; every client below reads the key
from the variable (VS Code instead prompts once and keeps it in its secret storage), so the key is
never written to a configuration file or seen by the model. The same snippets sit in the panel's
folded **Set it up by hand** section, filled in for the browser.

<details>
<summary>Per-client configuration</summary>

- **Claude Code**: `claude mcp add-json --scope user <name> '{"type":"http","url":"<url>","headers":{"Authorization":"Bearer ${<ENV>}"}}'`
  (single quotes: Claude Code expands `${VAR}` in `url` and `headers` at startup).
- **Codex** (`~/.codex/config.toml`): `[mcp_servers.<name>]` with `url = "<url>"`,
  `bearer_token_env_var = "<ENV>"` and `tool_timeout_sec = 90`.
- **Cursor** (`~/.cursor/mcp.json`): `{"mcpServers": {"<name>": {"url": "<url>", "headers": {"Authorization": "Bearer ${env:<ENV>}"}}}}`
- **VS Code** (user MCP configuration): a `promptString` input `<name>-key` (password), and
  `"servers": {"<name>": {"type": "http", "url": "<url>", "headers": {"Authorization": "Bearer ${input:<name>-key}"}}}`.
- **Windsurf** (`~/.codeium/windsurf/mcp_config.json`): `{"mcpServers": {"<name>": {"serverUrl": "<url>", "headers": {"Authorization": "Bearer ${env:<ENV>}"}}}}`
- **Gemini CLI** (`~/.gemini/settings.json`): `{"mcpServers": {"<name>": {"httpUrl": "<url>", "headers": {"Authorization": "Bearer ${<ENV>}"}}}}`
- **OpenCode** (`~/.config/opencode/opencode.json`): `{"mcp": {"<name>": {"type": "remote", "url": "<url>", "enabled": true, "oauth": false, "headers": {"Authorization": "Bearer {env:<ENV>}"}}}}`
- **Claude Desktop**: until OAuth, `claude_desktop_config.json` with
  `{"mcpServers": {"<name>": {"command": "npx", "args": ["-y", "mcp-remote", "<url>", "--header", "Authorization:Bearer <key>"]}}}`.
- **Any other client** (Streamable HTTP): the URL and the header. A quick check that lists the tools:
  `curl -s <url> -H "Authorization: Bearer $<ENV>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`

</details>

## Next: OAuth 2.1

Header keys work in every coding agent today. claude.ai and Claude Desktop connectors, and clients
that prefer not to hold a secret, need OAuth 2.1 as the MCP authorization spec describes it:

- **Authorization server** on `nevazu.com` (the api), with authorization code + PKCE, short-lived
  access tokens bound to the resource (`https://connect.<domain>/mcp/<instanceId>`) and rotating
  refresh tokens.
- **Protected-resource metadata** (RFC 9728) for `/mcp/:id` on the gateway, named in the 401's
  `WWW-Authenticate: Bearer resource_metadata="…"`, pointing at the authorization server.
- **Client registration** through Client ID Metadata Documents, with Dynamic Client Registration
  for clients that do not support them.
- **Consent** in the web app: the user signs in, picks the browser (and view-only or control), and
  sees which client asks.
- **Storage and revocation**: tokens hashed in D1 on the same `automation_clients` rows (a new
  `kind`), so the Settings list, last use, revocation, deletion and sign-out-everywhere work as for
  keys.

## Tests

- `apps/gateway/test/mcp-http.test.ts`: version negotiation, `ping`, `tools/list`, `202`, `405`,
  batches, origins, body size, `401` with its challenge, wrong-browser and expired keys, rate
  limits, tool errors instead of `401`.
- `apps/gateway/test/mcp-session.test.ts`: lazy open, blob reassembly, coordinate mapping
  (1280×720 to 1920×1080, drag paths), `stale_screenshot` without the VM, protocol 1 VMs,
  serialization, mode and view-only refusals, `busy_other_agent` then hand-over, idle and hard
  close, eviction, tunnel loss and resume, cancellation, revocation and the control long poll.
- `apps/gateway/test/mcp-upload.test.ts`: inline content and its limit, upload URLs (`409`, `410`,
  `411`, length mismatch, the acknowledgement window, SHA-256), VM failures, attaching.
- `apps/gateway/test/robustness.test.ts`: the gateway's per-socket budgets and failure isolation.
- `apps/api/test/automation.test.ts`: keys shown once and stored hashed, the MCP check, limits,
  revocation (owner, deletion, sign-out-everywhere), legacy credentials, migration 0035.
- `services/agent`: takeover order, held-key release, screen-change invalidation, privacy pause,
  stored-vs-attach control and a restored takeover.
