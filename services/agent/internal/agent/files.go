package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/protocol"
)

// File transfers (packages/contracts FILE_TRANSFER): files a viewer pasted or dropped arrive as
// ordered base64 chunks and are written under UploadDir, which Chrome sees as UploadBrowserDir
// (the browser container mounts the data volume). A paste puts them on the X clipboard for the
// viewer's Ctrl+V: one PNG as an image, anything else as a file list (text/uri-list), which
// Chrome pastes as files. A drop reaches the page under the pointer through CDP.
const (
	maxTransferFiles = 10
	maxTransferBytes = 50 << 20
	// Per viewer session, in flight at once.
	maxTransfers = 2
	// Uploads stay while a page may still read them (a form sent later); older ones are removed.
	uploadMaxAge = 24 * time.Hour
	// neko reads the clipboard's text after every change, and xclip answers a text request with
	// the image or file list it holds; the viewer must not get that as copied text.
	clipboardEcho = 3 * time.Second
	deliverLimit  = 15 * time.Second
)

var transferID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Clipboard sets the browser's X clipboard.
type Clipboard interface {
	SetClipboard(ctx context.Context, mime string, data []byte) error
}

type transfer struct {
	mu                             sync.Mutex // local relay EOF cleanup can race the gateway's ordered file_chunk handler
	sessionID, relayID, id, action string
	x, y                           int
	dir                            string // under UploadDir
	files                          []protocol.FileMeta
	names                          []string // relative to dir
	current                        int
	written                        int64 // of the current file
	received                       int64
	out                            *os.File
}

func transferKey(sessionID, id string) string { return sessionID + "/" + id }

// safeName keeps a file's own name (sites show it) without anything that leaves its directory.
func safeName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r < 0x20 || r == 0x7f {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	for len(name) > 200 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}

func (a *Agent) fileFrame(ctx context.Context, sessionID, relayID string, f protocol.ViewerFrame) {
	key := transferKey(sessionID, f.ID)
	switch f.T {
	case "file_begin":
		if reason := a.beginTransfer(sessionID, relayID, f); reason != "" {
			a.fileStatus(ctx, sessionID, relayID, f.ID, "error", 0, reason)
		}
	case "file_chunk":
		a.mu.Lock()
		t := a.transfers[key]
		a.mu.Unlock()
		if t == nil {
			return // canceled, or it failed and said so
		}
		if reason := t.write(f); reason != "" {
			a.endTransfer(key, true)
			a.fileStatus(ctx, sessionID, relayID, f.ID, "error", 0, reason)
			return
		}
		a.fileStatus(ctx, sessionID, relayID, f.ID, "progress", t.received, "")
	case "file_end":
		t := a.endTransfer(key, false)
		if t == nil {
			return
		}
		if reason := t.finish(); reason != "" {
			_ = os.RemoveAll(t.dir)
			a.fileStatus(ctx, sessionID, relayID, f.ID, "error", 0, reason)
			return
		}
		// Clipboard and CDP calls can take a while; the tunnel keeps reading meanwhile.
		go a.deliverTransfer(ctx, t)
	case "file_cancel":
		a.endTransfer(key, true)
	}
}

func (a *Agent) beginTransfer(sessionID, relayID string, f protocol.ViewerFrame) string {
	if !a.uploadsConfigured() {
		return "unsupported"
	}
	if !transferID.MatchString(f.ID) || len(f.Files) == 0 || len(f.Files) > maxTransferFiles {
		return "invalid"
	}
	if f.Action != "paste" && f.Action != "drop" {
		return "invalid"
	}
	if f.Action == "paste" && a.cfg.Clipboard == nil {
		return "unsupported"
	}
	if f.Action == "drop" && (f.X == nil || f.Y == nil) {
		return "invalid"
	}
	var total int64
	for _, m := range f.Files {
		if m.Size < 0 {
			return "invalid"
		}
		total += m.Size
	}
	if total > maxTransferBytes {
		return "too_large"
	}
	key := transferKey(sessionID, f.ID)
	a.mu.Lock()
	active := 0
	for _, t := range a.transfers {
		if t.sessionID == sessionID {
			active++
		}
	}
	_, exists := a.transfers[key]
	a.mu.Unlock()
	if exists {
		return "invalid"
	}
	if active >= maxTransfers {
		return "busy"
	}
	if reason := a.checkUploadDir(); reason != "" {
		return reason
	}
	a.pruneUploads()
	t := &transfer{sessionID: sessionID, relayID: relayID, id: f.ID, action: f.Action, files: f.Files}
	if f.X != nil && f.Y != nil {
		t.x, t.y = *f.X, *f.Y
	}
	t.dir = filepath.Join(a.cfg.UploadDir, strconv.FormatInt(time.Now().UnixNano(), 36)+"-"+f.ID)
	// One directory per file: two files may share a name, and each keeps it.
	for i, m := range f.Files {
		t.names = append(t.names, path.Join(strconv.Itoa(i), safeName(m.Name)))
		if err := os.MkdirAll(filepath.Join(t.dir, strconv.Itoa(i)), 0o755); err != nil {
			a.log.Warn("upload directory", "err", err)
			_ = os.RemoveAll(t.dir)
			return "write_failed"
		}
	}
	if err := t.open(); err != nil {
		a.log.Warn("upload file", "err", err)
		_ = os.RemoveAll(t.dir)
		return "write_failed"
	}
	a.mu.Lock()
	if a.sessions[sessionID] == nil || a.relayIDs[sessionID] != relayID {
		a.mu.Unlock()
		t.close()
		_ = os.RemoveAll(t.dir)
		return "relay_unavailable"
	}
	a.transfers[key] = t
	a.mu.Unlock()
	return ""
}

