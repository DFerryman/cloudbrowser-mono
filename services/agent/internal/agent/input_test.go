package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type inputRelay struct{ session *inputSession }

func (n inputRelay) Open(context.Context, string, func(json.RawMessage)) (NekoSession, error) {
	return n.session, nil
}

type inputSession struct {
	done chan struct{}
	once sync.Once
	err  error
	// got receives every frame sent, when a test wants to see them (buffered; never blocks).
	got chan json.RawMessage
}

func (s *inputSession) Send(m json.RawMessage) error {
	if s.got != nil {
		select {
		case s.got <- append(json.RawMessage(nil), m...):
		default:
		}
	}
	return s.err
}
func (s *inputSession) Done() <-chan struct{} { return s.done }
func (s *inputSession) Close()                { s.once.Do(func() { close(s.done) }) }

func inputAgent(t *testing.T, session *inputSession) (*Agent, *websocket.Conn) {
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
	a := New(Config{}, &fakeBrowser{}, inputRelay{session}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.conn = c
	return a, remote
}

func TestInputDeliveryFailuresAreReported(t *testing.T) {
	for _, mode := range []string{"missing", "write", "read"} {
		t.Run(mode, func(t *testing.T) {
			s := &inputSession{done: make(chan struct{})}
			a, remote := inputAgent(t, s)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode != "missing" {
				openReadyViewer(t, a, ctx, "viewer1", "relay-current")
			}
			var expected string
			switch mode {
			case "missing":
				expected = "relay_unavailable"
			case "write":
				s.err = errors.New("relay write failed")
				expected = "input_failed"
			case "read":
				expected = "relay_failed"
				s.Close()
			}
			if mode != "read" {
				a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"neko","data":{"event":"control/keydown","payload":{"keysym":97}}}`), "relay-current")
			}
			frame := readUntil(t, remote, func(m map[string]any) bool { return m["t"] == "viewer_error" })
			if frame["t"] != "viewer_error" || frame["sessionId"] != "viewer1" || frame["reason"] != expected {
				t.Fatalf("unexpected input error: %v", frame)
			}
			if frame["relayId"] != "relay-current" {
				t.Fatal("error lost the failed relay identity")
			}
			if _, leaked := frame["data"]; leaked {
				t.Fatal("error frame must not contain input content")
			}
			a.mu.Lock()
			defer a.mu.Unlock()
			if len(a.sessions) != 0 {
				t.Fatal("failed session retained")
			}
		})
	}
}

type rotatingInputRelay struct {
	sessions []NekoSession
	next     int
}

func (n *rotatingInputRelay) Open(context.Context, string, func(json.RawMessage)) (NekoSession, error) {
	s := n.sessions[n.next]
	n.next++
	return s, nil
}

func TestOldRelayCannotControlReplacementOrTypeAfterClose(t *testing.T) {
	old := &inputSession{done: make(chan struct{})}
	current := &inputSession{done: make(chan struct{})}
	browser := &fakeBrowser{}
	a := New(Config{}, browser, &rotatingInputRelay{sessions: []NekoSession{old, current}}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	openReadyViewer(t, a, ctx, "viewer1", "old-relay")
	openReadyViewer(t, a, ctx, "viewer1", "new-relay")
	a.closeViewer("viewer1", "old-relay")
	a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"ime","text":"stale"}`), "old-relay")
	a.mu.Lock()
	if a.sessions["viewer1"] != current || a.relayIDs["viewer1"] != "new-relay" {
		t.Fatal("old relay replaced or closed the new session")
	}
	a.mu.Unlock()
	a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"ime","text":"current"}`), "new-relay")
	a.closeViewer("viewer1", "new-relay")
	a.fromViewer(ctx, "viewer1", json.RawMessage(`{"t":"ime","text":"after close"}`), "new-relay")
	browser.mu.Lock()
	defer browser.mu.Unlock()
	if len(browser.inserted) != 1 || browser.inserted[0] != "current" {
		t.Fatalf("unexpected inserted text: %v", browser.inserted)
	}
}

// Existing input/file tests require an admitted relay before sending input. Admission is now
// asynchronous so production command delivery remains responsive during a stalled desktop.
func openReadyViewer(t *testing.T, a *Agent, ctx context.Context, sessionID, relayID string) {
	t.Helper()
	a.openViewer(ctx, sessionID, relayID)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		ready := a.sessions[sessionID] != nil && a.relayIDs[sessionID] == relayID
		a.mu.Unlock()
		if ready {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("viewer did not become admitted")
}
