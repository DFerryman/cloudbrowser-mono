// Package neko relays a viewer's signaling to neko's WebSocket on the loopback interface. neko
// listens only on 127.0.0.1 inside the VM (page 5); media flows separately over WebRTC and TURN.
package neko

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
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

// logoutLimit bounds the logout of a session that ended.
const logoutLimit = 5 * time.Second

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
	// The session token (BaseURL mode) for neko's HTTP API: screenshots, and the logout when
	// the session ends.
	token string
	relay *Relay
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

// logout ends the neko session a login created (POST /api/logout). neko keeps every session it
// signed in, connected or not, and lists them all in each new connection's system/init: without
// logouts every viewer, readiness probe and bridge left one behind, until system/init outgrew the
// gateway's 256 KiB frame limit and closed the agent's tunnel. It has its own bound, since it runs
// when the session's context has already ended; a failure leaves only that one entry behind.
func (r *Relay) logout(token string) {
	if token == "" || r.BaseURL == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), logoutLimit)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(r.BaseURL, "/")+"/api/logout", nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := r.httpClient().Do(req)
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	resp.Body.Close()
}

func (r *Relay) wsURL(ctx context.Context, sessionID string, progress func(string, string)) (string, string, error) {
	if r.BaseURL == "" {
		return r.URL, "", nil
	}
	progress("login_start", "")
	token, err := r.login(ctx, sessionID)
	if err != nil {
		return "", "", err
	}
	progress("login_ok", "")
	u, err := url.Parse(strings.TrimRight(r.BaseURL, "/") + "/api/ws")
	if err != nil {
		return "", "", &OpenError{Code: "websocket_unavailable"}
	}
	u.Scheme = strings.Replace(u.Scheme, "http", "ws", 1)
	q := u.Query()
	q.Set("token", token)
	u.RawQuery = q.Encode()
	return u.String(), token, nil
}

func (r *Relay) Open(ctx context.Context, sessionID string, toViewer func(json.RawMessage)) (*Session, error) {
	return r.OpenWithProgress(ctx, sessionID, toViewer, nil)
}

// OpenWithProgress completes only once the local desktop has sent system/init. Stage callbacks
// contain no URLs, credentials, or desktop payloads. Startup frames are bounded and delivered in
// order by the session reader after admission, so a viewer never loses the initial desktop state.
// The session lasts until ctx ends or Close; a session that signed in is logged out when it ends,
// also when it fails before it was admitted.
func (r *Relay) OpenWithProgress(ctx context.Context, sessionID string, toViewer func(json.RawMessage), progress func(stage, code string)) (*Session, error) {
	if progress == nil {
		progress = func(string, string) {}
	}
	sctx, cancel := context.WithCancel(ctx)
	token := ""
	fail := func(err error) (*Session, error) {
		cancel()
		r.logout(token)
		progress("failed", err.(interface{ FailureCode() string }).FailureCode())
		return nil, err
	}
	target, token, err := r.wsURL(sctx, sessionID, progress)
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
	s := &Session{conn: conn, cancel: cancel, ctx: sctx, token: token, relay: r}
	go func() {
		defer func() {
			cancel()
			_ = conn.CloseNow()
			r.logout(token)
		}()
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

// --- coding-agent bridge (docs/agent-access.md) ---------------------------------------------

func (r *Relay) httpClient() *http.Client {
	if r.Client != nil {
		return r.Client
	}
	return http.DefaultClient
}

// api sends an authenticated request to neko's HTTP API on the loopback interface.
func (s *Session) api(ctx context.Context, method, path string, contentType string, body io.Reader) (*http.Response, error) {
	if s.relay == nil || s.relay.BaseURL == "" || s.token == "" {
		return nil, errors.New("neko http api unavailable")
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(s.relay.BaseURL, "/")+"/api"+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return s.relay.httpClient().Do(req)
}

// Screenshot is the whole display as neko captures it (`GET /api/room/screen/shot.jpg`): every
// window, the tab strip, the address bar and any dialog, without changing focus or layout.
func (s *Session) Screenshot(ctx context.Context, quality int) ([]byte, error) {
	resp, err := s.api(ctx, http.MethodGet, "/room/screen/shot.jpg?quality="+strconv.Itoa(quality), "", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("screenshot: status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if len(data) < 4 || data[0] != 0xff || data[1] != 0xd8 {
		return nil, errors.New("screenshot: not a jpeg")
	}
	return data, nil
}

// OpenAutomation is the bridge's own neko session: its input and screen events, separate from
// any viewer's relay.
func (r *Relay) OpenAutomation(ctx context.Context, onEvent func(json.RawMessage)) (*Session, error) {
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	return r.Open(ctx, fmt.Sprintf("bridge-%x", nonce), onEvent)
}
