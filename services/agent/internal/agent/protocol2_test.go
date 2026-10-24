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
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Automation protocol 2 (protocol.AutomationProtocol), for the gateway's hosted MCP endpoint.

// automationPush waits for a pushed frame of the session (control or screen).
func automationPush(t *testing.T, c *websocket.Conn, kind string) map[string]any {
	t.Helper()
	return readUntil(t, c, func(m map[string]any) bool {
		d, _ := m["data"].(map[string]any)
		return m["t"] == "automation_result" && d["t"] == kind
	})["data"].(map[string]any)
}

// automation_open for a session the VM already has keeps it, files and all, and tells the
// gateway the control state and the screen again.
func TestAutomationOpenKeepsAnExistingSession(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, dir := bridgeAgent(t, n)
	ctx := context.Background()
	s := openReadyBridge(t, a, ctx, "b1")
	handle := storeFile(t, a, remote, "b1", "f1", "notes.txt", []byte("notes"))

	a.openAutomation(ctx, "b1", "client1")
	if control := automationPush(t, remote, "control"); control["reason"] != "restored" {
		t.Fatalf("control push %v", control)
	}
	if screen := automationPush(t, remote, "screen")["screen"].(map[string]any); screen["width"].(float64) != 64 {
		t.Fatalf("screen push %v", screen)
	}
	a.mu.Lock()
	kept := a.automations["b1"] == s
	a.mu.Unlock()
	if !kept || n.opened() != 1 {
		t.Fatalf("session replaced (kept=%v, desktop sessions=%d)", kept, n.opened())
	}
	request(a, ctx, "b1", map[string]any{"t": "attach", "id": "at1", "handles": []string{handle}, "method": "paste", "screenshot": false})
	if r, _ := bridgeResult(t, remote, "at1"); r["status"] != "executed" {
		t.Fatalf("attach after the repeated open %v", r)
	}
	// Another client's open of the same id is a new session; the old one's files go.
	a.openAutomation(ctx, "b1", "client2")
	a.mu.Lock()
	replaced := a.automations["b1"] != s
	a.mu.Unlock()
	if matches, _ := filepath.Glob(filepath.Join(dir, "*-f1")); !replaced || len(matches) != 0 {
		t.Fatalf("another client's open kept the session (replaced=%v, files=%v)", replaced, matches)
	}
}

