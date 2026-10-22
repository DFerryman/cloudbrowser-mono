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
// agent restart because the welcome carries it back.
type AutomationWelcome struct {
	Mode   string `json:"mode"` // agent | user | privacy
	Access bool   `json:"access"`
}

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
