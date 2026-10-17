// Command agent is the in-VM supervisor (page 2, services/agent). It reads its identity from the
// VM's user data, keeps one outbound WebSocket to the session gateway, and controls Chrome over
// the DevTools protocol on the loopback interface. Run by systemd from the golden image.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/agent"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/chrome"
	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/firewall"
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
		cdp          = flag.String("cdp", "http://127.0.0.1:9222", "Chrome DevTools endpoint (loopback only)")
		nekoWS       = flag.String("neko-ws", "", "neko WebSocket URL with the owner token (loopback only)")
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
	if *fakeEgressIP != "" {
		browser = fakeBrowser{ip: *fakeEgressIP}
	}
	var fw agent.Firewall = firewall.Noop{}
	if *nftDir != "" && *fakeEgressIP == "" {
		fw = firewall.NFT{RulesDir: *nftDir}
	}
	var nk agent.Neko
	if *nekoWS != "" {
		nk = nekoAdapter{&neko.Relay{URL: *nekoWS}}
	}

	a := agent.New(agent.Config{
		InstanceID:     ud.InstanceID,
		GatewayURL:     ud.GatewayURL,
		BootstrapToken: ud.BootstrapToken,
		Generation:     ud.Generation,
		StateDir:       *stateDir,
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