// open creates the current file and skips past empty ones.
func (t *transfer) open() error {
	for t.current < len(t.files) {
		f, err := os.OpenFile(filepath.Join(t.dir, filepath.FromSlash(t.names[t.current])), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		if t.files[t.current].Size > 0 {
			t.out = f
			return nil
		}
		if err := f.Close(); err != nil {
			return err
		}
		t.current++
	}
	return nil
}

func (t *transfer) write(f protocol.ViewerFrame) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	data, err := base64.StdEncoding.DecodeString(f.Chunk)
	if err != nil || len(data) == 0 || t.out == nil || f.File != t.current {
		return "invalid"
	}
	if t.written+int64(len(data)) > t.files[t.current].Size {
		return "invalid"
	}
	if _, err := t.out.Write(data); err != nil {
		return "write_failed"
	}
	t.written += int64(len(data))
	t.received += int64(len(data))
	if t.written == t.files[t.current].Size {
		err := t.out.Close()
		t.out = nil
		t.written = 0
		t.current++
		if err == nil {
			err = t.open()
		}
		if err != nil {
			return "write_failed"
		}
	}
	return ""
}

// finish checks that every file arrived whole.
func (t *transfer) finish() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.out != nil || t.current != len(t.files) {
		t.closeLocked()
		return "invalid"
	}
	return ""
}

func (t *transfer) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closeLocked()
}

func (t *transfer) closeLocked() {
	if t.out != nil {
		_ = t.out.Close()
		t.out = nil
	}
}

// endTransfer takes a transfer out of the table; discard also removes its files.
func (a *Agent) endTransfer(key string, discard bool) *transfer {
	a.mu.Lock()
	t := a.transfers[key]
	delete(a.transfers, key)
	a.mu.Unlock()
	if t != nil && discard {
		t.close()
		_ = os.RemoveAll(t.dir)
	}
	return t
}

func (a *Agent) endSessionTransfers(sessionID string, relayIDs ...string) {
	a.mu.Lock()
	var removed []*transfer
	for key, t := range a.transfers {
		if t.sessionID == sessionID && (len(relayIDs) == 0 || t.relayID == relayIDs[0]) {
			delete(a.transfers, key)
			removed = append(removed, t)
		}
	}
	a.mu.Unlock()
	for _, t := range removed {
		t.close()
		_ = os.RemoveAll(t.dir)
	}
}

func (a *Agent) deliverTransfer(ctx context.Context, t *transfer) {
	cctx, cancel := context.WithTimeout(ctx, deliverLimit)
	defer cancel()
	browserPaths := make([]string, len(t.names))
	for i, name := range t.names {
		browserPaths[i] = path.Join(a.cfg.UploadBrowserDir, path.Base(t.dir), name)
	}
	reason := ""
	switch t.action {
	case "paste":
		mime, data := "text/uri-list", fileList(browserPaths)
		if len(t.files) == 1 && t.files[0].Type == "image/png" {
			img, err := os.ReadFile(filepath.Join(t.dir, filepath.FromSlash(t.names[0])))
			if err != nil {
				reason = "paste_failed"
				break
			}
			mime, data = "image/png", img
		}
		a.quietClipboard()
		err := a.cfg.Clipboard.SetClipboard(cctx, mime, data)
		a.quietClipboard()
		if err != nil {
			a.log.Warn("set clipboard", "err", err)
			reason = "paste_failed"
		}
	case "drop":
		dropped, err := a.browser.DropFiles(cctx, t.x, t.y, browserPaths)
		if err != nil {
			a.log.Warn("drop files", "err", err)
			reason = "drop_failed"
		} else if !dropped {
			reason = "not_on_page"
		}
	}
	if reason != "" {
		_ = os.RemoveAll(t.dir)
		a.fileStatus(ctx, t.sessionID, t.relayID, t.id, "error", 0, reason)
		return
	}
	a.fileStatus(ctx, t.sessionID, t.relayID, t.id, "done", t.received, "")
}

