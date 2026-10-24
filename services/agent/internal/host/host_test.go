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

func TestCPUTimesSplitsBusyStealAndIdle(t *testing.T) {
	p := filepath.Join(t.TempDir(), "stat")
	stat := "cpu  100 5 50 800 20 3 2 10 7 0\ncpu0 50 2 25 400 10 1 1 5 3 0\nintr 1\n"
	if err := os.WriteFile(p, []byte(stat), 0o644); err != nil {
		t.Fatal(err)
	}
	busy, steal, total, err := Linux{ProcStat: p}.CPUTimes()
	if err != nil || busy != 160 || steal != 10 || total != 990 {
		t.Fatalf("got busy %d steal %d total %d, %v; want 160 10 990", busy, steal, total, err)
	}
	if err := os.WriteFile(p, []byte("intr 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := (Linux{ProcStat: p}).CPUTimes(); err == nil {
		t.Fatal("a file without the cpu line must fail")
	}
}
