// Package host reads what the engine meters and shows about the VM (page 6): space used on the data
// volume and bytes sent to the network; and grows the data file system after the volume grew.
package host

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Linux is the real VM.
type Linux struct {
	// SysClassNet is /sys/class/net (tests point it elsewhere).
	SysClassNet string
}

// NetTxBytes is the bytes sent by every network interface except loopback since boot. The browser
// shares the host network, so this includes the live-view video and everything Chrome uploads.
func (l Linux) NetTxBytes() (uint64, error) {
	dir := l.SysClassNet
	if dir == "" {
		dir = "/sys/class/net"
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	var total uint64
	for _, e := range entries {
		if e.Name() == "lo" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name(), "statistics", "tx_bytes"))
		if err != nil {
			continue
		}
		n, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
		if err == nil {
			total += n
		}
	}
	return total, nil
}

// GrowFilesystem grows the ext4 file system mounted at path to the size of its block device,
// online. It does nothing if the file system already fills the device.
func (Linux) GrowFilesystem(ctx context.Context, path string) error {
	out, err := exec.CommandContext(ctx, "findmnt", "-no", "SOURCE", path).Output()
	if err != nil {
		return fmt.Errorf("findmnt %s: %w", path, err)
	}
	dev := strings.TrimSpace(string(out))
	if dev == "" {
		return fmt.Errorf("%s is not a mount point", path)
	}
	if msg, err := exec.CommandContext(ctx, "resize2fs", dev).CombinedOutput(); err != nil {
		return fmt.Errorf("resize2fs %s: %v: %s", dev, err, strings.TrimSpace(string(msg)))
	}
	return nil
}
