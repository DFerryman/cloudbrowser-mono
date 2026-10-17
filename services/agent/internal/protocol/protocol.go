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
	Data      json.RawMessage `json:"data"`
}

// Incoming is any frame the gateway sends; fields are set according to T.
type Incoming struct {
	T          string          `json:"t"` // welcome | command | turn | viewer_open | viewer | viewer_close | pong
	Credential string          `json:"credential,omitempty"`
	ID         string          `json:"id,omitempty"`
	Kind       string          `json:"kind,omitempty"`
	Payload    map[string]any  `json:"payload,omitempty"`
	IceServers []IceServer     `json:"iceServers,omitempty"`
	SessionID  string          `json:"sessionId,omitempty"`
	Data       json.RawMessage `json:"data,omitempty"`
}

type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// ViewerFrame is what a viewer sent: a neko message or IME text.
type ViewerFrame struct {
	T    string          `json:"t"` // neko | ime
	Data json.RawMessage `json:"data,omitempty"`
	Text string          `json:"text,omitempty"`
}

// Command kinds (packages/contracts AgentCommandKind).
const (
	CmdPrepareShutdown = "prepare_shutdown"
	CmdIPCheck         = "ip_check"
	CmdRestartChrome   = "restart_chrome"
	CmdSetFirewall     = "set_firewall"
	CmdRestoreArchive  = "restore_archive"
)
