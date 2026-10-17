// Package neko relays a viewer's signaling to neko's WebSocket on the loopback interface. neko
// listens only on 127.0.0.1 inside the VM (page 5); media flows separately over WebRTC and TURN.
package neko

import (
	"context"
	"encoding/json"

	"github.com/coder/websocket"
)

type Relay struct {
	// URL of neko's WebSocket with the per-instance owner token, e.g. ws://127.0.0.1:8080/api/ws?token=…
	URL string
}

// Session is one viewer's relay to neko.
type Session struct {
	conn   *websocket.Conn
	cancel context.CancelFunc
}

func (r *Relay) Open(ctx context.Context, sessionID string, toViewer func(json.RawMessage)) (*Session, error) {
	sctx, cancel := context.WithCancel(ctx)
	conn, _, err := websocket.Dial(sctx, r.URL, nil)
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
