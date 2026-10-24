// Package agent is the in-VM supervisor's connection to the session gateway (page 2,
// services/agent): it registers the VM, reports readiness, heartbeats and IP checks, executes the
// engine's commands and relays neko signaling for viewers. It never listens on a public interface;
// the only connection is this outbound WebSocket.
package agent

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/archive"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/protocol"
)

// Version is reported in `ready`. 0.2.1 also reports failed viewer input relays; 0.2.2 runs IP
// checks in a hidden page instead of a window that flashed onto the user's screen, and finishes
// commands and delivers their replies across a gateway reconnect, and reports its final data-out
// count in the shutdown reply. 0.2.3 waits for Chrome to take the hidden page instead of opening a
// visible one when Chrome has no window yet (the check at every wake). 0.3.0 receives files a viewer
// pastes or drops (files.go). 0.3.1 bounds desktop admission and verifies local desktop readiness.
// 0.4.0 admits coding-agent bridges (docs/agent-access.md): full-display screenshots, input
// steps, stored files, and one arbiter for input between the bridge and the live view. 0.5.0 speaks
// automation protocol 2 for the gateway's hosted MCP endpoint (protocol.AutomationProtocol):
// sessions that are opened again or outlive a short tunnel gap, requests that wait for the desktop,
// scaled screenshots, and refusals that name the step. It keeps the bridge's desktop session open
// (it was closed right after opening), logs neko sessions out, drops neko messages too large for
// the gateway, refuses a symlinked upload directory, and closes the firewall only on a real IP
// mismatch or repeated failed checks, opening it again after a check passes. 0.6.0 replaces a
// tunnel that answers nothing (keepalive), closes it with a close frame when stopping, and tells
// the gateway in the next hello why the previous tunnel ended.
const Version = "0.6.0"

// Tunnel keepalive, with a gateway whose welcome says keepalive (it answers {"t":"ping"} with
// {"t":"pong"} without waking its object): a tunnel the gateway has sent nothing on for
// tunnelKeepaliveIdle gets a ping, and one that brings nothing tunnelKeepaliveWait later is given
// up for a new one. A connection that vanished without a close (a route change, a dead path)
// otherwise looked open until TCP gave up, up to 15 minutes, and the browser was unreachable.
const (
	tunnelKeepaliveIdle = 15 * time.Second
	tunnelKeepaliveWait = 10 * time.Second
)

var errTunnelSilent = errors.New("gateway sent nothing within the keepalive window")

// stopCloseWait bounds how long stopping waits for the gateway to answer the tunnel's close frame.
const stopCloseWait = 500 * time.Millisecond

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
	// DropFiles drops files (paths as Chrome sees them) on the page under a point of the remote
	// screen; false means no page is there.
	DropFiles(ctx context.Context, x, y int, paths []string) (bool, error)
}

// Neko opens a signaling relay to neko on the loopback interface for one viewer session.
type Neko interface {
	Open(ctx context.Context, sessionID string, toViewer func(json.RawMessage)) (NekoSession, error)
}

type NekoSession interface {
	Send(msg json.RawMessage) error
	Close()
	Done() <-chan struct{}
}

// Firewall switches the VM firewall between normal and fail-closed modes (page 3).
type Firewall interface {
	SetMode(mode string) error
}

// Host is what the agent reads from and does to the VM itself (package host).
type Host interface {
	DiskUsage(path string) (used, total uint64, err error)
	NetTxBytes() (uint64, error)
	GrowFilesystem(ctx context.Context, path string) error
}

