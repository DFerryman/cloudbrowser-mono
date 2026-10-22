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
// remote display (tabs, address bar, dialogs) without touching focus or layout.

// AutomationNeko is implemented by the production relay: a neko session that can also take
// screenshots and feed Chrome's open file dialog.
type AutomationNeko interface {
	OpenAutomation(ctx context.Context, onEvent func(json.RawMessage)) (AutomationSession, error)
}

type AutomationSession interface {
	NekoSession
	// Screenshot is the whole display as JPEG at `quality` (1-100).
	Screenshot(ctx context.Context, quality int) ([]byte, error)
	// UploadDialog hands files (paths on the VM) to Chrome's open file-chooser dialog; false means no dialog is open.
	UploadDialog(ctx context.Context, paths []string) (bool, error)
}

const (
	automationProtocol   = 1
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
)

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
	gatewayCtx   context.Context
	cancel       context.CancelFunc

	mu       sync.Mutex
	neko     AutomationSession
	ready    bool
	failure  string
	heldKeys []int64 // keysyms the bridge holds, in press order
	heldBtns []int64
	active   *activeAction
	lastShot time.Time
	stored   map[string]storedFile
	storedB  int64
	transfer *transfer
	writeMu  sync.Mutex // one goroutine writes this session's frames at a time
	writer   func(ctx context.Context, v any) error
}

type activeAction struct {
	id     string
	cancel context.CancelFunc
	reason string
}

