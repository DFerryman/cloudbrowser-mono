// Command agent is the in-VM supervisor (page 2, services/agent). It reads its identity from the
// VM's user data, keeps one outbound WebSocket to the session gateway, and controls Chrome over
// the DevTools protocol on the loopback interface. Run by systemd from the golden image.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/agent"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/chrome"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/firewall"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/host"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/neko"
)

// userData is what the engine puts into the VM's user data (create step 7, page 10).
type userData struct {
	InstanceID     string `json:"instanceId"`
	GatewayURL     string `json:"gatewayUrl"`
	BootstrapToken string `json:"bootstrapToken"`
	Generation     int    `json:"generation"`
}

func main() {
	var (
		userDataPath = flag.String("user-data", "/var/lib/cloud/instance/user-data.txt", "JSON user data written by the engine")
		stateDir     = flag.String("state-dir", "/data/agent", "where the long-lived credential is kept")
		profileDir   = flag.String("profile-dir", "/data/profile", "Chrome's user data dir; archived at each sleep")
		dataDir      = flag.String("data-dir", "/data", "mount point of the data volume (disk usage reports, growing the file system); empty disables")
		cdp          = flag.String("cdp", "http://127.0.0.1:9222", "Chrome DevTools endpoint (loopback only)")
		nekoWS       = flag.String("neko-ws", "", "development: neko WebSocket URL with a fixed token (loopback only)")
		nekoURL      = flag.String("neko-url", "", "neko on the loopback interface, e.g. http://127.0.0.1:8080; viewers sign in with --neko-password-file")
		nekoPassFile = flag.String("neko-password-file", "/etc/cloudbrowser/neko-password", "neko admin password (written at first boot)")
		browserStart = flag.String("browser-start", "", "shell command that starts the browser container, e.g. systemctl start cloudbrowser-browser")
		browserStop  = flag.String("browser-stop", "", "shell command that stops the browser container after Chrome closed")
		echo         = flag.String("echo", "https://app.example.com/api/echo/ip", "comma-separated IP echo URLs")
		expectedIP   = flag.String("expected-ip", "", "the instance's static IP, if known")
		nftDir       = flag.String("nft-dir", "/etc/cloudbrowser/nft", "nftables rule files; empty disables firewall switching")
		fakeEgressIP = flag.String("fake-egress-ip", "", "development: no Chrome; report this address as what Chrome sees")
		gateway      = flag.String("gateway", "", "override the gateway URL from user data")
	)
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	raw, err := os.ReadFile(*userDataPath)
	if err != nil {
		log.Error("read user data", "err", err)
		os.Exit(1)
	}
	var ud userData
	if err := json.Unmarshal(raw, &ud); err != nil || ud.InstanceID == "" {
		log.Error("invalid user data", "err", err)
		os.Exit(1)
	}
	if *gateway != "" {
		ud.GatewayURL = *gateway
	}
	if ud.Generation == 0 {
		ud.Generation = 1
	}

	var browser agent.Browser = chrome.New(*cdp)
	if *browserStart != "" || *browserStop != "" {
		browser = containerBrowser{Browser: browser, start: *browserStart, stop: *browserStop, log: log}
	}
	if *fakeEgressIP != "" {
		browser = fakeBrowser{ip: *fakeEgressIP}
	}
	var fw agent.Firewall = firewall.Noop{}
	if *nftDir != "" && *fakeEgressIP == "" {
		fw = firewall.NFT{RulesDir: *nftDir}
	}
	var nk agent.Neko
	switch {
	case *nekoURL != "":
		pw, err := os.ReadFile(*nekoPassFile)
		if err != nil {
			log.Error("read neko password", "err", err)
			os.Exit(1)
		}
		nk = nekoAdapter{&neko.Relay{BaseURL: *nekoURL, Username: "agent", Password: strings.TrimSpace(string(pw))}}
	case *nekoWS != "":
		nk = nekoAdapter{&neko.Relay{URL: *nekoWS}}
	}

	a := agent.New(agent.Config{
		InstanceID:     ud.InstanceID,
		GatewayURL:     ud.GatewayURL,
		BootstrapToken: ud.BootstrapToken,
		Generation:     ud.Generation,
		StateDir:       *stateDir,
		ProfileDir:     *profileDir,
		DataDir:        *dataDir,
		Host:           hostFor(*fakeEgressIP),
		EchoURLs:       strings.Split(*echo, ","),
		ExpectedIP:     *expectedIP,
	}, browser, nk, fw, log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("agent starting", "instance", ud.InstanceID, "gateway", ud.GatewayURL, "version", agent.Version)
	if err := a.Run(ctx); err != nil {
		log.Error("agent stopped", "err", err)
		os.Exit(1)
	}
}

// containerBrowser runs Chrome inside the browser container (systemd unit cloudbrowser-browser).
// Closing stops the container after Chrome has closed gracefully, so nothing restarts Chrome
// while its profile is archived or swapped; starting starts the container again.
type containerBrowser struct {
	agent.Browser
	start, stop string
	log         *slog.Logger
}

func run(ctx context.Context, command string) error {
	if command == "" {
		return nil
	}
	out, err := exec.CommandContext(ctx, "sh", "-c", command).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", command, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (b containerBrowser) Start(ctx context.Context) (int, error) {
	if err := run(ctx, b.start); err != nil {
		return 0, err
	}
	return b.Browser.Start(ctx)
}

func (b containerBrowser) Close(ctx context.Context) error {
	// Browser.close lets Chrome flush its stores; the container stop follows either way.
	if err := b.Browser.Close(ctx); err != nil {
		b.log.Warn("graceful chrome close", "err", err)
	}
	sctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return run(sctx, b.stop)
}

type nekoAdapter struct{ r *neko.Relay }

func (n nekoAdapter) Open(ctx context.Context, sessionID string, toViewer func(json.RawMessage)) (agent.NekoSession, error) {
	return n.r.Open(ctx, sessionID, toViewer)
}

// fakeBrowser stands in for Chrome in local runs against the fake executor.
type fakeBrowser struct{ ip string }

func (f fakeBrowser) Start(context.Context) (int, error) { return 141, nil }
func (f fakeBrowser) Close(context.Context) error        { return nil }
func (f fakeBrowser) ObservedIPs(context.Context, []string) ([]string, error) {
	return []string{f.ip}, nil
}
func (f fakeBrowser) InsertText(context.Context, string) error { return nil }

// hostFor is the VM itself, except in local development runs (no data volume to grow).
func hostFor(fakeEgressIP string) agent.Host {
	if fakeEgressIP != "" {
		return nil
	}
	return host.Linux{}
}
