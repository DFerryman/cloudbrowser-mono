package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image/jpeg"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/protocol"
)

// A bridge session (docs/agent-access.md): the coding agent's connection, relayed by the gateway
// as `automation_*` frames. It gets its own neko session for input and screen events and its
// own temporary files; screenshots come from neko's screenshot endpoint, so they show the whole
// remote display (tabs, address bar, dialogs) without touching focus or layout. The gateway's
// hosted MCP endpoint opens sessions lazily and may open one again, and a session outlives a lost
// tunnel for a short grace; protocol.AutomationProtocol describes the wire contract.

// AutomationNeko is implemented by the production relay: a neko session that can also take
// screenshots.
type AutomationNeko interface {
	OpenAutomation(ctx context.Context, onEvent func(json.RawMessage)) (AutomationSession, error)
}

type AutomationSession interface {
	NekoSession
	// Screenshot is the whole display as JPEG at `quality` (1-100).
	Screenshot(ctx context.Context, quality int) ([]byte, error)
}

// FileChooser tells whether Chrome's own file chooser, the GTK dialog an upload button opens, is
// open on the remote display (cmd/agent asks xdotool in the browser container). Optional: without
// one, a picker attach types into whatever has focus and its screenshot shows what happened.
type FileChooser interface {
	FileChooserOpen(ctx context.Context) (bool, error)
}

const (
	maxActDuration       = 30 * time.Second
	maxWaitStep          = 5 * time.Second
	defaultSettle        = 400 * time.Millisecond
	minScreenshotGap     = 150 * time.Millisecond
	blobChunkChars       = 160 * 1024
	defaultJPEGQuality   = 85
	screenshotRetries    = 2
	automationOpenLimit  = 35 * time.Second
	attachDeliverLimit   = 20 * time.Second
	automationStoredMax  = int64(maxTransferBytes)
	maxStoredPerSession  = 10
	automationFilePrefix = "a-"
	// A session outlives a lost tunnel this long, for the gateway to open it again.
	automationSuspendGrace = 60 * time.Second
	// A request waits this long for a desktop session that is still being opened.
	automationReadyWait = 15 * time.Second
	// The user is still at work for this long after a real input: the agent may not claim control.
	userActiveFor = 10 * time.Second
	// The box a request may ask its screenshot to fit in (maxWidth, maxHeight).
	minShotSide, maxShotSide = 320, 4096
	// Screenshots a session remembers for requests that name only their screenshotId.
	rememberedShots = 16
	// How long a picker attach waits for Chrome's file chooser to close after Enter.
	pickerSettle = 2 * time.Second
)

// automationReopen is the backoff before a bridge's desktop session is opened again.
var automationReopen = []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second}

type screenState struct {
	version       int64
	width, height int
}

type storedFile struct {
	handle, name, mime string
	size               int64
	path               string // on the VM
	browserPath        string // as Chrome sees it
}

type automation struct {
	id, clientID string
	// From automation_open until the session is closed; a lost tunnel only suspends it.
	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	neko     AutomationSession
	ready    bool
	readyCh  chan struct{} // closed while ready, so a request can wait for the desktop session
	failure  string
	heldKeys []int64 // keysyms the bridge holds, in press order
	heldBtns []int64
	active   *activeAction
	lastShot time.Time
	shots    []shotBasis // the latest screenshots taken, newest last
	stored   map[string]storedFile
	storedB  int64
	transfer *transfer
	// suspended: the tunnel it was opened on is gone; automation_open within the grace resumes it.
	suspended  bool
	suspension int // counts suspensions, so a resumed session's old grace timer does nothing
	grace      *time.Timer
	closing    bool
	writeMu    sync.Mutex // one goroutine writes this session's frames at a time
	writer     func(ctx context.Context, v any) error
}

type activeAction struct {
	id string
	// From admission, ctx is canceled by cancel (a cancel request, a takeover, a lost tunnel);
	// once the action may run, it is bounded by maxActDuration as well, which stop releases.
	ctx    context.Context
	cancel context.CancelFunc
	stop   context.CancelFunc
	neko   AutomationSession // the desktop session the action was admitted on
	reason string            // what interrupted it, protected by automation.mu
}

// shotBasis is what a screenshot was taken under, for a request that names only its screenshotId.
type shotBasis struct {
	id             string
	version, epoch int64
}

// automationRequest is a contracts AutomationRequest; unknown fields are ignored.
type automationRequest struct {
	T             string              `json:"t"`
	ID            string              `json:"id"`
	ActionID      string              `json:"actionId,omitempty"`
	Quality       int                 `json:"quality,omitempty"`
	MaxWidth      *int                `json:"maxWidth,omitempty"`
	MaxHeight     *int                `json:"maxHeight,omitempty"`
	ScreenshotID  string              `json:"screenshotId,omitempty"`
	ScreenVersion *int64              `json:"screenVersion,omitempty"`
	ControlEpoch  *int64              `json:"controlEpoch,omitempty"`
	Steps         []json.RawMessage   `json:"steps,omitempty"`
	SettleMs      *int                `json:"settleMs,omitempty"`
	Screenshot    *bool               `json:"screenshot,omitempty"`
	Action        string              `json:"action,omitempty"`
	Files         []protocol.FileMeta `json:"files,omitempty"`
	File          int                 `json:"file,omitempty"`
	Chunk         string              `json:"chunk,omitempty"`
	Handles       []string            `json:"handles,omitempty"`
	Method        string              `json:"method,omitempty"`
	X             *int                `json:"x,omitempty"`
	Y             *int                `json:"y,omitempty"`
}

