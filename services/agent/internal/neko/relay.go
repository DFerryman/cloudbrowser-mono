// Package neko relays a viewer's signaling to neko's WebSocket on the loopback interface. neko
// listens only on 127.0.0.1 inside the VM (page 5); media flows separately over WebRTC and TURN.
package neko

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
}

// Session is one viewer's relay to neko.
type Session struct {
	conn   *websocket.Conn
	cancel context.CancelFunc
}

// login signs in to neko v3 (POST /api/login) and returns the session token, from the response
// body or, when neko keeps it in a cookie, from the NEKO_SESSION cookie.
// Each viewer session signs in under its own name: neko refuses a second login for a name whose
// previous WebSocket is still connected, which a take-over from another tab can race with.
func (r *Relay) login(ctx context.Context, sessionID string) (string, error) {
	username := r.Username
	if sessionID != "" {
		username += "-" + sessionID
	}
	body, _ := json.Marshal(map[string]string{"username": username, "password": r.Password})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(r.BaseURL, "/")+"/api/login", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	client := r.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("neko login: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Token != "" {
		return out.Token, nil
	}
	for _, c := range resp.Cookies() {
		if c.Name == "NEKO_SESSION" && c.Value != "" {
			return c.Value, nil
		}
	}
	return "", errors.New("neko login: no session token in the response")
}

func (r *Relay) wsURL(ctx context.Context, sessionID string) (string, error) {
	if r.BaseURL == "" {
		return r.URL, nil
	}
	token, err := r.login(ctx, sessionID)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(strings.TrimRight(r.BaseURL, "/") + "/api/ws")
	if err != nil {
		return "", err
	}
	u.Scheme = strings.Replace(u.Scheme, "http", "ws", 1)
	q := u.Query()
	q.Set("token", token)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (r *Relay) Open(ctx context.Context, sessionID string, toViewer func(json.RawMessage)) (*Session, error) {
	sctx, cancel := context.WithCancel(ctx)
	target, err := r.wsURL(sctx, sessionID)
	if err != nil {
		cancel()
		return nil, err
	}
	conn, _, err := websocket.Dial(sctx, target, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	conn.SetReadLimit(4 << 20)
	s := &Session{conn: conn, cancel: cancel}
	go func() {
		defer cancel()
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

func (s *Session) Send(msg json.RawMessage) error {
	return s.conn.Write(context.Background(), websocket.MessageText, msg)
}

func (s *Session) Close() {
	s.cancel()
	s.conn.Close(websocket.StatusNormalClosure, "")
}
