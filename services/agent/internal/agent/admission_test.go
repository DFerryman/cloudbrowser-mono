package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/neko"
)

type actualRelay struct{ relay *neko.Relay }

func (n actualRelay) Open(ctx context.Context, id string, forward func(json.RawMessage)) (NekoSession, error) {
	s, err := n.relay.Open(ctx, id, forward)
	if err != nil {
		return nil, err
	}
	return s, nil
}
func (n actualRelay) OpenWithProgress(ctx context.Context, id string, forward func(json.RawMessage), progress func(string, string)) (NekoSession, error) {
	s, err := n.relay.OpenWithProgress(ctx, id, forward, progress)
	if err != nil {
		return nil, err
	}
	return s, nil
}

type lockedLogBuffer struct {
	mu   sync.Mutex
	data bytes.Buffer
}

func (b *lockedLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.data.Write(p)
}
func (b *lockedLogBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.data.String() }

// This reproduces the incident's concrete missing timeout: login succeeds, but the local HTTP
// server never upgrades. The agent must still process commands and close the pending attempt.
func TestStalledLocalUpgradeDoesNotBlockCommandsOrClose(t *testing.T) {
	upgrade := make(chan struct{}, 1)
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/login" {
			_, _ = io.WriteString(w, `{"token":"must-not-appear-in-logs"}`)
			return
		}
		upgrade <- struct{}{}
		<-r.Context().Done()
	}))
	t.Cleanup(local.Close)
	g, srv := newGateway(t)
	var logs lockedLogBuffer
	a := New(Config{InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot", StateDir: t.TempDir(), Heartbeat: 15 * time.Millisecond}, &fakeBrowser{ip: "203.0.113.7"}, actualRelay{&neko.Relay{BaseURL: local.URL, Password: "private-password", WebSocketTimeout: time.Second}}, nil, slog.New(slog.NewJSONHandler(&logs, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = a.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	c := <-g.conns
	send(t, c, map[string]any{"t": "welcome", "viewerStages": true})
	readUntil(t, c, func(m map[string]any) bool { return m["kind"] == "ready" })
	send(t, c, map[string]any{"t": "viewer_open", "sessionId": "s1", "relayId": "r1"})
	select {
	case <-upgrade:
	case <-time.After(time.Second):
		t.Fatal("upgrade was not attempted")
	}
	send(t, c, map[string]any{"t": "command", "id": "ip", "kind": "ip_check", "payload": map[string]any{}})
	r := readUntil(t, c, func(m map[string]any) bool { return m["t"] == "reply" })
	if r["commandId"] != "ip" || r["ok"] != true {
		t.Fatalf("command blocked: %v", r)
	}
	readUntil(t, c, func(m map[string]any) bool { return m["kind"] == "heartbeat" })
	send(t, c, map[string]any{"t": "viewer_close", "sessionId": "s1", "relayId": "r1"})
	closed := readUntil(t, c, func(m map[string]any) bool { return m["t"] == "viewer_stage" && m["stage"] == "closed" })
	if closed["code"] != "canceled" {
		t.Fatalf("close stage: %v", closed)
	}
	a.mu.Lock()
	pending := len(a.viewerOpens)
	a.mu.Unlock()
	if pending != 0 {
		t.Fatal("closed open remains pending")
	}
	cancel()
	<-done
	// No more writes after Run and its canceled local attempt have quiesced.
	if strings.Contains(logs.String(), "must-not-appear-in-logs") || strings.Contains(logs.String(), "private-password") || strings.Contains(logs.String(), "token=") {
		t.Fatal("admission telemetry exposed a secret")
	}
}

type delayedOpen struct {
	ctx     context.Context
	forward func(json.RawMessage)
	release chan NekoSession
}
type delayedRelay struct{ calls chan delayedOpen }

func (n delayedRelay) Open(ctx context.Context, _ string, forward func(json.RawMessage)) (NekoSession, error) {
	c := delayedOpen{ctx: ctx, forward: forward, release: make(chan NekoSession, 1)}
	n.calls <- c
	return <-c.release, nil // deliberately late completion, even after cancellation
}

func TestLateOldOpenCannotReplaceNewRelay(t *testing.T) {
	a, _ := inputAgent(t, &inputSession{done: make(chan struct{})})
	n := delayedRelay{calls: make(chan delayedOpen, 2)}
	a.neko = n
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.openViewer(ctx, "s", "old")
	old := <-n.calls
	a.fromViewer(ctx, "s", json.RawMessage(`{"t":"neko","data":{"event":"signal/request"}}`), "old")
	if old.ctx.Err() != nil {
		t.Fatal("early input canceled pending admission")
	}
	a.openViewer(ctx, "s", "new")
	current := <-n.calls
	select {
	case <-old.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("replacement did not cancel old opening")
	}
	newSession := &inputSession{done: make(chan struct{})}
	current.release <- newSession
	waitAdmission(t, a, "s", "new")
	a.closeViewer("s", "old")
	oldSession := &inputSession{done: make(chan struct{})}
	old.forward(json.RawMessage(`{"event":"system/init","stale":true}`))
	old.release <- oldSession
	select {
	case <-oldSession.Done():
	case <-time.After(time.Second):
		t.Fatal("late old session was not closed")
	}
	a.mu.Lock()
	active := a.sessions["s"]
	relay := a.relayIDs["s"]
	a.mu.Unlock()
	if active != newSession || relay != "new" {
		t.Fatal("obsolete completion replaced the current session")
	}
	a.closeSessions()
}

func TestCloseAndDisconnectFencePendingOpen(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		t.Run(map[bool]string{false: "viewer_close", true: "gateway_disconnect"}[disconnect], func(t *testing.T) {
			n := delayedRelay{calls: make(chan delayedOpen, 1)}
			a := New(Config{}, &fakeBrowser{}, n, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a.openViewer(ctx, "s", "r")
			call := <-n.calls
			if disconnect {
				a.closeSessions()
			} else {
				a.closeViewer("s", "r")
			}
			select {
			case <-call.ctx.Done():
			case <-time.After(time.Second):
				t.Fatal("pending open was not canceled")
			}
			s := &inputSession{done: make(chan struct{})}
			call.release <- s
			select {
			case <-s.Done():
			case <-time.After(time.Second):
				t.Fatal("closed opening revived a relay")
			}
			a.mu.Lock()
			active := len(a.sessions) + len(a.viewerOpens)
			a.mu.Unlock()
			if active != 0 {
				t.Fatal("obsolete open retained")
			}
		})
	}
}

func waitAdmission(t *testing.T, a *Agent, id, relay string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		ready := a.sessions[id] != nil && a.relayIDs[id] == relay
		a.mu.Unlock()
		if ready {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("relay was not admitted")
}

type probingRelay struct {
	fakeNeko
	healthy atomic.Bool
	probes  atomic.Int32
}

func (n *probingRelay) Probe(context.Context) error {
	n.probes.Add(1)
	if !n.healthy.Load() {
		return &neko.OpenError{Code: "login_rejected"}
	}
	return nil
}

func TestReadinessWaitsForDesktopAndRetriesWhileHeartbeatContinues(t *testing.T) {
	g, srv := newGateway(t)
	n := &probingRelay{}
	a := New(Config{InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot", StateDir: t.TempDir(), Heartbeat: 10 * time.Millisecond, DesktopProbeRetry: 10 * time.Millisecond}, &fakeBrowser{}, n, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = a.Run(ctx) }()
	c := <-g.conns
	for {
		m := read(t, c)
		if m["kind"] == "ready" {
			t.Fatal("announced ready before desktop probe succeeded")
		}
		if m["kind"] == "heartbeat" {
			data := m["data"].(map[string]any)
			if data["desktopReady"] != false || data["desktopFailureCode"] != "login_rejected" {
				t.Fatalf("unhealthy desktop heartbeat: %v", m)
			}
			break
		}
	}
	n.healthy.Store(true)
	ready := readUntil(t, c, func(m map[string]any) bool { return m["kind"] == "ready" })
	if ready["data"].(map[string]any)["desktopReady"] != true || n.probes.Load() < 2 {
		t.Fatalf("readiness retry missing: %v", ready)
	}
	n.healthy.Store(false)
	a.recheckDesktop(ctx)
	readUntil(t, c, func(m map[string]any) bool {
		if m["kind"] != "heartbeat" {
			return false
		}
		data := m["data"].(map[string]any)
		return data["desktopReady"] == false && data["desktopFailureCode"] == "login_rejected"
	})
	n.healthy.Store(true)
	readUntil(t, c, func(m map[string]any) bool { return m["kind"] == "ready" })
	probesBeforeReconnect := n.probes.Load()
	_ = c.CloseNow()
	c2 := <-g.conns
	readUntil(t, c2, func(m map[string]any) bool { return m["kind"] == "ready" })
	if n.probes.Load() <= probesBeforeReconnect {
		t.Fatal("gateway reconnect skipped desktop probe")
	}
	_ = c2.Close(websocket.StatusNormalClosure, "")
}

func TestLegacyWelcomeDisablesStageFramesAfterNegotiatedReconnect(t *testing.T) {
	g, srv := newGateway(t)
	var logs lockedLogBuffer
	a := New(Config{InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot", StateDir: t.TempDir(), Heartbeat: 10 * time.Millisecond}, &fakeBrowser{}, &fakeNeko{sent: make(chan json.RawMessage, 1)}, nil, slog.New(slog.NewJSONHandler(&logs, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = a.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	c := <-g.conns
	send(t, c, map[string]any{"t": "welcome", "viewerStages": true})
	send(t, c, map[string]any{"t": "viewer_open", "sessionId": "first", "relayId": "r1"})
	stage, viewer := false, false
	for i := 0; i < 30 && (!stage || !viewer); i++ {
		m := read(t, c)
		stage = stage || m["t"] == "viewer_stage"
		viewer = viewer || m["t"] == "viewer"
	}
	if !stage || !viewer {
		t.Fatal("capable gateway did not receive stage and init")
	}
	_ = c.CloseNow()
	legacy := <-g.conns
	// A previously negotiated connection must not leak its capability into this old welcome.
	send(t, legacy, map[string]any{"t": "welcome"})
	send(t, legacy, map[string]any{"t": "viewer_open", "sessionId": "legacy", "relayId": "r2"})
	send(t, legacy, map[string]any{"t": "command", "id": "legacy-ip", "kind": "ip_check", "payload": map[string]any{}})
	gotViewer, reply, hb := false, false, false
	for i := 0; i < 30 && (!gotViewer || !reply || !hb); i++ {
		m := read(t, legacy)
		if m["t"] == "viewer_stage" {
			t.Fatalf("sent an unknown frame to legacy gateway: %v", m)
		}
		gotViewer = gotViewer || m["t"] == "viewer" && m["sessionId"] == "legacy"
		reply = reply || m["t"] == "reply" && m["commandId"] == "legacy-ip"
		hb = hb || m["kind"] == "heartbeat"
	}
	if !gotViewer || !reply || !hb {
		t.Fatal("legacy gateway connection stopped functioning")
	}
	if !strings.Contains(logs.String(), `"sessionId":"legacy"`) || !strings.Contains(logs.String(), `"stage":"received"`) {
		t.Fatal("capability gating removed local stage evidence")
	}
}
