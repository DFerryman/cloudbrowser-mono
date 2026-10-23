package host

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

// IMDS reads the instance metadata service with IMDSv2 session tokens, as
// images/vm/files/bin/cloudbrowser-browser-env does. The agent runs on the VM itself, outside the
// browser container, and the firewall fences only the browser's user off the metadata address.
type IMDS struct {
	// Endpoint is http://169.254.169.254 unless set (tests).
	Endpoint string
	Client   *http.Client
}

// PublicIPv4 is the VM's public address: its Elastic IP once one is associated.
func (m IMDS) PublicIPv4(ctx context.Context) (string, error) {
	base := m.Endpoint
	if base == "" {
		base = "http://169.254.169.254"
	}
	client := m.Client
	if client == nil {
		client = http.DefaultClient
	}
	get := func(method, path string, header http.Header) (string, error) {
		req, err := http.NewRequestWithContext(ctx, method, base+path, nil)
		if err != nil {
			return "", err
		}
		req.Header = header
		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		if err != nil {
			return "", err
		}
		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("instance metadata %s: HTTP %d", path, resp.StatusCode)
		}
		return strings.TrimSpace(string(body)), nil
	}
	token, err := get(http.MethodPut, "/latest/api/token", http.Header{"X-Aws-Ec2-Metadata-Token-Ttl-Seconds": {"60"}})
	if err != nil {
		return "", err
	}
	ip, err := get(http.MethodGet, "/latest/meta-data/public-ipv4", http.Header{"X-Aws-Ec2-Metadata-Token": {token}})
	if err != nil {
		return "", err
	}
	if parsed := net.ParseIP(ip); parsed == nil || parsed.To4() == nil {
		return "", errors.New("instance metadata: no public IPv4 address")
	}
	return ip, nil
}
