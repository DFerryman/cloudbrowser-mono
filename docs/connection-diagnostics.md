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
  never sent on the old one, goes once on the new one. Held input is carried the same way when the
  socket errors, closes or is found stale during the check. A ping sent before the page was
  hidden or frozen is timed from the page's return, and the check decides while it runs: timed by
  the clock, such a ping condemned the socket the moment an iPad was unlocked, ahead of the check,
  and the taps it held were reported lost. Input that finds the 2 s check overdue (a page thawed
  before its timers ran) starts the check itself. A stats reading across a freeze starts a new
  baseline: it is neither reported (fps, bitrate) nor taken as video still arriving.
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
| `background` | The page was hidden or frozen when the connection dropped, or came back from the background or a freeze less than 10 s before the drop was found (iPadOS ends a locked page's connections without a word) | Before inferred causes; `service` and `desktop` still stand |
| `network` | The picture's own path failed too (ICE disconnected/failed), the socket dropped without a close frame (1006) or went silent while no media arrived, or ICE never connected after neko offered | Most likely the device's network; three such drops in five minutes are called unstable |
| `gateway` | The socket dropped without a close frame or went silent while video kept arriving over TURN | The device is online, but where the socket was lost cannot be told: our side, or a router, proxy or VPN on the way. Fresh video says only that the device reaches TURN, not that the socket's TCP path is healthy |
| `service` | The gateway closed the socket with a code of its own, or the token request failed with a 5xx | Our side |
| `desktop` | The VM's tunnel went offline, the relay to neko failed (`input_error`), or the desktop never answered | The cloud browser's side |

A round trip above 250 ms for three readings in a row (6 s) shows a closable note that taps and
typing appear later. Touch taps are marked locally at once, so a tap that is on its way does not
look like one that went nowhere.

## The VM's tunnel

The agent's WebSocket to the gateway carries every viewer's relay and command. Stages in the
`cloudbrowser-gateway` logs (`apps/gateway/src/instance-gateway.ts`):

| Stage | Meaning |
| --- | --- |
| `agent_tunnel_accepted` / `agent_replaced` | A tunnel opened; an older one of the same VM was closed (4000) |
| `agent_tunnel_closed` | A live tunnel closed. 1001: the agent stopped (0.6.0 sends a close frame when its VM shuts down; older agents' stops read 1006) |
| `agent_tunnel_released` | A tunnel the gateway had already closed (replaced, revoked, silent) reported its close. One whose path had died reports it when TCP gives up, often 15 minutes later: no new drop |
| `agent_tunnel_silent` | Nothing (no frame, no answered keepalive) arrived for 45 s: closed as dead (4008), viewers told `agent_offline` |
| `agent_reconnected` | The VM's own account of the previous tunnel (agent 0.6.0): `code` silent, closed (with `closeCode`), write_timeout, reset, eof, timeout or error; `upMs`, `elapsedMs` (time without a tunnel), `attempts` (failed dials) and `event` (the last dial's failure: dns, connect, tls, timeout, http_<status>) |

A socket the gateway closed is marked in its attachment and never chosen again: the runtime has
reported such a socket as open once the object had hibernated, and listed it first, so viewers'
relays and commands went into a replaced tunnel while the VM waited on its new one. Of the
newest open tunnels, the most recently accepted is used.

Agents from 0.6.0 ping (`{"t":"ping"}`, answered by the runtime) after 15 s without a frame from
the gateway and replace a tunnel that brings nothing 10 s later; they do so only when the
gateway's welcome says `keepalive: true`. Without it, a connection that vanished without a close
(a route change between AWS and Cloudflare) looked open to the VM until TCP gave up.

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

## Live quality

Diagnostics explain views that fail; live-quality reports measure the ones that work, so latency
and frame rate can be compared by browser region and by where viewers are. While a picture is
live and visible, the viewer sums up its 2 s stats readings and the input socket's pongs once a
minute (sooner when the view ends or the tab is hidden, never for under 10 s) and posts the
summary to `POST /api/v1/sessions/{id}/quality`. The api writes one Workers Analytics Engine
data point per report to the `cloudbrowser_live_quality` dataset (binding `LIVE_QUALITY`), with
the visitor's country, Cloudflare colo and ASN from `request.cf`. Nothing is written to D1, and a
report never renews a session, wakes a VM or changes billing. Reports share the diagnostics
write budget. The dataset is created by its first write after the api is deployed.

Fields are only ever appended, so existing queries keep working. `-1` in a double means the
browser did not report it; an empty blob means unknown.

| Column | Value |
| --- | --- |
| `index1`, `blob1` | Browser region id (`tyo1`) |
| `blob2`, `blob3`, `blob4` | Viewer country, Cloudflare colo, ASN (a VPN's or proxy's when one is used) |
| `blob5` | Picture level neko streamed at the end of the interval |
| `blob6`, `blob7` | Selected local candidate type, and the protocol to the TURN relay |
| `blob8`, `blob9`, `blob10` | Instance, viewer session and attempt ids |
| `double1`, `double2` | Interval in ms, stats readings in it |
| `double3`, `double4` | Median picture round trip through TURN, median input round trip to the gateway (ms) |
| `double5`, `double6`, `double7` | Median fps, median kbps, share of video packets lost (0–1) |
| `double8`, `double9` | Freezes, ms frozen |
| `double10`, `double11` | Average jitter buffer delay and decode time per frame (ms) |
| `double12` | Frames dropped |
| `double13`, `double14` | Width and height at the end of the interval |

Median picture round trip and frame rate by region and country over the last day, with the
[SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/):

```sql
SELECT blob1 AS region, blob2 AS country,
  SUM(_sample_interval) AS reports,
  quantileExactWeighted(0.5, double3, _sample_interval) AS rtt_ms,
  quantileExactWeighted(0.5, double5, _sample_interval) AS fps
FROM cloudbrowser_live_quality
WHERE timestamp > NOW() - INTERVAL '1' DAY AND double3 >= 0 AND double5 >= 0
GROUP BY region, country
ORDER BY reports DESC
```

`double3` includes the viewer's route to its nearest Cloudflare PoP and the backbone onward to
the VM; `double4` is the route to the browser's gateway object. A high `double3` with a normal
`double4` points at the media path (TURN, the VM's network); both high points at the viewer's
own network, a VPN, or a detour such as mainland China's.

### Where the gateway object runs

A browser's `InstanceGateway` Durable Object is created near whichever caller reaches it first,
and stays there. When a viewer in Europe or the agent's first connection through a distant PoP
got there first, every input event of every later viewer crossed that detour. The api now
passes a location hint derived from the browser's AWS region: to the agent and MCP paths in the
authentication result, and to viewers as the `loc` claim of the viewer token. The gateway gives
the hint to `get()`, which only affects an object that does not exist yet: objects that
already exist keep their location. A gateway that does not know a hint ignores it. Internal
calls (revocation, queue delivery) carry no hint, so an object one of them creates first is
placed near its caller.

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
The gateway advertises `viewerStages: true` and `keepalive: true` in its welcome frame; new agents
send stage frames, and keepalive pings, only when those capabilities are present. This keeps a new image compatible with an older gateway
during rollout. Older agents continue to work with the new gateway, but cannot report detailed
local milestones or perform the new desktop readiness probe.

Running VMs keep their installed agent binary. They do not gain 0.3.1 simply because the image
tag changes, and normal stop/start preserves the installed binary too. Do not recover a user's
VM merely to collect diagnostics: that interrupts service and removes its live process state.
Use the deployment's reviewed agent upgrade/replacement procedure, and preserve incident
evidence before any replacement. A fresh VM uses the newly published agent image.
