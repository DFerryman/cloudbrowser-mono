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
			_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"event":"system/init"}`))
			<-r.Context().Done()
		}
	}))
	t.Cleanup(srv.Close)
	return srv
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
