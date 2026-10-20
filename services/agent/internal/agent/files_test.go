package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fakeClipboard struct {
	mu   sync.Mutex
	mime string
	data []byte
}

func (c *fakeClipboard) SetClipboard(_ context.Context, mime string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mime, c.data = mime, data
	return nil
}

func fileAgent(t *testing.T) (*Agent, *websocket.Conn, *fakeBrowser, *fakeClipboard, string) {
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
	dir := t.TempDir()
	browser, clip := &fakeBrowser{}, &fakeClipboard{}
	a := New(Config{UploadDir: dir, UploadBrowserDir: "/data/uploads", Clipboard: clip}, browser,
		inputRelay{&inputSession{done: make(chan struct{})}}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.conn = c
	return a, remote, browser, clip, dir
}

func frame(t *testing.T, v map[string]any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func chunk(id string, file int, data string) map[string]any {
	return map[string]any{"t": "file_chunk", "id": id, "file": file, "chunk": base64.StdEncoding.EncodeToString([]byte(data))}
}

func fileStatus(t *testing.T, c *websocket.Conn, id string) map[string]any {
	t.Helper()
	return readUntil(t, c, func(m map[string]any) bool {
		return m["t"] == "viewer_file" && m["id"] == id && m["status"] != "progress"
	})
}

func TestPastedFilesReachTheClipboard(t *testing.T) {
	a, remote, _, clip, dir := fileAgent(t)
	ctx := context.Background()
	a.openViewer(ctx, "viewer1", "relay1")

	// One PNG is pasted as an image.
	png := "\x89PNG\r\n\x1a\nimage"
	a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_begin", "id": "p1", "action": "paste",
		"files": []map[string]any{{"name": "image.png", "type": "image/png", "size": len(png)}}}), "relay1")
	a.fromViewer(ctx, "viewer1", frame(t, chunk("p1", 0, png[:5])), "relay1")
	a.fromViewer(ctx, "viewer1", frame(t, chunk("p1", 0, png[5:])), "relay1")
	a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_end", "id": "p1"}), "relay1")
	if m := fileStatus(t, remote, "p1"); m["status"] != "done" || m["relayId"] != "relay1" || m["received"] != float64(len(png)) {
		t.Fatalf("paste status: %v", m)
	}
	clip.mu.Lock()
	if clip.mime != "image/png" || string(clip.data) != png {
		t.Fatalf("clipboard: %s %q", clip.mime, clip.data)
	}
	clip.mu.Unlock()

	// Anything else is pasted as files, each under its own name.
	a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_begin", "id": "p2", "action": "paste",
		"files": []map[string]any{{"name": "notes.md", "type": "text/markdown", "size": 7}, {"name": "../a b.txt", "type": "text/plain", "size": 0}}}), "relay1")
	a.fromViewer(ctx, "viewer1", frame(t, chunk("p2", 0, "# Notes")), "relay1")
	a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_end", "id": "p2"}), "relay1")
	if m := fileStatus(t, remote, "p2"); m["status"] != "done" {
		t.Fatalf("paste status: %v", m)
	}
	clip.mu.Lock()
	list := string(clip.data)
	clip.mu.Unlock()
	matches, _ := filepath.Glob(filepath.Join(dir, "*-p2", "0", "notes.md"))
	if len(matches) != 1 {
		t.Fatalf("upload not written: %v", matches)
	}
	if b, _ := os.ReadFile(matches[0]); string(b) != "# Notes" {
		t.Fatalf("upload content %q", b)
	}
	upload := filepath.Base(filepath.Dir(filepath.Dir(matches[0])))
	want := "file:///data/uploads/" + upload + "/0/notes.md\r\nfile:///data/uploads/" + upload + "/1/.._a%20b.txt\r\n"
	if clip.mime != "text/uri-list" || list != want {
		t.Fatalf("file list %s %q, want %q", clip.mime, list, want)
	}

	// neko's report of that clipboard is not relayed as copied text.
	if !a.clipboardEchoed(json.RawMessage(`{"event":"clipboard/updated","payload":{"text":"file:///data"}}`)) {
		t.Fatal("clipboard echo relayed")
	}
	a.mu.Lock()
	a.clipboardQuietUntil = time.Time{}
	a.mu.Unlock()
	if a.clipboardEchoed(json.RawMessage(`{"event":"clipboard/updated","payload":{"text":"copied"}}`)) {
		t.Fatal("a later copy was dropped")
	}
}

