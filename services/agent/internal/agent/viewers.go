package agent

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/protocol"
)

// Implemented by the production relay; older adapters can retain the basic Open interface.
type progressNeko interface {
	OpenWithProgress(context.Context, string, func(json.RawMessage), func(string, string)) (NekoSession, error)
}

type viewerOpen struct {
	ctx                context.Context
	gatewayCtx         context.Context
	cancel             context.CancelFunc
	started            time.Time
	sessionID, relayID string
	forwardMu          sync.Mutex
	published          bool // protected by Agent.mu
	buffer             []json.RawMessage
	bufferBytes        int
	stageMu            sync.Mutex
	terminal           bool
	stages             chan protocol.ViewerStage
	sendStages         bool
}

func failureCode(err error) string {
	var coded interface{ FailureCode() string }
	if errors.As(err, &coded) {
		switch code := coded.FailureCode(); code {
		case "login_timeout", "login_rejected", "login_unavailable", "websocket_timeout", "websocket_unavailable", "desktop_timeout", "canceled":
			return code
		}
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	return "relay_unavailable"
}

// Logging and stage delivery never carry the underlying error: HTTP/WebSocket errors may
// include the local authentication token in a URL. A small ordered queue keeps the receive loop
// independent of both the local desktop and the gateway's write backpressure.
func (a *Agent) viewerStage(p *viewerOpen, stage, code string) {
	p.stageMu.Lock()
	defer p.stageMu.Unlock()
	if p.terminal {
		return
	}
	p.terminal = stage == "failed" || stage == "closed"
	f := protocol.ViewerStage{T: "viewer_stage", SessionID: p.sessionID, RelayID: p.relayID, Stage: stage, ElapsedMs: max(0, time.Since(p.started).Milliseconds()), Code: code}
	a.log.Info("viewer admission", "sessionId", f.SessionID, "relayId", f.RelayID, "stage", stage, "elapsedMs", f.ElapsedMs, "code", code)
	if !p.sendStages {
		return
	}
	select {
	case p.stages <- f:
	default:
	} // at most eight stages per attempt; never block admission
}

func (a *Agent) openViewer(ctx context.Context, sessionID string, relayIDs ...string) {
	if sessionID == "" {
		return
	}
	a.closeViewer(sessionID)
	relayID := ""
	if len(relayIDs) > 0 {
		relayID = relayIDs[0]
	}
	octx, cancel := context.WithCancel(ctx)
	p := &viewerOpen{ctx: octx, gatewayCtx: ctx, cancel: cancel, started: time.Now(), sessionID: sessionID, relayID: relayID, stages: make(chan protocol.ViewerStage, 16)}
	a.mu.Lock()
	p.sendStages = a.viewerStages
	a.viewerOpens[sessionID] = p
	a.relayIDs[sessionID] = relayID // pending attempts are fenced too
	a.mu.Unlock()
	if p.sendStages {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case f := <-p.stages:
					if a.write(ctx, f) != nil || f.Stage == "failed" || f.Stage == "closed" {
						return
					}
				}
			}
		}()
	}
	a.viewerStage(p, "received", "")
	go a.finishViewerOpen(p)
}

func (a *Agent) finishViewerOpen(p *viewerOpen) {
	// Cancel the opening operation on a total deadline, but stop that timer on success so an
	// admitted session can outlive the handshake. Production also has separate stage deadlines.
	timer := time.AfterFunc(a.cfg.ViewerOpenTimeout, p.cancel)
	defer timer.Stop()
	forward := func(msg json.RawMessage) {
		p.forwardMu.Lock()
		defer p.forwardMu.Unlock()
		a.mu.Lock()
		current := a.viewerOpens[p.sessionID] == p && p.ctx.Err() == nil
		if !current {
			a.mu.Unlock()
			return
		}
		if !p.published {
			if p.bufferBytes+len(msg) > 1<<20 {
				p.cancel()
				a.mu.Unlock()
				return
			}
			p.buffer = append(p.buffer, append(json.RawMessage(nil), msg...))
			p.bufferBytes += len(msg)
			a.mu.Unlock()
			return
		}
		a.mu.Unlock()
		a.forwardViewer(p, msg)
	}
	var s NekoSession
	var err error
	if a.neko == nil {
		err = errors.New("relay unavailable")
	} else if n, ok := a.neko.(progressNeko); ok {
		s, err = n.OpenWithProgress(p.ctx, p.sessionID, forward, func(stage, code string) {
			if stage != "failed" {
				a.viewerStage(p, stage, code)
			}
		})
	} else {
		s, err = a.neko.Open(p.ctx, p.sessionID, forward)
	}
	// Serialize publishing with callbacks, preserving init-before-later-signaling order.
	p.forwardMu.Lock()
	a.mu.Lock()
	current := a.viewerOpens[p.sessionID] == p
	if !current || p.ctx.Err() != nil || err != nil || s == nil {
		if current {
			delete(a.viewerOpens, p.sessionID)
			delete(a.relayIDs, p.sessionID)
		}
		a.mu.Unlock()
		p.forwardMu.Unlock()
		if s != nil {
			s.Close()
		}
		p.cancel()
		if !current {
			return
		}
		if err == nil {
			err = errors.New("relay unavailable")
		}
		a.viewerStage(p, "failed", failureCode(err))
		a.recheckDesktop(p.gatewayCtx)
		// Use the gateway context, not the now canceled local opening context.
		a.sendViewerError(p, "relay_unavailable")
		return
	}
	timer.Stop()
	a.sessions[p.sessionID] = s
	p.published = true
	buffer := p.buffer
	p.buffer = nil
	a.mu.Unlock()
	for _, msg := range buffer {
		a.forwardViewer(p, msg)
	}
	p.forwardMu.Unlock()
	go func() {
		select {
		case <-p.ctx.Done():
		case <-s.Done():
		}
		a.mu.Lock()
		if a.viewerOpens[p.sessionID] != p {
			a.mu.Unlock()
			return
		}
		delete(a.viewerOpens, p.sessionID)
		delete(a.sessions, p.sessionID)
		delete(a.relayIDs, p.sessionID)
		a.mu.Unlock()
		p.cancel()
		s.Close()
		a.endSessionTransfers(p.sessionID, p.relayID)
		a.viewerStage(p, "failed", "relay_unavailable")
		a.recheckDesktop(p.gatewayCtx)
		a.sendViewerError(p, "relay_failed")
	}()
}

