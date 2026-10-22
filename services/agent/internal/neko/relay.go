// Package neko relays a viewer's signaling to neko's WebSocket on the loopback interface. neko
// listens only on 127.0.0.1 inside the VM (page 5); media flows separately over WebRTC and TURN.
package neko

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type Relay struct {
	// URL of neko's WebSocket, e.g. ws://127.0.0.1:8080/api/ws?token=… (development: a fixed token).
	URL string
	// BaseURL, e.g. http://127.0.0.1:8080: when set, each session first signs in to neko with
	// Username/Password (the VM's admin password) and connects with the session token it returns.
	BaseURL  string
	Username string
	Password string
	Client   *http.Client
	// Stage limits bound local desktop admission independently from the session's lifetime.
	// Zero uses ten seconds for each stage.
	LoginTimeout     time.Duration
	WebSocketTimeout time.Duration
	DesktopTimeout   time.Duration
}

// OpenError deliberately contains only a safe diagnostic code. The underlying HTTP/WebSocket
// errors can include the token-bearing local URL and must not reach journals or viewers.
type OpenError struct{ Code string }

func (e *OpenError) Error() string       { return "neko: " + e.Code }
func (e *OpenError) FailureCode() string { return e.Code }

func stageLimit(d time.Duration) time.Duration {
	if d <= 0 {
		return 10 * time.Second
	}
	return d
}

func stageError(parent, stage context.Context, timeoutCode, unavailableCode string) error {
	if parent.Err() != nil {
		return &OpenError{Code: "canceled"}
	}
	if stage.Err() == context.DeadlineExceeded {
		return &OpenError{Code: timeoutCode}
	}
	return &OpenError{Code: unavailableCode}
}

// Session is one viewer's relay to neko.
type Session struct {
	conn   *websocket.Conn
	cancel context.CancelFunc
	ctx    context.Context
}

// login signs in to neko v3 (POST /api/login) and returns the session token, from the response
// body or, when neko keeps it in a cookie, from the NEKO_SESSION cookie.
// Each viewer session signs in under its own name: neko refuses a second login for a name whose
// previous WebSocket is still connected, which a take-over from another tab can race with.
func (r *Relay) login(ctx context.Context, sessionID string) (string, error) {
	lctx, cancel := context.WithTimeout(ctx, stageLimit(r.LoginTimeout))
	defer cancel()
	username := r.Username
	if sessionID != "" {
		username += "-" + sessionID
	}
	body, _ := json.Marshal(map[string]string{"username": username, "password": r.Password})
	req, err := http.NewRequestWithContext(lctx, http.MethodPost, strings.TrimRight(r.BaseURL, "/")+"/api/login", bytes.NewReader(body))
	if err != nil {
		return "", &OpenError{Code: "login_unavailable"}
	}
	req.Header.Set("Content-Type", "application/json")
	client := r.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", stageError(ctx, lctx, "login_timeout", "login_unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		code := "login_unavailable"
		if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnprocessableEntity {
			code = "login_rejected"
		}
		return "", &OpenError{Code: code}
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 64<<10)).Decode(&out); err != nil && lctx.Err() != nil {
		return "", stageError(ctx, lctx, "login_timeout", "login_unavailable")
	}
	if out.Token != "" {
		return out.Token, nil
	}
	for _, c := range resp.Cookies() {
		if c.Name == "NEKO_SESSION" && c.Value != "" {
			return c.Value, nil
		}
	}
	return "", &OpenError{Code: "login_unavailable"}
}

