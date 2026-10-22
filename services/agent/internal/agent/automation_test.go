package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/protocol"
)

// bridgeNeko is a desktop with one viewer relay and bridge sessions that record what they send.
type bridgeNeko struct {
	viewer *inputSession
	mu     sync.Mutex
	sent   []map[string]any
	events []func(json.RawMessage)
	shot   []byte
	width  int
	height int
	dialog bool
	fed    [][]string
	done   chan struct{}
}

type bridgeSession struct{ n *bridgeNeko }

func protocolIncoming(raw string) protocol.Incoming {
	var in protocol.Incoming
	_ = json.Unmarshal([]byte(raw), &in)
	return in
}

func newBridgeNeko(width, height int) *bridgeNeko {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := range img.Pix {
		img.Pix[i] = 0x80
	}
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80})
	return &bridgeNeko{viewer: &inputSession{done: make(chan struct{}), got: make(chan json.RawMessage, 64)}, shot: buf.Bytes(), width: width, height: height, dialog: true, done: make(chan struct{})}
}

func (n *bridgeNeko) Open(context.Context, string, func(json.RawMessage)) (NekoSession, error) {
	return n.viewer, nil
}

func (n *bridgeNeko) OpenAutomation(_ context.Context, onEvent func(json.RawMessage)) (AutomationSession, error) {
	n.mu.Lock()
	n.events = append(n.events, onEvent)
	n.mu.Unlock()
	init, _ := json.Marshal(map[string]any{"event": "system/init", "payload": map[string]any{"screen_size": map[string]any{"width": n.width, "height": n.height, "rate": 30}}})
	go onEvent(init)
	return bridgeSession{n}, nil
}

func (n *bridgeNeko) resize(width, height int) {
	n.mu.Lock()
	n.width, n.height = width, height
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	n.shot = buf.Bytes()
	events := append([]func(json.RawMessage){}, n.events...)
	n.mu.Unlock()
	msg, _ := json.Marshal(map[string]any{"event": "screen/updated", "payload": map[string]any{"width": width, "height": height, "rate": 30}})
	for _, f := range events {
		f(msg)
	}
}

func (n *bridgeNeko) inputs() []map[string]any {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]map[string]any{}, n.sent...)
}

func (n *bridgeNeko) events_(filter string) []map[string]any {
	var out []map[string]any
	for _, m := range n.inputs() {
		if filter == "" || m["event"] == filter {
			out = append(out, m)
		}
	}
	return out
}

func (s bridgeSession) Send(m json.RawMessage) error {
	var v map[string]any
	_ = json.Unmarshal(m, &v)
	s.n.mu.Lock()
	s.n.sent = append(s.n.sent, v)
	s.n.mu.Unlock()
	return nil
}
func (s bridgeSession) Close()                {}
func (s bridgeSession) Done() <-chan struct{} { return s.n.done }
func (s bridgeSession) Screenshot(context.Context, int) ([]byte, error) {
	s.n.mu.Lock()
	defer s.n.mu.Unlock()
	return s.n.shot, nil
}
func (s bridgeSession) UploadDialog(_ context.Context, paths []string) (bool, error) {
	s.n.mu.Lock()
	defer s.n.mu.Unlock()
	if !s.n.dialog {
		return false, nil
	}
	s.n.fed = append(s.n.fed, paths)
	return true, nil
}

