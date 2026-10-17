// Package archive packs the Chrome profile into an encrypted archive for R2 and unpacks it again
// (page 4: profile archives at each sleep, restorable while the browser runs).
//
// Format "CBAR1": the 5-byte magic, an 8-byte random nonce prefix, then chunks of
// [4-byte big-endian length][AES-256-GCM ciphertext]. Chunk i is sealed with the nonce
// prefix ‖ uint32(i) and additional data "more" or "last", so reordered, dropped or truncated
// chunks fail to open. The plaintext is a zstd-compressed tar of the profile without its caches.
package archive

import (
	"archive/tar"
	"bufio"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/klauspost/compress/zstd"
)

const (
	magic     = "CBAR1"
	chunkSize = 1 << 20
)

// skipped are rebuilt by Chrome on demand or tied to the running process; never archived.
var skipped = map[string]bool{
	"Cache": true, "Code Cache": true, "GPUCache": true, "ShaderCache": true, "GrShaderCache": true,
	"GraphiteDawnCache": true, "DawnGraphiteCache": true, "DawnWebGPUCache": true, "CacheStorage": true,
	"ScriptCache": true, "component_crx_cache": true, "Crashpad": true,
	"SingletonLock": true, "SingletonSocket": true, "SingletonCookie": true,
}

// ParseKey decodes the base64 archive key the gateway adds to the command.
func ParseKey(b64 string) ([]byte, error) {
	k, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(k) != 32 {
		return nil, errors.New("archive key must be 32 bytes, base64")
	}
	return k, nil
}

// Pack writes the encrypted archive of dir to w.
func Pack(dir string, key []byte, w io.Writer) error {
	enc, err := newSealer(key, w)
	if err != nil {
		return err
	}
	zw, err := zstd.NewWriter(enc, zstd.WithEncoderLevel(zstd.SpeedDefault))
	if err != nil {
		return err
	}
	tw := tar.NewWriter(zw)
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		if skipped[d.Name()] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			return nil // sockets, symlinks: nothing a profile needs
		}
		rel, _ := filepath.Rel(dir, path)
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if info.IsDir() {
			hdr.Name += "/"
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.CopyN(tw, f, info.Size())
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return enc.Close()
}

// Unpack decrypts r and extracts it into dir, which must not exist yet.
func Unpack(r io.Reader, key []byte, dir string) error {
	dec, err := newOpener(key, r)
	if err != nil {
		return err
	}
	zr, err := zstd.NewReader(dec)
	if err != nil {
		return err
	}
	defer zr.Close()
	if err := os.Mkdir(dir, 0o700); err != nil {
		return err
	}
	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := filepath.FromSlash(strings.TrimSuffix(hdr.Name, "/"))
		if !filepath.IsLocal(name) {
			return fmt.Errorf("archive entry escapes the profile: %q", hdr.Name)
		}
		target := filepath.Join(dir, name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, hdr.FileInfo().Mode().Perm()|0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
			_ = os.Chtimes(target, hdr.ModTime, hdr.ModTime)
		}
	}
	// The whole stream must authenticate, including the final chunk.
	_, err = io.Copy(io.Discard, dec)
	return err
}

// Upload packs dir into a temporary file (R2 needs the length up front) and PUTs it to the
// presigned URL. It returns the archive's size.
func Upload(ctx context.Context, dir string, key []byte, putURL string) (int64, error) {
	tmp, err := os.CreateTemp("", "cbar-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	bw := bufio.NewWriterSize(tmp, 1<<20)
	if err := Pack(dir, key, bw); err != nil {
		return 0, fmt.Errorf("pack: %w", err)
	}
	if err := bw.Flush(); err != nil {
		return 0, err
	}
	size, err := tmp.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, putURL, tmp)
	if err != nil {
		return 0, err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return 0, fmt.Errorf("upload: HTTP %d", resp.StatusCode)
	}
	return size, nil
}

// Restore downloads the archive and swaps it in as dir. The old profile is kept as dir+".old"
// until the swap succeeded, so a failed download or a bad archive leaves the profile untouched.
func Restore(ctx context.Context, getURL string, key []byte, dir string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, getURL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("download: HTTP %d", resp.StatusCode)
	}
	staging, old := dir+".restore", dir+".old"
	_ = os.RemoveAll(staging)
	if err := Unpack(bufio.NewReaderSize(resp.Body, 1<<20), key, staging); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("unpack: %w", err)
	}
	// Chrome runs as its own user in the browser container: the restored files keep the profile's owner.
	if info, err := os.Stat(dir); err == nil {
		if err := chownLike(staging, info); err != nil {
			_ = os.RemoveAll(staging)
			return err
		}
	}
	_ = os.RemoveAll(old)
	if err := os.Rename(dir, old); err != nil && !errors.Is(err, fs.ErrNotExist) {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := os.Rename(staging, dir); err != nil {
		_ = os.Rename(old, dir)
		return err
	}
	return os.RemoveAll(old)
}

