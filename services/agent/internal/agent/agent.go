// Package agent is the in-VM supervisor's connection to the session gateway (page 2,
// services/agent): it registers the VM, reports readiness, heartbeats and IP checks, executes the
// engine's commands and relays neko signaling for viewers. It never listens on a public interface;
// the only connection is this outbound WebSocket.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/archive"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/protocol"
)

const Version = "0.1.0"

// Browser is Chrome as the agent controls it through CDP.
type Browser interface {
	// Start launches Chrome (if needed) and returns its major version.
	Start(ctx context.Context) (chromeMajor int, err error)
	// Close closes Chrome gracefully (CDP Browser.close) so it flushes its stores.
	Close(ctx context.Context) error
	// ObservedIPs opens the echo URLs in a separate browser context and returns the addresses seen.
	ObservedIPs(ctx context.Context, echoURLs []string) ([]string, error)
	// InsertText types composed IME text into the focused element (CDP Input.insertText).
	InsertText(ctx context.Context, text string) error
}

// Neko opens a signaling relay to neko on the loopback interface for one viewer session.
type Neko interface {
	Open(ctx context.Context, sessionID string, toViewer func(json.RawMessage)) (NekoSession, error)
}

type NekoSession interface {
	Send(msg json.RawMessage) error
	Close()
}

// Firewall switches the VM firewall between normal and fail-closed modes (page 3).
type Firewall interface {
	SetMode(mode string) error
}

type Config struct {
	InstanceID     string
	GatewayURL     string // wss://connect.example.com
	BootstrapToken string // from user data; single use
	StateDir       string // /data/agent: the long-lived credential lives here (mode 0600)
	ProfileDir     string // /data/profile: Chrome's user data dir, archived at each sleep (page 4)
	EchoURLs       []string
	ExpectedIP     string // optional; reported with checks
	Generation     int    // placement generation, from user data
	Heartbeat      time.Duration
	IPCheckEvery   time.Duration
}

type Agent struct {
	cfg      Config
	browser  Browser
	neko     Neko
	firewall Firewall
	log      *slog.Logger

	mu          sync.Mutex
	conn        *websocket.Conn
	sessions    map[string]NekoSession
	lastInputAt time.Time
}

func New(cfg Config, b Browser, n Neko, f Firewall, log *slog.Logger) *Agent {
	if cfg.Heartbeat == 0 {
		cfg.Heartbeat = 15 * time.Second
	}
	if cfg.IPCheckEvery == 0 {
		cfg.IPCheckEvery = 5 * time.Minute
	}
	return &Agent{cfg: cfg, browser: b, neko: n, firewall: f, log: log, sessions: map[string]NekoSession{}}
}

func (a *Agent) credentialPath() string { return filepath.Join(a.cfg.StateDir, "credential") }

func (a *Agent) authHeader() (string, error) {
	if b, err := os.ReadFile(a.credentialPath()); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		return "Bearer " + strings.TrimSpace(string(b)), nil
	}
	if a.cfg.BootstrapToken == "" {
		return "", errors.New("no credential and no bootstrap token")
	}
	return "Bootstrap " + a.cfg.BootstrapToken, nil
}

// Run keeps the tunnel up until ctx ends, reconnecting with backoff (0.5 s doubling to 30 s).
func (a *Agent) Run(ctx context.Context) error {
	chromeMajor, err := a.browser.Start(ctx)
	if err != nil {
		return fmt.Errorf("start chrome: %w", err)
	}
	backoff := 500 * time.Millisecond
	for ctx.Err() == nil {
		started := time.Now()
		err := a.session(ctx, chromeMajor)
		if ctx.Err() != nil {
			return nil
		}
		if time.Since(started) > time.Minute {
			backoff = 500 * time.Millisecond
		}
		a.log.Warn("gateway connection ended", "err", err, "retry_in", backoff)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
	return nil
}

func (a *Agent) session(ctx context.Context, chromeMajor int) error {
	auth, err := a.authHeader()
	if err != nil {
		return err
	}
	url := strings.TrimRight(a.cfg.GatewayURL, "/") + "/v1/agent"
	conn, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{
		"Authorization": {auth},
		"X-Instance-Id": {a.cfg.InstanceID},
	}})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized && strings.HasPrefix(auth, "Bootstrap") {
			return fmt.Errorf("bootstrap token rejected: %w", err)
		}
		return err
	}
	conn.SetReadLimit(1 << 20)
	defer conn.CloseNow()
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	a.mu.Lock()
	a.conn = conn
	a.mu.Unlock()
	defer a.closeSessions()

	if err := a.write(sctx, protocol.Hello{T: "hello", AgentVersion: Version, Generation: a.cfg.Generation}); err != nil {
		return err
	}
	if err := a.write(sctx, protocol.TurnRequest{T: "turn_request"}); err != nil {
		return err
	}
	if err := a.event(sctx, "ready", map[string]any{"chromeMajor": chromeMajor}); err != nil {
		return err
	}
	go a.loops(sctx)

	for {
		_, data, err := conn.Read(sctx)
		if err != nil {
			return err
		}
		var in protocol.Incoming
		if err := json.Unmarshal(data, &in); err != nil {
			a.log.Warn("bad frame", "err", err)
			continue
		}
		a.handle(sctx, in)
	}
}