type Config struct {
	InstanceID     string
	GatewayURL     string // wss://connect.example.com
	BootstrapToken string // from user data; single use
	StateDir       string // /data/agent: the long-lived credential lives here (mode 0600)
	ProfileDir     string // /data/profile: Chrome's user data dir, archived at each sleep (page 4)
	DataDir        string // /data: the data volume's mount point (disk usage, file system growth)
	Host           Host   // optional: disk and network reports, file system growth
	// Files viewers paste or drop (files.go): written to UploadDir, which Chrome sees as
	// UploadBrowserDir; both empty disables them. Clipboard is needed for pastes.
	UploadDir        string
	UploadBrowserDir string
	Clipboard        Clipboard
	// FileChooser tells whether Chrome's file chooser is open, for picker attaches (optional).
	FileChooser FileChooser
	EchoURLs    []string
	ExpectedIP  string // optional; reported with checks
	// PublicIP reads the VM's public address from the instance metadata (optional): the address
	// periodic checks expect until the engine names one in an ip_check command.
	PublicIP          func(ctx context.Context) (string, error)
	Generation        int // placement generation, from user data
	Heartbeat         time.Duration
	IPCheckEvery      time.Duration
	ViewerOpenTimeout time.Duration // total bound, in addition to the relay's stage deadlines
	DesktopProbeRetry time.Duration
}

type Agent struct {
	cfg      Config
	browser  Browser
	neko     Neko
	firewall Firewall
	log      *slog.Logger

	mu                   sync.Mutex
	conn                 *websocket.Conn
	sessions             map[string]NekoSession
	relayIDs             map[string]string
	viewerOpens          map[string]*viewerOpen
	desktopReady         bool
	desktopFailure       string
	desktopProbeRequests chan struct{}
	viewerStages         bool // negotiated by the current gateway's welcome
	keepaliveOn          bool // negotiated by the current gateway's welcome
	// stalled is the tunnel a write timed out on: the library closed it, and its read loop says why.
	stalled     *websocket.Conn
	lastInputAt time.Time
	transfers   map[string]*transfer
	// clipboardQuietUntil: neko's clipboard reports are not relayed until then (files.go).
	clipboardQuietUntil time.Time
	// Coding-agent bridges (automation.go) and who may drive the browser (control.go).
	automations map[string]*automation
	control     controlState
	screen      screenState
	// Bridge and keepalive timings: constants in production, shorter in tests.
	readyWait, suspendGrace, openLimit time.Duration
	reopenDelays                       []time.Duration
	keepaliveIdle, keepaliveWait       time.Duration
	// Why the last tunnel ended and the dials that failed since, for the next hello. Only Run's
	// goroutine uses them.
	lastEnd      *tunnelEnd
	dialFailures int
	dialError    string
	// uploadsRefused: UploadDir turned out not to be the agent's own directory (checkUploadDir).
	uploadsRefused bool
	// IP checks (selfCheck): one periodic check at a time, the address the engine last named, how
	// many checks in a row failed to observe an address, and who closed the firewall.
	checking   atomic.Bool
	engineIP   string // protected by mu
	firewallMu sync.Mutex
	ipFailures int // protected by firewallMu
	// Who closed the firewall: "" (open), "check" or "engine"; protected by firewallMu.
	firewallClosedBy string
}

