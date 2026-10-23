package neko

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A stand-in for neko v3: /api/login checks the password and returns a token (in the body or a
// cookie); /api/ws accepts only that token and echoes one message.
func fakeNeko(t *testing.T, tokenInCookie bool) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/login":
			var in struct{ Username, Password string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			if in.Password != "pw" || in.Username != "agent-v1" {
				http.Error(w, "nope", http.StatusUnauthorized)
				return
			}
			if tokenInCookie {
				http.SetCookie(w, &http.Cookie{Name: "NEKO_SESSION", Value: "tok"})
				_, _ = w.Write([]byte(`{"id":"s1"}`))
				return
			}
			_, _ = w.Write([]byte(`{"id":"s1","token":"tok"}`))
		case "/api/ws":
			if r.URL.Query().Get("token") != "tok" {
				http.Error(w, "bad token", http.StatusUnauthorized)
				return
			}
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"event":"system/init"}`))
			for {
				kind, data, err := c.Read(r.Context())
				if err != nil {
					return
				}
				_ = c.Write(r.Context(), kind, data)
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func failureCode(t *testing.T, err error) string {
	t.Helper()
	var failure interface{ FailureCode() string }
	if !errors.As(err, &failure) {
		t.Fatalf("expected a safe stage failure, got %v", err)
	}
	if strings.Contains(err.Error(), "secret-neko-token") || strings.Contains(err.Error(), "password") || strings.Contains(err.Error(), "http") {
		t.Fatalf("failure exposed local connection details: %v", err)
	}
	return failure.FailureCode()
}

// These use real HTTP/WebSocket connections: merely accepting /api/ws is not a successful
// desktop connection, and a stalled upgrade must stop even while the gateway stays connected.
func TestOpenStageDeadlinesAndSafeFailures(t *testing.T) {
	for _, tc := range []struct{ name, want string }{
		{"login_stall", "login_timeout"},
		{"login_body_stall", "login_timeout"},
		{"login_rejected", "login_rejected"},
		{"upgrade_stall", "websocket_timeout"},
		{"desktop_stall", "desktop_timeout"},
		{"desktop_closed", "websocket_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.URL.Path == "/api/login" {
					var login map[string]string
					_ = json.NewDecoder(req.Body).Decode(&login)
					if tc.name == "login_stall" {
						<-req.Context().Done()
						return
					}
					if tc.name == "login_body_stall" {
						w.WriteHeader(http.StatusOK)
						w.(http.Flusher).Flush()
						<-req.Context().Done()
						return
					}
					if tc.name == "login_rejected" {
						http.Error(w, "password rejected", http.StatusUnauthorized)
						return
					}
					_, _ = w.Write([]byte(`{"token":"secret-neko-token"}`))
					return
				}
				if req.URL.Path == "/api/logout" {
					return
				}
				if tc.name == "upgrade_stall" {
					<-req.Context().Done()
					return
				}
				c, err := websocket.Accept(w, req, nil)
				if err != nil {
					return
				}
				defer c.CloseNow()
				if tc.name == "desktop_closed" {
					return
				}
				_, _, _ = c.Read(req.Context())
			}))
			defer srv.Close()
			r := &Relay{BaseURL: srv.URL, Username: "agent", Password: "password", LoginTimeout: 50 * time.Millisecond, WebSocketTimeout: 50 * time.Millisecond, DesktopTimeout: 50 * time.Millisecond}
			var stages []string
			started := time.Now()
			_, err := r.OpenWithProgress(context.Background(), "v1", func(json.RawMessage) { t.Error("uninitialized desktop forwarded a frame") }, func(stage, code string) {
				stages = append(stages, stage)
				if stage == "failed" && code != tc.want {
					t.Errorf("stage failure=%s, want %s", code, tc.want)
				}
			})
			if got := failureCode(t, err); got != tc.want {
				t.Fatalf("failure=%s, want %s", got, tc.want)
			}
			if time.Since(started) > time.Second {
				t.Fatal("local desktop admission did not respect its stage deadline")
			}
			if len(stages) == 0 || stages[len(stages)-1] != "failed" {
				t.Fatalf("missing terminal failure: %v", stages)
			}
		})
	}
}

func TestDesktopInitializationDeadlineIsNotResetByOtherFrames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		c, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := c.CloseRead(req.Context())
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if c.Write(ctx, websocket.MessageText, []byte(`{"event":"unrelated"}`)) != nil {
					return
				}
			}
		}
	}))
	defer srv.Close()
	r := &Relay{URL: "ws" + strings.TrimPrefix(srv.URL, "http"), DesktopTimeout: 60 * time.Millisecond}
	started := time.Now()
	_, err := r.Open(context.Background(), "v1", func(json.RawMessage) { t.Error("forwarded a frame before initialization") })
	if got := failureCode(t, err); got != "desktop_timeout" {
		t.Fatalf("failure=%s", got)
	}
	if time.Since(started) > time.Second {
		t.Fatal("unrelated frames kept an uninitialized desktop open")
	}
}

func TestCancelPendingUpgrade(t *testing.T) {
	entered := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/api/login" {
			_, _ = w.Write([]byte(`{"token":"secret-neko-token"}`))
			return
		}
		if req.URL.Path == "/api/logout" {
			return
		}
		close(entered)
		<-req.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := (&Relay{BaseURL: srv.URL}).Open(ctx, "v1", func(json.RawMessage) {})
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("upgrade not attempted")
	}
	cancel()
	select {
	case err := <-result:
		if got := failureCode(t, err); got != "canceled" {
			t.Fatalf("failure=%s", got)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not interrupt the local upgrade")
	}
}

func TestInitializedSessionOutlivesStageDeadline(t *testing.T) {
	srv := fakeNeko(t, false)
	r := &Relay{BaseURL: srv.URL, Username: "agent", Password: "pw", WebSocketTimeout: 30 * time.Millisecond, DesktopTimeout: 30 * time.Millisecond}
	got := make(chan string, 4)
	var stages []string
	s, err := r.OpenWithProgress(context.Background(), "v1", func(m json.RawMessage) { got <- string(m) }, func(stage, _ string) { stages = append(stages, stage) })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if want := "login_start,login_ok,websocket_start,websocket_open,desktop_ready"; strings.Join(stages, ",") != want {
		t.Fatalf("stages=%v", stages)
	}
	<-got // system/init
	timer := time.NewTimer(80 * time.Millisecond)
	defer timer.Stop()
	<-timer.C
	if err := s.Send(json.RawMessage(`{"event":"test"}`)); err != nil {
		t.Fatalf("stage timeout canceled an admitted session: %v", err)
	}
	select {
	case msg := <-got:
		if msg != `{"event":"test"}` {
			t.Fatalf("unexpected relayed frame %s", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("admitted relay stopped after its stage deadline")
	}
}

func TestProbeUsesDistinctSessionsAndClosesThem(t *testing.T) {
	names := make(chan string, 2)
	closed := make(chan struct{}, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/api/login" {
			var in struct{ Username string }
			_ = json.NewDecoder(req.Body).Decode(&in)
			names <- in.Username
			_, _ = w.Write([]byte(`{"token":"tok"}`))
			return
		}
		c, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		_ = c.Write(req.Context(), websocket.MessageText, []byte(`{"event":"system/init"}`))
		_, _, _ = c.Read(req.Context())
		closed <- struct{}{}
	}))
	defer srv.Close()
	r := &Relay{BaseURL: srv.URL, Username: "agent"}
	for range 2 {
		if err := r.Probe(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	first, second := <-names, <-names
	if first == second || !strings.HasPrefix(first, "agent-probe-") || !strings.HasPrefix(second, "agent-probe-") {
		t.Fatalf("probe names must be unique: %q %q", first, second)
	}
	for range 2 {
		select {
		case <-closed:
		case <-time.After(time.Second):
			t.Fatal("probe left its local desktop connection open")
		}
	}
}

func TestLoginThenRelay(t *testing.T) {
	for _, cookie := range []bool{false, true} {
		srv := fakeNeko(t, cookie)
		got := make(chan string, 1)
		r := &Relay{BaseURL: srv.URL, Username: "agent", Password: "pw"}
		s, err := r.Open(context.Background(), "v1", func(m json.RawMessage) { got <- string(m) })
		if err != nil {
			t.Fatalf("cookie=%v: %v", cookie, err)
		}
		select {
		case m := <-got:
			if m != `{"event":"system/init"}` {
				t.Fatalf("got %s", m)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("no message from neko")
		}
		s.Close()
	}
	bad := &Relay{BaseURL: fakeNeko(t, false).URL, Username: "agent", Password: "wrong"}
	if _, err := bad.Open(context.Background(), "v1", func(json.RawMessage) {}); err == nil {
		t.Fatal("wrong password accepted")
	}
}
