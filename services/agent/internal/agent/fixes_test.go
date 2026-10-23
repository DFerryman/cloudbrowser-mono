package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/neko"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/protocol"
)

// eventually waits up to two seconds for cond.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// bridgeRelay is the production relay with the bridge's desktop sessions (cmd/agent's adapter).
type bridgeRelay struct{ actualRelay }

func (n bridgeRelay) OpenAutomation(ctx context.Context, onEvent func(json.RawMessage)) (AutomationSession, error) {
	s, err := n.relay.OpenAutomation(ctx, onEvent)
	if err != nil {
		return nil, err
	}
	return s, nil
}

// The automation's desktop session lives until the session closes. Its opening is bounded, but
// the relay ends a session with the context it was opened with: canceling that context once the
// open returned left every request without a desktop (desktop_unavailable in production).
func TestBridgeDesktopSessionOutlivesItsOpening(t *testing.T) {
	inputs := make(chan map[string]any, 64)
	logouts := make(chan string, 4)
	shot := newBridgeNeko(64, 48).shot
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/login":
			_, _ = io.WriteString(w, `{"token":"bridge-token"}`)
		case "/api/logout":
			logouts <- r.Header.Get("Authorization")
		case "/api/room/screen/shot.jpg":
			_, _ = w.Write(shot)
		case "/api/ws":
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"event":"system/init","payload":{"screen_size":{"width":64,"height":48,"rate":30}}}`))
			for {
				_, data, err := c.Read(r.Context())
				if err != nil {
					return
				}
				var m map[string]any
				_ = json.Unmarshal(data, &m)
				inputs <- m
			}
		}
	}))
	defer local.Close()
	g, srv := newGateway(t)
	c, _, err := websocket.Dial(context.Background(), "ws"+srv.URL[len("http"):]+"/v1/agent", &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Instance-Id": []string{"inst1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	remote := <-g.conns
	relay := bridgeRelay{actualRelay{&neko.Relay{BaseURL: local.URL, Username: "agent", Password: "pw"}}}
	a := New(Config{}, &fakeBrowser{}, relay, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.conn = c
	a.openLimit = 100 * time.Millisecond
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")
	time.Sleep(3 * a.openLimit) // past the bound on the opening

	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a1", "settleMs": 0, "steps": []map[string]any{{"type": "click", "x": 3, "y": 4}}})
	r, blobs := bridgeResult(t, remote, "a1")
	if r["status"] != "executed" || len(blobs) != 1 {
		t.Fatalf("act on the bridge's desktop session %v", r)
	}
	for {
		select {
		case m := <-inputs:
			if m["event"] != "control/buttondown" {
				continue
			}
		case <-time.After(2 * time.Second):
			t.Fatal("the click never reached neko")
		}
		break
	}
	select {
	case <-logouts:
		t.Fatal("logged out while the session lasts")
	default:
	}
	a.closeAutomation("b1")
	select {
	case auth := <-logouts:
		if auth != "Bearer bridge-token" {
			t.Fatalf("logout with %q", auth)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the closed session was not logged out")
	}
}

// Neko messages too large for the gateway are dropped (the tunnel survives), and a viewer whose
// context ended cannot close the tunnel by writing.
func TestViewerFramesNeverCloseTheTunnel(t *testing.T) {
	logs := &lockedLogBuffer{}
	a, remote := inputAgent(t, &inputSession{done: make(chan struct{})})
	a.log = slog.New(slog.NewTextHandler(logs, nil))
	vctx, cancel := context.WithCancel(context.Background())
	p := &viewerOpen{ctx: vctx, gatewayCtx: context.Background(), cancel: cancel, sessionID: "v1", relayID: "r1"}

	big := `{"event":"clipboard/updated","payload":{"text":"` + strings.Repeat("x", maxViewerMessage) + `"}}`
	a.forwardViewer(p, json.RawMessage(big))
	// Within the message limit, but past the frame limit once escaped for the frame.
	escaped := `{"event":"clipboard/updated","payload":{"text":"` + strings.Repeat("<", 100<<10) + `"}}`
	a.forwardViewer(p, json.RawMessage(escaped))
	if !strings.Contains(logs.String(), "clipboard/updated") || strings.Contains(logs.String(), "xxxx") {
		t.Fatalf("drop log: %.200s", logs.String())
	}
	// The viewer closes: what it still forwards must not take the tunnel down.
	cancel()
	for i := 0; i < 20; i++ {
		a.forwardViewer(p, json.RawMessage(`{"event":"cursor/position","payload":{"x":1}}`))
	}
	for i := 0; i < 20; i++ {
		m := read(t, remote)
		if m["t"] != "viewer" || !strings.Contains(string(mustJSON(m["data"])), "cursor/position") {
			t.Fatalf("frame %d: %v", i, m)
		}
	}
	if err := a.write(context.Background(), protocol.Event{T: "event", Kind: "heartbeat"}); err != nil {
		t.Fatalf("tunnel closed: %v", err)
	}
	if m := read(t, remote); m["kind"] != "heartbeat" {
		t.Fatalf("after the viewer frames %v", m)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// An act that ends normally keeps its explicit holds for the next one; one that is canceled or
// interrupted releases every key and button held.
func TestStoppedActionsReleaseHeldInput(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	s := openReadyBridge(t, a, ctx, "b1")

	request(a, ctx, "b1", map[string]any{"t": "act", "id": "h1", "settleMs": 0, "screenshot": false, "steps": []map[string]any{
		{"type": "keyhold", "key": "Shift", "down": true},
	}})
	if r, _ := bridgeResult(t, remote, "h1"); r["status"] != "executed" {
		t.Fatalf("hold %v", r)
	}
	if k, _ := s.held(); k != 1 {
		t.Fatal("a normally ended act released its explicit hold")
	}
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "h2", "steps": []map[string]any{
		{"type": "button", "x": 1, "y": 1, "down": true}, {"type": "wait", "ms": 4000},
	}})
	eventually(t, "the button held", func() bool { _, b := s.held(); return b == 1 })
	request(a, ctx, "b1", map[string]any{"t": "cancel", "id": "c1", "actionId": "h2"})
	r, _ := bridgeResult(t, remote, "h2")
	if r["status"] != "interrupted" || r["reason"] != "canceled" || r["stoppedAt"].(float64) != 1 {
		t.Fatalf("canceled act %v", r)
	}
	if k, b := s.held(); k != 0 || b != 0 {
		t.Fatalf("held after cancel: keys=%d buttons=%d", k, b)
	}
	if ups := n.events_("control/keyup"); len(ups) != 1 || ups[0]["payload"].(map[string]any)["keysym"].(float64) != 0xffe1 {
		t.Fatalf("Shift not released: %v", ups)
	}
	if ups := n.events_("control/buttonup"); len(ups) != 1 {
		t.Fatalf("button not released: %v", ups)
	}

	// A screen change interrupts too.
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "h3", "steps": []map[string]any{
		{"type": "keyhold", "key": "Alt", "down": true}, {"type": "wait", "ms": 4000},
	}})
	eventually(t, "Alt held", func() bool { k, _ := s.held(); return k == 1 })
	n.resize(80, 60)
	r, _ = bridgeResult(t, remote, "h3")
	if r["status"] != "interrupted" || r["reason"] != "screen_changed" {
		t.Fatalf("act during a screen change %v", r)
	}
	if k, _ := s.held(); k != 0 {
		t.Fatal("Alt still held after the screen changed")
	}
}

// failingSession fails the keydown of one keysym.
type failingSession struct {
	mu     sync.Mutex
	failOn int64
	sent   []string
}

func (f *failingSession) Send(m json.RawMessage) error {
	var v struct {
		Event   string `json:"event"`
		Payload struct {
			Keysym int64 `json:"keysym"`
		} `json:"payload"`
	}
	_ = json.Unmarshal(m, &v)
	f.mu.Lock()
	defer f.mu.Unlock()
	if v.Event == "control/keydown" && v.Payload.Keysym == f.failOn {
		return errors.New("neko gone")
	}
	f.sent = append(f.sent, strings.TrimPrefix(v.Event, "control/")+":"+string(rune(v.Payload.Keysym&0xff)))
	return nil
}
func (f *failingSession) Close()                {}
func (f *failingSession) Done() <-chan struct{} { return nil }

// A chord or a typed character whose key could not go down releases the keys it pressed.
func TestChordsAndTypingReleaseTheirOwnPresses(t *testing.T) {
	a := New(Config{}, &fakeBrowser{}, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx := context.Background()
	s := &automation{}
	f := &failingSession{failOn: 'x'}
	if err := a.sendChord(ctx, s, f, []string{"Control", "Alt", "x"}); err == nil {
		t.Fatal("chord succeeded")
	}
	if k, _ := s.held(); k != 0 || len(f.sent) != 4 || !strings.HasPrefix(f.sent[2], "keyup") || !strings.HasPrefix(f.sent[3], "keyup") {
		t.Fatalf("chord left keys held: %v", f.sent)
	}
	f = &failingSession{failOn: 'B'}
	if err := a.typeText(ctx, s, f, "aB"); err == nil {
		t.Fatal("typing succeeded")
	}
	if k, _ := s.held(); k != 0 || f.sent[len(f.sent)-1] != "keyup:"+string(rune(0xe1)) {
		t.Fatalf("Shift left held: %v", f.sent)
	}
}

// Closing the session while a picker attach runs ends the attach; it never touches the closed
// session's emptied desktop.
func TestClosingTheSessionDuringAnAttach(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")
	handle := storeFile(t, a, remote, "b1", "f1", "photo.jpg", []byte("jpeg"))
	var once sync.Once
	n.mu.Lock()
	n.onChooser = func() { once.Do(func() { a.closeAutomation("b1") }) }
	n.mu.Unlock()
	request(a, ctx, "b1", map[string]any{"t": "attach", "id": "at1", "handles": []string{handle}, "method": "picker"})
	if r, _ := bridgeResult(t, remote, "at1"); r["status"] != "interrupted" || r["reason"] != "relay_unavailable" {
		t.Fatalf("attach on a closed session %v", r)
	}
}

// storeFile stores one file in a bridge session and returns its handle.
func storeFile(t *testing.T, a *Agent, remote *websocket.Conn, session, id, name string, data []byte) string {
	t.Helper()
	ctx := context.Background()
	request(a, ctx, session, map[string]any{"t": "file_begin", "id": id, "action": "store",
		"files": []map[string]any{{"name": name, "type": "application/octet-stream", "size": len(data)}}})
	request(a, ctx, session, map[string]any{"t": "file_chunk", "id": id, "file": 0, "chunk": base64.StdEncoding.EncodeToString(data)})
	request(a, ctx, session, map[string]any{"t": "file_end", "id": id})
	done := readUntil(t, remote, func(m map[string]any) bool {
		d, _ := m["data"].(map[string]any)
		return m["t"] == "automation_result" && d["t"] == "file" && d["id"] == id && d["status"] != "progress"
	})["data"].(map[string]any)
	if done["status"] != "done" {
		t.Fatalf("store %v", done)
	}
	return done["handles"].([]any)[0].(map[string]any)["handle"].(string)
}

// The picker takes one file at a time and reports a file chooser that did not take it.
func TestPickerAttachTakesOneFileAndChecksTheDialog(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")
	h1 := storeFile(t, a, remote, "b1", "f1", "a.txt", []byte("a"))
	h2 := storeFile(t, a, remote, "b1", "f2", "b.txt", []byte("b"))
	request(a, ctx, "b1", map[string]any{"t": "attach", "id": "two", "handles": []string{h1, h2}, "method": "picker"})
	if r, _ := bridgeResult(t, remote, "two"); r["status"] != "rejected" || r["reason"] != "unsupported" {
		t.Fatalf("picker with two files %v", r)
	}
	n.mu.Lock()
	n.stuck = true
	n.mu.Unlock()
	request(a, ctx, "b1", map[string]any{"t": "attach", "id": "stuck", "handles": []string{h1}, "method": "picker", "screenshot": false})
	if r, _ := bridgeResult(t, remote, "stuck"); r["status"] != "error" || r["reason"] != "dialog_open" {
		t.Fatalf("file chooser that stayed open %v", r)
	}
	if !strings.Contains(string(mustJSON(n.inputs())), `"keysym":65293`) {
		t.Fatal("no Enter typed into the file chooser")
	}
	request(a, ctx, "b1", map[string]any{"t": "status", "id": "st"})
	r, _ := bridgeResult(t, remote, "st")
	if caps := r["capabilities"].(map[string]any); caps["picker"] != true {
		t.Fatalf("capabilities %v", caps)
	}
}

// Files are written only into the agent's own upload directory: a symlink in its place, a file
// or a directory someone else owns turns transfers off, and nothing behind it is pruned.
func TestUploadDirectoryMustBeTheAgentsOwn(t *testing.T) {
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	cases := map[string]func(t *testing.T, dir string){
		"symlink": func(t *testing.T, dir string) {
			target := t.TempDir()
			old := filepath.Join(target, "old-upload")
			if err := os.WriteFile(old, []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
			past := time.Now().Add(-48 * time.Hour)
			_ = os.Chtimes(old, past, past)
			if err := os.Symlink(target, dir); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if _, err := os.Stat(old); err != nil {
					t.Error("the symlink's target was pruned")
				}
			})
		},
		"file": func(t *testing.T, dir string) {
			if err := os.WriteFile(dir, nil, 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"foreign owner": func(t *testing.T, dir string) {
			if os.Geteuid() != 0 {
				t.Skip("needs root to give the directory away")
			}
			if err := os.Mkdir(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Chown(dir, 4242, 4242); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "uploads")
			setup(t, dir)
			a := New(Config{UploadDir: dir, UploadBrowserDir: "/data/uploads", Clipboard: &fakeClipboard{}}, &fakeBrowser{}, nil, nil, quiet)
			if reason := a.checkUploadDir(); reason != "unsupported" {
				t.Fatalf("check %q", reason)
			}
			if a.uploadsConfigured() || a.capabilities()["files"] != false {
				t.Fatal("transfers still on")
			}
			// A viewer's transfer is refused before anything is pruned or written.
			x, y := 1, 1
			if reason := a.beginTransfer("v1", "r1", protocol.ViewerFrame{ID: "t1", Action: "drop", X: &x, Y: &y, Files: []protocol.FileMeta{{Name: "a", Size: 1}}}); reason != "unsupported" {
				t.Fatalf("transfer %q", reason)
			}
		})
	}
	// A missing directory is made, owned by the agent.
	dir := filepath.Join(t.TempDir(), "uploads")
	a := New(Config{UploadDir: dir, UploadBrowserDir: "/data/uploads"}, &fakeBrowser{}, nil, nil, quiet)
	if reason := a.checkUploadDir(); reason != "" {
		t.Fatalf("fresh directory %q", reason)
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		t.Fatalf("upload directory not made: %v", err)
	}
}

// The welcome keeps the stricter of the VM's mode and the persisted one; only an explicit
// automation_control relaxes it.
func TestWelcomeKeepsTheStricterLocalMode(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")
	openReadyViewer(t, a, ctx, "viewer1", "relay1")
	isState := func(reason string) func(map[string]any) bool {
		return func(m map[string]any) bool { return m["t"] == "control_state" && m["reason"] == reason }
	}
	// A takeover whose control_state the gateway never persisted (the tunnel dropped).
	a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"neko","data":{"event":"control/keydown","payload":{"keysym":97}}}`), "relay1")
	readUntil(t, remote, isState("user_input"))
	a.handle(ctx, protocolIncoming(`{"t":"welcome","automation":{"mode":"agent","access":true}}`))
	cs := readUntil(t, remote, func(m map[string]any) bool { return m["t"] == "control_state" })
	if cs["reason"] != "user_input" || cs["control"].(map[string]any)["mode"] != "user" {
		t.Fatalf("welcome undid the takeover: %v", cs)
	}
	a.applyControl(ctx, modePrivacy, nil, "privacy")
	readUntil(t, remote, isState("privacy"))
	a.handle(ctx, protocolIncoming(`{"t":"welcome","automation":{"mode":"user","access":true}}`))
	cs = readUntil(t, remote, func(m map[string]any) bool { return m["t"] == "control_state" })
	if cs["reason"] != "restored" || cs["control"].(map[string]any)["mode"] != "privacy" {
		t.Fatalf("welcome relaxed privacy: %v", cs)
	}
	a.handle(ctx, protocolIncoming(`{"t":"automation_control","mode":"agent"}`))
	cs = readUntil(t, remote, func(m map[string]any) bool { return m["t"] == "control_state" })
	if cs["reason"] != "resumed" || cs["control"].(map[string]any)["mode"] != "agent" {
		t.Fatalf("explicit hand-back %v", cs)
	}
}