func New(cfg Config, b Browser, n Neko, f Firewall, log *slog.Logger) *Agent {
	if cfg.Heartbeat == 0 {
		cfg.Heartbeat = 15 * time.Second
	}
	if cfg.IPCheckEvery == 0 {
		cfg.IPCheckEvery = 5 * time.Minute
	}
	if cfg.ViewerOpenTimeout == 0 {
		cfg.ViewerOpenTimeout = 35 * time.Second
	}
	if cfg.DesktopProbeRetry == 0 {
		cfg.DesktopProbeRetry = 10 * time.Second
	}
	return &Agent{cfg: cfg, browser: b, neko: n, firewall: f, log: log, sessions: map[string]NekoSession{}, relayIDs: map[string]string{}, viewerOpens: map[string]*viewerOpen{}, desktopProbeRequests: make(chan struct{}, 1), transfers: map[string]*transfer{},
		automations: map[string]*automation{}, control: controlState{controller: ctlNone, mode: modeAgent, access: true},
		readyWait: automationReadyWait, suspendGrace: automationSuspendGrace, openLimit: automationOpenLimit, reopenDelays: automationReopen,
		keepaliveIdle: tunnelKeepaliveIdle, keepaliveWait: tunnelKeepaliveWait}
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
	// The volume may have grown while the VM was stopped: use the new space from this boot on.
	if a.cfg.Host != nil && a.cfg.DataDir != "" {
		gctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		if err := a.cfg.Host.GrowFilesystem(gctx, a.cfg.DataDir); err != nil {
			a.log.Warn("grow data file system", "err", err)
		}
		cancel()
	}
	if a.cfg.UploadDir != "" && a.checkUploadDir() == "" {
		a.pruneUploads(0) // pages that could still read them did not survive the sleep
	}
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

func (a *Agent) session(ctx context.Context, chromeMajor int) (err error) {
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
		a.dialFailures++
		a.dialError = dialFailure(err, resp)
		if resp != nil && resp.StatusCode == http.StatusUnauthorized && strings.HasPrefix(auth, "Bootstrap") {
			return fmt.Errorf("bootstrap token rejected: %w", err)
		}
		return err
	}
	conn.SetReadLimit(1 << 20)
	defer conn.CloseNow()
	connected := time.Now()
	previous := a.takeTunnelEnd(connected)
	// Stopping closes the tunnel with a close frame (going away), so the gateway can tell a VM
	// going to sleep from a lost connection; a read ended by ctx closed it without one. The read
	// ends at the gateway's answer, or stopCloseWait later anyway. The keepalive gives up a tunnel
	// that answers nothing.
	readCtx, giveUp := context.WithCancelCause(context.WithoutCancel(ctx))
	closing := make(chan struct{})
	go func() {
		defer close(closing)
		select {
		case <-ctx.Done():
			closed := make(chan struct{})
			go func() {
				defer close(closed)
				_ = conn.Close(websocket.StatusGoingAway, "agent stopping")
			}()
			select {
			case <-closed:
			case <-time.After(stopCloseWait):
			}
			giveUp(nil)
		case <-readCtx.Done():
		}
	}()
	defer func() {
		silent := errors.Is(context.Cause(readCtx), errTunnelSilent)
		giveUp(nil)
		<-closing
		a.mu.Lock()
		stalled := a.stalled == conn
		a.mu.Unlock()
		a.tunnelEnded(connected, err, silent, stalled)
	}()
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	a.mu.Lock()
	a.conn = conn
	a.viewerStages = false
	a.keepaliveOn = false
	a.mu.Unlock()
	defer a.closeSessions()
	// A coding agent's sessions outlive a lost tunnel for a short grace (protocol 2), so the
	// gateway can open them again on the next one with their desktop session and stored files.
	// Shutting down ends them.
	defer func() {
		if ctx.Err() != nil {
			a.closeAutomations()
		} else {
			a.suspendAutomations()
		}
	}()

	if err := a.write(sctx, protocol.Hello{T: "hello", AgentVersion: Version, Generation: a.cfg.Generation, Previous: previous}); err != nil {
		return err
	}
	if err := a.write(sctx, protocol.TurnRequest{T: "turn_request"}); err != nil {
		return err
	}
	if _, checked := a.neko.(desktopProber); checked {
		go a.reportReadiness(sctx, chromeMajor)
	} else {
		a.reportReadiness(sctx, chromeMajor)
	}
	go a.loops(sctx)
	var heard atomic.Int64
	heard.Store(connected.UnixNano())
	go a.keepalive(sctx, &heard, giveUp)

	for {
		_, data, err := conn.Read(readCtx)
		if err != nil {
			if cause := context.Cause(readCtx); errors.Is(cause, errTunnelSilent) {
				return cause
			}
			return err
		}
		heard.Store(time.Now().UnixNano())
		if ctx.Err() != nil {
			continue // stopping: nothing that arrives while the close goes out is acted on
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
	// IP checks must not delay heartbeats or desktop readiness: each runs on its own goroutine.
	go a.selfCheck(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-hb.C:
			a.mu.Lock()
			viewers, last := len(a.sessions), a.lastInputAt
			desktopReady, desktopFailure := a.desktopReady, a.desktopFailure
			a.mu.Unlock()
			data := map[string]any{"viewers": viewers}
			if _, checked := a.neko.(desktopProber); checked {
				data["desktopReady"] = desktopReady
			}
			if desktopFailure != "" {
				data["desktopFailureCode"] = desktopFailure
			}
			if !last.IsZero() {
				data["lastInputAt"] = last.UTC().Format(time.RFC3339)
			}
			a.hostReport(data)
			_ = a.event(ctx, "heartbeat", data)
		case <-ip.C:
			go a.selfCheck(ctx)
		}
	}
}

// hostReport adds the data volume's usage (storage page) and the bytes sent since boot (metered
// as data transfer, page 6) to a heartbeat.
func (a *Agent) hostReport(data map[string]any) {
	if a.cfg.Host == nil {
		return
	}
	if a.cfg.DataDir != "" {
		if used, total, err := a.cfg.Host.DiskUsage(a.cfg.DataDir); err == nil {
			data["disk"] = map[string]any{"usedBytes": used, "totalBytes": total}
		}
	}
	if tx, err := a.cfg.Host.NetTxBytes(); err == nil {
		data["netTxBytes"] = tx
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

// ipFailuresToClose is how many IP checks in a row may fail to observe any address before the
// firewall closes anyway: one echo request that timed out, or a Chrome that was still starting,
// says nothing about the address websites see.
const ipFailuresToClose = 3

// expectedIP is the address Chrome must be seen with: the one the engine last named in an
// ip_check command (the placement's static IP), else the configured one, else the public address
// in the instance metadata. Empty means only that every echo must agree.
func (a *Agent) expectedIP(ctx context.Context) string {
	a.mu.Lock()
	ip := a.engineIP
	a.mu.Unlock()
	if ip == "" {
		ip = a.cfg.ExpectedIP
	}
	if ip == "" && a.cfg.PublicIP != nil {
		mctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		got, err := a.cfg.PublicIP(mctx)
		if err != nil {
			a.log.Warn("public address from the instance metadata", "err", err)
		}
		ip = got
	}
	return ip
}

// selfCheck runs the periodic IP check (page 3). Callers start it on its own goroutine, since a
// check can take its full 20 s; a check that finds another one running does nothing.
func (a *Agent) selfCheck(ctx context.Context) {
	if !a.checking.CompareAndSwap(false, true) {
		return
	}
	defer a.checking.Store(false)
	res := a.checkIP(ctx, a.expectedIP(ctx))
	if ctx.Err() != nil {
		return // the tunnel ended meanwhile: the failure may be the check's own cancellation
	}
	a.judgeIPCheck(res)
	_ = a.event(ctx, "ip_check", res)
}

// judgeIPCheck fails closed on evidence (page 3): an address other than the expected one, or
// echoes that disagree, closes the firewall at once; checks that observe nothing close it only
// after ipFailuresToClose of them in a row. A check that passes opens a firewall that a check
// closed, so a passing "Check again" also restores browsing; one the engine closed (set_firewall)
// stays closed.
func (a *Agent) judgeIPCheck(res map[string]any) {
	if a.firewall == nil {
		return
	}
	ok, _ := res["ok"].(bool)
	observed, _ := res["observed"].([]string)
	expected, _ := res["expected"].(string)
	a.firewallMu.Lock()
	defer a.firewallMu.Unlock()
	mode := ""
	switch {
	case ok:
		a.ipFailures = 0
		if a.firewallClosedBy == "check" {
			mode = "normal"
		}
	case ipMismatch(observed, expected):
		a.ipFailures = 0
		mode = "closed"
	default:
		a.ipFailures++
		if a.ipFailures >= ipFailuresToClose {
			mode = "closed"
		}
	}
	if mode == "" || (mode == "closed" && a.firewallClosedBy != "") {
		return
	}
	if err := a.firewall.SetMode(mode); err != nil {
		a.log.Error("firewall after an IP check", "mode", mode, "err", err)
		return
	}
	a.firewallClosedBy = map[string]string{"closed": "check", "normal": ""}[mode]
	a.log.Warn("firewall after an IP check", "mode", mode, "observed", observed, "expected", expected)
}

// ipMismatch is whether the observed addresses prove that websites see Chrome with the wrong
// address: they disagree, or one differs from the expected address.
func ipMismatch(observed []string, expected string) bool {
	for _, o := range observed {
		if o != observed[0] || (expected != "" && o != expected) {
			return true
		}
	}
	return false
}

func (a *Agent) handle(ctx context.Context, in protocol.Incoming) {
	switch in.T {
	case "welcome":
		a.mu.Lock()
		a.viewerStages = in.ViewerStages
		a.keepaliveOn = in.Keepalive
		a.mu.Unlock()
		if in.Credential != "" {
			if err := a.saveCredential(in.Credential); err != nil {
				a.log.Error("save credential", "err", err)
			}
		}
		// The persisted control mode: a manual takeover outlives agent restarts and reconnects,
		// and one the gateway has not heard of yet outlives the welcome (restoreControl).
		if in.Automation != nil {
			a.restoreControl(ctx, in.Automation.Mode, in.Automation.Access)
		}
	case "turn":
		a.log.Info("turn credentials received", "servers", len(in.IceServers))
	case "command":
		// A command outlives the tunnel it arrived on. Bound to the tunnel, a reconnect during a
		// shutdown canceled the archive and lost the reply, and the engine waited for one that never
		// came while the browser showed "Going to sleep". Each command has its own time limits.
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), commandLimit)
		go func() {
			defer cancel()
			a.command(cctx, in)
		}()
	case "viewer_open":
		a.openViewer(ctx, in.SessionID, in.RelayID)
	case "viewer_close":
		a.closeViewer(in.SessionID, in.RelayID)
	case "viewer":
		a.fromViewer(ctx, in.SessionID, in.Data, in.RelayID)
	case "automation_open":
		a.openAutomation(ctx, in.SessionID, in.ClientID)
	case "automation_close":
		a.closeAutomation(in.SessionID)
	case "automation":
		a.fromAutomation(ctx, in.SessionID, in.Data)
	case "automation_control":
		a.applyControl(ctx, in.Mode, in.Access, controlReason(in.Mode, in.Access))
	}
}

func controlReason(mode string, access *bool) string {
	if access != nil && !*access {
		return "revoked"
	}
	switch mode {
	case modeAgent:
		return "resumed"
	case modePrivacy:
		return "privacy"
	case modeUser:
		return "paused"
	}
	return "restored"
}

func (a *Agent) command(ctx context.Context, in protocol.Incoming) {
	reply := protocol.Reply{T: "reply", CommandID: in.ID, OK: true}
	switch in.Kind {
	case protocol.CmdIPCheck:
		// The engine names the placement's static IP: periodic checks expect it from now on.
		expected, _ := in.Payload["expected"].(string)
		if expected != "" {
			a.mu.Lock()
			a.engineIP = expected
			a.mu.Unlock()
		} else {
			expected = a.expectedIP(ctx)
		}
		reply.Result = a.checkIP(ctx, expected)
		a.judgeIPCheck(reply.Result)
	case protocol.CmdPrepareShutdown:
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		err := a.browser.Close(cctx)
		cancel()
		if err != nil {
			reply.OK, reply.Error = false, err.Error()
			break
		}
		reply.Result = a.archiveProfile(ctx, in.Payload)
		// The archive upload is the last traffic before the VM halts and its counter resets: report
		// the final count here, since the next heartbeat may never come (data out, page 6).
		if a.cfg.Host != nil {
			if tx, err := a.cfg.Host.NetTxBytes(); err == nil {
				reply.Result["netTxBytes"] = tx
			}
		}
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
	case protocol.CmdGrowFilesystem:
		if a.cfg.Host == nil || a.cfg.DataDir == "" {
			reply.OK, reply.Error = false, "no data volume"
			break
		}
		cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		err := a.cfg.Host.GrowFilesystem(cctx, a.cfg.DataDir)
		cancel()
		if err != nil {
			reply.OK, reply.Error = false, err.Error()
			break
		}
		if used, total, err := a.cfg.Host.DiskUsage(a.cfg.DataDir); err == nil {
			reply.Result = map[string]any{"usedBytes": used, "totalBytes": total}
		}
	case protocol.CmdSetFirewall:
		mode, _ := in.Payload["mode"].(string)
		if a.firewall == nil {
			reply.OK, reply.Error = false, "no firewall"
			break
		}
		// The engine's own choice: no later IP check undoes it.
		a.firewallMu.Lock()
		if err := a.firewall.SetMode(mode); err != nil {
			reply.OK, reply.Error = false, err.Error()
		} else {
			a.firewallClosedBy = map[string]string{"closed": "engine", "normal": ""}[mode]
			a.ipFailures = 0
		}
		a.firewallMu.Unlock()
	default:
		reply.OK, reply.Error = false, "unknown command "+in.Kind
	}
	a.deliver(reply)
}

// commandLimit bounds any one command (restoring a large archive is the longest); replyWait is how
// long its reply waits for the tunnel to come back.
const (
	commandLimit = 15 * time.Minute
	replyWait    = 3 * time.Minute
)

// deliver sends a reply on the current tunnel, retrying until a reconnected one takes it: the
// gateway delivers a command once, so a reply lost with its tunnel would never be asked for again.
func (a *Agent) deliver(reply protocol.Reply) {
	deadline := time.Now().Add(replyWait)
	for {
		err := a.write(context.Background(), reply)
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			a.log.Warn("reply", "command", reply.CommandID, "err", err)
			return
		}
		time.Sleep(time.Second)
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

func (a *Agent) fromViewer(ctx context.Context, sessionID string, data json.RawMessage, relayIDs ...string) {
	var f protocol.ViewerFrame
	if err := json.Unmarshal(data, &f); err != nil {
		return
	}
	a.mu.Lock()
	s := a.sessions[sessionID]
	relayID := a.relayIDs[sessionID]
	if len(relayIDs) > 0 {
		if (s != nil || a.viewerOpens[sessionID] != nil) && relayIDs[0] != relayID {
			a.mu.Unlock()
			return
		}
		relayID = relayIDs[0]
	}
	if s == nil && a.viewerOpens[sessionID] != nil {
		a.mu.Unlock()
		return // An early input must not cancel an opening desktop.
	}
	a.lastInputAt = time.Now()
	a.mu.Unlock()
	// Input control (control.go): a real input takes over from a coding agent's bridge before it
	// is executed; pointer movement under bridge control is withheld.
	ahead, forward := a.arbitrateViewer(ctx, f)
	if !forward {
		return
	}
	for _, msg := range ahead {
		if s != nil {
			_ = s.Send(msg)
		}
	}
	switch f.T {
	case "ime":
		if s == nil {
			a.viewerError(ctx, sessionID, relayID, "relay_unavailable")
			return
		}
		if err := a.browser.InsertText(ctx, f.Text); err != nil {
			a.log.Warn("insert text", "err", err)
			a.viewerError(ctx, sessionID, relayID, "input_failed")
		}
	case "neko":
		if s == nil {
			a.viewerError(ctx, sessionID, relayID, "relay_unavailable")
			return
		}
		if err := s.Send(f.Data); err != nil {
			a.viewerError(ctx, sessionID, relayID, "input_failed")
		}
	case "file_begin", "file_chunk", "file_end", "file_cancel":
		if s == nil {
			a.viewerError(ctx, sessionID, relayID, "relay_unavailable")
			return
		}
		a.fileFrame(ctx, sessionID, relayID, f)
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
	// The caller's cancellation never reaches the connection: coder/websocket closes the whole
	// tunnel when a write's context ends mid-write, and the tunnel may by then be a newer one than
	// the caller's context belonged to (a viewer that closed, a tunnel that was replaced). A caller
	// whose context already ended writes nothing; a write that started is bounded on its own.
	if err := ctx.Err(); err != nil {
		return err
	}
	a.mu.Lock()
	conn := a.conn
	a.mu.Unlock()
	if conn == nil {
		return errors.New("not connected")
	}
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	err = conn.Write(wctx, websocket.MessageText, b)
	if err != nil && errors.Is(wctx.Err(), context.DeadlineExceeded) {
		a.mu.Lock()
		a.stalled = conn
		a.mu.Unlock()
	}
	return err
}

// keepalive pings a tunnel the gateway has sent nothing on for keepaliveIdle, and gives it up
// when keepaliveWait more brings nothing either. It does nothing unless the welcome said keepalive.
func (a *Agent) keepalive(ctx context.Context, heard *atomic.Int64, giveUp context.CancelCauseFunc) {
	tick := time.NewTicker(a.keepaliveIdle / 3)
	defer tick.Stop()
	var pinged int64
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		a.mu.Lock()
		on := a.keepaliveOn
		a.mu.Unlock()
		last := heard.Load()
		quiet := time.Since(time.Unix(0, last))
		switch {
		case !on || quiet < a.keepaliveIdle:
		case quiet >= a.keepaliveIdle+a.keepaliveWait:
			giveUp(errTunnelSilent)
			return
		case pinged != last:
			pinged = last
			_ = a.write(ctx, protocol.Ping{T: "ping"})
		}
	}
}

// tunnelEnd is why a tunnel ended, reported in the next tunnel's hello.
type tunnelEnd struct {
	reason    string
	closeCode int
	at        time.Time
	up        time.Duration
}

func (a *Agent) tunnelEnded(connected time.Time, err error, silent, stalled bool) {
	reason, code := tunnelEndReason(err, silent, stalled)
	a.lastEnd = &tunnelEnd{reason: reason, closeCode: code, at: time.Now(), up: time.Since(connected)}
	a.dialFailures, a.dialError = 0, ""
}

// takeTunnelEnd is the previous tunnel's end and the dials that failed since, once.
func (a *Agent) takeTunnelEnd(now time.Time) *protocol.TunnelEnd {
	end, failures, dialErr := a.lastEnd, a.dialFailures, a.dialError
	a.lastEnd, a.dialFailures, a.dialError = nil, 0, ""
	if end == nil {
		return nil
	}
	return &protocol.TunnelEnd{Reason: end.reason, CloseCode: end.closeCode, UpMs: end.up.Milliseconds(),
		DownMs: now.Sub(end.at).Milliseconds(), DialFailures: failures, DialError: dialErr}
}

// tunnelEndReason names why a tunnel's reads ended: a fixed code, never the error's text.
func tunnelEndReason(err error, silent, stalled bool) (string, int) {
	if silent {
		return "silent", 0
	}
	if code := int(websocket.CloseStatus(err)); code >= 1000 && code <= 4999 {
		return "closed", code
	}
	var ne net.Error
	switch {
	case stalled:
		return "write_timeout", 0
	case errors.Is(err, syscall.ECONNRESET):
		return "reset", 0
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "eof", 0
	case errors.As(err, &ne) && ne.Timeout():
		return "timeout", 0
	}
	return "error", 0
}

// dialFailure names how a dial failed: dns, connect, tls, timeout, http_<status> or error.
func dialFailure(err error, resp *http.Response) string {
	if resp != nil {
		return fmt.Sprintf("http_%d", resp.StatusCode)
	}
	var dnsErr *net.DNSError
	var certErr *tls.CertificateVerificationError
	var recordErr tls.RecordHeaderError
	var alert tls.AlertError
	var opErr *net.OpError
	var ne net.Error
	switch {
	case errors.As(err, &dnsErr):
		return "dns"
	case errors.As(err, &certErr), errors.As(err, &recordErr), errors.As(err, &alert):
		return "tls"
	case errors.As(err, &ne) && ne.Timeout():
		return "timeout"
	case errors.As(err, &opErr) && opErr.Op == "dial":
		return "connect"
	}
	return "error"
}
