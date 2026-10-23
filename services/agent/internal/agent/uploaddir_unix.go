//go:build linux || darwin

package agent

import (
	"io/fs"
	"os"
	"syscall"
)

// ownedByAgent is whether the agent's own user owns the file.
func ownedByAgent(info fs.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Geteuid()
}
