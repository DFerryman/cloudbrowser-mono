package host

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublicIPv4UsesAnIMDSv2Token(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/latest/api/token" && r.Header.Get("X-Aws-Ec2-Metadata-Token-Ttl-Seconds") != "":
			_, _ = w.Write([]byte("session-token"))
		case r.Method == http.MethodGet && r.URL.Path == "/latest/meta-data/public-ipv4" && r.Header.Get("X-Aws-Ec2-Metadata-Token") == "session-token":
			_, _ = w.Write([]byte("203.0.113.7\n"))
		default:
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}
	}))
	defer srv.Close()
	ip, err := IMDS{Endpoint: srv.URL}.PublicIPv4(context.Background())
	if err != nil || ip != "203.0.113.7" {
		t.Fatalf("public address %q, %v", ip, err)
	}

	// No public address (a VM without one answers 404) is an error, not an empty expectation.
	none := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			_, _ = w.Write([]byte("t"))
			return
		}
		http.NotFound(w, r)
	}))
	defer none.Close()
	if ip, err := (IMDS{Endpoint: none.URL}).PublicIPv4(context.Background()); err == nil {
		t.Fatalf("missing address read as %q", ip)
	}
}
