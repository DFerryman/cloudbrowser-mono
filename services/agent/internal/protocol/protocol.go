// Package protocol mirrors packages/contracts/src/protocol.ts: JSON text frames between the agent
// and the session gateway. Every frame has a "t" (type) field.
package protocol

import "encoding/json"

// Frames the agent sends.
type Hello struct {
	T            string     `json:"t"` // "hello"
	AgentVersion string     `json:"agentVersion"`
	Generation   int        `json:"generation"`
	Previous     *TunnelEnd `json:"previous,omitempty"`
}

// TunnelEnd says why the previous tunnel ended (contracts AgentTunnelEnd), so the gateway's logs
// explain a drop without this VM's journal: fixed codes and durations, never an error's text.
type TunnelEnd struct {
	Reason       string `json:"reason"` // silent | closed | write_timeout | reset | eof | timeout | error
	CloseCode    int    `json:"closeCode,omitempty"`
	UpMs         int64  `json:"upMs"`
	DownMs       int64  `json:"downMs"`
	DialFailures int    `json:"dialFailures"`
	DialError    string `json:"dialError,omitempty"` // dns | connect | tls | timeout | http_<status> | error
}

// Ping asks for a pong, which a gateway whose welcome says keepalive answers.
type Ping struct {
	T string `json:"t"` // "ping"
}

type Event struct {
	T    string         `json:"t"`    // "event"
	Kind string         `json:"kind"` // ready | heartbeat | ip_check | chrome_exited
	Data map[string]any `json:"data"`
}

type Reply struct {
	T         string         `json:"t"` // "reply"
	CommandID string         `json:"commandId"`
	OK        bool           `json:"ok"`
	Result    map[string]any `json:"result,omitempty"`
	Error     string         `json:"error,omitempty"`
}

type TurnRequest struct {
	T string `json:"t"` // "turn_request"
}

// ToViewer carries one neko message to a viewer session.
type ToViewer struct {
	T         string          `json:"t"` // "viewer"
	SessionID string          `json:"sessionId"`
	RelayID   string          `json:"relayId,omitempty"`
	Data      json.RawMessage `json:"data"`
}

// ViewerError reports an input delivery failure without logging or returning input content.
type ViewerError struct {
	T         string `json:"t"` // "viewer_error"
	SessionID string `json:"sessionId"`
	RelayID   string `json:"relayId,omitempty"`
	Reason    string `json:"reason"` // relay_unavailable | relay_failed | input_failed
}

// ViewerStage records admission progress without carrying URLs, credentials or viewer content.
type ViewerStage struct {
	T         string `json:"t"`
	SessionID string `json:"sessionId"`
	RelayID   string `json:"relayId,omitempty"`
	Stage     string `json:"stage"`
	ElapsedMs int64  `json:"elapsedMs"`
	Code      string `json:"code,omitempty"`
}

// Incoming is any frame the gateway sends; fields are set according to T.
type Incoming struct {
	T            string          `json:"t"` // welcome | command | turn | viewer_open | viewer | viewer_close | automation_open | automation | automation_close | automation_control | pong
	Credential   string          `json:"credential,omitempty"`
	ViewerStages bool            `json:"viewerStages,omitempty"` // welcome capability; absent on older gateways
	Keepalive    bool            `json:"keepalive,omitempty"`    // welcome capability: pings are answered
	ID           string          `json:"id,omitempty"`
	Kind         string          `json:"kind,omitempty"`
	Payload      map[string]any  `json:"payload,omitempty"`
	IceServers   []IceServer     `json:"iceServers,omitempty"`
	SessionID    string          `json:"sessionId,omitempty"`
	RelayID      string          `json:"relayId,omitempty"`
	Data         json.RawMessage `json:"data,omitempty"`
	// Coding-agent access (packages/contracts automation.ts): the persisted control mode in
	// `welcome` and `automation_control`, and the bridge client of an `automation_open`.
	Automation *AutomationWelcome `json:"automation,omitempty"`
	Mode       string             `json:"mode,omitempty"`
	Access     *bool              `json:"access,omitempty"`
	ClientID   string             `json:"clientId,omitempty"`
}