func bridgeAgent(t *testing.T, n *bridgeNeko) (*Agent, *websocket.Conn, *fakeClipboard, string) {
	t.Helper()
	g, srv := newGateway(t)
	c, _, err := websocket.Dial(context.Background(), "ws"+srv.URL[len("http"):]+"/v1/agent", &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Instance-Id": []string{"inst1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	remote := <-g.conns
	dir := t.TempDir()
	clip := &fakeClipboard{}
	a := New(Config{UploadDir: dir, UploadBrowserDir: "/data/uploads", Clipboard: clip}, &fakeBrowser{}, n, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.conn = c
	return a, remote, clip, dir
}

func openReadyBridge(t *testing.T, a *Agent, ctx context.Context, id string) *automation {
	t.Helper()
	a.openAutomation(ctx, id, "client1")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		s := a.automations[id]
		screen := a.screen.version
		a.mu.Unlock()
		if s != nil {
			s.mu.Lock()
			ready := s.ready
			s.mu.Unlock()
			if ready && screen > 0 {
				return s
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("bridge session did not become ready")
	return nil
}

// bridgeResult waits for the result of request `id`, collecting the blob frames before it.
func bridgeResult(t *testing.T, c *websocket.Conn, id string) (map[string]any, map[string][]byte) {
	t.Helper()
	blobs := map[string][]string{}
	for i := 0; i < 200; i++ {
		m := read(t, c)
		if m["t"] != "automation_result" {
			continue
		}
		data := m["data"].(map[string]any)
		switch data["t"] {
		case "blob":
			bid := data["id"].(string)
			blobs[bid] = append(blobs[bid], data["data"].(string))
		case "result":
			if data["id"] != id {
				continue
			}
			out := map[string][]byte{}
			for bid, parts := range blobs {
				joined := ""
				for _, p := range parts {
					joined += p
				}
				raw, err := base64.StdEncoding.DecodeString(joined)
				if err != nil {
					t.Fatalf("blob %s: %v", bid, err)
				}
				out[bid] = raw
			}
			return data, out
		}
	}
	t.Fatalf("no result for %s", id)
	return nil, nil
}

func request(a *Agent, ctx context.Context, session string, v map[string]any) {
	b, _ := json.Marshal(v)
	a.fromAutomation(ctx, session, b)
}

func TestBridgeActClicksAndReturnsTheWholeDisplay(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")

	request(a, ctx, "b1", map[string]any{"t": "status", "id": "s1"})
	status, _ := bridgeResult(t, remote, "s1")
	caps := status["capabilities"].(map[string]any)
	if status["status"] != "executed" || caps["screenshot"] != true || caps["files"] != true || caps["picker"] != true {
		t.Fatalf("status %v", status)
	}
	screen := status["screen"].(map[string]any)
	if screen["width"].(float64) != 64 || screen["height"].(float64) != 48 || screen["version"].(float64) != 1 {
		t.Fatalf("screen %v", screen)
	}

	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a1", "screenVersion": 1, "settleMs": 0, "steps": []map[string]any{
		{"type": "click", "x": 10, "y": 12, "count": 2},
		{"type": "key", "keys": []string{"Control", "l"}},
		{"type": "type", "text": "Hi 你好"},
		{"type": "scroll", "x": 5, "y": 5, "deltaY": 3},
	}})
	r, blobs := bridgeResult(t, remote, "a1")
	if r["status"] != "executed" || r["kind"] != "act" {
		t.Fatalf("act result %v", r)
	}
	shot := r["screenshot"].(map[string]any)
	if shot["width"].(float64) != 64 || shot["height"].(float64) != 48 || shot["mime"] != "image/jpeg" || shot["screenVersion"].(float64) != 1 {
		t.Fatalf("screenshot meta %v", shot)
	}
	if img := blobs[shot["blobId"].(string)]; !bytes.Equal(img, n.shot) || int(shot["bytes"].(float64)) != len(img) {
		t.Fatalf("screenshot bytes differ (%d vs %d)", len(img), len(n.shot))
	}
	control := r["control"].(map[string]any)
	if control["controller"] != "agent" || control["mode"] != "agent" {
		t.Fatalf("control %v", control)
	}
	moves, downs, ups := n.events_("control/move"), n.events_("control/buttondown"), n.events_("control/buttonup")
	if len(moves) < 2 || moves[0]["payload"].(map[string]any)["x"].(float64) != 10 || len(downs) != 2 || len(ups) != 2 {
		t.Fatalf("mouse events: moves=%d downs=%d ups=%d", len(moves), len(downs), len(ups))
	}
	keys := n.events_("control/keydown")
	// Ctrl+L, then "Hi " = Shift+h, i, space; the non-ASCII rest goes through paste.
	if len(keys) < 6 || keys[0]["payload"].(map[string]any)["keysym"].(float64) != 0xffe3 || keys[1]["payload"].(map[string]any)["keysym"].(float64) != 'l' {
		t.Fatalf("keys %v", keys)
	}
	if pastes := n.events_("control/paste"); len(pastes) != 1 || pastes[0]["payload"].(map[string]any)["text"] != "你好" {
		t.Fatalf("paste %v", pastes)
	}
	if scrolls := n.events_("control/scroll"); len(scrolls) != 1 || scrolls[0]["payload"].(map[string]any)["delta_y"].(float64) != -3 {
		t.Fatalf("scroll %v", scrolls)
	}
	s := a.automations["b1"]
	if k, b := s.held(); k != 0 || b != 0 {
		t.Fatalf("held after act: keys=%d buttons=%d", k, b)
	}
}

func TestUserInputTakesOverStopsTheBridgeAndStaysUntilHandedBack(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	s := openReadyBridge(t, a, ctx, "b1")
	openReadyViewer(t, a, ctx, "viewer1", "relay1")

	// A long action: hold Shift, then wait.
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a1", "steps": []map[string]any{
		{"type": "keyhold", "key": "Shift", "down": true}, {"type": "wait", "ms": 4000},
	}})
	readUntil(t, remote, func(m map[string]any) bool { return m["t"] == "control_state" && m["reason"] == "agent_input" })
	deadline := time.Now().Add(time.Second)
	for {
		if k, _ := s.held(); k == 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}

	// While the bridge controls, the viewer's pointer movement is withheld...
	a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"neko","data":{"event":"control/move","payload":{"x":30,"y":31}}}`), "relay1")
	select {
	case m := <-n.viewer.got:
		t.Fatalf("move forwarded: %s", m)
	case <-time.After(50 * time.Millisecond):
	}
	// ...but a click takes over at once: the withheld position first, then the click itself.
	a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"neko","data":{"event":"control/buttondown","payload":{"code":1}}}`), "relay1")
	first, second := <-n.viewer.got, <-n.viewer.got
	if !bytes.Contains(first, []byte(`"control/move"`)) || !bytes.Contains(first, []byte(`"x":30`)) || !bytes.Contains(second, []byte(`buttondown`)) {
		t.Fatalf("takeover order: %s then %s", first, second)
	}
	cs := readUntil(t, remote, func(m map[string]any) bool { return m["t"] == "control_state" && m["reason"] == "user_input" })
	control := cs["control"].(map[string]any)
	if control["controller"] != "user" || control["mode"] != "user" {
		t.Fatalf("control after takeover %v", control)
	}
	r, _ := bridgeResult(t, remote, "a1")
	if r["status"] != "interrupted" || r["reason"] != "control_changed" || r["stoppedAt"].(float64) != 1 {
		t.Fatalf("interrupted result %v", r)
	}
	if k, _ := s.held(); k != 0 {
		t.Fatal("Shift still held after takeover")
	}
	if ups := n.events_("control/keyup"); len(ups) == 0 || ups[len(ups)-1]["payload"].(map[string]any)["keysym"].(float64) != 0xffe1 {
		t.Fatalf("Shift not released: %v", ups)
	}

	// Input from the bridge is refused until the user hands control back; screenshots still work.
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a2", "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "a2"); r["status"] != "rejected" || r["reason"] != "control_user" {
		t.Fatalf("act under user control %v", r)
	}
	time.Sleep(minScreenshotGap)
	request(a, ctx, "b1", map[string]any{"t": "screenshot", "id": "sh1"})
	if r, blobs := bridgeResult(t, remote, "sh1"); r["status"] != "executed" || len(blobs) != 1 {
		t.Fatalf("screenshot under user control %v", r)
	}
	// Reconnecting the bridge does not bypass the takeover.
	a.closeAutomation("b1")
	openReadyBridge(t, a, ctx, "b2")
	request(a, ctx, "b2", map[string]any{"t": "act", "id": "a3", "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "a3"); r["status"] != "rejected" || r["reason"] != "control_user" {
		t.Fatalf("act after reconnect %v", r)
	}
	// The explicit hand-back resumes with a new epoch; the old queue is gone.
	a.applyControl(ctx, modeAgent, nil, "resumed")
	readUntil(t, remote, func(m map[string]any) bool { return m["t"] == "control_state" && m["reason"] == "resumed" })
	epoch := a.control.epoch
	request(a, ctx, "b2", map[string]any{"t": "act", "id": "a4", "controlEpoch": epoch - 1, "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "a4"); r["status"] != "rejected" || r["reason"] != "control_changed" {
		t.Fatalf("stale epoch %v", r)
	}
	request(a, ctx, "b2", map[string]any{"t": "act", "id": "a5", "controlEpoch": epoch, "settleMs": 0, "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "a5"); r["status"] != "executed" {
		t.Fatalf("act after hand-back %v", r)
	}
}

func TestScreenChangeVoidsOldCoordinatesAndPrivacyWithholdsScreenshots(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")

	n.resize(80, 60)
	sc := readUntil(t, remote, func(m map[string]any) bool {
		d, _ := m["data"].(map[string]any)
		return m["t"] == "automation_result" && d["t"] == "screen" && d["screen"].(map[string]any)["version"].(float64) == 2
	})["data"].(map[string]any)["screen"].(map[string]any)
	if sc["version"].(float64) != 2 || sc["width"].(float64) != 80 {
		t.Fatalf("screen update %v", sc)
	}
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "old", "screenVersion": 1, "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "old"); r["status"] != "rejected" || r["reason"] != "screen_changed" {
		t.Fatalf("stale screen %v", r)
	}
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "off", "screenVersion": 2, "steps": []map[string]any{{"type": "click", "x": 500, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "off"); r["status"] != "error" {
		t.Fatalf("off-screen click %v", r)
	}

	a.applyControl(ctx, modePrivacy, nil, "privacy")
	readUntil(t, remote, func(m map[string]any) bool { return m["t"] == "control_state" && m["reason"] == "privacy" })
	time.Sleep(minScreenshotGap)
	request(a, ctx, "b1", map[string]any{"t": "screenshot", "id": "sh"})
	if r, blobs := bridgeResult(t, remote, "sh"); r["status"] != "rejected" || r["reason"] != "control_privacy" || len(blobs) != 0 {
		t.Fatalf("privacy screenshot %v", r)
	}
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "pa", "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "pa"); r["status"] != "rejected" || r["reason"] != "control_privacy" {
		t.Fatalf("privacy act %v", r)
	}
	// Agent access turned off ends the session.
	off := false
	a.applyControl(ctx, "", &off, "revoked")
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.automations) != 0 {
		t.Fatal("bridge session survived revocation")
	}
}

