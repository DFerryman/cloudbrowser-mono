# Coding-agent access

A local coding agent (Claude Code, Cursor, Codex, or any MCP client) drives a Nevazu cloud browser
through the same Chrome, profile and desktop the live view shows. The agent runs its own loop —
observe a screenshot, decide, act, observe again — while the user can watch in the Viewer and take
control back with a single real input. Input between the agent and the user is arbitrated in the
VM, so one browser is never driven from two places at once.

This document is both the design and a review of the submitted plan: most of the plan was right and
is built as described; the paragraphs marked **Correction** are where it was wrong or imprecise and
what was built instead.

## What the submitted plan got right

- Independent screenshot and action channels for the agent, separate from the Viewer's video and
  input, over one authenticated automation channel to the gateway.
- One shared browser state: the agent and the user see and change the same Chrome.
- Central input arbitration in the VM, every input path checked against the same control state.
- A real user input takes control; the agent loses it until the user explicitly hands it back; on
  resume the agent re-screenshots and the old queue is not resumed.
- Screen-version and control-epoch stamps on every screenshot, re-checked before coordinate input
  is dispatched; a resolution change invalidates old coordinates instead of remapping them.
- Transfer then attach as two stages: a file reaches temporary storage without input control, but
  attaching it to the page re-checks control at the moment it runs.
- Authorization covers the whole browser instance; keyboard shortcuts, the address bar and tabs are
  all in scope. Access is enabled by default and can be unchecked before an instance is created.
- Capability negotiation so an older VM reports what it cannot do.

## Architecture (as built)

```
Coding agent ↔ Bridge (MCP, local) ↔ Gateway + InstanceGateway DO ↔ VM agent ↔ Chrome + neko
User ↔ Viewer ────────────────────────────┘ (same Durable Object, same VM agent)
```

- **Bridge** (`packages/bridge`): a local process the user pairs once. It is an MCP stdio server
  exposing `screenshot`, `act`, `upload_files`, `attach_files` and `get_status`, and it holds a
  WebSocket to the gateway speaking the automation protocol. The credential and channel live only
  in the bridge; they never enter the model's context. Local file reads are limited to directories
  the user allowed.
- **Gateway** (`apps/gateway`): the new route `GET /v1/automation/:instanceId`, authenticated by
  the bridge's long-lived credential through the api's `Internal` entrypoint. Each bridge session
  joins the browser's `InstanceGateway` Durable Object alongside the agent tunnel and viewers. The
  object relays automation requests to the VM and results (including screenshot blobs) back,
  enforces the persisted control mode before a request reaches the VM, fans control changes out to
  viewers, and holds one bridge at a time. Automation shares the viewers' per-frame authorization
  lease and credit check.
- **VM agent** (`services/agent`): `control.go` is the single arbiter (controller, mode, epoch,
  withheld pointer); `automation.go` and `automation_input.go` run a bridge session — its own neko
  session for input and screen events, screenshots from neko's `screen/shot.jpg`, action steps with
  held-key release and cancellation, and the stored-file workflow.
- **api** (`apps/api`): the `agentAccess` setting and `agentControl` mode on the instance, pairing
  (`POST /instances/{id}/automation/pairings`, redeemed at the public `POST /api/automation/pair`),
  client revocation, the control choice (`POST /instances/{id}/automation/control`), status
  (`GET /instances/{id}/automation`), and the gateway's connect-time checks. Every change is
  audited; pairing codes and credentials are stored only as hashes.

## Control arbitration

The VM holds who may drive the browser:

- **controller**: `none`, `agent` or `user` — who holds input right now.
- **mode** (`browser_instances.agent_control`, persisted): `agent` (a bridge may hold input),
  `user` (the user took over and has not handed back), `privacy` (as `user`, and no screenshot is
  delivered either).
- **epoch**: incremented on every control change; a coordinate action names the epoch it was
  decided under and is refused if it moved.