// When neko ends the bridge's desktop session, the running act stops and the session is opened
// again with backoff while the bridge session lasts.
func TestBridgeDesktopSessionIsOpenedAgain(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	a.reopenDelays = []time.Duration{20 * time.Millisecond, 40 * time.Millisecond}
	ctx := context.Background()
	s := openReadyBridge(t, a, ctx, "b1")
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a1", "steps": []map[string]any{
		{"type": "keyhold", "key": "Shift", "down": true}, {"type": "wait", "ms": 4000},
	}})
	eventually(t, "Shift held", func() bool { k, _ := s.held(); return k == 1 })
	n.endDesktop()
	r, _ := bridgeResult(t, remote, "a1")
	if r["status"] != "interrupted" || r["reason"] != "desktop_unavailable" {
		t.Fatalf("act when neko ended %v", r)
	}
	eventually(t, "the desktop session opened again", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return n.opened() == 2 && s.ready
	})
	// The Shift the lost session could not release is released through the new one.
	if k, _ := s.held(); k != 0 {
		t.Fatal("Shift still held")
	}
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a2", "settleMs": 0, "screenshot": false, "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "a2"); r["status"] != "executed" {
		t.Fatalf("act on the new desktop session %v", r)
	}
	// It keeps trying while neko is away, and stops when the session closes.
	n.mu.Lock()
	n.gate = make(chan struct{})
	n.mu.Unlock()
	n.endDesktop()
	time.Sleep(100 * time.Millisecond)
	a.closeAutomation("b1")
	time.Sleep(100 * time.Millisecond)
	if got := n.opened(); got != 2 {
		t.Fatalf("opened %d desktop sessions after the bridge session closed", got)
	}
}

