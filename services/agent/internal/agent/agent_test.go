package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fakeBrowser struct {
	mu       sync.Mutex
	ip       string
	closed   int
	inserted []string
}

func (b *fakeBrowser) Start(context.Context) (int, error) { return 141, nil }
func (b *fakeBrowser) Close(context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed++
	return nil
}
func (b *fakeBrowser) ObservedIPs(context.Context, []string) ([]string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return []string{b.ip}, nil
}
func (b *fakeBrowser) InsertText(_ context.Context, t string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.inserted = append(b.inserted, t)
	return nil
}

type fakeFirewall struct{ modes []string }

func (f *fakeFirewall) SetMode(m string) error { f.modes = append(f.modes, m); return nil }

type fakeNeko struct{ sent chan json.RawMessage }

type fakeNekoSession struct{ n *fakeNeko }

func (s fakeNekoSession) Send(m json.RawMessage) error { s.n.sent <- m; return nil }
func (s fakeNekoSession) Close()                       {}
func (n *fakeNeko) Open(_ context.Context, _ string, toViewer func(json.RawMessage)) (NekoSession, error) {
	go toViewer(json.RawMessage(`{"event":"system/init"}`))
	return fakeNekoSession{n}, nil
}

// gateway plays the session gateway: it records the Authorization header of each connection and
// hands every connection to the test.
type gateway struct {
	auths chan string
	conns chan *websocket.Conn
}

func newGateway(t *testing.T) (*gateway, *httptest.Server) {
	g := &gateway{auths: make(chan string, 4), conns: make(chan *websocket.Conn, 4)}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent" || r.Header.Get("X-Instance-Id") != "inst1" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		g.auths <- r.Header.Get("Authorization")
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		g.conns <- c
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	return g, srv
}

func read(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	return m
}

// readUntil skips frames until one matches.
func readUntil(t *testing.T, c *websocket.Conn, match func(map[string]any) bool) map[string]any {
	t.Helper()
	for i := 0; i < 20; i++ {
		if m := read(t, c); match(m) {
			return m
		}
	}
	t.Fatal("frame not found")
	return nil
}