func TestDroppedFilesReachThePage(t *testing.T) {
	a, remote, browser, _, _ := fileAgent(t)
	ctx := context.Background()
	a.openViewer(ctx, "viewer1", "relay1")
	a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_begin", "id": "d1", "action": "drop", "x": 640, "y": 400,
		"files": []map[string]any{{"name": "a.txt", "type": "text/plain", "size": 3}}}), "relay1")
	a.fromViewer(ctx, "viewer1", frame(t, chunk("d1", 0, "abc")), "relay1")
	if m := readUntil(t, remote, func(m map[string]any) bool { return m["t"] == "viewer_file" }); m["status"] != "progress" || m["received"] != float64(3) {
		t.Fatalf("progress: %v", m)
	}
	a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_end", "id": "d1"}), "relay1")
	if m := fileStatus(t, remote, "d1"); m["status"] != "done" {
		t.Fatalf("drop status: %v", m)
	}
	browser.mu.Lock()
	defer browser.mu.Unlock()
	if len(browser.drops) != 1 || browser.drops[0].x != 640 || browser.drops[0].y != 400 || len(browser.drops[0].paths) != 1 {
		t.Fatalf("drops: %v", browser.drops)
	}
	if p := browser.drops[0].paths[0]; filepath.Dir(filepath.Dir(filepath.Dir(p))) != "/data/uploads" || filepath.Base(p) != "a.txt" {
		t.Fatalf("drop path %s", p)
	}
}

func TestBadTransfersAreRefusedAndRemoved(t *testing.T) {
	a, remote, _, _, dir := fileAgent(t)
	ctx := context.Background()
	a.openViewer(ctx, "viewer1", "relay1")
	begin := func(id string, size int) {
		a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_begin", "id": id, "action": "paste",
			"files": []map[string]any{{"name": "a.txt", "type": "text/plain", "size": size}}}), "relay1")
	}

	// More bytes than declared.
	begin("x1", 2)
	a.fromViewer(ctx, "viewer1", frame(t, chunk("x1", 0, "abc")), "relay1")
	if m := fileStatus(t, remote, "x1"); m["status"] != "error" || m["reason"] != "invalid" {
		t.Fatalf("overrun: %v", m)
	}
	// Ended before every byte arrived.
	begin("x2", 5)
	a.fromViewer(ctx, "viewer1", frame(t, chunk("x2", 0, "ab")), "relay1")
	a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_end", "id": "x2"}), "relay1")
	if m := fileStatus(t, remote, "x2"); m["status"] != "error" || m["reason"] != "invalid" {
		t.Fatalf("short: %v", m)
	}
	// Too large in total.
	begin("x3", maxTransferBytes+1)
	if m := fileStatus(t, remote, "x3"); m["status"] != "error" || m["reason"] != "too_large" {
		t.Fatalf("too large: %v", m)
	}
	// Canceled, or its viewer left.
	begin("x4", 5)
	a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_cancel", "id": "x4"}), "relay1")
	begin("x5", 5)
	a.closeViewer("viewer1", "relay1")
	a.mu.Lock()
	left := len(a.transfers)
	a.mu.Unlock()
	if entries, _ := os.ReadDir(dir); left != 0 || len(entries) != 0 {
		t.Fatalf("transfers left: %d, files left: %v", left, entries)
	}
}

func TestTransfersNeedAnUploadDirectory(t *testing.T) {
	a, remote := inputAgent(t, &inputSession{done: make(chan struct{})})
	ctx := context.Background()
	a.openViewer(ctx, "viewer1", "relay1")
	a.fromViewer(ctx, "viewer1", frame(t, map[string]any{"t": "file_begin", "id": "u1", "action": "drop", "x": 1, "y": 1,
		"files": []map[string]any{{"name": "a.txt", "type": "text/plain", "size": 1}}}), "relay1")
	if m := fileStatus(t, remote, "u1"); m["status"] != "error" || m["reason"] != "unsupported" {
		t.Fatalf("status: %v", m)
	}
}
