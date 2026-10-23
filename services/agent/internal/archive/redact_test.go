package archive

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// A presigned URL's query is the credential for the object: a failed transfer names the
// operation, the storage host and the status, never the URL.
func TestTransferErrorsDoNotCarryThePresignedURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "denied", http.StatusForbidden)
	}))
	presigned := srv.URL + "/archives/inst1.cbar?X-Amz-Credential=AKIDEXAMPLE&X-Amz-Signature=deadbeefsecret"
	host := strings.TrimPrefix(srv.URL, "http://")
	dir, _ := profile(t)
	k := key(t)
	check := func(op string, err error, want string) {
		t.Helper()
		if err == nil {
			t.Fatalf("%s succeeded", op)
		}
		msg := err.Error()
		if strings.Contains(msg, "deadbeefsecret") || strings.Contains(msg, "AKIDEXAMPLE") || strings.Contains(msg, "/archives/") {
			t.Fatalf("%s error carries the URL: %s", op, msg)
		}
		if !strings.Contains(msg, op) || !strings.Contains(msg, host) || !strings.Contains(msg, want) {
			t.Fatalf("%s error %q, want the operation, %s and %s", op, msg, host, want)
		}
	}
	_, err := Upload(context.Background(), dir, k, presigned)
	check("upload", err, "HTTP 403")
	check("download", Restore(context.Background(), presigned, k, t.TempDir()), "HTTP 403")

	// Without a response the error is the kind of failure: net/http's own error quotes the URL.
	srv.Close()
	_, err = Upload(context.Background(), dir, k, presigned)
	check("upload", err, "unreachable")
	var uerr *url.Error
	if strings.Contains(err.Error(), "?") || errors.As(err, &uerr) {
		t.Fatalf("upload error wraps the request: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	check("download", Restore(ctx, presigned, k, t.TempDir()), "canceled")
}
