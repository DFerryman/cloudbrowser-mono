# Diagnosing remote desktop connection failures

An EC2 VM can be running and its agent can send heartbeats while its remote desktop cannot
accept a viewer. Instance lifecycle status and connection availability are separate signals.
The viewer stops after three consecutive unsuccessful attempts; explicit Retry starts a new
budget. The web viewer reports live only after a frame from the current peer is rendered.
Media statistics and automatic quality adjustment start as soon as the peer connects, including
while waiting for that first frame. This lets an undecodable stream try a lower quality before
the original connection deadline; it does not mark the desktop live or enable input early.

## Keeping a live view connected

What the viewer does about a connection that degrades, and what the user is told
(`packages/viewer/src/remote-browser.ts`, `apps/web/src/features/session/SessionPage.tsx`):

- **Liveness.** With nothing from the gateway for 12 s the viewer sends `{"t":"ping"}`, which the
  gateway's runtime answers with `{"t":"pong"}` without waking its object
  (`setWebSocketAutoResponse`; a ping that reaches the object is answered there too). A socket that
  answers nothing for 8 s after a ping is replaced (`failed` / `transport_stale`): mobile networks
  drop connections without closing them, and the next tap used to go into the dead socket.
- **Confirmed input.** Each burst of input is followed by a ping; its pong confirms, in order,
  every frame the gateway received before it. A drop after confirmation reconnects without asking
  the user; unconfirmed input asks, however late the close arrives. Failures past the gateway
  (`agent_offline`, `input_error`) use the time since the input (10 s), since the gateway's
  confirmation does not cover the VM's relay.
- **Shown again, or a new network.** A page shown after 3 s hidden, a page whose timers were
  frozen, the `online` event and a network change (`navigator.connection`) hold input while a ping
  checks the socket; the pong sends it. Silence for 4 s replaces the socket, and the held input,
  never sent on the old one, goes once on the new one.
- **Hidden or offline.** A hidden page cannot draw its first frame, so attempts made while hidden
  ran into the 20 s deadline until the budget was spent. Hidden or offline pages make no attempts;
  they reconnect with a whole budget once shown and online.
- **The picture's path.** A live peer whose ICE state becomes `disconnected` gets 4 s to recover by
  itself; then (or at once for `failed`) the viewer asks neko for an ICE restart on the same socket
  (`signal/restart`, milestones `media_restart` and `media_recovered`), keeping the desktop session
  and the input path, with input held meanwhile. A restart that brings nothing back within 12 s
  starts over (`failed` / `media_failed`).

Each reconnect and failure carries a cause, recorded as `issue` on `failed` milestones (with the
WebSocket `closeCode` for a closed transport) and shown in the session overlays:

| `issue` | Meaning | How it is told |
| --- | --- | --- |
| `offline` | The device reported no network (`navigator.onLine`) | Always first |
| `background` | The page was hidden or frozen when the connection dropped | Before network causes |
| `network` | The picture's own path failed too (ICE disconnected/failed), the socket dropped without a close frame (1006) while no media arrived, or ICE never connected after neko offered | The user's network; three such drops in five minutes are called unstable |
| `service` | The gateway closed the socket with a code of its own, or the socket dropped while video bytes kept arriving over TURN | Not the user's network |
| `desktop` | The VM's tunnel went offline, the relay to neko failed (`input_error`), or the desktop never answered | The cloud browser's side |

A round trip above 250 ms for three readings in a row (6 s) shows a closable note that taps and
typing appear later. Touch taps are marked locally at once, so a tap that is on its way does not
look like one that went nowhere.

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

`failed` and `first_frame` can include a bounded `media` snapshot: selected candidate types and
UDP/TCP/TLS transport, RTP packet/byte/frame counters, RTT/jitter, and current video playback
and visibility state. Samples older than five seconds or from another peer are omitted.
`sampleAgeMs` identifies a usable stats sample; `inboundVideo: false` means that sample had no
video receiver report, not that a browser independently measured zero packets. Missing
counters remain unknown rather than becoming zero. `packetsLost` may legitimately be negative.

Packets with no decoded frames direct investigation toward delivery/reassembly/keyframes or
decoding; decoded frames without presentation direct it toward playback/rendering. A selected
TURN path's RTT includes both the user's route to Cloudflare and the route onward to the VM,
so it alone cannot attribute failure to the user's local network. Compare failed/successful
attempts, and use a controlled network comparison where available.

## Readiness and privacy

Agent 0.3.1 probes the real local Neko login, WebSocket and `system/init` before reporting
desktop readiness. A failed probe leaves heartbeat/control processing available and retries.
Local admission or relay failure requests a coalesced recheck; a single viewer error does not
by itself declare the entire desktop unhealthy. This probe does not test a user's media path.
Client first-frame evidence covers that later part of the connection.

Milestones contain identifiers, fixed stage/error names, timing and allowlisted numeric/enum
media evidence. They do not contain
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
