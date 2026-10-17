// Package firewall switches the VM's nftables rules between normal browsing and fail-closed mode,
// where the browser container may reach only the gateway, the TURN relay and the IP echo
// endpoints (page 3, "Fail-closed"). The rule files ship in the golden image (images/vm).
package firewall

import (
	"fmt"
	"os/exec"
	"path/filepath"
)

type NFT struct {
	RulesDir string // /etc/cloudbrowser/nft: normal.nft and closed.nft
}

func (n NFT) SetMode(mode string) error {
	if mode != "normal" && mode != "closed" {
		return fmt.Errorf("unknown firewall mode %q", mode)
	}
	out, err := exec.Command("nft", "-f", filepath.Join(n.RulesDir, mode+".nft")).CombinedOutput()
	if err != nil {
		return fmt.Errorf("nft: %v: %s", err, out)
	}
	return nil
}

// Noop is used for local runs without root.
type Noop struct{}

func (Noop) SetMode(string) error { return nil }
