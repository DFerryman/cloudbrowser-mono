package agent

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A gateway whose welcome says keepalive gets a ping once it has been quiet. A tunnel that answers
// nothing is given up for a new one, whose hello says why the last one ended; answered pings keep
// a tunnel up.
func TestKeepaliveReplacesASilentTunnelAndSaysWhy(t *testing.T) {
	g, srv := newGateway(t)
	a := New(Config{
		InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot",
		StateDir: t.TempDir(), Generation: 1, Heartbeat: time.Hour,
	}, &fakeBrowser{ip: "203.0.113.7"}, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.keepaliveIdle, a.keepaliveWait = 150*time.Millisecond, 150*time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = a.Run(ctx) }()

	<-g.auths
	first := <-g.conns
	send(t, first, map[string]any{"t": "welcome", "keepalive": true})
	if m := read(t, first); m["t"] != "hello" || m["previous"] != nil {
		t.Fatalf("first hello %v", m)
	}
	readUntil(t, first, func(m map[string]any) bool { return m["t"] == "ping" })

	<-g.auths
	second := <-g.conns
	hello := read(t, second)
	prev, _ := hello["previous"].(map[string]any)
	if hello["t"] != "hello" || prev == nil || prev["reason"] != "silent" || prev["upMs"].(float64) < 150 || prev["downMs"].(float64) < 400 {
		t.Fatalf("second hello %v", hello)
	}
	send(t, second, map[string]any{"t": "welcome", "keepalive": true})
	for until := time.Now().Add(time.Second); time.Now().Before(until); {
		if m := read(t, second); m["t"] == "ping" {
			send(t, second, map[string]any{"t": "pong"})
		}
	}
	select {
	case <-g.auths:
		t.Fatal("a tunnel that answered its pings was replaced")
	default:
	}
}

// Without the welcome's keepalive (an older gateway), a quiet tunnel gets no pings and stays.
func TestNoKeepaliveWithoutTheGatewaysWord(t *testing.T) {
	g, srv := newGateway(t)
	a := New(Config{
		InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot",
		StateDir: t.TempDir(), Generation: 1, Heartbeat: time.Hour,
	}, &fakeBrowser{ip: "203.0.113.7"}, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.keepaliveIdle, a.keepaliveWait = 50*time.Millisecond, 50*time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = a.Run(ctx) }()
	<-g.auths
	c := <-g.conns
	send(t, c, map[string]any{"t": "welcome"})
	rctx, rcancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer rcancel()
	for {
		_, data, err := c.Read(rctx)
		if err != nil {
			break
		}
		if string(data) == `{"t":"ping"}` {
			t.Fatal("pinged a gateway that never offered keepalive")
		}
	}
	select {
	case <-g.auths:
		t.Fatal("the tunnel was replaced")
	default:
	}
}

// Stopping closes the tunnel with a close frame (going away), so the gateway can tell a VM going
// to sleep from a lost connection, and Run returns.
func TestStoppingClosesTheTunnelWithGoingAway(t *testing.T) {
	g, srv := newGateway(t)
	a := New(Config{
		InstanceID: "inst1", GatewayURL: "ws" + srv.URL[len("http"):], BootstrapToken: "boot",
		StateDir: t.TempDir(), Generation: 1, Heartbeat: time.Hour,
	}, &fakeBrowser{ip: "203.0.113.7"}, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = a.Run(ctx)
		close(done)
	}()
	<-g.auths
	c := <-g.conns
	read(t, c)
	cancel()
	rctx, rcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer rcancel()
	for {
		if _, _, err := c.Read(rctx); err != nil {
			if code := websocket.CloseStatus(err); code != websocket.StatusGoingAway {
				t.Fatalf("closed with %v: %v", code, err)
			}
			break
		}
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return")
	}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

// Reports carry fixed codes, never an error's text (which can hold the gateway's URL).
func TestTunnelEndAndDialFailureCodes(t *testing.T) {
	for _, tc := range []struct {
		err             error
		silent, stalled bool
		reason          string
		code            int
	}{
		{errTunnelSilent, true, false, "silent", 0},
		{fmt.Errorf("failed to get reader: %w", websocket.CloseError{Code: 4000, Reason: "replaced"}), false, false, "closed", 4000},
		{fmt.Errorf("failed to read frame header: %w", io.EOF), false, false, "eof", 0},
		{fmt.Errorf("read tcp: %w", syscall.ECONNRESET), false, false, "reset", 0},
		{net.ErrClosed, false, true, "write_timeout", 0},
		{&net.OpError{Op: "read", Err: timeoutError{}}, false, false, "timeout", 0},
		{errors.New("something else"), false, false, "error", 0},
	} {
		if reason, code := tunnelEndReason(tc.err, tc.silent, tc.stalled); reason != tc.reason || code != tc.code {
			t.Errorf("%v: got %s %d, want %s %d", tc.err, reason, code, tc.reason, tc.code)
		}
	}
	for _, tc := range []struct {
		err  error
		resp *http.Response
		want string
	}{
		{&net.DNSError{Err: "no such host", Name: "connect.example"}, nil, "dns"},
		{&net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, nil, "connect"},
		{&net.OpError{Op: "dial", Err: timeoutError{}}, nil, "timeout"},
		{tls.RecordHeaderError{Msg: "first record does not look like a TLS handshake"}, nil, "tls"},
		{errors.New("expected handshake response status code 101"), &http.Response{StatusCode: 503}, "http_503"},
		{errors.New("something else"), nil, "error"},
	} {
		if got := dialFailure(tc.err, tc.resp); got != tc.want {
			t.Errorf("%v: got %s, want %s", tc.err, got, tc.want)
		}
	}
}