func send(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestAgentLifecycle(t *testing.T) {
	g, srv := newGateway(t)
	dir := t.TempDir()
	browser := &fakeBrowser{ip: "203.0.113.7"}
	fw := &fakeFirewall{}
	nk := &fakeNeko{sent: make(chan json.RawMessage, 4)}
	a := New(Config{
		InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot",
		StateDir: dir, EchoURLs: []string{"https://echo.test"}, ExpectedIP: "203.0.113.7", Generation: 1,
		Heartbeat: 50 * time.Millisecond,
	}, browser, nk, fw, slog.New(slog.NewTextHandler(io.Discard, nil)))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = a.Run(ctx) }()

	// First connect uses the bootstrap token; the gateway answers with the long-lived credential.
	if got := <-g.auths; got != "Bootstrap boot" {
		t.Fatalf("auth = %q", got)
	}
	c := <-g.conns
	send(t, c, map[string]any{"t": "welcome", "credential": "cred-1"})
	if m := read(t, c); m["t"] != "hello" || m["generation"].(float64) != 1 {
		t.Fatalf("first frame %v", m)
	}
	ready := readUntil(t, c, func(m map[string]any) bool { return m["kind"] == "ready" })
	if ready["data"].(map[string]any)["chromeMajor"].(float64) != 141 {
		t.Fatalf("ready %v", ready)
	}
	check := readUntil(t, c, func(m map[string]any) bool { return m["kind"] == "ip_check" })
	if check["data"].(map[string]any)["ok"] != true {
		t.Fatalf("self check %v", check)
	}
	readUntil(t, c, func(m map[string]any) bool { return m["kind"] == "heartbeat" })

	// Commands are answered with replies.
	send(t, c, map[string]any{"t": "command", "id": "c1", "kind": "ip_check", "payload": map[string]any{"expected": "203.0.113.7"}})
	r := readUntil(t, c, func(m map[string]any) bool { return m["t"] == "reply" })
	if r["commandId"] != "c1" || r["ok"] != true || r["result"].(map[string]any)["observed"].([]any)[0] != "203.0.113.7" {
		t.Fatalf("reply %v", r)
	}
	send(t, c, map[string]any{"t": "command", "id": "c2", "kind": "prepare_shutdown", "payload": map[string]any{}})
	r = readUntil(t, c, func(m map[string]any) bool { return m["t"] == "reply" })
	if r["commandId"] != "c2" || r["ok"] != true || browser.closed != 1 {
		t.Fatalf("shutdown reply %v closed=%d", r, browser.closed)
	}

	// Viewer frames reach neko and neko's messages reach the viewer; IME text goes to Chrome.
	send(t, c, map[string]any{"t": "viewer_open", "sessionId": "s1"})
	v := readUntil(t, c, func(m map[string]any) bool { return m["t"] == "viewer" })
	if v["sessionId"] != "s1" {
		t.Fatalf("viewer frame %v", v)
	}
	send(t, c, map[string]any{"t": "viewer", "sessionId": "s1", "data": map[string]any{"t": "neko", "data": map[string]any{"event": "signal/request"}}})
	select {
	case m := <-nk.sent:
		if string(m) != `{"event":"signal/request"}` {
			t.Fatalf("neko got %s", m)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("neko got nothing")
	}
	send(t, c, map[string]any{"t": "viewer", "sessionId": "s1", "data": map[string]any{"t": "ime", "text": "你好"}})
	time.Sleep(100 * time.Millisecond)
	browser.mu.Lock()
	if len(browser.inserted) != 1 || browser.inserted[0] != "你好" {
		t.Fatalf("inserted %v", browser.inserted)
	}
	browser.mu.Unlock()

	// The credential was stored with mode 0600, and the reconnect uses it instead of the bootstrap token.
	info, err := os.Stat(filepath.Join(dir, "credential"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("credential file: %v %v", err, info)
	}
	c.Close(websocket.StatusGoingAway, "bye")
	select {
	case got := <-g.auths:
		if got != "Bearer cred-1" {
			t.Fatalf("reconnect auth = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no reconnect")
	}
}

func TestFailsClosedWhenChromeSeesAnotherAddress(t *testing.T) {
	g, srv := newGateway(t)
	fw := &fakeFirewall{}
	a := New(Config{
		InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot",
		StateDir: t.TempDir(), EchoURLs: []string{"https://echo.test"}, ExpectedIP: "203.0.113.7",
	}, &fakeBrowser{ip: "192.0.2.1"}, nil, fw, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = a.Run(ctx) }()
	<-g.auths
	c := <-g.conns
	check := readUntil(t, c, func(m map[string]any) bool { return m["kind"] == "ip_check" })
	if check["data"].(map[string]any)["ok"] != false {
		t.Fatalf("check %v", check)
	}
	if len(fw.modes) != 1 || fw.modes[0] != "closed" {
		t.Fatalf("firewall modes %v", fw.modes)
	}
}

func TestArchivesOnShutdownAndRestores(t *testing.T) {
	var mu sync.Mutex
	var stored []byte
	r2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodPut {
			stored, _ = io.ReadAll(r.Body)
			return
		}
		_, _ = w.Write(stored)
	}))
	defer r2.Close()

	g, srv := newGateway(t)
	profile := filepath.Join(t.TempDir(), "profile")
	_ = os.MkdirAll(filepath.Join(profile, "Default"), 0o700)
	_ = os.WriteFile(filepath.Join(profile, "Default", "Cookies"), []byte("v1"), 0o600)
	browser := &fakeBrowser{ip: "203.0.113.7"}
	a := New(Config{
		InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot",
		StateDir: t.TempDir(), ProfileDir: profile, EchoURLs: []string{"https://echo.test"}, Heartbeat: time.Hour,
	}, browser, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = a.Run(ctx) }()
	<-g.auths
	c := <-g.conns

	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	send(t, c, map[string]any{"t": "command", "id": "c1", "kind": "prepare_shutdown", "payload": map[string]any{
		"archive": map[string]any{"putUrl": r2.URL + "/x.cbar", "objectKey": "x.cbar", "key": key},
	}})
	r := readUntil(t, c, func(m map[string]any) bool { return m["t"] == "reply" })
	res := r["result"].(map[string]any)
	if r["ok"] != true || res["archived"] != true || res["sizeBytes"].(float64) <= 0 {
		t.Fatalf("shutdown reply %v", r)
	}

	_ = os.WriteFile(filepath.Join(profile, "Default", "Cookies"), []byte("v2"), 0o600)
	send(t, c, map[string]any{"t": "command", "id": "c2", "kind": "restore_archive", "payload": map[string]any{
		"archive": map[string]any{"getUrl": r2.URL + "/x.cbar", "objectKey": "x.cbar", "key": key},
	}})
	r = readUntil(t, c, func(m map[string]any) bool { return m["t"] == "reply" })
	if r["ok"] != true {
		t.Fatalf("restore reply %v", r)
	}
	if b, _ := os.ReadFile(filepath.Join(profile, "Default", "Cookies")); string(b) != "v1" {
		t.Fatalf("cookies after restore = %q", b)
	}

	// Without a key (archives off, or the key destroyed) the browser still sleeps; nothing is archived.
	send(t, c, map[string]any{"t": "command", "id": "c3", "kind": "prepare_shutdown", "payload": map[string]any{"archive": nil}})
	r = readUntil(t, c, func(m map[string]any) bool { return m["t"] == "reply" })
	if r["ok"] != true || r["result"].(map[string]any)["archived"] != false {
		t.Fatalf("keyless shutdown %v", r)
	}
}