// The gateway closes the agent's tunnel on a frame over gatewayFrameLimit, which would end every
// session of the browser. A neko message over maxViewerMessage (a large clipboard, a long
// system/init) is not relayed, nor one whose frame grew past the limit with its envelope and JSON
// escaping.
const (
	maxViewerMessage  = 192 << 10
	gatewayFrameLimit = 256 << 10
)

func (a *Agent) forwardViewer(p *viewerOpen, msg json.RawMessage) {
	if a.clipboardEchoed(msg) {
		return
	}
	frame, err := json.Marshal(protocol.ToViewer{T: "viewer", SessionID: p.sessionID, RelayID: p.relayID, Data: msg})
	if err != nil || len(msg) > maxViewerMessage || len(frame) > gatewayFrameLimit {
		// Only the size and the event's name: the payload is the user's content.
		var m struct {
			Event string `json:"event"`
		}
		_ = json.Unmarshal(msg, &m)
		a.log.Warn("neko message too large for the gateway; dropped", "sessionId", p.sessionID, "event", m.Event, "bytes", len(msg))
		return
	}
	// Not the viewer's own context: it ends when the viewer closes, possibly mid-write, and a
	// write whose context ends closes the whole tunnel (write).
	_ = a.write(context.WithoutCancel(p.ctx), json.RawMessage(frame))
}

func (a *Agent) sendViewerError(p *viewerOpen, reason string) {
	// An obsolete relay's error is still identified by its relay ID, so the gateway can discard it.
	ctx, cancel := context.WithTimeout(p.gatewayCtx, 10*time.Second)
	defer cancel()
	_ = a.write(ctx, protocol.ViewerError{T: "viewer_error", SessionID: p.sessionID, RelayID: p.relayID, Reason: reason})
}

func (a *Agent) viewerError(ctx context.Context, sessionID, relayID, reason string) {
	a.closeViewer(sessionID, relayID)
	_ = a.write(ctx, protocol.ViewerError{T: "viewer_error", SessionID: sessionID, RelayID: relayID, Reason: reason})
}

func (a *Agent) closeViewer(sessionID string, relayIDs ...string) {
	a.mu.Lock()
	if len(relayIDs) > 0 && a.relayIDs[sessionID] != relayIDs[0] {
		a.mu.Unlock()
		return
	}
	p, s := a.viewerOpens[sessionID], a.sessions[sessionID]
	delete(a.viewerOpens, sessionID)
	delete(a.sessions, sessionID)
	delete(a.relayIDs, sessionID)
	a.mu.Unlock()
	if p != nil {
		p.cancel()
		a.viewerStage(p, "closed", "canceled")
	}
	if s != nil {
		s.Close()
	}
	a.endSessionTransfers(sessionID)
}

func (a *Agent) closeSessions() {
	a.mu.Lock()
	all, opens := a.sessions, a.viewerOpens
	a.sessions = map[string]NekoSession{}
	a.relayIDs = map[string]string{}
	a.viewerOpens = map[string]*viewerOpen{}
	a.mu.Unlock()
	for _, p := range opens {
		p.cancel()
		a.viewerStage(p, "closed", "canceled")
	}
	for id, s := range all {
		s.Close()
		a.endSessionTransfers(id)
	}
}
