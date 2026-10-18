//go:build linux || darwin

package host

import "syscall"

// DiskUsage is the space used and the size of the file system that holds path, in bytes.
func (Linux) DiskUsage(path string) (used, total uint64, err error) {
	var s syscall.Statfs_t
	if err := syscall.Statfs(path, &s); err != nil {
		return 0, 0, err
	}
	bs := uint64(s.Bsize)
	return (uint64(s.Blocks) - uint64(s.Bfree)) * bs, uint64(s.Blocks) * bs, nil
}
