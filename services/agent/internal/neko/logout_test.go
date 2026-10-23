package neko

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// neko lists every signed-in session in each system/init: a session that ends, also one whose
// admission failed after the login, must be logged out with its own token.
func TestSessionsAreLoggedOutWhenTheyEnd(t *testing.T) {
	for _, tc := range []struct{ name, mode string }{
		{"closed", "ok"},
		{"neko_ended", "end"},
		{"websocket_refused", "refuse"},
		{"desktop_stall", "stall"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logouts := make(chan string, 4)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				switch req.URL.Path {
				case "/api/login":
					_, _ = w.Write([]byte(`{"token":"tok-` + tc.name + `"}`))
					return
				case "/api/logout":
					logouts <- req.Header.Get("Authorization")
					_, _ = w.Write([]byte(`true`))
					return
				}
				if tc.mode == "refuse" {
					http.Error(w, "no", http.StatusInternalServerError)
					return
				}
				c, err := websocket.Accept(w, req, nil)
				if err != nil {
					return
				}
				defer c.CloseNow()
				if tc.mode != "stall" {
					_ = c.Write(req.Context(), websocket.MessageText, []byte(`{"event":"system/init"}`))
				}
				if tc.mode == "end" {
					return
				}
				_, _, _ = c.Read(req.Context())
			}))
			defer srv.Close()
			r := &Relay{BaseURL: srv.URL, Username: "agent", DesktopTimeout: 50 * time.Millisecond}
			s, err := r.Open(context.Background(), "v1", func(json.RawMessage) {})
			switch tc.mode {
			case "ok":
				if err != nil {
					t.Fatal(err)
				}
				select {
				case <-logouts:
					t.Fatal("logged out while the session lasts")
				case <-time.After(50 * time.Millisecond):
				}
				s.Close()
			case "end":
				if err != nil {
					t.Fatal(err)
				}
			default:
				if err == nil {
					t.Fatal("admission succeeded")
				}
			}
			select {
			case auth := <-logouts:
				if auth != "Bearer tok-"+tc.name {
					t.Fatalf("logout with %q", auth)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("session not logged out")
			}
		})
	}
}
