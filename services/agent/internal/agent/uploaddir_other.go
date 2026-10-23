//go:build !linux && !darwin

package agent

import "io/fs"

// ownedByAgent cannot tell the owner here; the agent runs on Linux, this is for local builds.
func ownedByAgent(fs.FileInfo) bool { return true }
