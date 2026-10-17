package archive

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func key(t *testing.T) []byte {
	t.Helper()
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	return k
}

func write(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func profile(t *testing.T) (string, []byte) {
	dir := t.TempDir()
	big := make([]byte, 3*chunkSize+123) // spans several chunks
	_, _ = rand.Read(big)
	write(t, filepath.Join(dir, "Default", "Cookies"), []byte("cookie-db"))
	write(t, filepath.Join(dir, "Default", "Local Storage", "leveldb", "000001.log"), big)
	write(t, filepath.Join(dir, "Default", "Cache", "Cache_Data", "data_0"), []byte("cache"))
	write(t, filepath.Join(dir, "Local State"), []byte("{}"))
	_ = os.Symlink("host-123", filepath.Join(dir, "SingletonLock"))
	return dir, big
}

func TestRoundTripSkipsCaches(t *testing.T) {
	dir, big := profile(t)
	k := key(t)
	var buf bytes.Buffer
	if err := Pack(dir, k, &buf); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(buf.Bytes(), []byte("cookie-db")) {
		t.Fatal("archive is not encrypted")
	}
	out := filepath.Join(t.TempDir(), "p")
	if err := Unpack(bytes.NewReader(buf.Bytes()), k, out); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "Default", "Cookies")); string(b) != "cookie-db" {
		t.Fatalf("cookies = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "Default", "Local Storage", "leveldb", "000001.log")); !bytes.Equal(b, big) {
		t.Fatal("large file differs")
	}
	if _, err := os.Stat(filepath.Join(out, "Default", "Cache")); !os.IsNotExist(err) {
		t.Fatal("cache was archived")
	}
	if _, err := os.Lstat(filepath.Join(out, "SingletonLock")); !os.IsNotExist(err) {
		t.Fatal("singleton lock was archived")
	}
}

func TestRejectsWrongKeyAndDamage(t *testing.T) {
	dir, _ := profile(t)
	k := key(t)
	var buf bytes.Buffer
	if err := Pack(dir, k, &buf); err != nil {
		t.Fatal(err)
	}
	data := buf.Bytes()
	if err := Unpack(bytes.NewReader(data), key(t), filepath.Join(t.TempDir(), "a")); err == nil {
		t.Fatal("wrong key accepted")
	}
	flipped := bytes.Clone(data)
	flipped[len(flipped)/2] ^= 1
	if err := Unpack(bytes.NewReader(flipped), k, filepath.Join(t.TempDir(), "b")); err == nil {
		t.Fatal("damaged archive accepted")
	}
	// Cut after the first full chunk: every remaining chunk authenticates, but the end is missing.
	first := len(magic) + 8 + 4 + chunkSize + 16
	if err := Unpack(bytes.NewReader(data[:first]), k, filepath.Join(t.TempDir(), "c")); err == nil {
		t.Fatal("truncated archive accepted")
	}
}

func TestRejectsEntriesOutsideTheProfile(t *testing.T) {
	k := key(t)
	var buf bytes.Buffer
	s, _ := newSealer(k, &buf)
	zw, _ := zstd.NewWriter(s)
	tw := tar.NewWriter(zw)
	_ = tw.WriteHeader(&tar.Header{Name: "../evil", Mode: 0o600, Size: 1, Typeflag: tar.TypeReg})
	_, _ = tw.Write([]byte("x"))
	_ = tw.Close()
	_ = zw.Close()
	_ = s.Close()
	base := t.TempDir()
	if err := Unpack(&buf, k, filepath.Join(base, "p")); err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, "evil")); !os.IsNotExist(err) {
		t.Fatal("wrote outside the profile")
	}
}

func TestUploadAndRestoreThroughPresignedURLs(t *testing.T) {
	var mu sync.Mutex
	objects := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			if r.ContentLength <= 0 {
				http.Error(w, "length required", http.StatusLengthRequired)
				return
			}
			b, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = b
		case http.MethodGet:
			b, ok := objects[r.URL.Path]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(b)
		}
	}))
	defer srv.Close()

	dir, _ := profile(t)
	k := key(t)
	size, err := Upload(context.Background(), dir, k, srv.URL+"/a.cbar")
	if err != nil || size != int64(len(objects["/a.cbar"])) {
		t.Fatalf("upload: %v size=%d", err, size)
	}

	write(t, filepath.Join(dir, "Default", "Cookies"), []byte("changed"))
	if err := Restore(context.Background(), srv.URL+"/a.cbar", k, dir); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "Default", "Cookies")); string(b) != "cookie-db" {
		t.Fatalf("after restore cookies = %q", b)
	}
	// A missing archive leaves the current profile in place.
	if err := Restore(context.Background(), srv.URL+"/missing", k, dir); err == nil {
		t.Fatal("missing archive restored")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "Default", "Cookies")); string(b) != "cookie-db" {
		t.Fatal("profile changed by a failed restore")
	}
	if _, err := ParseKey(base64.StdEncoding.EncodeToString(k)); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseKey("short"); err == nil {
		t.Fatal("bad key accepted")
	}
}
