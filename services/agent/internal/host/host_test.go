package host

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNetTxBytesSumsInterfacesButLoopback(t *testing.T) {
	dir := t.TempDir()
	for name, v := range map[string]string{"lo": "999\n", "ens5": "1000\n", "ens6": "24\n"} {
		p := filepath.Join(dir, name, "statistics")
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "tx_bytes"), []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	n, err := Linux{SysClassNet: dir}.NetTxBytes()
	if err != nil || n != 1024 {
		t.Fatalf("got %d, %v; want 1024", n, err)
	}
}

func TestDiskUsage(t *testing.T) {
	used, total, err := Linux{}.DiskUsage(t.TempDir())
	if err != nil || total == 0 || used > total {
		t.Fatalf("used %d total %d err %v", used, total, err)
	}
}