// AutomationWelcome is the control state the gateway persisted: a manual takeover survives an
// agent restart because the welcome carries it back. The VM keeps the stricter of this mode and
// its own (privacy > user > agent) and answers with a control_state: a takeover the gateway has
// not persisted yet (made while the tunnel was down) is reported with reason "user_input" so the
// api records it. Only an explicit automation_control relaxes user or privacy.
type AutomationWelcome struct {
	Mode   string `json:"mode"` // agent | user | privacy
	Access bool   `json:"access"`
}

// AutomationProtocol is the automation protocol version the VM speaks (capabilities.protocol).
//
// Protocol 2 serves the gateway's hosted MCP endpoint, which opens VM automation sessions lazily,
// speaks request/response to its clients, and may open a session again after a tunnel blip.
// Frames are those of protocol 1 (packages/contracts automation.ts) with the additions below;
// every addition is optional, so a protocol 1 gateway keeps working. Session data travels as
// {t:"automation", sessionId, data} (gateway → VM) and {t:"automation_result", sessionId, data}
// (VM → gateway), as in protocol 1.
//
// Sessions:
//   - {t:"automation_open", sessionId, clientId} is idempotent. For a session id the VM already
//     has, open or suspended (below), with the same clientId, the session is kept with its desktop
//     session, its running action and its stored files, and the VM pushes
//     {t:"control", control, reason:"restored"} and, when the screen is known,
//     {t:"screen", screen:{version, width, height}}. A new id, or another clientId for a known
//     one, opens a new session as in protocol 1 (closing the old one and its files).
//   - When the agent's tunnel drops, its sessions are suspended for 60 s rather than closed: the
//     running act or attach ends ("interrupted", reason "relay_unavailable"; its result is not
//     delivered), every held key and button is released, and the desktop session and stored files
//     stay. Nothing is pushed for a suspended session and requests for it are ignored. An
//     automation_open for it within 60 s resumes it on the new tunnel; after that it is closed
//     silently, as protocol 1 closed it at once. automation_close, agent access turned off and the
//     agent shutting down still close sessions at once.
//
// Requests (`automation` data):
//   - screenshot, act and attach that arrive before the session's desktop session is ready (just
//     opened, or opened again after neko restarted) wait up to 15 s for it, instead of failing at
//     once with "desktop_unavailable". An act or attach is the session's running action from the
//     moment it arrives: while it waits, a second one is refused ("busy"), status reports it as
//     activeActionId, and a cancel (or a takeover, or a lost tunnel) ends it with status
//     "interrupted", stoppedAt 0, nothing executed.
//   - screenshot, act and attach may carry maxWidth and maxHeight, integers 320..4096, either or
//     both; any other value rejects the request with reason "invalid". When the screen exceeds
//     them, the screenshot is scaled down to fit (area-averaged, aspect kept, never enlarged) and
//     encoded as JPEG at the request's quality; otherwise it is neko's own image. Coordinates in
//     act steps and attach stay native screen pixels.
//   - The basis of act and attach: screenVersion must equal the current one ("screen_changed"
//     otherwise); controlEpoch is refused ("control_changed") only when it is older than the
//     epoch at which control last left the agent (a user takeover, the mode becoming user or
//     privacy, access turned off) or was handed back to it, since a screenshot from before the
//     hand-back may predate the user's last input. The agent's own claim of control advances the
//     epoch without voiding its screenshots, so several acts may be decided on one screenshot. A
//     request that names only screenshotId uses the screenVersion and controlEpoch that screenshot
//     was taken under, when it is one of the session's last 16.
//   - The screenshot that finishes an act or attach waits out the 150 ms screenshot interval
//     instead of failing with "too_fast".
//
// Results (`automation_result` data):
//   - The screenshot meta gains screenWidth and screenHeight, the native screen size, next to
//     width and height, the image's size.
//   - New reasons, all with status "rejected" and nothing executed:
//     "off_screen": a point outside the current screen (stoppedAt: that step's index; an attach
//     "drop" point has no stoppedAt);
//     "unknown_key": a key or modifier name the VM does not know (stoppedAt: that step's index);
//     "too_long": the steps with their pacing and waits, and settleMs, cannot finish within the
//     act's 30 s (half a second is kept free for scheduling); a typed character counts about
//     12 ms;
//     "user_active": the user holds control and gave a real input in the last 10 s (they took it
//     while no session was open, so no pause was persisted); also for attach.
//   - Any act or attach that does not end "executed" releases every held key and button. Keys
//     and buttons held explicitly (keyhold, button down) last across acts only while each act ends
//     normally.
//   - attach with method "picker" takes exactly one handle ("unsupported" for more). It types the
//     stored file's path, as Chrome sees it, into Chrome's own file chooser, the GTK dialog an
//     upload button opens (Ctrl+L, the path, Delete, Enter), and returns a screenshot. When the
//     VM can tell (it asks xdotool), a chooser that is not open is "rejected" with "no_dialog" and
//     one that stays open is status "error" with reason "dialog_open". neko's own upload dialog
//     stays disabled.
//   - Capabilities gain scaledShots: true and resume: true; protocol is 2, agentVersion "0.5.0" (from then on, the agent's Version).
const AutomationProtocol = 2