// An act that cannot finish within the limit is refused before any of it runs.
func TestActionsTooLongAreRefusedUpFront(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")
	waits := []map[string]any{}
	for range 6 {
		waits = append(waits, map[string]any{"type": "wait", "ms": 5000})
	}
	drag := []map[string]any{}
	for range 30 {
		path := []map[string]any{}
		for i := range 64 {
			path = append(path, map[string]any{"x": i % 60, "y": 1})
		}
		drag = append(drag, map[string]any{"type": "drag", "path": path})
	}
	for id, steps := range map[string][]map[string]any{
		"typing": {{"type": "type", "text": strings.Repeat("a", 3000)}},
		"waits":  waits,
		"settle": waits[:5],
		"drags":  drag,
	} {
		req := map[string]any{"t": "act", "id": id, "steps": steps}
		if id == "settle" {
			req["settleMs"] = 5000
		}
		request(a, ctx, "b1", req)
		if r, _ := bridgeResult(t, remote, id); r["status"] != "rejected" || r["reason"] != "too_long" {
			t.Fatalf("%s: %v", id, r)
		}
	}
	if sent := n.inputs(); len(sent) != 0 {
		t.Fatalf("a refused act sent input: %v", sent[0])
	}
	// What fits runs.
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "fits", "settleMs": 0, "screenshot": false, "steps": []map[string]any{{"type": "type", "text": "hello"}}})
	if r, _ := bridgeResult(t, remote, "fits"); r["status"] != "executed" {
		t.Fatalf("short act %v", r)
	}
}