func (r *Relay) wsURL(ctx context.Context, sessionID string, progress func(string, string)) (string, error) {
	if r.BaseURL == "" {
		return r.URL, nil
	}
	progress("login_start", "")
	token, err := r.login(ctx, sessionID)
	if err != nil {
		return "", err
	}
	progress("login_ok", "")
	u, err := url.Parse(strings.TrimRight(r.BaseURL, "/") + "/api/ws")
	if err != nil {
		return "", &OpenError{Code: "websocket_unavailable"}
	}
	u.Scheme = strings.Replace(u.Scheme, "http", "ws", 1)
	q := u.Query()
	q.Set("token", token)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (r *Relay) Open(ctx context.Context, sessionID string, toViewer func(json.RawMessage)) (*Session, error) {
	return r.OpenWithProgress(ctx, sessionID, toViewer, nil)
}

// OpenWithProgress completes only once the local desktop has sent system/init. Stage callbacks
// contain no URLs, credentials, or desktop payloads. Startup frames are bounded and delivered in
// order by the session reader after admission, so a viewer never loses the initial desktop state.
func (r *Relay) OpenWithProgress(ctx context.Context, sessionID string, toViewer func(json.RawMessage), progress func(stage, code string)) (*Session, error) {
	if progress == nil {
		progress = func(string, string) {}
	}
	sctx, cancel := context.WithCancel(ctx)
	fail := func(err error) (*Session, error) {
		cancel()
		progress("failed", err.(interface{ FailureCode() string }).FailureCode())
		return nil, err
	}
	target, err := r.wsURL(sctx, sessionID, progress)
	if err != nil {
		return fail(err)
	}
	progress("websocket_start", "")
	wctx, wcancel := context.WithTimeout(sctx, stageLimit(r.WebSocketTimeout))
	conn, _, err := websocket.Dial(wctx, target, nil)
	if err != nil {
		failure := stageError(sctx, wctx, "websocket_timeout", "websocket_unavailable")
		wcancel()
		return fail(failure)
	}
	wcancel()
	conn.SetReadLimit(4 << 20)
	progress("websocket_open", "")
	// A connected socket alone is not a usable desktop. Bound the wait for the first init even
	// if the server keeps sending unrelated frames, and cap buffered data while admission waits.
	dctx, dcancel := context.WithTimeout(sctx, stageLimit(r.DesktopTimeout))
	var startup []json.RawMessage
	startupBytes := 0
	for {
		_, data, err := conn.Read(dctx)
		if err != nil {
			failure := stageError(sctx, dctx, "desktop_timeout", "websocket_unavailable")
			dcancel()
			_ = conn.CloseNow()
			return fail(failure)
		}
		startupBytes += len(data)
		if len(startup) >= 32 || startupBytes > 4<<20 {
			dcancel()
			_ = conn.CloseNow()
			return fail(&OpenError{Code: "websocket_unavailable"})
		}
		startup = append(startup, json.RawMessage(data))
		var frame struct {
			Event string `json:"event"`
		}
		if json.Unmarshal(data, &frame) == nil && frame.Event == "system/init" {
			break
		}
	}
	dcancel()
	progress("desktop_ready", "")
	s := &Session{conn: conn, cancel: cancel, ctx: sctx}
	go func() {
		defer cancel()
		defer conn.CloseNow()
		for _, data := range startup {
			if sctx.Err() != nil {
				return
			}
			toViewer(data)
		}
		for {
			_, data, err := conn.Read(sctx)
			if err != nil {
				return
			}
			toViewer(json.RawMessage(data))
		}
	}()
	return s, nil
}

// Probe exercises the same login, WebSocket and initialization path as a viewer, with a unique
// session name so readiness retries cannot collide with a live viewer or an earlier probe.
func (r *Relay) Probe(ctx context.Context) error {
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return &OpenError{Code: "login_unavailable"}
	}
	s, err := r.Open(ctx, fmt.Sprintf("probe-%x", nonce), func(json.RawMessage) {})
	if err != nil {
		return err
	}
	s.Close()
	return nil
}

func (s *Session) Send(msg json.RawMessage) error {
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	return s.conn.Write(ctx, websocket.MessageText, msg)
}

func (s *Session) Done() <-chan struct{} { return s.ctx.Done() }

func (s *Session) Close() {
	s.cancel()
	_ = s.conn.CloseNow()
}