// ControlState is who may drive the browser (contracts ControlState).
type ControlState struct {
	Controller string `json:"controller"` // none | agent | user
	Mode       string `json:"mode"`       // agent | user | privacy
	Epoch      int64  `json:"epoch"`
}

// ControlStateFrame reports a change of control to the gateway, which fans it out and persists it.
type ControlStateFrame struct {
	T       string       `json:"t"` // "control_state"
	Control ControlState `json:"control"`
	Reason  string       `json:"reason"`
}

// AutomationResult carries one response to a bridge session; Data is a contracts AutomationResponse.
type AutomationResult struct {
	T         string `json:"t"` // "automation_result"
	SessionID string `json:"sessionId"`
	Data      any    `json:"data"`
}

type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// ViewerFile reports a viewer's file transfer (packages/contracts AgentViewerFile).
type ViewerFile struct {
	T         string `json:"t"` // "viewer_file"
	SessionID string `json:"sessionId"`
	RelayID   string `json:"relayId,omitempty"`
	ID        string `json:"id"`
	Status    string `json:"status"` // progress | done | error
	Received  int64  `json:"received,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// ViewerFrame is what a viewer sent: a neko message, IME text or part of a file transfer.
type ViewerFrame struct {
	T    string          `json:"t"` // neko | ime | file_begin | file_chunk | file_end | file_cancel
	Data json.RawMessage `json:"data,omitempty"`
	Text string          `json:"text,omitempty"`

	// File transfers (file_*).
	ID     string     `json:"id,omitempty"`
	Action string     `json:"action,omitempty"` // paste | drop
	X      *int       `json:"x,omitempty"`
	Y      *int       `json:"y,omitempty"`
	Files  []FileMeta `json:"files,omitempty"`
	File   int        `json:"file,omitempty"`
	Chunk  string     `json:"chunk,omitempty"` // base64
}

type FileMeta struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}

// Command kinds (packages/contracts AgentCommandKind).
const (
	CmdPrepareShutdown = "prepare_shutdown"
	CmdIPCheck         = "ip_check"
	CmdRestartChrome   = "restart_chrome"
	CmdSetFirewall     = "set_firewall"
	CmdRestoreArchive  = "restore_archive"
	CmdGrowFilesystem  = "grow_filesystem"
)
