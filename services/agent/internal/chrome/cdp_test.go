package chrome

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Runs against a real Chrome when CHROME_BIN is set, e.g.
// CHROME_BIN=/opt/pw-browsers/chromium-1194/chrome-linux/chrome go test ./internal/chrome
func TestChromeAgainstRealBrowser(t *testing.T) {
	bin := os.Getenv("CHROME_BIN")
	if bin == "" {
		t.Skip("CHROME_BIN not set")
	}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cmd := exec.Command(bin, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
		"--remote-debugging-port="+strconv.Itoa(port), "--user-data-dir="+t.TempDir(), "about:blank")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	// The echo endpoint answers with the caller's address, like GET /api/echo/ip.
	echo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		_, _ = w.Write([]byte(host))
	}))
	defer echo.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	c := New("http://127.0.0.1:" + strconv.Itoa(port))
	major, err := c.Start(ctx)
	if err != nil || major < 100 {
		t.Fatalf("start: %d %v", major, err)
	}
	ips, err := c.ObservedIPs(ctx, []string{echo.URL, echo.URL})
	if err != nil || len(ips) != 2 || ips[0] != "127.0.0.1" {
		t.Fatalf("observed %v %v", ips, err)
	}
	if err := c.InsertText(ctx, "你好"); err != nil {
		t.Fatalf("insert text: %v", err)
	}
	testDropFiles(ctx, t, c)
	if err := c.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("chrome did not exit after Browser.close")
	}
}

// testDropFiles drops a file on a page that lists what it received in its title.
func testDropFiles(ctx context.Context, t *testing.T, c *Chrome) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(file, []byte("# Notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	page := `<body style="margin:0;height:100vh"><script>
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; document.title = f.name + ":" + (await f.text()) + ":" + e.clientX; });
</script>`
	var created struct {
		TargetID string `json:"targetId"`
	}
	if err := c.CDP.Call(ctx, "", "Target.createTarget", map[string]any{"url": "data:text/html," + url.PathEscape(page)}, &created); err != nil {
		t.Fatal(err)
	}
	var w struct {
		Bounds struct{ Left, Top, Height float64 } `json:"bounds"`
	}
	if err := c.CDP.Call(ctx, "", "Browser.getWindowForTarget", map[string]any{"targetId": created.TargetID}, &w); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	// The bottom row of the window is the page's.
	dropped, err := c.DropFiles(ctx, int(w.Bounds.Left)+40, int(w.Bounds.Top+w.Bounds.Height)-5, []string{file})
	if err != nil || !dropped {
		t.Fatalf("drop: %v %v", dropped, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var targets struct {
			TargetInfos []struct{ TargetID, Title string } `json:"targetInfos"`
		}
		_ = c.CDP.Call(ctx, "", "Target.getTargets", map[string]any{}, &targets)
		for _, info := range targets.TargetInfos {
			if info.TargetID == created.TargetID && info.Title == "notes.md:# Notes:40" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("page did not receive the file: %+v", targets.TargetInfos)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// fakeDevTools answers an IP check's DevTools calls the way Chrome 155 does: hidden pages are
// refused until Chrome has a page of its own. It counts the pages asked for without hidden.
type fakeDevTools struct {
	mu      sync.Mutex
	hasPage bool
	refused int
	visible int
}

func (f *fakeDevTools) counts() (refused, visible int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.refused, f.visible
}

func (f *fakeDevTools) openWindow() {
	f.mu.Lock()
	f.hasPage = true
	f.mu.Unlock()
}

func newFakeDevTools(t *testing.T, ip string) (*fakeDevTools, string) {
	f := &fakeDevTools{}
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
				ID     int64          `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal(data, &req)
			resp := map[string]any{"id": req.ID, "result": map[string]any{}}
			switch req.Method {
			case "Target.createBrowserContext":
				resp["result"] = map[string]any{"browserContextId": "context"}
			case "Target.createTarget":
				f.mu.Lock()
				switch {
				case req.Params["hidden"] != true:
					f.visible++
					resp["result"] = map[string]any{"targetId": "visible"}
				case !f.hasPage:
					f.refused++
					delete(resp, "result")
					resp["error"] = map[string]any{"code": -32000, "message": "Hidden target can be created only when remote debugging is enabled"}
				default:
					resp["result"] = map[string]any{"targetId": "hidden"}
				}
				f.mu.Unlock()
			case "Target.attachToTarget":
				resp["result"] = map[string]any{"sessionId": "session"}
			case "Runtime.evaluate":
				resp["result"] = map[string]any{"result": map[string]any{"type": "string", "value": ip}}
			}
			b, _ := json.Marshal(resp)
			if err := conn.Write(r.Context(), websocket.MessageText, b); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return f, srv.URL
}

// At wake the IP check runs before Chrome has restored its first window. It waits for Chrome to
// take the hidden page and never asks for a visible one, which in a new browser context is a
// window of its own that flashed onto the user's screen.
func TestIPCheckWaitsForChromeWindow(t *testing.T) {
	f, endpoint := newFakeDevTools(t, "203.0.113.7")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() {
		for ctx.Err() == nil {
			if refused, _ := f.counts(); refused >= 3 {
				f.openWindow()
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	ips, err := New(endpoint).ObservedIPs(ctx, []string{"https://a.example/ip", "https://b.example/ip"})
	if err != nil || len(ips) != 2 || ips[0] != "203.0.113.7" || ips[1] != "203.0.113.7" {
		t.Fatalf("observed %v %v", ips, err)
	}
	if refused, visible := f.counts(); refused < 3 || visible != 0 {
		t.Fatalf("refused %d hidden pages, asked for %d visible ones", refused, visible)
	}
}

// A Chrome that never opens a window fails the check with its reason, still without a visible page.
func TestIPCheckWithoutChromeWindow(t *testing.T) {
	f, endpoint := newFakeDevTools(t, "203.0.113.7")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := New(endpoint).ObservedIPs(ctx, []string{"https://a.example/ip"})
	if err == nil || !strings.Contains(err.Error(), "Hidden target can be created only") {
		t.Fatalf("err %v", err)
	}
	if _, visible := f.counts(); visible != 0 {
		t.Fatalf("asked for %d visible pages", visible)
	}
}