// A lost tunnel suspends the coding agent's sessions: the running act stops, held input is let
// go, and the desktop session and files stay for automation_open on the next tunnel within the
// grace. After the grace, or when the agent shuts down, sessions close.
func TestALostTunnelSuspendsSessionsForAGrace(t *testing.T) {
	g, srv := newGateway(t)
	n := newBridgeNeko(64, 48)
	dir := t.TempDir()
	a := New(Config{
		InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot", StateDir: t.TempDir(),
		UploadDir: dir, UploadBrowserDir: "/data/uploads", Clipboard: &fakeClipboard{},
	}, &fakeBrowser{ip: "203.0.113.7"}, n, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.suspendGrace = time.Second // the agent reconnects after 0.5 s, then after 1 s
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = a.Run(ctx) }()
	<-g.auths
	c := <-g.conns
	session := func(id string) *automation {
		a.mu.Lock()
		defer a.mu.Unlock()
		return a.automations[id]
	}
	toVM := func(c *websocket.Conn, id string, data map[string]any) {
		send(t, c, map[string]any{"t": "automation", "sessionId": id, "data": data})
	}
	send(t, c, map[string]any{"t": "automation_open", "sessionId": "b1", "clientId": "k1"})
	eventually(t, "the session", func() bool { s := session("b1"); return s != nil && n.opened() == 1 })
	s := session("b1")
	toVM(c, "b1", map[string]any{"t": "file_begin", "id": "f1", "action": "store", "files": []map[string]any{{"name": "a.txt", "type": "text/plain", "size": 1}}})
	toVM(c, "b1", map[string]any{"t": "file_chunk", "id": "f1", "file": 0, "chunk": base64.StdEncoding.EncodeToString([]byte("a"))})
	toVM(c, "b1", map[string]any{"t": "file_end", "id": "f1"})
	toVM(c, "b1", map[string]any{"t": "act", "id": "a1", "steps": []map[string]any{{"type": "keyhold", "key": "Shift", "down": true}, {"type": "wait", "ms": 4000}}})
	eventually(t, "Shift held", func() bool { k, _ := s.held(); return k == 1 })

	c.CloseNow()
	// Held input is let go just after the session is marked suspended.
	eventually(t, "the suspension to let Shift go", func() bool { k, _ := s.held(); return s.isSuspended() && k == 0 })
	if session("b1") != s {
		t.Fatal("the session closed with the tunnel")
	}
	<-g.auths
	c = <-g.conns
	send(t, c, map[string]any{"t": "automation_open", "sessionId": "b1", "clientId": "k1"})
	if control := automationPush(t, c, "control"); control["reason"] != "restored" {
		t.Fatalf("resume %v", control)
	}
	toVM(c, "b1", map[string]any{"t": "act", "id": "a2", "settleMs": 0, "screenshot": false, "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, c, "a2"); r["status"] != "executed" {
		t.Fatalf("act after the resume %v", r)
	}
	if session("b1") != s || n.opened() != 1 {
		t.Fatal("the resumed session is not the same one")
	}
	if matches, _ := filepath.Glob(filepath.Join(dir, "*-f1", "0", "a.txt")); len(matches) != 1 {
		t.Fatal("stored file lost across the tunnel gap")
	}

	// Not opened again within the grace: closed, files and all.
	c.CloseNow()
	eventually(t, "the grace to run out", func() bool { return session("b1") == nil })
	<-g.auths
	c = <-g.conns
	// The files go just after the session leaves the list.
	eventually(t, "the expired session's files to go", func() bool {
		matches, _ := filepath.Glob(filepath.Join(dir, "*-f1"))
		return len(matches) == 0
	})

	// Shutting down closes at once.
	send(t, c, map[string]any{"t": "automation_open", "sessionId": "b2", "clientId": "k1"})
	eventually(t, "the second session", func() bool { return session("b2") != nil })
	cancel()
	eventually(t, "shutdown to close it", func() bool { return session("b2") == nil })
}

// Requests that arrive before the desktop session is ready wait for it; an act waiting for it is
// the session's action, so cancel reaches it.
func TestRequestsWaitForTheDesktop(t *testing.T) {
	n := newBridgeNeko(64, 48)
	gate := make(chan struct{})
	n.gate = gate
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	a.openAutomation(ctx, "b1", "client1")
	request(a, ctx, "b1", map[string]any{"t": "screenshot", "id": "sh1"})
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a1", "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a2", "steps": []map[string]any{{"type": "click", "x": 1, "y": 1}}})
	if r, _ := bridgeResult(t, remote, "a2"); r["status"] != "rejected" || r["reason"] != "busy" {
		t.Fatalf("second act while one waits %v", r)
	}
	eventually(t, "a1 to be the running action", func() bool {
		request(a, ctx, "b1", map[string]any{"t": "status", "id": "st"})
		r, _ := bridgeResult(t, remote, "st")
		return r["activeActionId"] == "a1"
	})
	request(a, ctx, "b1", map[string]any{"t": "cancel", "id": "c1", "actionId": "a1"})
	if r, _ := bridgeResult(t, remote, "a1"); r["status"] != "interrupted" || r["reason"] != "canceled" || r["stoppedAt"].(float64) != 0 {
		t.Fatalf("act canceled while waiting %v", r)
	}
	close(gate)
	if r, blobs := bridgeResult(t, remote, "sh1"); r["status"] != "executed" || len(blobs) != 1 {
		t.Fatalf("screenshot that waited %v", r)
	}
	if downs := n.events_("control/buttondown"); len(downs) != 0 {
		t.Fatal("the canceled act clicked")
	}

	// The wait is bounded.
	n2 := newBridgeNeko(64, 48)
	n2.gate = make(chan struct{})
	a2, remote2, _, _ := bridgeAgent(t, n2)
	a2.readyWait = 100 * time.Millisecond
	a2.openAutomation(ctx, "b2", "client1")
	started := time.Now()
	request(a2, ctx, "b2", map[string]any{"t": "screenshot", "id": "sh2"})
	if r, _ := bridgeResult(t, remote2, "sh2"); r["status"] != "rejected" || r["reason"] != "desktop_unavailable" || time.Since(started) > time.Second {
		t.Fatalf("screenshot without a desktop %v after %v", r, time.Since(started))
	}
}

func decodeShot(t *testing.T, data []byte) image.Image {
	t.Helper()
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

// maxWidth and maxHeight scale the screenshot down to fit, aspect kept, never up; the meta has
// both sizes, and coordinates stay native.
func TestScreenshotsScaleToFitTheRequestedBox(t *testing.T) {
	n := newBridgeNeko(1600, 1000)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")
	request(a, ctx, "b1", map[string]any{"t": "status", "id": "st"})
	r, _ := bridgeResult(t, remote, "st")
	caps := r["capabilities"].(map[string]any)
	if caps["protocol"].(float64) != 2 || caps["scaledShots"] != true || caps["resume"] != true || caps["agentVersion"] != Version {
		t.Fatalf("capabilities %v", caps)
	}
	for _, tc := range []struct {
		id                string
		box               map[string]any
		width, height     int
		native, untouched bool
	}{
		{"w", map[string]any{"maxWidth": 800}, 800, 500, false, false},
		{"wh", map[string]any{"maxWidth": 1000, "maxHeight": 320}, 512, 320, false, false},
		{"big", map[string]any{"maxWidth": 4096, "maxHeight": 4096}, 1600, 1000, true, true},
		{"none", map[string]any{}, 1600, 1000, true, true},
	} {
		time.Sleep(minScreenshotGap)
		req := map[string]any{"t": "screenshot", "id": tc.id, "quality": 60}
		for k, v := range tc.box {
			req[k] = v
		}
		request(a, ctx, "b1", req)
		r, blobs := bridgeResult(t, remote, tc.id)
		meta, _ := r["screenshot"].(map[string]any)
		if r["status"] != "executed" || meta == nil {
			t.Fatalf("%s: %v", tc.id, r)
		}
		if int(meta["width"].(float64)) != tc.width || int(meta["height"].(float64)) != tc.height || meta["screenWidth"].(float64) != 1600 || meta["screenHeight"].(float64) != 1000 {
			t.Fatalf("%s: meta %v", tc.id, meta)
		}
		data := blobs[meta["blobId"].(string)]
		if b := decodeShot(t, data).Bounds(); b.Dx() != tc.width || b.Dy() != tc.height || int(meta["bytes"].(float64)) != len(data) {
			t.Fatalf("%s: image %v (%d bytes)", tc.id, b, len(data))
		}
		if tc.untouched != bytes.Equal(data, n.shot) {
			t.Fatalf("%s: re-encoded=%v", tc.id, !bytes.Equal(data, n.shot))
		}
	}
	for _, bad := range []map[string]any{{"maxWidth": 319}, {"maxHeight": 4097}} {
		req := map[string]any{"t": "screenshot", "id": "bad"}
		for k, v := range bad {
			req[k] = v
		}
		request(a, ctx, "b1", req)
		if r, _ := bridgeResult(t, remote, "bad"); r["status"] != "rejected" || r["reason"] != "invalid" {
			t.Fatalf("bounds %v: %v", bad, r)
		}
	}
	// An act's coordinates are screen pixels whatever size its screenshot is.
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a1", "settleMs": 0, "maxWidth": 800, "steps": []map[string]any{{"type": "click", "x": 1500, "y": 900}}})
	r, _ = bridgeResult(t, remote, "a1")
	if r["status"] != "executed" || r["screenshot"].(map[string]any)["width"].(float64) != 800 {
		t.Fatalf("act %v", r)
	}
	if moves := n.events_("control/move"); len(moves) == 0 || moves[0]["payload"].(map[string]any)["x"].(float64) != 1500 {
		t.Fatalf("click not at the screen point: %v", moves)
	}
}

// Each output pixel is the mean of the screen pixels it covers.
func TestScaleJPEGAveragesAreas(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 400, 100))
	for y := 0; y < 100; y++ {
		for x := 0; x < 400; x++ {
			c := color.RGBA{0, 0, 0, 255}
			if x >= 200 || (x/2+y)%2 == 0 && x >= 100 {
				c = color.RGBA{255, 255, 255, 255}
			}
			src.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, src, &jpeg.Options{Quality: 100})
	out, err := scaleJPEG(buf.Bytes(), 4, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	img := decodeShot(t, out)
	// Black, a half-white checker, white, white.
	for x, want := range []float64{0, 127, 255, 255} {
		r, _, _, _ := img.At(x, 0).RGBA()
		if got := float64(r >> 8); got < want-24 || got > want+24 {
			t.Fatalf("pixel %d: %v, want about %v", x, got, want)
		}
	}
	for _, tc := range []struct {
		box          shotBox
		w, h, ww, wh int
	}{
		{shotBox{1280, 800}, 2560, 1440, 1280, 720},
		{shotBox{1280, 800}, 1366, 768, 1280, 720},
		{shotBox{1280, 800}, 1024, 768, 1024, 768},
		{shotBox{0, 320}, 1920, 1080, 569, 320},
	} {
		if w, h := tc.box.fit(tc.w, tc.h); w != tc.ww || h != tc.wh {
			t.Fatalf("%v fit %dx%d: %dx%d, want %dx%d", tc.box, tc.w, tc.h, w, h, tc.ww, tc.wh)
		}
	}
}

// A screenshot stays a valid basis while only the agent's own claims advance the epoch; once
// control left the agent, it is void. Unknown key names are refused naming the step.
func TestControlEpochVoidsOnlyWhenControlLeftTheAgent(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyBridge(t, a, ctx, "b1")
	openReadyViewer(t, a, ctx, "viewer1", "relay1")
	request(a, ctx, "b1", map[string]any{"t": "screenshot", "id": "sh"})
	r, _ := bridgeResult(t, remote, "sh")
	shot := r["screenshot"].(map[string]any)
	click := []map[string]any{{"type": "click", "x": 1, "y": 1}}
	basis := map[string]any{"screenVersion": shot["screenVersion"], "controlEpoch": shot["controlEpoch"]}
	for _, id := range []string{"a1", "a2"} {
		req := map[string]any{"t": "act", "id": id, "settleMs": 0, "screenshot": false, "steps": click}
		for k, v := range basis {
			req[k] = v
		}
		request(a, ctx, "b1", req)
		if r, _ := bridgeResult(t, remote, id); r["status"] != "executed" {
			t.Fatalf("%s on the first screenshot: %v", id, r)
		}
	}
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a3", "settleMs": 0, "screenshot": false, "screenshotId": shot["id"], "steps": click})
	if r, _ := bridgeResult(t, remote, "a3"); r["status"] != "executed" {
		t.Fatalf("act naming its screenshot %v", r)
	}

	// The user takes over and hands back: the old screenshot is void.
	a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"neko","data":{"event":"control/buttondown","payload":{"code":1}}}`), "relay1")
	a.applyControl(ctx, modeAgent, nil, "resumed")
	req := map[string]any{"t": "act", "id": "a4", "steps": click}
	for k, v := range basis {
		req[k] = v
	}
	request(a, ctx, "b1", req)
	if r, _ := bridgeResult(t, remote, "a4"); r["status"] != "rejected" || r["reason"] != "control_changed" {
		t.Fatalf("act on a screenshot from before the takeover %v", r)
	}
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a5", "screenshotId": shot["id"], "steps": click})
	if r, _ := bridgeResult(t, remote, "a5"); r["status"] != "rejected" || r["reason"] != "control_changed" {
		t.Fatalf("act naming a screenshot from before the takeover %v", r)
	}

	for id, steps := range map[string][]map[string]any{
		"k1": {{"type": "move", "x": 1, "y": 1}, {"type": "key", "keys": []string{"Control", "Hyper"}}},
		"k2": {{"type": "move", "x": 1, "y": 1}, {"type": "keyhold", "key": "NoSuchKey", "down": true}},
		"k3": {{"type": "move", "x": 1, "y": 1}, {"type": "click", "x": 1, "y": 1, "modifiers": []string{"Fn"}}},
	} {
		request(a, ctx, "b1", map[string]any{"t": "act", "id": id, "steps": steps})
		if r, _ := bridgeResult(t, remote, id); r["status"] != "rejected" || r["reason"] != "unknown_key" || r["stoppedAt"].(float64) != 1 {
			t.Fatalf("%s: %v", id, r)
		}
	}
}

// While the user works in the browser (no pause was persisted: no agent was connected when they
// took control), the agent may not claim control until they stop for a while.
func TestAgentMayNotClaimWhileTheUserIsActive(t *testing.T) {
	n := newBridgeNeko(64, 48)
	a, remote, _, _ := bridgeAgent(t, n)
	ctx := context.Background()
	openReadyViewer(t, a, ctx, "viewer1", "relay1")
	a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"neko","data":{"event":"control/keydown","payload":{"keysym":97}}}`), "relay1")
	openReadyBridge(t, a, ctx, "b1")
	a.mu.Lock()
	controller, mode := a.control.controller, a.control.mode
	a.mu.Unlock()
	if controller != ctlUser || mode != modeAgent {
		t.Fatalf("controller %s, mode %s", controller, mode)
	}
	click := []map[string]any{{"type": "click", "x": 1, "y": 1}}
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a1", "steps": click})
	if r, _ := bridgeResult(t, remote, "a1"); r["status"] != "rejected" || r["reason"] != "user_active" {
		t.Fatalf("claim while the user is active %v", r)
	}
	a.mu.Lock()
	a.control.userInputAt = time.Now().Add(-userActiveFor - time.Second)
	a.mu.Unlock()
	request(a, ctx, "b1", map[string]any{"t": "act", "id": "a2", "settleMs": 0, "screenshot": false, "steps": click})
	if r, _ := bridgeResult(t, remote, "a2"); r["status"] != "executed" || r["control"].(map[string]any)["controller"] != "agent" {
		t.Fatalf("claim after the user stopped %v", r)
	}
}
