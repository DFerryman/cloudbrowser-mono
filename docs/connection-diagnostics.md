# Diagnosing remote desktop connection failures

An EC2 VM can be running and its agent can send heartbeats while its remote desktop cannot
accept a viewer. Instance lifecycle status and connection availability are separate signals.
The viewer stops after three consecutive unsuccessful attempts; explicit Retry starts a new
budget. The web viewer reports live only after a frame from the current peer is rendered.
Media statistics and automatic quality adjustment start as soon as the peer connects, including
while waiting for that first frame. This lets an undecodable stream try a lower quality before
the original connection deadline; it does not mark the desktop live or enable input early.

## Correlating one attempt

The failure overlay displays an attempt UUID. Search the `cloudbrowser` API and
`cloudbrowser-gateway` Workers logs for that `attemptId`. The gateway associates it with a
server-generated `relayId`, instance ID, generation and viewer session. Agent milestones use
that relay ID. Search by relay ID to include late results after the viewer already disconnected.
Guest journal messages named `viewer admission` use the same session and relay IDs.
When media is renegotiated on the same socket, `peerSequence` separates its peer and first-frame
observations from those of the previous peer.

Client observations are labelled `source: viewer`; treat these as reports, not authoritative
server state. A gateway `viewer_open_sent` proves only that its socket send returned. The
agent's `received` milestone supplies the corresponding application acknowledgement.

| Last recorded milestone | Next evidence to inspect |
| --- | --- |
| Client `token_start` | Token request completion or `token_timeout` / `token_failed` |
| Gateway `viewer_upgrade_requested` | Token validation/redemption and admission rejection |
| Gateway `viewer_admission_started` | Authorization/storage result and `viewer_gateway_accepted` |
| Gateway `viewer_open_sent` | Agent `received`; a gap here needs tunnel/agent receive-loop investigation |
| Agent `login_start` | `login_ok`, `login_timeout`, `login_rejected` or `login_unavailable` |
| Agent `websocket_start` | `websocket_open`, `websocket_timeout` or `websocket_unavailable` |
| Agent `websocket_open` | `desktop_ready` or `desktop_timeout` waiting for Neko `system/init` |
| Desktop `system/init` | Signaling request/offer/answer and client `peer_connected` |
| Client `peer_connected` | Client `first_frame`; a peer connection alone is not decoded video |

An absent milestone alone is not proof of the cause: inspect the terminal timeout/error, the
other side's acknowledgement and logs from the same relay. Stale relay milestones retain
their original stage, failure code and duration, with `ignored: true`; they never advance a
replacement viewer. An initial connection error followed by successful playback resets the
consecutive failure budget.

## Readiness and privacy

Agent 0.3.1 probes the real local Neko login, WebSocket and `system/init` before reporting
desktop readiness. A failed probe leaves heartbeat/control processing available and retries.
Local admission or relay failure requests a coalesced recheck; a single viewer error does not
by itself declare the entire desktop unhealthy. This probe does not test a user's media path.
Client first-frame evidence covers that later part of the connection.

Milestones contain only identifiers, fixed stage/error names and timing. They do not contain
tokens, credential-bearing URLs, SDP, pasted text, keyboard input or desktop content. Gateway
automatic invocation logs are disabled because stream URLs carry a single-use token; custom
connection logs remain persisted at 100% sampling. Client reports use an authenticated,
ownership-checked, rate-limited API and never renew activity, wake a VM or change billing.
Reporting is bounded and best effort; an unavailable reporting channel can still leave gaps.

## Rollout compatibility

Deploy the gateway and API/frontend using the repository release commands. The API/frontend
release requires a committed, clean checkout of the latest `origin/main` (see
`deploy-cloudflare.md`). Do not bypass that release check with a direct API Wrangler deploy.

New agent images are published by the Images workflow after agent changes reach `main`.
The gateway advertises `viewerStages: true` in its welcome frame; new agents send stage frames
only when that capability is present. This keeps a new image compatible with an older gateway
during rollout. Older agents continue to work with the new gateway, but cannot report detailed
local milestones or perform the new desktop readiness probe.

Running VMs keep their installed agent binary. They do not gain 0.3.1 simply because the image
tag changes, and normal stop/start preserves the installed binary too. Do not recover a user's
VM merely to collect diagnostics: that interrupts service and removes its live process state.
Use the deployment's reviewed agent upgrade/replacement procedure, and preserve incident
evidence before any replacement. A fresh VM uses the newly published agent image.