type screenshotMeta struct {
	ID     string `json:"id"`
	BlobID string `json:"blobId"`
	Mime   string `json:"mime"`
	Bytes  int    `json:"bytes"`
	// The image's size, and the screen's: they differ when the request asked for a smaller box.
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	ScreenWidth   int    `json:"screenWidth"`
	ScreenHeight  int    `json:"screenHeight"`
	CapturedAt    string `json:"capturedAt"`
	ScreenVersion int64  `json:"screenVersion"`
	ControlEpoch  int64  `json:"controlEpoch"`
}

type screenInfo struct {
	Version int64 `json:"version"`
	Width   int   `json:"width"`
	Height  int   `json:"height"`
}

type result struct {
	T              string                `json:"t"`
	ID             string                `json:"id"`
	Kind           string                `json:"kind"`
	Status         string                `json:"status"`
	Reason         string                `json:"reason,omitempty"`
	StoppedAt      *int                  `json:"stoppedAt,omitempty"`
	Control        protocol.ControlState `json:"control"`
	Screen         screenInfo            `json:"screen"`
	Screenshot     *screenshotMeta       `json:"screenshot,omitempty"`
	Capabilities   map[string]any        `json:"capabilities,omitempty"`
	ActiveActionID string                `json:"activeActionId,omitempty"`
}

func (a *Agent) automationList() []*automation {
	out := make([]*automation, 0, len(a.automations))
	for _, s := range a.automations {
		out = append(out, s)
	}
	return out
}

func (a *Agent) capabilities() map[string]any {
	_, nekoOK := a.neko.(AutomationNeko)
	files := a.uploadsConfigured()
	return map[string]any{
		"protocol": protocol.AutomationProtocol, "agentVersion": Version,
		"screenshot": nekoOK, "files": files,
		"picker": files && nekoOK, "paste": files && a.cfg.Clipboard != nil, "drop": files,
		"touch": false, "scaledShots": true, "resume": true,
	}
}

func (a *Agent) screenNow() screenInfo {
	return screenInfo{Version: a.screen.version, Width: a.screen.width, Height: a.screen.height}
}

// openAutomation admits a bridge session: its neko session is opened in the background and the
// bridge learns the control state and screen as soon as they are known. Opening a session the VM
// already has keeps it instead (resumeAutomation).
func (a *Agent) openAutomation(ctx context.Context, sessionID, clientID string) {
	if sessionID == "" {
		return
	}
	if a.resumeAutomation(ctx, sessionID, clientID) {
		return
	}
	a.closeAutomation(sessionID)
	// The session's lifetime is its own, not the tunnel's: a lost tunnel suspends it
	// (suspendAutomations) instead of ending its desktop session.
	sctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	s := &automation{id: sessionID, clientID: clientID, ctx: sctx, cancel: cancel, readyCh: make(chan struct{}), stored: map[string]storedFile{}, writer: a.write}
	a.mu.Lock()
	a.automations[sessionID] = s
	state := a.controlSnapshot()
	a.mu.Unlock()
	s.push(ctx, map[string]any{"t": "control", "control": state, "reason": "restored"})
	go a.keepAutomationDesktop(sctx, s)
}

// resumeAutomation keeps a session that is opened again: the hosted MCP endpoint may send
// automation_open for a session it already has, and after a tunnel blip it resumes a suspended
// one. Its desktop session and stored files stay, and the gateway learns the control state and
// the screen again. False when there is no such session to keep: a new id, another client, a
// session already being closed, or one that can never have a desktop.
func (a *Agent) resumeAutomation(ctx context.Context, sessionID, clientID string) bool {
	a.mu.Lock()
	s := a.automations[sessionID]
	a.mu.Unlock()
	if s == nil {
		return false
	}
	s.mu.Lock()
	keep := !s.closing && s.clientID == clientID && s.failure != "unsupported"
	if keep {
		s.suspended = false
		if s.grace != nil {
			s.grace.Stop()
			s.grace = nil
		}
	}
	s.mu.Unlock()
	if !keep {
		return false
	}
	a.mu.Lock()
	state, screen := a.controlSnapshot(), a.screenNow()
	a.mu.Unlock()
	s.push(ctx, map[string]any{"t": "control", "control": state, "reason": "restored"})
	if screen.Width > 0 {
		s.push(ctx, map[string]any{"t": "screen", "screen": screen})
	}
	return true
}

