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
	// SysClassNet is /sys/class/net and ProcStat /proc/stat (tests point them elsewhere).
	SysClassNet string
	ProcStat    string
}

// CPUTimes is the time every CPU of the VM spent busy, taken by the hypervisor (steal: a burstable
// instance out of CPU credits, or a busy host), and in all, since boot, in clock ticks.
func (l Linux) CPUTimes() (busy, steal, total uint64, err error) {
	path := l.ProcStat
	if path == "" {
		path = "/proc/stat"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, 0, err
	}
	line, _, _ := strings.Cut(string(raw), "\n")
	fields := strings.Fields(line)
	// cpu user nice system idle iowait irq softirq steal (guest time is already in user).
	if len(fields) < 9 || fields[0] != "cpu" {
		return 0, 0, 0, fmt.Errorf("unexpected %s", path)
	}
	var t [8]uint64
	for i := range t {
		if t[i], err = strconv.ParseUint(fields[i+1], 10, 64); err != nil {
			return 0, 0, 0, fmt.Errorf("unexpected %s: %w", path, err)
		}
	}
	busy = t[0] + t[1] + t[2] + t[5] + t[6]
	return busy, t[7], busy + t[3] + t[4] + t[7], nil
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
