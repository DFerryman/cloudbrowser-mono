package chrome

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A Chrome that answers the check but never its cleanup (closing the hidden page, disposing the
// browser context) must not hold the IP check: each cleanup call has its own bound.
func TestIPCheckCleanupIsBounded(t *testing.T) {
	old := cleanupLimit
	cleanupLimit = 100 * time.Millisecond
	t.Cleanup(func() { cleanupLimit = old })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/json/version" {
			fmt.Fprintf(w, `{"webSocketDebuggerUrl":"ws://%s/devtools/browser/fake"}`, r.Host)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			_, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			var req struct {
				ID     int64  `json:"id"`
				Method string `json:"method"`
			}
			_ = json.Unmarshal(data, &req)
			var result any = map[string]any{}
			switch req.Method {
			case "Target.closeTarget", "Target.disposeBrowserContext":
				continue // never answered
			case "Target.createBrowserContext":
				result = map[string]any{"browserContextId": "context"}
			case "Target.createTarget":
				result = map[string]any{"targetId": "hidden"}
			case "Target.attachToTarget":
				result = map[string]any{"sessionId": "session"}
			case "Runtime.evaluate":
				result = map[string]any{"result": map[string]any{"type": "string", "value": "203.0.113.7"}}
			}
			b, _ := json.Marshal(map[string]any{"id": req.ID, "result": result})
			if err := conn.Write(r.Context(), websocket.MessageText, b); err != nil {
				return
			}
		}
	}))
	defer srv.Close()
	started := time.Now()
	ips, err := New(srv.URL).ObservedIPs(context.Background(), []string{"https://a.example/ip", "https://b.example/ip"})
	if err != nil || len(ips) != 2 {
		t.Fatalf("observed %v %v", ips, err)
	}
	// Two pages closed and one context disposed, each waiting out its bound.
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("the check took %v", elapsed)
	}
}