// keepAutomationDesktop holds the session's own desktop (neko) session for as long as the bridge
// session lasts: it opens it, and whenever neko ends it, opens it again with backoff (1 s, 2 s,
// 5 s, then every 10 s), so a restart of neko does not leave the session without input and
// screenshots until the bridge reconnects.
func (a *Agent) keepAutomationDesktop(ctx context.Context, s *automation) {
	n, ok := a.neko.(AutomationNeko)
	if !ok {
		s.mu.Lock()
		s.failure = "unsupported"
		s.mu.Unlock()
		return
	}
	retry := 0
	for {
		started := time.Now()
		if session, end := a.openAutomationDesktop(ctx, n, s); session != nil {
			select {
			case <-ctx.Done():
			case <-session.Done():
			}
			end()
			if ctx.Err() != nil {
				return
			}
			a.log.Warn("bridge desktop session ended; opening it again", "sessionId", s.id)
			if time.Since(started) > time.Minute {
				retry = 0
			}
		}
		if ctx.Err() != nil {
			return
		}
		delay := a.reopenDelays[min(retry, len(a.reopenDelays)-1)]
		retry++
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

// openAutomationDesktop opens the session's desktop session once. Only the opening is bounded
// (automationOpenLimit): the relay derives the session's lifetime from the context it is opened
// with, so a deadline on that context, or canceling it once the open returned, would end the
// session at once and every request would find the desktop unavailable. A timer cancels a
// context that otherwise lives until the session ends. It returns the session and the function
// that ends it, or nil when it could not be opened.
func (a *Agent) openAutomationDesktop(ctx context.Context, n AutomationNeko, s *automation) (AutomationSession, func()) {
	octx, cancel := context.WithCancel(ctx)
	timer := time.AfterFunc(a.openLimit, cancel)
	session, err := n.OpenAutomation(octx, func(msg json.RawMessage) { a.automationEvent(ctx, s, msg) })
	inTime := timer.Stop()
	a.mu.Lock()
	current := a.automations[s.id] == s && ctx.Err() == nil
	a.mu.Unlock()
	if err != nil || session == nil || !inTime || !current {
		if session != nil {
			session.Close()
		}
		cancel()
		s.mu.Lock()
		s.failure = "desktop_unavailable"
		s.mu.Unlock()
		if current {
			code := failureCode(err)
			if err == nil {
				code = "desktop_timeout"
			}
			a.log.Warn("bridge desktop session", "sessionId", s.id, "code", code)
		}
		return nil, nil
	}
	s.mu.Lock()
	s.neko, s.ready, s.failure = session, true, ""
	close(s.readyCh)
	s.mu.Unlock()
	// Keys and buttons a lost desktop session could not let go of are released now.
	s.releaseHeld()
	a.mu.Lock()
	screen := a.screenNow()
	a.mu.Unlock()
	if screen.Width > 0 {
		s.push(ctx, map[string]any{"t": "screen", "screen": screen})
	}
	return session, func() {
		s.mu.Lock()
		if s.neko == session {
			s.neko, s.ready, s.failure = nil, false, "desktop_unavailable"
			s.readyCh = make(chan struct{})
		}
		s.mu.Unlock()
		s.interrupt("desktop_unavailable")
		session.Close()
		cancel()
	}
}

// waitDesktop returns the session's desktop session, waiting up to `wait` while it is being
// opened (or opened again): a request that arrives right after automation_open must not fail
// only because neko has not answered yet. Nil if it is not ready in time.
func (a *Agent) waitDesktop(ctx context.Context, s *automation, wait time.Duration) AutomationSession {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		s.mu.Lock()
		n, ready, readyCh, failure := s.neko, s.ready, s.readyCh, s.failure
		s.mu.Unlock()
		if ready && n != nil {
			return n
		}
		if failure == "unsupported" || ctx.Err() != nil || s.ctx.Err() != nil {
			return nil
		}
		select {
		case <-readyCh:
		case <-timer.C:
			return nil
		case <-ctx.Done():
			return nil
		case <-s.ctx.Done():
			return nil
		}
	}
}

// automationEvent handles neko's messages on the bridge's session: only screen geometry matters.
func (a *Agent) automationEvent(ctx context.Context, s *automation, msg json.RawMessage) {
	var m struct {
		Event   string          `json:"event"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(msg, &m) != nil {
		return
	}
	var size struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	}
	switch m.Event {
	case "system/init":
		var init struct {
			ScreenSize json.RawMessage `json:"screen_size"`
		}
		if json.Unmarshal(m.Payload, &init) != nil || json.Unmarshal(init.ScreenSize, &size) != nil {
			return
		}
	case "screen/updated":
		if json.Unmarshal(m.Payload, &size) != nil {
			return
		}
	default:
		return
	}
	if size.Width <= 0 || size.Height <= 0 {
		return
	}
	a.mu.Lock()
	if a.screen.width == size.Width && a.screen.height == size.Height && a.screen.version > 0 {
		a.mu.Unlock()
		return
	}
	a.screen = screenState{version: a.screen.version + 1, width: size.Width, height: size.Height}
	screen := a.screenNow()
	sessions := a.automationList()
	a.mu.Unlock()
	// A size change voids every coordinate decided on an earlier screenshot; a running action
	// stops rather than clicking remapped points.
	for _, other := range sessions {
		other.interrupt("screen_changed")
		other.push(ctx, map[string]any{"t": "screen", "screen": screen})
	}
}

func (a *Agent) closeAutomation(sessionID string) {
	a.mu.Lock()
	s := a.automations[sessionID]
	a.mu.Unlock()
	if s != nil {
		a.endAutomation(s)
	}
}

// endAutomation ends a bridge session: its action, held input, desktop session and files.
func (a *Agent) endAutomation(s *automation) {
	a.mu.Lock()
	if a.automations[s.id] != s {
		a.mu.Unlock()
		return
	}
	delete(a.automations, s.id)
	if len(a.automations) == 0 && a.control.controller == ctlAgent {
		a.control.controller = ctlNone
		a.control.epoch++
	}
	a.mu.Unlock()
	s.mu.Lock()
	s.closing = true
	if s.grace != nil {
		s.grace.Stop()
		s.grace = nil
	}
	s.mu.Unlock()
	s.interrupt("relay_unavailable")
	s.releaseHeld()
	s.cancel()
	s.mu.Lock()
	n := s.neko
	s.neko = nil
	s.ready = false
	s.readyCh = make(chan struct{})
	stored := s.stored
	s.stored = map[string]storedFile{}
	t := s.transfer
	s.transfer = nil
	s.mu.Unlock()
	if n != nil {
		n.Close()
	}
	if t != nil {
		t.close()
		_ = os.RemoveAll(t.dir)
	}
	dirs := map[string]bool{}
	for _, f := range stored {
		dirs[filepath.Dir(filepath.Dir(f.path))] = true
	}
	for dir := range dirs {
		_ = os.RemoveAll(dir)
	}
}

func (a *Agent) closeAutomations() {
	a.mu.Lock()
	sessions := a.automationList()
	a.mu.Unlock()
	for _, s := range sessions {
		a.endAutomation(s)
	}
}

// suspendAutomations keeps the bridge sessions of a lost tunnel for automationSuspendGrace, for
// the gateway to open them again on its next tunnel: the running action stops, every held key and
// button is released, and the desktop session and stored files stay. A session that is not
// resumed in time is closed.
func (a *Agent) suspendAutomations() {
	a.mu.Lock()
	sessions := a.automationList()
	a.mu.Unlock()
	for _, s := range sessions {
		s.mu.Lock()
		if s.closing || s.suspended {
			s.mu.Unlock()
			continue
		}
		s.suspended = true
		s.suspension++
		suspension := s.suspension
		s.grace = time.AfterFunc(a.suspendGrace, func() { a.expireAutomation(s, suspension) })
		s.mu.Unlock()
		s.interrupt("relay_unavailable")
		s.releaseHeld()
	}
}

// expireAutomation closes a session still suspended since `suspension` when its grace ran out.
func (a *Agent) expireAutomation(s *automation, suspension int) {
	s.mu.Lock()
	expired := s.suspended && s.suspension == suspension && !s.closing
	if expired {
		s.closing = true // no automation_open can resume it from here on
	}
	s.mu.Unlock()
	if expired {
		a.log.Info("bridge session not resumed after a lost tunnel; closed", "sessionId", s.id)
		a.endAutomation(s)
	}
}

func (s *automation) isSuspended() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.suspended
}

// push sends one response frame to the bridge through the gateway.
func (s *automation) push(ctx context.Context, data any) {
	// Serialize with the agent's writer through the session, so blob chunks and their result keep their order.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.pushLocked(ctx, data)
}

func (s *automation) pushLocked(ctx context.Context, data any) {
	s.mu.Lock()
	suspended := s.suspended
	s.mu.Unlock()
	if suspended {
		return // the gateway that asked is gone; a resumed session is told its state again
	}
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_ = s.write(wctx, protocol.AutomationResult{T: "automation_result", SessionID: s.id, Data: data})
}

// write is set by the agent (its tunnel writer); separate so tests can observe frames.
func (s *automation) write(ctx context.Context, v any) error {
	if s.writer == nil {
		return errors.New("no tunnel")
	}
	return s.writer(ctx, v)
}

func (s *automation) interrupt(reason string) {
	s.mu.Lock()
	act := s.active
	if act != nil && act.reason == "" {
		act.reason = reason
	}
	s.mu.Unlock()
	if act != nil {
		act.cancel()
	}
}

// releaseHeld lets go of every key and button the bridge still holds: a takeover mid-chord, an
// action that did not end normally, a lost tunnel. It takes no context, as nothing that stopped
// the action may stop its releases. Sending under s.mu orders it with key and button, so a press
// is either released here or never sent. Without a desktop session the keys stay listed, and the
// next desktop session releases them.
func (s *automation) releaseHeld() {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.neko
	if n == nil {
		return
	}
	for i := len(s.heldKeys) - 1; i >= 0; i-- {
		_ = n.Send(nekoEvent("control/keyup", map[string]any{"keysym": s.heldKeys[i]}))
	}
	for i := len(s.heldBtns) - 1; i >= 0; i-- {
		_ = n.Send(nekoEvent("control/buttonup", map[string]any{"code": s.heldBtns[i]}))
	}
	s.heldKeys, s.heldBtns = nil, nil
}

// rememberShot keeps what a screenshot was taken under, for requests that name only its id.
func (s *automation) rememberShot(b shotBasis) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.shots = append(s.shots, b)
	if len(s.shots) > rememberedShots {
		s.shots = append([]shotBasis(nil), s.shots[len(s.shots)-rememberedShots:]...)
	}
}

func (s *automation) shotBasis(id string) (shotBasis, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.shots) - 1; i >= 0; i-- {
		if s.shots[i].id == id {
			return s.shots[i], true
		}
	}
	return shotBasis{}, false
}

func nekoEvent(event string, payload any) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"event": event, "payload": payload})
	return b
}

// fromAutomation handles one request of a bridge session.
func (a *Agent) fromAutomation(ctx context.Context, sessionID string, data json.RawMessage) {
	var req automationRequest
	if json.Unmarshal(data, &req) != nil || req.ID == "" && req.T != "file_chunk" {
		return
	}
	a.mu.Lock()
	s := a.automations[sessionID]
	a.mu.Unlock()
	if s == nil {
		return
	}
	s.mu.Lock()
	suspended := s.suspended
	s.mu.Unlock()
	if suspended {
		return // only automation_open resumes it
	}
	switch req.T {
	case "status":
		s.push(ctx, a.result(s, req.ID, "status", "executed", "", nil))
	case "screenshot":
		go a.serveScreenshot(ctx, s, req)
	case "act":
		go a.serveAct(ctx, s, req)
	case "cancel":
		s.mu.Lock()
		act := s.active
		s.mu.Unlock()
		status := "executed"
		if act == nil || act.id != req.ActionID {
			status = "rejected"
		} else {
			s.interrupt("canceled")
		}
		s.push(ctx, a.result(s, req.ID, "cancel", status, map[bool]string{true: "", false: "not_found"}[status == "executed"], nil))
	case "attach":
		go a.serveAttach(ctx, s, req)
	case "file_begin", "file_chunk", "file_end", "file_cancel":
		a.automationFile(ctx, s, req)
	}
}

// result builds a response with the current control and screen; `extra` adds the screenshot.
func (a *Agent) result(s *automation, id, kind, status, reason string, shot *screenshotMeta) result {
	a.mu.Lock()
	r := result{T: "result", ID: id, Kind: kind, Status: status, Reason: reason, Control: a.controlSnapshot(), Screen: a.screenNow(), Screenshot: shot}
	a.mu.Unlock()
	if kind == "status" {
		r.Capabilities = a.capabilities()
		s.mu.Lock()
		if s.active != nil {
			r.ActiveActionID = s.active.id
		}
		if !s.ready && s.failure != "" {
			r.Reason = s.failure
		}
		s.mu.Unlock()
	}
	return r
}

// rejectStep refuses a request because of one of its steps, naming the step.
func (a *Agent) rejectStep(ctx context.Context, s *automation, req automationRequest, kind, reason string, step int) {
	r := a.result(s, req.ID, kind, "rejected", reason, nil)
	r.StoppedAt = &step
	s.push(ctx, r)
}

// checkBasis refuses a coordinate-based request decided on a stale screenshot. The screen must be
// the same version. Control may have moved meanwhile only to the agent itself: its own claims
// advance the epoch, but only the user taking control, a pause, access turned off or a hand-back
// (leftEpoch) make what the screenshot showed unreliable. A request that names only a screenshot
// this session took is checked against what that screenshot was taken under.
func (a *Agent) checkBasis(s *automation, req automationRequest) string {
	version, epoch := req.ScreenVersion, req.ControlEpoch
	if req.ScreenshotID != "" && (version == nil || epoch == nil) {
		if shot, ok := s.shotBasis(req.ScreenshotID); ok {
			if version == nil {
				version = &shot.version
			}
			if epoch == nil {
				epoch = &shot.epoch
			}
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if version != nil && *version != a.screen.version {
		return "screen_changed"
	}
	if epoch != nil && *epoch < a.control.leftEpoch {
		return "control_changed"
	}
	return ""
}

func (a *Agent) serveScreenshot(ctx context.Context, s *automation, req automationRequest) {
	box, ok := screenshotBox(req)
	if !ok {
		s.push(ctx, a.result(s, req.ID, "screenshot", "rejected", "invalid", nil))
		return
	}
	a.mu.Lock()
	refused := ""
	switch {
	case !a.control.access:
		refused = "agent_access_off"
	case a.control.mode == modePrivacy:
		refused = "control_privacy"
	}
	a.mu.Unlock()
	if refused != "" {
		s.push(ctx, a.result(s, req.ID, "screenshot", "rejected", refused, nil))
		return
	}
	shot, reason := a.captureScreenshot(ctx, s, req.Quality, box, a.readyWait, false)
	if shot == nil {
		s.push(ctx, a.result(s, req.ID, "screenshot", "rejected", reason, nil))
		return
	}
	a.deliverShot(ctx, s, req.ID, "screenshot", "executed", "", nil, shot)
}

type capturedShot struct {
	meta screenshotMeta
	data []byte
}

// captureScreenshot takes the display as it is now and makes sure its size and the screen
// version agree; a change during capture is retried, then refused, never returned inconsistent.
// The image is scaled down to the box the request asked for, if the screen is larger. Requests
// for screenshots alone are refused when they come faster than minScreenshotGap; the screenshot
// that finishes an action waits out the gap instead, since the action already ran.
func (a *Agent) captureScreenshot(ctx context.Context, s *automation, quality int, box shotBox, wait time.Duration, finishing bool) (*capturedShot, string) {
	n := a.waitDesktop(ctx, s, wait)
	if n == nil {
		return nil, "desktop_unavailable"
	}
	s.mu.Lock()
	gap := minScreenshotGap - time.Since(s.lastShot)
	if gap > 0 && !finishing {
		s.mu.Unlock()
		return nil, "too_fast"
	}
	s.lastShot = time.Now().Add(max(gap, 0))
	s.mu.Unlock()
	if pace(ctx, gap) != nil {
		return nil, "desktop_unavailable"
	}
	if quality <= 0 {
		quality = defaultJPEGQuality
	}
	quality = max(10, min(100, quality))
	for attempt := 0; attempt <= screenshotRetries; attempt++ {
		a.mu.Lock()
		before, epoch := a.screen, a.control.epoch
		a.mu.Unlock()
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		data, err := n.Screenshot(cctx, quality)
		cancel()
		if err != nil {
			a.log.Warn("screenshot", "err", err)
			return nil, "desktop_unavailable"
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			return nil, "desktop_unavailable"
		}
		a.mu.Lock()
		// The first screenshot also tells us the screen when neko's init has not yet.
		if a.screen.version == 0 {
			a.screen = screenState{version: 1, width: cfg.Width, height: cfg.Height}
			before = a.screen
		}
		after := a.screen
		if a.control.mode == modePrivacy {
			a.mu.Unlock()
			return nil, "control_privacy" // decided while capturing: not delivered
		}
		a.mu.Unlock()
		if after != before || cfg.Width != after.width || cfg.Height != after.height {
			continue
		}
		width, height := box.fit(cfg.Width, cfg.Height)
		if width != cfg.Width || height != cfg.Height {
			if data, err = scaleJPEG(data, width, height, quality); err != nil {
				a.log.Warn("scale screenshot", "err", err)
				return nil, "desktop_unavailable"
			}
		}
		id := strconv.FormatInt(time.Now().UnixNano(), 36)
		s.rememberShot(shotBasis{id: id, version: after.version, epoch: epoch})
		return &capturedShot{data: data, meta: screenshotMeta{
			ID: id, BlobID: id, Mime: "image/jpeg", Bytes: len(data), Width: width, Height: height,
			ScreenWidth: cfg.Width, ScreenHeight: cfg.Height,
			CapturedAt: time.Now().UTC().Format(time.RFC3339Nano), ScreenVersion: after.version, ControlEpoch: epoch,
		}}, ""
	}
	return nil, "screen_changed"
}

// deliverShot sends the image bytes in bounded blob frames, then the result that names them.
func (a *Agent) deliverShot(ctx context.Context, s *automation, id, kind, status, reason string, stoppedAt *int, shot *capturedShot) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var meta *screenshotMeta
	if shot != nil {
		encoded := base64.StdEncoding.EncodeToString(shot.data)
		total := (len(encoded) + blobChunkChars - 1) / blobChunkChars
		for i := 0; i < total; i++ {
			end := min(len(encoded), (i+1)*blobChunkChars)
			s.pushLocked(ctx, map[string]any{"t": "blob", "id": shot.meta.BlobID, "seq": i, "last": i == total-1, "data": encoded[i*blobChunkChars : end]})
		}
		meta = &shot.meta
	}
	r := a.result(s, id, kind, status, reason, meta)
	r.StoppedAt = stoppedAt
	s.pushLocked(ctx, r)
}

// admitAction registers a request that drives input as the session's one action from the moment
// it arrives, so a second one is refused as busy and a cancel reaches it while it still waits for
// the desktop. Nil when another action is running.
func (s *automation) admitAction(ctx context.Context, id string) *activeAction {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != nil {
		return nil
	}
	actx, cancel := context.WithCancel(ctx)
	act := &activeAction{id: id, ctx: actx, cancel: cancel}
	s.active = act
	return act
}

// beginAction makes an admitted action ready to run. It waits for the desktop session (a request
// may arrive while it is still being opened), refuses a request decided on a stale screenshot or
// with a point off the screen, then claims input for the agent, so a refused request never takes
// control. It returns why the action may not run and, for a step, its index; the caller ends the
// action either way (endAction), which also tells whether something interrupted it meanwhile. On
// success the action runs on act.ctx, bounded by maxActDuration, through act.neko.
func (a *Agent) beginAction(ctx context.Context, s *automation, act *activeAction, req automationRequest, steps []step) (string, *int) {
	n := a.waitDesktop(act.ctx, s, a.readyWait)
	if n == nil {
		return "desktop_unavailable", nil
	}
	if reason := a.checkBasis(s, req); reason != "" {
		return reason, nil
	}
	s.mu.Lock()
	if !s.ready || s.neko != n || act.ctx.Err() != nil {
		s.mu.Unlock()
		return "desktop_unavailable", nil
	}
	a.mu.Lock()
	if i := offScreen(steps, a.screen); i >= 0 {
		a.mu.Unlock()
		s.mu.Unlock()
		return "off_screen", &i
	}
	changed, reason := a.claimForBridge()
	if reason != "" {
		a.mu.Unlock()
		s.mu.Unlock()
		return reason, nil
	}
	state := a.controlSnapshot()
	a.lastInputAt = time.Now()
	a.mu.Unlock()
	act.ctx, act.stop = context.WithTimeout(act.ctx, maxActDuration)
	act.neko = n
	s.mu.Unlock()
	if changed {
		a.publishControl(ctx, state, "agent_input")
	}
	return "", nil
}

// endAction unregisters the action and returns what interrupted it, if anything. An action that
// did not end normally must then release everything held (releaseHeld).
func (a *Agent) endAction(s *automation, act *activeAction) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	act.cancel()
	if act.stop != nil {
		act.stop()
	}
	if s.active == act {
		s.active = nil
	}
	return act.reason
}

// refuseAction ends an admitted action that never ran: rejected for `reason` (at `step`), or
// interrupted at its first step when something stopped it while it waited.
func (a *Agent) refuseAction(ctx context.Context, s *automation, act *activeAction, req automationRequest, box shotBox, kind, reason string, step *int) {
	if interruption := a.endAction(s, act); interruption != "" {
		s.releaseHeld()
		zero := 0
		a.finishWithShot(ctx, s, req, box, kind, "interrupted", interruption, &zero)
		return
	}
	r := a.result(s, req.ID, kind, "rejected", reason, nil)
	r.StoppedAt = step
	s.push(ctx, r)
}

// actSlack is kept free of an action's 30 s: timers and writes take a little longer than their
// nominal time, and an action refused up front is better than one cut off halfway through.
const actSlack = 500 * time.Millisecond

func (a *Agent) serveAct(ctx context.Context, s *automation, req automationRequest) {
	box, ok := screenshotBox(req)
	if !ok {
		s.push(ctx, a.result(s, req.ID, "act", "rejected", "invalid", nil))
		return
	}
	steps, cost, err := parseSteps(req.Steps)
	if err != nil {
		var bad *stepError
		if errors.As(err, &bad) && bad.reason == "unknown_key" {
			a.rejectStep(ctx, s, req, "act", bad.reason, bad.index)
			return
		}
		s.push(ctx, a.result(s, req.ID, "act", "rejected", "invalid", nil))
		return
	}
	settle := defaultSettle
	if req.SettleMs != nil {
		settle = time.Duration(max(0, min(*req.SettleMs, int(maxWaitStep/time.Millisecond)))) * time.Millisecond
	}
	// An action that cannot finish in time is refused up front, never cut off halfway through.
	if cost+settle > maxActDuration-actSlack {
		s.push(ctx, a.result(s, req.ID, "act", "rejected", "too_long", nil))
		return
	}
	act := s.admitAction(ctx, req.ID)
	if act == nil {
		s.push(ctx, a.result(s, req.ID, "act", "rejected", "busy", nil))
		return
	}
	if reason, step := a.beginAction(ctx, s, act, req, steps); reason != "" {
		a.refuseAction(ctx, s, act, req, box, "act", reason, step)
		return
	}
	stoppedAt, stepErr := a.runSteps(act.ctx, s, act.neko, steps)
	if stepErr == nil && settle > 0 {
		select {
		case <-act.ctx.Done():
		case <-time.After(settle):
		}
	}
	deadline := errors.Is(act.ctx.Err(), context.DeadlineExceeded)
	interruption := a.endAction(s, act)
	status, why := "executed", ""
	var stopped *int
	switch {
	case interruption != "":
		status, why, stopped = "interrupted", interruption, &stoppedAt
	case errors.Is(stepErr, context.DeadlineExceeded) || deadline:
		status, why, stopped = "timeout", "", &stoppedAt
	case stepErr != nil:
		status, why, stopped = "error", "relay_unavailable", &stoppedAt
	}
	if status != "executed" {
		// Explicit holds (keyhold, button down) last across actions only while each one ends
		// normally: a stopped action never leaves a key or a button pressed.
		s.releaseHeld()
	}
	a.finishWithShot(ctx, s, req, box, "act", status, why, stopped)
}

// finishWithShot ends a request with a fresh screenshot unless the bridge asked for none or
// control moved to the user meanwhile (the result still says so).
func (a *Agent) finishWithShot(ctx context.Context, s *automation, req automationRequest, box shotBox, kind, status, reason string, stopped *int) {
	if s.isSuspended() {
		return // the gateway that asked is gone, and nobody would receive the picture
	}
	want := req.Screenshot == nil || *req.Screenshot
	a.mu.Lock()
	privacy := a.control.mode == modePrivacy || !a.control.access
	a.mu.Unlock()
	if !want || privacy {
		r := a.result(s, req.ID, kind, status, reason, nil)
		r.StoppedAt = stopped
		s.push(ctx, r)
		return
	}
	// No wait for the desktop here: the request already ran, and its result must not wait for
	// a desktop session that ended meanwhile to come back.
	shot, shotReason := a.captureScreenshot(ctx, s, req.Quality, box, 0, true)
	if shot == nil && status == "executed" && shotReason != "" {
		// The input went in; only the picture is missing. Say which.
		reason = shotReason
	}
	a.deliverShot(ctx, s, req.ID, kind, status, reason, stopped, shot)
}

// --- files -----------------------------------------------------------------------------------

func (a *Agent) automationFile(ctx context.Context, s *automation, req automationRequest) {
	status := func(st string, received int64, reason string, handles []map[string]any) {
		m := map[string]any{"t": "file", "id": req.ID, "status": st}
		if received > 0 {
			m["received"] = received
		}
		if reason != "" {
			m["reason"] = reason
		}
		if handles != nil {
			m["handles"] = handles
		}
		s.push(ctx, m)
	}
	switch req.T {
	case "file_begin":
		if reason := a.beginStore(s, req); reason != "" {
			status("error", 0, reason, nil)
		}
	case "file_chunk":
		s.mu.Lock()
		t := s.transfer
		s.mu.Unlock()
		if t == nil || t.id != req.ID {
			return
		}
		if reason := t.write(protocol.ViewerFrame{File: req.File, Chunk: req.Chunk}); reason != "" {
			s.dropTransfer(t)
			status("error", 0, reason, nil)
			return
		}
		status("progress", t.received, "", nil)
	case "file_end":
		s.mu.Lock()
		t := s.transfer
		if t != nil && t.id == req.ID {
			s.transfer = nil
		} else {
			t = nil
		}
		s.mu.Unlock()
		if t == nil {
			return
		}
		if reason := t.finish(); reason != "" {
			_ = os.RemoveAll(t.dir)
			status("error", 0, reason, nil)
			return
		}
		var handles []map[string]any
		s.mu.Lock()
		for i, name := range t.names {
			h := automationFilePrefix + filepath.Base(t.dir) + "-" + strconv.Itoa(i)
			f := storedFile{handle: h, name: t.files[i].Name, mime: t.files[i].Type, size: t.files[i].Size,
				path: filepath.Join(t.dir, filepath.FromSlash(name)), browserPath: path.Join(a.cfg.UploadBrowserDir, path.Base(t.dir), name)}
			s.stored[h] = f
			s.storedB += f.size
			handles = append(handles, map[string]any{"handle": h, "name": f.name, "size": f.size, "type": f.mime})
		}
		s.mu.Unlock()
		status("done", t.received, "", handles)
	case "file_cancel":
		s.mu.Lock()
		t := s.transfer
		if t != nil && t.id == req.ID {
			s.transfer = nil
		} else {
			t = nil
		}
		s.mu.Unlock()
		if t != nil {
			s.dropTransfer(t)
		}
	}
}

func (s *automation) dropTransfer(t *transfer) {
	s.mu.Lock()
	if s.transfer == t {
		s.transfer = nil
	}
	s.mu.Unlock()
	t.close()
	_ = os.RemoveAll(t.dir)
}

// beginStore starts a transfer into the session's temporary area (no input control needed).
func (a *Agent) beginStore(s *automation, req automationRequest) string {
	if !a.uploadsConfigured() {
		return "unsupported"
	}
	if !transferID.MatchString(req.ID) || req.Action != "store" || len(req.Files) == 0 || len(req.Files) > maxTransferFiles {
		return "invalid"
	}
	var total int64
	for _, m := range req.Files {
		if m.Size < 0 {
			return "invalid"
		}
		total += m.Size
	}
	s.mu.Lock()
	busy := s.transfer != nil
	over := total > maxTransferBytes || s.storedB+total > automationStoredMax || len(s.stored)+len(req.Files) > maxStoredPerSession
	s.mu.Unlock()
	if busy {
		return "busy"
	}
	if over {
		return "too_large"
	}
	if reason := a.checkUploadDir(); reason != "" {
		return reason
	}
	a.pruneUploads()
	t := &transfer{sessionID: "bridge:" + s.id, id: req.ID, action: "store", files: req.Files}
	t.dir = filepath.Join(a.cfg.UploadDir, strconv.FormatInt(time.Now().UnixNano(), 36)+"-"+req.ID)
	for i, m := range req.Files {
		t.names = append(t.names, path.Join(strconv.Itoa(i), safeName(m.Name)))
		if err := os.MkdirAll(filepath.Join(t.dir, strconv.Itoa(i)), 0o755); err != nil {
			_ = os.RemoveAll(t.dir)
			return "write_failed"
		}
	}
	if err := t.open(); err != nil {
		_ = os.RemoveAll(t.dir)
		return "write_failed"
	}
	s.mu.Lock()
	if s.transfer != nil {
		s.mu.Unlock()
		t.close()
		_ = os.RemoveAll(t.dir)
		return "busy"
	}
	s.transfer = t
	s.mu.Unlock()
	return ""
}

// serveAttach delivers stored files to the page. Unlike storing, this changes the browser, so
// it needs input control at the moment it runs, never the permission the upload began with.
func (a *Agent) serveAttach(ctx context.Context, s *automation, req automationRequest) {
	box, ok := screenshotBox(req)
	if !ok {
		s.push(ctx, a.result(s, req.ID, "attach", "rejected", "invalid", nil))
		return
	}
	s.mu.Lock()
	var files []storedFile
	for _, h := range req.Handles {
		f, ok := s.stored[h]
		if !ok {
			s.mu.Unlock()
			s.push(ctx, a.result(s, req.ID, "attach", "rejected", "not_found", nil))
			return
		}
		files = append(files, f)
	}
	s.mu.Unlock()
	if len(files) == 0 || (req.Method != "picker" && req.Method != "paste" && req.Method != "drop") || (req.Method == "drop" && (req.X == nil || req.Y == nil)) {
		s.push(ctx, a.result(s, req.ID, "attach", "rejected", "invalid", nil))
		return
	}
	// The file chooser takes one typed path; several files go one attach at a time.
	if (req.Method == "picker" && len(files) != 1) || (req.Method == "paste" && a.cfg.Clipboard == nil) {
		s.push(ctx, a.result(s, req.ID, "attach", "rejected", "unsupported", nil))
		return
	}
	act := s.admitAction(ctx, req.ID)
	if act == nil {
		s.push(ctx, a.result(s, req.ID, "attach", "rejected", "busy", nil))
		return
	}
	// A drop lands at a point of the screen: refused off it, like an act's step.
	var at []step
	if req.Method == "drop" {
		at = []step{{Type: "move", X: req.X, Y: req.Y}}
	}
	if reason, _ := a.beginAction(ctx, s, act, req, at); reason != "" {
		a.refuseAction(ctx, s, act, req, box, "attach", reason, nil)
		return
	}
	dctx, cancel := context.WithTimeout(act.ctx, attachDeliverLimit)
	defer cancel()
	browserPaths := make([]string, len(files))
	for i, f := range files {
		browserPaths[i] = f.browserPath
	}
	// Input goes through the desktop session the action was admitted on, never s.neko read
	// again: closing the session meanwhile empties that.
	status, why := "executed", ""
	switch req.Method {
	case "picker":
		status, why = a.attachPicker(dctx, s, act.neko, files[0])
	case "paste":
		mime, data := "text/uri-list", fileList(browserPaths)
		if len(files) == 1 && files[0].mime == "image/png" {
			if img, err := os.ReadFile(files[0].path); err == nil {
				mime, data = "image/png", img
			}
		}
		a.quietClipboard()
		err := a.cfg.Clipboard.SetClipboard(dctx, mime, data)
		a.quietClipboard()
		if err != nil {
			status, why = "error", "write_failed"
			break
		}
		if err := a.sendChord(dctx, s, act.neko, []string{"Control", "v"}); err != nil {
			status, why = "error", "relay_unavailable"
		}
	case "drop":
		dropped, err := a.browser.DropFiles(dctx, *req.X, *req.Y, browserPaths)
		if err != nil {
			status, why = "error", "write_failed"
		} else if !dropped {
			status, why = "rejected", "not_on_page"
		}
	}
	if interruption := a.endAction(s, act); interruption != "" {
		status, why = "interrupted", interruption
	}
	if status != "executed" {
		s.releaseHeld()
	}
	a.finishWithShot(ctx, s, req, box, "attach", status, why, nil)
}

// attachPicker hands one stored file to Chrome's own file chooser, the GTK dialog an upload
// button opens: Ctrl+L focuses its location field, the file's path as Chrome sees it is typed,
// Delete drops what GTK's completion appended, and Enter picks the file. neko's own dialog
// handling stays off (desktop.file_chooser_dialog): it would replace file dialogs for the person
// in the live view too. With a FileChooser the dialog must be open before and gone after; without
// one, the keys go to whatever has focus and the screenshot shows what happened.
func (a *Agent) attachPicker(ctx context.Context, s *automation, n AutomationSession, f storedFile) (status, reason string) {
	chooser := a.cfg.FileChooser
	if chooser != nil {
		open, err := chooser.FileChooserOpen(ctx)
		if err != nil {
			a.log.Warn("find the file chooser", "err", err)
			return "error", "relay_unavailable"
		}
		if !open {
			return "rejected", "no_dialog"
		}
	}
	err := a.sendChord(ctx, s, n, []string{"Control", "l"})
	if err == nil {
		err = pace(ctx, clickGap)
	}
	if err == nil {
		err = a.typeText(ctx, s, n, f.browserPath)
	}
	if err == nil {
		err = a.sendChord(ctx, s, n, []string{"Delete"})
	}
	if err == nil {
		err = a.sendChord(ctx, s, n, []string{"Enter"})
	}
	if err != nil {
		return "error", "relay_unavailable"
	}
	if chooser == nil {
		return "executed", ""
	}
	// GTK closes the dialog once it took the file; a dialog still open did not.
	deadline := time.Now().Add(pickerSettle)
	for {
		if open, err := chooser.FileChooserOpen(ctx); err == nil && !open {
			return "executed", ""
		}
		if time.Now().After(deadline) || pace(ctx, 200*time.Millisecond) != nil {
			return "error", "dialog_open"
		}
	}
}

// held is for tests: how many keys and buttons are still held.
func (s *automation) held() (keys, buttons int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.heldKeys), len(s.heldBtns)
}