func TestStoredFilesAreAttachedOnlyUnderBridgeControl(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, clip, dir := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")

	// Storing needs no control: it only fills the session's temporary area.
	a.applyControl(ctx, modeUser, nil, "paused")
	request(a, ctx, "b1", map[string]any{"t": "file_begin", "id": "f1", "action": "store",
		"files": []map[string]any{{"name": "report.pdf", "type": "application/pdf", "size": 6}}})
	request(a, ctx, "b1", map[string]any{"t": "file_chunk", "id": "f1", "file": 0, "chunk": base64.StdEncoding.EncodeToString([]byte("%PDF-1"))})
	request(a, ctx, "b1", map[string]any{"t": "file_end", "id": "f1"})
	done := readUntil(t, remote, func(m map[string]any) bool {
		if m["t"] != "automation_result" {
			return false
		}
		d := m["data"].(map[string]any)
		return d["t"] == "file" && d["id"] == "f1" && d["status"] != "progress"
	})["data"].(map[string]any)
	if done["status"] != "done" {
		t.Fatalf("store %v", done)
	}
	handle := done["handles"].([]any)[0].(map[string]any)["handle"].(string)
	matches, _ := filepath.Glob(filepath.Join(dir, "*-f1", "0", "report.pdf"))
	if len(matches) != 1 {
		t.Fatalf("stored file: %v", matches)
	}

	// Attaching changes the page: refused while the user holds control, and the file stays stored.
	request(a, ctx, "b1", map[string]any{"t": "attach", "id": "at1", "handles": []string{handle}, "method": "picker"})
	if r, _ := bridgeResult(t, remote, "at1"); r["status"] != "rejected" || r["reason"] != "control_user" {
		t.Fatalf("attach under user control %v", r)
	}
	if _, err := os.Stat(matches[0]); err != nil {
		t.Fatal("stored file removed by a refused attach")
	}
	a.applyControl(ctx, modeAgent, nil, "resumed")
	request(a, ctx, "b1", map[string]any{"t": "attach", "id": "at2", "handles": []string{handle}, "method": "picker", "screenshot": false})
	if r, _ := bridgeResult(t, remote, "at2"); r["status"] != "executed" {
		t.Fatalf("picker attach %v", r)
	}
	n.mu.Lock()
	fed := n.fed
	n.mu.Unlock()
	if len(fed) != 1 || fed[0][0] != matches[0] {
		t.Fatalf("dialog fed %v", fed)
	}
	n.mu.Lock()
	n.dialog = false
	n.mu.Unlock()
	request(a, ctx, "b1", map[string]any{"t": "attach", "id": "at3", "handles": []string{handle}, "method": "picker", "screenshot": false})
	if r, _ := bridgeResult(t, remote, "at3"); r["status"] != "rejected" || r["reason"] != "no_dialog" {
		t.Fatalf("no dialog %v", r)
	}
	request(a, ctx, "b1", map[string]any{"t": "attach", "id": "at4", "handles": []string{handle}, "method": "paste", "screenshot": false})
	if r, _ := bridgeResult(t, remote, "at4"); r["status"] != "executed" {
		t.Fatalf("paste attach %v", r)
	}
	clip.mu.Lock()
	list := string(clip.data)
	clip.mu.Unlock()
	if clip.mime != "text/uri-list" || !bytes.Contains([]byte(list), []byte("file:///data/uploads/")) {
		t.Fatalf("clipboard %s %q", clip.mime, list)
	}
	if keys := n.events_("control/keydown"); len(keys) < 2 || keys[len(keys)-1]["payload"].(map[string]any)["keysym"].(float64) != 'v' {
		t.Fatalf("no Ctrl+V after paste: %v", keys)
	}
	request(a, ctx, "b1", map[string]any{"t": "attach", "id": "at5", "handles": []string{"nope"}, "method": "drop", "x": 1, "y": 1})
	if r, _ := bridgeResult(t, remote, "at5"); r["status"] != "rejected" || r["reason"] != "not_found" {
		t.Fatalf("unknown handle %v", r)
	}
	// Closing the session removes its files.
	a.closeAutomation("b1")
	if _, err := os.Stat(matches[0]); !os.IsNotExist(err) {
		t.Fatal("stored file survived the session")
	}
}

func TestWelcomeRestoresAPersistedTakeover(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	a.handle(ctx, protocolIncoming(`{"t":"welcome","automation":{"mode":"user","access":true}}`))
	openReadyBridge(t, a, ctx, "b1")
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a1", "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "a1"); r["status"] != "rejected" || r["reason"] != "control_user" {
		t.Fatalf("act after restored takeover %v", r)
	}
}
