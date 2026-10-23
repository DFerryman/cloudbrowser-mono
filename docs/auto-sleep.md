# Auto-sleep timing and activity

An established remote picture keeps the browser awake while its page is visible and the video
element is playing with a live video track. Watching a video or reading needs no keyboard or
mouse activity. Page Visibility, not focus/blur, determines whether the page is visible; an
unfocused window can still be on screen. Minimizing, changing tabs, or switching apps on mobile
normally reports hidden. This does not measure a person's gaze or reliably detect every kind
of window occlusion.

Hiding or disconnecting an established picture starts a fresh idle window. If Page Visibility
is unavailable, the client falls back to input-based inactivity with the final-minute warning.
The default is 10 minutes; choices are 5, 10, 15, 30, and 60 minutes, plus the separately authorized
Never sleep setting. An open socket or healthy VM alone does not keep a browser awake.

## Starting and resetting the timer

| Event | Effect |
| --- | --- |
| Create, wake, or recover finishes as running | Starts a fresh idle window from completion, not from the creation request |
| A new viewer session is successfully opened | Records activity immediately, before media connection or its first frame |
| An idempotent replay of the same session-open request | Does not create another activity event |
| Mouse movement, clicks, scrolling, keyboard/touch input, paste or file input | The frontend records input for the next 15-second heartbeat; legacy clients also use the agent's relayed activity |
| Heartbeat with input | Persists activity and returns the resulting idle deadline |
| Visible, established, playing picture | Renews activity every 15 seconds, even with no input |
| First accepted visible-to-hidden/disconnected transition | Records a final activity anchor and starts a full idle window |
| Repeated hidden/disconnected heartbeats | Keep session authorization current; do not restart the idle window |
| Visibility unavailable (`viewing: null`) | Only actual input renews activity |
| The idle-timeout setting changes | Starts a fresh window at the new duration |
| A visible viewer closes | The end-session transaction records the final activity anchor once |
| Automatic reconnect or signaling | Does not renew activity for a presence-aware client; a successful visible picture does |
| Diagnostic reports | Never reset activity, wake the VM, or change billing |

The activity deadline is the later of the running-start baseline and the last recorded activity,
plus the configured duration. Activity merges are monotonic: a delayed heartbeat must not
replace a newer input timestamp. Every viewer heartbeat carrying input must persist that
activity; returning a later UI deadline while discarding
the timestamp would allow the backend to stop earlier than the UI indicates.

Presence is explicitly reported as `{ sequence, viewing }`, separately from human input.
Its session-scoped sequence increases for every request, including reconnects and visibility
edges. The server accepts only newer reports for the current, non-ended session in one
transaction. That transaction reads the previous viewing state, advances activity if needed,
and stores the new state. Late visible/input reports cannot overwrite a newer hidden report;
an ended or replaced controller cannot renew activity. Legacy clients without presence keep
the old input behavior. For presence-aware clients, agent signaling no longer counts as input.

## Stop admission and execution

The engine checks idle browsers once per minute. Reaching the deadline makes a browser
eligible; it does not promise that AWS will stop it at that exact second. Operation scheduling,
shutdown preparation, and provider completion add delay.

The initial scheduler scan is only a candidate list. The actual idle deadline must be checked
again atomically when admitting the stop and when transitioning from running to stopping.
Activity or a timeout change between those checks cancels a stop that is no longer due.
The latter check must distinguish the original running-start baseline from the billing
settlement timestamp written when the stop was admitted.

Once the transition to stopping has committed, the stop completes. Opening a browser already
stopping does not cancel shutdown; the UI must show the lifecycle state and offer wake once
it is asleep. Manual sleep, exhausted credit, account freezing, and operator suspension are
separate stop reasons and are not overridden by idle activity.

A browser that needs attention (a failed operation, or a network paused by an IP check) sleeps
by the same rules, so its VM does not run unused until someone notices. Its idle window starts
at the failure at the earliest, so the user has the whole timeout to see why; with Never sleep
it is one hour. It never sleeps while an operation, such as a restart, is under way.

## User-visible boundaries

The viewer shows the idle warning during the final 60 seconds and offers Stay awake. The
warning remains above connection/reconnection overlays. Stay awake immediately flushes input
through the same ordered heartbeat queue; no response means the existing deadline remains.
There is no extra grace countdown after the displayed deadline. The engine's minute sweep
and shutdown time can make actual sleep later.

Presence is a finite activity renewal, not a permanent keep-awake flag. If the browser is
frozen or loses its reporting path, the last successful activity deadline still expires.
The client bounds heartbeat requests to 5 seconds, coalesces visibility changes, flushes the
latest state after an in-flight request, and attempts hide reports with fetch keepalive.
Failed human-input reports are retried for at most 30 seconds; a missing response must not
replay a single old gesture forever under new presence sequence numbers.
If the hide/end report cannot arrive, the fallback clock begins at the last confirmed activity
(normally within the preceding 15 seconds). A local gesture is not durable until the service
receives it; no implementation can guarantee immediate observation during a network outage.

For an incident, correlate the stop operation's reason and admission/execution times with
`last_input_at`, the running baseline, session presence/heartbeat/ending times, and the viewer's
connection attempts. A nonzero viewer count or a healthy EC2 status alone does not establish
that the inactivity deadline was reset.

Apply migration `0033_viewer_presence.sql` before deploying the API/frontend. It only adds
defaulted/nullable columns, so the previous API can continue serving during rollout. The
API and bundled web assets are released together. Existing tabs must refresh to gain the
visibility behavior; no agent replacement or VM recovery is required.