// automationRequest is a contracts AutomationRequest; unknown fields are ignored.
type automationRequest struct {
	T             string              `json:"t"`
	ID            string              `json:"id"`
	ActionID      string              `json:"actionId,omitempty"`
	Quality       int                 `json:"quality,omitempty"`
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
	ID            string `json:"id"`
	BlobID        string `json:"blobId"`
	Mime          string `json:"mime"`
	Bytes         int    `json:"bytes"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
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
	files := a.cfg.UploadDir != "" && a.cfg.UploadBrowserDir != ""
	return map[string]any{
		"protocol": automationProtocol, "agentVersion": Version,
		"screenshot": nekoOK, "files": files,
		"picker": files && nekoOK, "paste": files && a.cfg.Clipboard != nil, "drop": files,
		"touch": false,
	}
}

func (a *Agent) screenNow() screenInfo {
	return screenInfo{Version: a.screen.version, Width: a.screen.width, Height: a.screen.height}
}

// openAutomation admits a bridge session: its neko session is opened in the background and the
// bridge learns the control state and screen as soon as they are known.
func (a *Agent) openAutomation(ctx context.Context, sessionID, clientID string) {
	if sessionID == "" {
		return
	}
	a.closeAutomation(sessionID)
	sctx, cancel := context.WithCancel(ctx)
	s := &automation{id: sessionID, clientID: clientID, gatewayCtx: ctx, cancel: cancel, stored: map[string]storedFile{}, writer: a.write}
	a.mu.Lock()
	a.automations[sessionID] = s
	state := a.controlSnapshot()
	a.mu.Unlock()
	s.push(ctx, map[string]any{"t": "control", "control": state, "reason": "restored"})
	go a.finishAutomationOpen(sctx, s)
}

func (a *Agent) finishAutomationOpen(ctx context.Context, s *automation) {
	n, ok := a.neko.(AutomationNeko)
	if !ok {
		s.mu.Lock()
		s.failure = "unsupported"
		s.mu.Unlock()
		return
	}
	octx, cancel := context.WithTimeout(ctx, automationOpenLimit)
	session, err := n.OpenAutomation(octx, func(msg json.RawMessage) { a.automationEvent(ctx, s, msg) })
	cancel()
	a.mu.Lock()
	current := a.automations[s.id] == s && ctx.Err() == nil
	a.mu.Unlock()
	if err != nil || session == nil || !current {
		if session != nil {
			session.Close()
		}
		s.mu.Lock()
		s.failure = "desktop_unavailable"
		s.mu.Unlock()
		if current {
			a.log.Warn("bridge desktop session", "sessionId", s.id, "code", failureCode(err))
		}
		return
	}
	s.mu.Lock()
	s.neko = session
	s.ready = true
	s.mu.Unlock()
	a.mu.Lock()
	screen := a.screenNow()
	a.mu.Unlock()
	if screen.width() > 0 {
		s.push(ctx, map[string]any{"t": "screen", "screen": screen})
	}
	go func() {
		select {
		case <-ctx.Done():
		case <-session.Done():
			s.mu.Lock()
			s.ready = false
			s.failure = "desktop_unavailable"
			s.mu.Unlock()
			s.interrupt("desktop_unavailable")
		}
	}()
}

func (si screenInfo) width() int { return si.Width }

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
	delete(a.automations, sessionID)
	if s == nil {
		a.mu.Unlock()
		return
	}
	if len(a.automations) == 0 && a.control.controller == ctlAgent {
		a.control.controller = ctlNone
		a.control.epoch++
	}
	a.mu.Unlock()
	s.interrupt("relay_unavailable")
	s.releaseHeld(context.Background())
	s.cancel()
	s.mu.Lock()
	n := s.neko
	s.neko = nil
	s.ready = false
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
	ids := make([]string, 0, len(a.automations))
	for id := range a.automations {
		ids = append(ids, id)
	}
	a.mu.Unlock()
	for _, id := range ids {
		a.closeAutomation(id)
	}
}

// push sends one response frame to the bridge through the gateway.
func (s *automation) push(ctx context.Context, data any) {
	// Serialize with the agent's writer through the session, so blob chunks and their result keep their order.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.pushLocked(ctx, data)
}

func (s *automation) pushLocked(ctx context.Context, data any) {
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

// releaseHeld lets go of every key and button the bridge left pressed (a takeover mid-chord).
func (s *automation) releaseHeld(ctx context.Context) {
	s.mu.Lock()
	keys, btns, n := s.heldKeys, s.heldBtns, s.neko
	s.heldKeys, s.heldBtns = nil, nil
	s.mu.Unlock()
	if n == nil {
		return
	}
	for i := len(keys) - 1; i >= 0; i-- {
		_ = n.Send(nekoEvent("control/keyup", map[string]any{"keysym": keys[i]}))
	}
	for i := len(btns) - 1; i >= 0; i-- {
		_ = n.Send(nekoEvent("control/buttonup", map[string]any{"code": btns[i]}))
	}
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

// checkBasis refuses a coordinate-based request decided on a stale screenshot.
func (a *Agent) checkBasis(req automationRequest) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if req.ScreenVersion != nil && *req.ScreenVersion != a.screen.version {
		return "screen_changed"
	}
	if req.ControlEpoch != nil && *req.ControlEpoch != a.control.epoch {
		return "control_changed"
	}
	return ""
}

func (a *Agent) serveScreenshot(ctx context.Context, s *automation, req automationRequest) {
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
	shot, reason := a.captureScreenshot(ctx, s, req.Quality)
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
func (a *Agent) captureScreenshot(ctx context.Context, s *automation, quality int) (*capturedShot, string) {
	s.mu.Lock()
	n, ready := s.neko, s.ready
	if time.Since(s.lastShot) < minScreenshotGap {
		s.mu.Unlock()
		return nil, "too_fast"
	}
	s.lastShot = time.Now()
	s.mu.Unlock()
	if !ready || n == nil {
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
		id := strconv.FormatInt(time.Now().UnixNano(), 36)
		return &capturedShot{data: data, meta: screenshotMeta{
			ID: id, BlobID: id, Mime: "image/jpeg", Bytes: len(data), Width: cfg.Width, Height: cfg.Height,
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

// beginAction claims input for the bridge and registers the action; empty reason on success.
func (a *Agent) beginAction(ctx context.Context, s *automation, req automationRequest) (context.Context, *activeAction, string) {
	if reason := a.checkBasis(req); reason != "" {
		return nil, nil, reason
	}
	s.mu.Lock()
	if s.active != nil {
		s.mu.Unlock()
		return nil, nil, "busy"
	}
	if !s.ready || s.neko == nil {
		s.mu.Unlock()
		return nil, nil, "desktop_unavailable"
	}
	a.mu.Lock()
	changed, reason := a.claimForBridge()
	if reason != "" {
		a.mu.Unlock()
		s.mu.Unlock()
		return nil, nil, reason
	}
	state := a.controlSnapshot()
	a.lastInputAt = time.Now()
	a.mu.Unlock()
	actx, cancel := context.WithTimeout(ctx, maxActDuration)
	act := &activeAction{id: req.ID, cancel: cancel}
	s.active = act
	s.mu.Unlock()
	if changed {
		a.publishControl(ctx, state, "agent_input")
	}
	return actx, act, ""
}

func (a *Agent) endAction(s *automation, act *activeAction) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	act.cancel()
	if s.active == act {
		s.active = nil
	}
	return act.reason
}

func (a *Agent) serveAct(ctx context.Context, s *automation, req automationRequest) {
	steps, err := parseSteps(req.Steps)
	if err != nil {
		s.push(ctx, a.result(s, req.ID, "act", "rejected", "invalid", nil))
		return
	}
	actx, act, reason := a.beginAction(ctx, s, req)
	if reason != "" {
		s.push(ctx, a.result(s, req.ID, "act", "rejected", reason, nil))
		return
	}
	a.mu.Lock()
	screen := a.screen
	a.mu.Unlock()
	stoppedAt, stepErr := a.runSteps(actx, s, steps, screen)
	settle := defaultSettle
	if req.SettleMs != nil {
		settle = time.Duration(max(0, min(*req.SettleMs, int(maxWaitStep/time.Millisecond)))) * time.Millisecond
	}
	if stepErr == nil && settle > 0 {
		select {
		case <-actx.Done():
		case <-time.After(settle):
		}
	}
	interruption := a.endAction(s, act)
	status, why := "executed", ""
	var stopped *int
	switch {
	case interruption == "canceled":
		status, why, stopped = "interrupted", "canceled", &stoppedAt
	case interruption != "":
		status, why, stopped = "interrupted", interruption, &stoppedAt
	case errors.Is(stepErr, context.DeadlineExceeded) || errors.Is(actx.Err(), context.DeadlineExceeded):
		status, why, stopped = "timeout", "", &stoppedAt
	case stepErr != nil:
		status, why, stopped = "error", "relay_unavailable", &stoppedAt
	}
	a.finishWithShot(ctx, s, req, "act", status, why, stopped)
}

// finishWithShot ends a request with a fresh screenshot unless the bridge asked for none or
// control moved to the user meanwhile (the result still says so).
func (a *Agent) finishWithShot(ctx context.Context, s *automation, req automationRequest, kind, status, reason string, stopped *int) {
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
	shot, shotReason := a.captureScreenshot(ctx, s, req.Quality)
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
	if a.cfg.UploadDir == "" || a.cfg.UploadBrowserDir == "" {
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
	if req.Method == "paste" && a.cfg.Clipboard == nil {
		s.push(ctx, a.result(s, req.ID, "attach", "rejected", "unsupported", nil))
		return
	}
	actx, act, reason := a.beginAction(ctx, s, req)
	if reason != "" {
		s.push(ctx, a.result(s, req.ID, "attach", "rejected", reason, nil))
		return
	}
	dctx, cancel := context.WithTimeout(actx, attachDeliverLimit)
	defer cancel()
	vmPaths, browserPaths := make([]string, len(files)), make([]string, len(files))
	for i, f := range files {
		vmPaths[i], browserPaths[i] = f.path, f.browserPath
	}
	status, why := "executed", ""
	switch req.Method {
	case "picker":
		s.mu.Lock()
		n := s.neko
		s.mu.Unlock()
		ok, err := n.UploadDialog(dctx, vmPaths)
		if err != nil {
			status, why = "error", "relay_unavailable"
		} else if !ok {
			status, why = "rejected", "no_dialog"
		}
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
		s.mu.Lock()
		n := s.neko
		s.mu.Unlock()
		if err := a.sendChord(dctx, s, n, []string{"Control", "v"}); err != nil {
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
	a.finishWithShot(ctx, s, req, "attach", status, why, nil)
}

// bridgeHeldReset is for tests: whether anything is still held.
func (s *automation) held() (keys, buttons int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.heldKeys), len(s.heldBtns)
}