// Control changes from the user, the api and the bridge at once are race free (go test -race).
func TestControlChangesAreRaceFree(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	go func() {
		for {
			if _, _, err := remote.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")
	openReadyViewer(t, a, ctx, "viewer1", "relay1")
	var wg sync.WaitGroup
	for i := range 10 {
		wg.Add(3)
		go func() {
			defer wg.Done()
			access := i%2 == 0
			a.applyControl(ctx, modeAgent, &access, "resumed")
		}()
		go func() {
			defer wg.Done()
			a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"neko","data":{"event":"control/buttondown","payload":{"code":1}}}`), "relay1")
		}()
		go func() {
			defer wg.Done()
			a.restoreControl(ctx, modeUser, true)
		}()
	}
	wg.Wait()
}

// lockedFirewall records the modes it was set to.
type lockedFirewall struct {
	mu    sync.Mutex
	modes []string
}

func (f *lockedFirewall) SetMode(m string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.modes = append(f.modes, m)
	return nil
}

func (f *lockedFirewall) got() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.modes, ",")
}

// scriptedBrowser answers IP checks from a script: an address list, or an error when empty.
type scriptedBrowser struct {
	fakeBrowser
	mu      sync.Mutex
	answers [][]string
	calls   int
	hold    chan struct{}
}

func (b *scriptedBrowser) ObservedIPs(ctx context.Context, _ []string) ([]string, error) {
	b.mu.Lock()
	b.calls++
	hold := b.hold
	var answer []string
	if len(b.answers) > 0 {
		answer, b.answers = b.answers[0], b.answers[1:]
	}
	b.mu.Unlock()
	if hold != nil {
		<-hold
	}
	if answer == nil {
		return nil, errors.New("echo timed out")
	}
	return answer, nil
}

// IP checks close the firewall on evidence: an address other than the expected one at once,
// checks that see nothing only after three in a row; a check that passes opens it again.
func TestIPChecksCloseTheFirewallOnlyOnEvidence(t *testing.T) {
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	newAgent := func(cfg Config, answers ...[]string) (*Agent, *scriptedBrowser, *lockedFirewall) {
		b := &scriptedBrowser{answers: answers}
		fw := &lockedFirewall{}
		a, _ := inputAgent(t, &inputSession{done: make(chan struct{})}) // a tunnel for events and replies
		cfg.InstanceID = "inst1"
		a.cfg, a.browser, a.firewall, a.log = cfg, b, fw, quiet
		return a, b, fw
	}
	ok := []string{"203.0.113.7"}
	other := []string{"192.0.2.1"}
	metadata := Config{PublicIP: func(context.Context) (string, error) { return "203.0.113.7", nil }}

	a, _, fw := newAgent(metadata, nil, nil, ok, nil, nil, nil)
	for i, want := range []string{"", "", "", "", "", "closed"} {
		a.selfCheck(ctx)
		if fw.got() != want {
			t.Fatalf("after check %d: firewall %q, want %q", i+1, fw.got(), want)
		}
	}

	// The instance metadata names the address: another one closes at once, a pass opens again.
	a, _, fw = newAgent(metadata, other, ok, ok)
	a.selfCheck(ctx)
	a.selfCheck(ctx)
	a.selfCheck(ctx)
	if fw.got() != "closed,normal" {
		t.Fatalf("firewall %q", fw.got())
	}

	// The engine's address wins over the metadata's; what the engine closes stays closed.
	a, _, fw = newAgent(metadata, []string{"198.51.100.4"}, []string{"198.51.100.4"}, ok, []string{"198.51.100.4"})
	a.command(ctx, protocol.Incoming{T: "command", ID: "c1", Kind: protocol.CmdIPCheck, Payload: map[string]any{"expected": "198.51.100.4"}})
	a.command(ctx, protocol.Incoming{T: "command", ID: "c2", Kind: protocol.CmdSetFirewall, Payload: map[string]any{"mode": "closed"}})
	a.selfCheck(ctx)
	if fw.got() != "closed" {
		t.Fatalf("a pass opened what the engine closed: %q", fw.got())
	}
	a.selfCheck(ctx) // the metadata's address is not the engine's: a mismatch, already closed
	a.command(ctx, protocol.Incoming{T: "command", ID: "c3", Kind: protocol.CmdSetFirewall, Payload: map[string]any{"mode": "normal"}})
	a.selfCheck(ctx)
	if fw.got() != "closed,normal" {
		t.Fatalf("firewall %q", fw.got())
	}

	// One check at a time.
	a, b, _ := newAgent(metadata, ok, ok)
	b.hold = make(chan struct{})
	done := make(chan struct{})
	go func() { a.selfCheck(ctx); close(done) }()
	eventually(t, "the first check", func() bool { b.mu.Lock(); defer b.mu.Unlock(); return b.calls == 1 })
	a.selfCheck(ctx)
	close(b.hold)
	<-done
	if b.calls != 1 {
		t.Fatalf("%d checks ran at once", b.calls)
	}
}