// fileList is text/uri-list: one file URL per line, CRLF-terminated (RFC 2483).
func fileList(paths []string) []byte {
	var b strings.Builder
	for _, p := range paths {
		b.WriteString((&url.URL{Scheme: "file", Path: p}).String())
		b.WriteString("\r\n")
	}
	return []byte(b.String())
}

func (a *Agent) quietClipboard() {
	a.mu.Lock()
	a.clipboardQuietUntil = time.Now().Add(clipboardEcho)
	a.mu.Unlock()
}

// clipboardEchoed is neko's report of a clipboard the agent just set to an image or files.
func (a *Agent) clipboardEchoed(msg json.RawMessage) bool {
	a.mu.Lock()
	quiet := time.Now().Before(a.clipboardQuietUntil)
	a.mu.Unlock()
	if !quiet || !bytes.Contains(msg, []byte(`clipboard/updated`)) {
		return false
	}
	var m struct {
		Event string `json:"event"`
	}
	return json.Unmarshal(msg, &m) == nil && m.Event == "clipboard/updated"
}

func (a *Agent) fileStatus(ctx context.Context, sessionID, relayID, id, status string, received int64, reason string) {
	_ = a.write(ctx, protocol.ViewerFile{T: "viewer_file", SessionID: sessionID, RelayID: relayID, ID: id, Status: status, Received: received, Reason: reason})
}

// uploadsConfigured is whether files can be received at all: an upload directory is configured
// and has not been refused (checkUploadDir).
func (a *Agent) uploadsConfigured() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg.UploadDir != "" && a.cfg.UploadBrowserDir != "" && !a.uploadsRefused
}

// checkUploadDir makes sure UploadDir is still the directory the agent made, before anything is
// written into it or removed from it: "" when it is, "unsupported" when transfers are off. The
// agent runs as root, and the upload directory lies on the data volume inside a directory the
// browser's own user owns, so a compromised browser could put a symlink in its place and have the
// agent write files elsewhere or prune another directory. A symlink, anything but a directory, or
// a directory the agent's user does not own turns transfers off until the agent restarts. A
// missing directory is made.
func (a *Agent) checkUploadDir() string {
	if !a.uploadsConfigured() {
		return "unsupported"
	}
	info, err := os.Lstat(a.cfg.UploadDir)
	if errors.Is(err, fs.ErrNotExist) {
		if err = os.Mkdir(a.cfg.UploadDir, 0o755); err == nil || errors.Is(err, fs.ErrExist) {
			info, err = os.Lstat(a.cfg.UploadDir)
		}
	}
	problem := ""
	switch {
	case err != nil:
		a.log.Warn("upload directory", "err", err)
		return "write_failed" // nothing suspicious, and the next transfer looks again
	case info.Mode()&fs.ModeSymlink != 0:
		problem = "a symbolic link"
	case !info.IsDir():
		problem = "not a directory"
	case !ownedByAgent(info):
		problem = "owned by another user"
	}
	if problem == "" {
		return ""
	}
	a.mu.Lock()
	a.uploadsRefused = true
	a.mu.Unlock()
	a.log.Error("upload directory refused; file transfers are off", "dir", a.cfg.UploadDir, "problem", problem)
	return "unsupported"
}

// pruneUploads removes uploads older than uploadMaxAge (all of them with maxAge 0). Callers check
// the directory first (checkUploadDir); entries are removed without following symlinks, so a link
// in the directory goes, never what it points to.
func (a *Agent) pruneUploads(maxAge ...time.Duration) {
	age := uploadMaxAge
	if len(maxAge) > 0 {
		age = maxAge[0]
	}
	entries, err := os.ReadDir(a.cfg.UploadDir)
	if err != nil {
		return
	}
	a.mu.Lock()
	active := map[string]bool{}
	for _, t := range a.transfers {
		active[filepath.Base(t.dir)] = true
	}
	a.mu.Unlock()
	for _, e := range entries {
		info, err := e.Info() // Lstat: a symlink's own time
		if err != nil || active[e.Name()] || time.Since(info.ModTime()) < age {
			continue
		}
		if err := os.RemoveAll(filepath.Join(a.cfg.UploadDir, e.Name())); err != nil {
			a.log.Warn("remove upload", "name", e.Name(), "err", err)
		}
	}
}