func (a *Agent) loops(ctx context.Context) {
	hb := time.NewTicker(a.cfg.Heartbeat)
	ip := time.NewTicker(a.cfg.IPCheckEvery)
	defer hb.Stop()
	defer ip.Stop()
	a.selfCheck(ctx) // at every (re)connect, i.e. every wake
	for {
		select {
		case <-ctx.Done():
			return
		case <-hb.C:
			a.mu.Lock()
			viewers, last := len(a.sessions), a.lastInputAt
			a.mu.Unlock()
			data := map[string]any{"viewers": viewers}
			if !last.IsZero() {
				data["lastInputAt"] = last.UTC().Format(time.RFC3339)
			}
			_ = a.event(ctx, "heartbeat", data)
		case <-ip.C:
			a.selfCheck(ctx)
		}
	}
}

// checkIP returns what Chrome sees; ok means every echo agreed on one address (and the expected one, if known).
func (a *Agent) checkIP(ctx context.Context, expected string) map[string]any {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	observed, err := a.browser.ObservedIPs(cctx, a.cfg.EchoURLs)
	res := map[string]any{"observed": observed, "expected": expected}
	if err != nil {
		res["ok"] = false
		res["detail"] = err.Error()
		return res
	}
	ok := len(observed) > 0
	for _, o := range observed {
		if o != observed[0] || (expected != "" && o != expected) {
			ok = false
		}
	}
	res["ok"] = ok
	return res
}

// selfCheck runs the periodic IP check and fails closed on a mismatch (page 3).
func (a *Agent) selfCheck(ctx context.Context) {
	res := a.checkIP(ctx, a.cfg.ExpectedIP)
	if ok, _ := res["ok"].(bool); !ok && a.firewall != nil {
		if err := a.firewall.SetMode("closed"); err != nil {
			a.log.Error("fail-closed firewall", "err", err)
		}
	}
	_ = a.event(ctx, "ip_check", res)
}

func (a *Agent) handle(ctx context.Context, in protocol.Incoming) {
	switch in.T {
	case "welcome":
		if in.Credential != "" {
			if err := a.saveCredential(in.Credential); err != nil {
				a.log.Error("save credential", "err", err)
			}
		}
	case "turn":
		a.log.Info("turn credentials received", "servers", len(in.IceServers))
	case "command":
		go a.command(ctx, in)
	case "viewer_open":
		a.openViewer(ctx, in.SessionID)
	case "viewer_close":
		a.closeViewer(in.SessionID)
	case "viewer":
		a.fromViewer(ctx, in.SessionID, in.Data)
	}
}

func (a *Agent) command(ctx context.Context, in protocol.Incoming) {
	reply := protocol.Reply{T: "reply", CommandID: in.ID, OK: true}
	switch in.Kind {
	case protocol.CmdIPCheck:
		expected, _ := in.Payload["expected"].(string)
		reply.Result = a.checkIP(ctx, expected)
	case protocol.CmdPrepareShutdown:
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		err := a.browser.Close(cctx)
		cancel()
		if err != nil {
			reply.OK, reply.Error = false, err.Error()
			break
		}
		reply.Result = a.archiveProfile(ctx, in.Payload)
	case protocol.CmdRestoreArchive:
		if err := a.restoreProfile(ctx, in.Payload); err != nil {
			reply.OK, reply.Error = false, err.Error()
		}
	case protocol.CmdRestartChrome:
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		_ = a.browser.Close(cctx)
		_, err := a.browser.Start(cctx)
		cancel()
		if err != nil {
			reply.OK, reply.Error = false, err.Error()
		}
	case protocol.CmdSetFirewall:
		mode, _ := in.Payload["mode"].(string)
		if a.firewall == nil {
			reply.OK, reply.Error = false, "no firewall"
		} else if err := a.firewall.SetMode(mode); err != nil {
			reply.OK, reply.Error = false, err.Error()
		}
	default:
		reply.OK, reply.Error = false, "unknown command "+in.Kind
	}
	if err := a.write(ctx, reply); err != nil {
		a.log.Warn("reply", "err", err)
	}
}

