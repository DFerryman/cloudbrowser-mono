// Package protocol mirrors packages/contracts/src/protocol.ts: JSON text frames between the agent
// and the session gateway. Every frame has a "t" (type) field.
package protocol

import "encoding/json"

// Frames the agent sends.
type Hello struct {
	T            string `json:"t"` // "hello"
	AgentVersion string `json:"agentVersion"`
	Generation   int    `json:"generation"`
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
// Protocol 2, for the gateway's hosted MCP endpoint, which opens VM automation sessions lazily and
// speaks request/response to its clients. Frames are as in protocol 1 (packages/contracts
// automation.ts) with these additions; a protocol 1 gateway sees nothing new it must understand.
//
// Sessions (gateway → VM):
//   - {t:"automation_open", sessionId, clientId} is idempotent. For a session id the VM already
//     has (open, or suspended as below) with the same clientId, the session is kept with its
//     desktop session and stored files, and the VM pushes {t:"control", control, reason:"restored"}
//     and, when the screen is known, {t:"screen", screen}. Any other id opens a new session as in
//     protocol 1.
//   - When the agent's tunnel drops, its automation sessions are suspended rather than closed: the
//     running act ends (status "interrupted", reason "relay_unavailable"; the result is not
//     delivered), every held key and button is released, and the desktop session and stored files
//     stay. Nothing is pushed for a suspended session and requests for it are ignored. An
//     automation_open for it within 60 s resumes it on the new tunnel; after that it is closed.
//     automation_close, agent access turned off and the agent shutting down close sessions at once.
//
// Requests (VM ← gateway, `automation` data):
//   - screenshot, act and attach that arrive before the session's desktop session is ready wait up
//     to 15 s for it (or until the tunnel ends) instead of failing with "desktop_unavailable".
//   - screenshot, act and attach may carry maxWidth and maxHeight: integers 320..4096, either or
//     both; any other value rejects the request with reason "invalid". When the screen exceeds
//     them, the screenshot is downscaled (area-averaged, aspect kept, never enlarged) to fit and
//     encoded as JPEG at the request's quality. Coordinates in act and attach remain native screen
//     pixels.
//   - A request's basis: screenVersion must equal the current one ("screen_changed" otherwise);
//     controlEpoch is refused ("control_changed") only when it is older than the epoch at which
//     control last left the agent (a user takeover, the mode becoming user or privacy, access
//     turned off) or was handed back to it. An agent's own claim of control advances the epoch
//     but does not void its screenshots, so several acts may be decided on one screenshot. A
//     request with only screenshotId uses that screenshot's screenVersion and controlEpoch when
//     the session issued it.
//
// Results (VM → gateway, `automation_result` data):
//   - screenshot meta gains screenWidth and screenHeight, the native screen size, next to width
//     and height, the image's size.
//   - New reasons for act, all with status "rejected" and nothing executed:
//     "off_screen" (a coordinate outside the current screen; stoppedAt is that step's index),
//     "unknown_key" (a key name the VM does not know; stoppedAt is that step's index),
//     "too_long" (the steps, their waits and settleMs cannot finish within 30 s), and
//     "user_active" (the user holds control and gave a real input in the last 10 s; also for
//     attach). Any act or attach that does not end "executed" releases every held key and button;
//     keys and buttons held explicitly (keyhold, button down) last across acts only while each
//     act ends normally.
//   - attach with method "picker" takes exactly one handle ("unsupported" for more): it types the
//     file's path into Chrome's own file chooser (the dialog an upload button opens), "no_dialog"
//     when none is open, status "error" with reason "dialog_open" when the dialog did not take the
//     file.
//   - capabilities: protocol 2, scaledShots true, resume true.
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
