package chrome

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
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