// archiveSpec is the archive part of a command payload; the gateway adds the key on delivery.
func archiveSpec(payload map[string]any) (spec map[string]any, key []byte, err error) {
	spec, _ = payload["archive"].(map[string]any)
	if spec == nil {
		return nil, nil, nil
	}
	k, _ := spec["key"].(string)
	key, err = archive.ParseKey(k)
	return spec, key, err
}

// archiveProfile uploads an encrypted archive of the closed profile. A failed archive never blocks
// the sleep: the reply says archived=false and the engine marks the backup failed.
func (a *Agent) archiveProfile(ctx context.Context, payload map[string]any) map[string]any {
	spec, key, err := archiveSpec(payload)
	if spec == nil {
		return map[string]any{"archived": false}
	}
	putURL, _ := spec["putUrl"].(string)
	if err == nil && putURL == "" {
		err = errors.New("no upload URL")
	}
	if err == nil && a.cfg.ProfileDir == "" {
		err = errors.New("no profile directory")
	}
	if err != nil {
		a.log.Error("archive", "err", err)
		return map[string]any{"archived": false, "detail": err.Error()}
	}
	cctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	size, err := archive.Upload(cctx, a.cfg.ProfileDir, key, putURL)
	if err != nil {
		a.log.Error("archive", "err", err)
		return map[string]any{"archived": false, "detail": err.Error()}
	}
	return map[string]any{"archived": true, "sizeBytes": size}
}

// restoreProfile closes Chrome, swaps the archived profile in and starts Chrome again. If the
// archive cannot be read, the current profile stays and Chrome restarts on it.
func (a *Agent) restoreProfile(ctx context.Context, payload map[string]any) error {
	spec, key, err := archiveSpec(payload)
	if spec == nil {
		return errors.New("archives are not configured")
	}
	if err != nil {
		return err
	}
	getURL, _ := spec["getUrl"].(string)
	if getURL == "" || a.cfg.ProfileDir == "" {
		return errors.New("no download URL or profile directory")
	}
	cctx, cancel := context.WithTimeout(ctx, 9*time.Minute)
	defer cancel()
	if err := a.browser.Close(cctx); err != nil {
		a.log.Warn("close chrome before restore", "err", err)
	}
	restoreErr := archive.Restore(cctx, getURL, key, a.cfg.ProfileDir)
	if _, err := a.browser.Start(cctx); err != nil {
		return fmt.Errorf("start chrome: %w", err)
	}
	return restoreErr
}

func (a *Agent) openViewer(ctx context.Context, sessionID string) {
	if a.neko == nil || sessionID == "" {
		return
	}
	a.closeViewer(sessionID)
	s, err := a.neko.Open(ctx, sessionID, func(msg json.RawMessage) {
		_ = a.write(ctx, protocol.ToViewer{T: "viewer", SessionID: sessionID, Data: msg})
	})
	if err != nil {
		a.log.Error("open neko", "err", err)
		return
	}
	a.mu.Lock()
	a.sessions[sessionID] = s
	a.mu.Unlock()
}

func (a *Agent) closeViewer(sessionID string) {
	a.mu.Lock()
	s := a.sessions[sessionID]
	delete(a.sessions, sessionID)
	a.mu.Unlock()
	if s != nil {
		s.Close()
	}
}

func (a *Agent) closeSessions() {
	a.mu.Lock()
	all := a.sessions
	a.sessions = map[string]NekoSession{}
	a.mu.Unlock()
	for _, s := range all {
		s.Close()
	}
}

func (a *Agent) fromViewer(ctx context.Context, sessionID string, data json.RawMessage) {
	var f protocol.ViewerFrame
	if err := json.Unmarshal(data, &f); err != nil {
		return
	}
	a.mu.Lock()
	a.lastInputAt = time.Now()
	s := a.sessions[sessionID]
	a.mu.Unlock()
	switch f.T {
	case "ime":
		if err := a.browser.InsertText(ctx, f.Text); err != nil {
			a.log.Warn("insert text", "err", err)
		}
	case "neko":
		if s != nil {
			_ = s.Send(f.Data)
		}
	}
}

func (a *Agent) saveCredential(c string) error {
	if err := os.MkdirAll(a.cfg.StateDir, 0o700); err != nil {
		return err
	}
	tmp := a.credentialPath() + ".tmp"
	if err := os.WriteFile(tmp, []byte(c), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.credentialPath())
}

func (a *Agent) event(ctx context.Context, kind string, data map[string]any) error {
	return a.write(ctx, protocol.Event{T: "event", Kind: kind, Data: data})
}

func (a *Agent) write(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	a.mu.Lock()
	conn := a.conn
	a.mu.Unlock()
	if conn == nil {
		return errors.New("not connected")
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.Write(wctx, websocket.MessageText, b)
}