func chownLike(root string, like fs.FileInfo) error {
	st, ok := like.Sys().(*syscall.Stat_t)
	if !ok || (int(st.Uid) == os.Getuid() && int(st.Gid) == os.Getgid()) {
		return nil
	}
	return filepath.WalkDir(root, func(path string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(path, int(st.Uid), int(st.Gid))
	})
}

// --- chunked AES-GCM ---------------------------------------------------------------------------

type sealer struct {
	w      io.Writer
	aead   cipher.AEAD
	prefix [8]byte
	n      uint32
	buf    []byte
	closed bool
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func newSealer(key []byte, w io.Writer) (*sealer, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	s := &sealer{w: w, aead: aead, buf: make([]byte, 0, chunkSize)}
	if _, err := rand.Read(s.prefix[:]); err != nil {
		return nil, err
	}
	if _, err := w.Write(append([]byte(magic), s.prefix[:]...)); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *sealer) nonce() []byte {
	var n [12]byte
	copy(n[:8], s.prefix[:])
	binary.BigEndian.PutUint32(n[8:], s.n)
	return n[:]
}

func (s *sealer) flush(last bool) error {
	ad := []byte("more")
	if last {
		ad = []byte("last")
	}
	ct := s.aead.Seal(nil, s.nonce(), s.buf, ad)
	s.n++
	s.buf = s.buf[:0]
	var l [4]byte
	binary.BigEndian.PutUint32(l[:], uint32(len(ct)))
	if _, err := s.w.Write(l[:]); err != nil {
		return err
	}
	_, err := s.w.Write(ct)
	return err
}

func (s *sealer) Write(p []byte) (int, error) {
	total := len(p)
	for len(p) > 0 {
		if len(s.buf) == chunkSize {
			if err := s.flush(false); err != nil {
				return 0, err
			}
		}
		n := min(chunkSize-len(s.buf), len(p))
		s.buf = append(s.buf, p[:n]...)
		p = p[n:]
	}
	return total, nil
}

// Close seals the final chunk (possibly empty), which marks the end of the stream.
func (s *sealer) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	return s.flush(true)
}

type opener struct {
	r      io.Reader
	aead   cipher.AEAD
	prefix [8]byte
	n      uint32
	buf    []byte
	done   bool
}

func newOpener(key []byte, r io.Reader) (*opener, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	head := make([]byte, len(magic)+8)
	if _, err := io.ReadFull(r, head); err != nil {
		return nil, fmt.Errorf("not an archive: %w", err)
	}
	if string(head[:len(magic)]) != magic {
		return nil, errors.New("not an archive")
	}
	o := &opener{r: r, aead: aead}
	copy(o.prefix[:], head[len(magic):])
	return o, nil
}

func (o *opener) Read(p []byte) (int, error) {
	for len(o.buf) == 0 {
		if o.done {
			return 0, io.EOF
		}
		var l [4]byte
		if _, err := io.ReadFull(o.r, l[:]); err != nil {
			return 0, fmt.Errorf("archive truncated: %w", err)
		}
		size := binary.BigEndian.Uint32(l[:])
		if size > chunkSize+uint32(o.aead.Overhead()) {
			return 0, errors.New("archive chunk too large")
		}
		ct := make([]byte, size)
		if _, err := io.ReadFull(o.r, ct); err != nil {
			return 0, fmt.Errorf("archive truncated: %w", err)
		}
		var nonce [12]byte
		copy(nonce[:8], o.prefix[:])
		binary.BigEndian.PutUint32(nonce[8:], o.n)
		pt, err := o.aead.Open(nil, nonce[:], ct, []byte("more"))
		if err != nil {
			pt, err = o.aead.Open(nil, nonce[:], ct, []byte("last"))
			if err != nil {
				return 0, errors.New("archive does not authenticate (wrong key or damaged)")
			}
			o.done = true
		}
		o.n++
		o.buf = pt
	}
	n := copy(p, o.buf)
	o.buf = o.buf[n:]
	return n, nil
}