A real user input (click, key, scroll, paste, dropped file) switches control atomically: the epoch
advances, the running bridge action is cancelled, keys and buttons the bridge left held are
released, and the same input is then executed — the user never clicks twice. Pointer movement alone
is not a takeover and is withheld while the bridge controls, so the hover state the agent is looking
at does not change; the withheld position is replayed just before a click takes over. While a
bridge is connected, a takeover also sets the mode to `user`, which only an explicit hand-back ends.

**Correction — the plan implied a takeover is only a transient controller change.** Because a
reconnect or restart must not silently return control to the agent, the takeover is persisted as the
mode and replayed to the VM in the gateway's `welcome`. Reconnecting the bridge, closing the Viewer,
or the VM agent restarting never clears it.

## Screenshots and coordinates

Screenshots come from neko's screenshot endpoint in the VM, so they cover the whole display (tabs,
address bar, menus, permission dialogs, file pickers) at its real size and do not depend on a
Viewer being open or change focus or layout. Each screenshot carries an id, size, a `screenVersion`
and the `controlEpoch` at capture. A capture whose size disagrees with the screen version is retried
and then refused rather than returned inconsistent. A remote resolution change bumps the version,
notifies the bridge and voids earlier coordinates; it is not a takeover, so the agent keeps control
and continues on the new screenshot.

**Correction — the plan left scaling open "for later."** The first version returns screenshots at
their original dimensions only. There is no Bridge-side scaling or cropping, so there is never a
coordinate mapping that could drift; adding one later must carry an accurate mapping.

## Files

`upload_files` streams a local file (base64 chunks, same framing as a viewer's paste) into the
session's temporary storage in the VM and returns a handle. `attach_files` delivers handles to the
page — `picker` into Chrome's open file dialog, `paste` onto the clipboard then Ctrl+V, `drop` onto
a point — and re-checks input control at the moment it runs, so an upload that began under the
agent cannot auto-attach after a takeover. Temporary files are bound to the session and removed when
the bridge disconnects. The bridge reads local files only inside allowed directories, resolving
symlinks first.

## Sessions, limits and lifecycle

A bridge session ends after eight hours; the bridge reconnects for a new one. A bridge action counts
as activity, so a browser an agent is working in does not sleep, but an idle connection does not keep
it awake. Automation shares the Viewer's credit and lease checks: when available credit runs out,
input and screenshots stop like the live view. Turning agent access off, revoking a client, deleting
the browser, or an old placement generation all end bridge sessions at once.

## Security boundaries and residual risks

Reusing the authenticated profile means the agent can exercise the account's permissions through web
pages: reading, sending, deleting, sharing, submitting. Screenshots are themselves data access.
These are inherent to the feature; the protocol narrows the surface but cannot remove them:

- Access is off unless the user allows it, and a single real input takes control back.
- The bridge's credential and channel never enter the model's context or ordinary logs.
- The external interface is only the five tools: no arbitrary script, no cookie export, no arbitrary
  local path. The browser's own nftables and Chrome policy still fence off local files, private
  addresses and the metadata service.
- Old credentials, old instance generations and old control epochs stop working.
- Connections, control changes and action outcomes are auditable without storing input text, page
  content, credentials or every screenshot.

**Correction — the plan called transport "authenticated and encrypted" as if end to end.** It is
not: the gateway terminates TLS and is inside the trust boundary, exactly as for the Viewer. Prompt
injection and mistaken business actions are not eliminated; users should give an agent only tasks
they would do themselves, watch in the Viewer, and prefer a browser whose sign-ins are scoped to the
agent's work.

## Acceptance

The acceptance checks in the plan map to tests: the Go suite in `services/agent` covers takeover
order, held-key release, screen-change invalidation, privacy pause, stored-vs-attach control and a
restored takeover; the gateway suite covers admission, relay, mode enforcement, revocation and
one-bridge-at-a-time; the api suite covers the default-on setting, pairing redemption and its hashes,
control persistence and audit; the bridge suite covers the allowed-files boundary, the MCP
handshake, blob reassembly and refusals. The first version is complete when the agent can run the
screenshot → action → file → screenshot loop while the user watches the same browser in the Viewer
and takes over with one input.
