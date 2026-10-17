// Package chrome drives Google Chrome over the DevTools protocol on the loopback interface
// (page 4 and 5). It attaches only for what the agent needs and never calls Runtime.enable on the
// user's pages, so sites see an ordinary Chrome.
package chrome

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// CDP is a minimal DevTools client: one browser-level connection, flat sessions.
type CDP struct {
	Endpoint string // http://127.0.0.1:9222

	mu      sync.Mutex
	conn    *websocket.Conn
	nextID  atomic.Int64
	pending map[int64]chan rpcResponse
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *CDP) connect(ctx context.Context) (*websocket.Conn, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != nil {
		return c.conn, nil
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Endpoint+"/json/version", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var v struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return nil, err
	}
	conn, _, err := websocket.Dial(context.Background(), v.WebSocketDebuggerURL, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(32 << 20)
	c.conn = conn
	c.pending = map[int64]chan rpcResponse{}
	go c.readLoop(conn)
	return conn, nil
}

func (c *CDP) readLoop(conn *websocket.Conn) {
	for {
		_, data, err := conn.Read(context.Background())
		if err != nil {
			c.mu.Lock()
			c.conn = nil
			for id, ch := range c.pending {
				close(ch)
				delete(c.pending, id)
			}
			c.mu.Unlock()
			return
		}
		var msg struct {
			ID int64 `json:"id"`
			rpcResponse
		}
		if json.Unmarshal(data, &msg) != nil || msg.ID == 0 {
			continue // events are not used
		}
		c.mu.Lock()
		ch := c.pending[msg.ID]
		delete(c.pending, msg.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- msg.rpcResponse
		}
	}
}

// Call sends one CDP command, on a flat session if sessionID is set.
func (c *CDP) Call(ctx context.Context, sessionID, method string, params any, out any) error {
	conn, err := c.connect(ctx)
	if err != nil {
		return err
	}
	id := c.nextID.Add(1)
	ch := make(chan rpcResponse, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	req := map[string]any{"id": id, "method": method, "params": params}
	if sessionID != "" {
		req["sessionId"] = sessionID
	}
	b, _ := json.Marshal(req)
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case resp, ok := <-ch:
		if !ok {
			return errors.New("devtools connection closed")
		}
		if resp.Error != nil {
			return fmt.Errorf("%s: %s", method, resp.Error.Message)
		}
		if out != nil {
			return json.Unmarshal(resp.Result, out)
		}
		return nil
	}
}

// Chrome implements agent.Browser. Chrome itself runs in the browser container (neko image);
// Start waits until its DevTools endpoint answers.
type Chrome struct {
	CDP *CDP
}

func New(endpoint string) *Chrome { return &Chrome{CDP: &CDP{Endpoint: endpoint}} }

func (c *Chrome) Start(ctx context.Context) (int, error) {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		var v struct {
			Product string `json:"product"` // "Chrome/141.0.7390.54"
		}
		err := c.CDP.Call(ctx, "", "Browser.getVersion", map[string]any{}, &v)
		if err == nil {
			major, _ := strconv.Atoi(strings.SplitN(strings.TrimPrefix(v.Product, "Chrome/"), ".", 2)[0])
			return major, nil
		}
		if time.Now().After(deadline) {
			return 0, err
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func (c *Chrome) Close(ctx context.Context) error {
	err := c.CDP.Call(ctx, "", "Browser.close", map[string]any{}, nil)
	if err != nil && strings.Contains(err.Error(), "closed") {
		return nil // Chrome exits before answering
	}
	return err
}

// ObservedIPs loads each echo URL in a throwaway browser context, so the request takes Chrome's
// normal network path without touching the user's tabs or cookies (page 3, "Verification").
func (c *Chrome) ObservedIPs(ctx context.Context, echoURLs []string) ([]string, error) {
	var bc struct {
		BrowserContextID string `json:"browserContextId"`
	}
	if err := c.CDP.Call(ctx, "", "Target.createBrowserContext", map[string]any{"disposeOnDetach": true}, &bc); err != nil {
		return nil, err
	}
	defer c.CDP.Call(context.Background(), "", "Target.disposeBrowserContext", map[string]any{"browserContextId": bc.BrowserContextID}, nil)

	var out []string
	for _, u := range echoURLs {
		var t struct {
			TargetID string `json:"targetId"`
		}
		if err := c.CDP.Call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank", "browserContextId": bc.BrowserContextID, "background": true}, &t); err != nil {
			return out, err
		}
		var s struct {
			SessionID string `json:"sessionId"`
		}
		if err := c.CDP.Call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": t.TargetID, "flatten": true}, &s); err != nil {
			return out, err
		}
		// fetch() from the page uses the same network stack, proxy policy and DNS as browsing.
		var r struct {
			Result struct {
				Value string `json:"value"`
			} `json:"result"`
			ExceptionDetails any `json:"exceptionDetails"`
		}
		expr := fmt.Sprintf(`fetch(%q, {cache: "no-store"}).then(r => r.text())`, u)
		err := c.CDP.Call(ctx, s.SessionID, "Runtime.evaluate", map[string]any{"expression": expr, "awaitPromise": true, "returnByValue": true}, &r)
		_ = c.CDP.Call(context.Background(), "", "Target.closeTarget", map[string]any{"targetId": t.TargetID}, nil)
		if err != nil {
			return out, err
		}
		if r.ExceptionDetails != nil {
			return out, fmt.Errorf("echo %s failed", u)
		}
		ip := strings.TrimSpace(r.Result.Value)
		if net.ParseIP(ip) == nil {
			return out, fmt.Errorf("echo %s returned %q", u, ip)
		}
		out = append(out, ip)
	}
	return out, nil
}

// InsertText types into the focused element of the active tab (IME, CJK, emoji; page 5).
func (c *Chrome) InsertText(ctx context.Context, text string) error {
	var targets struct {
		TargetInfos []struct {
			TargetID string `json:"targetId"`
			Type     string `json:"type"`
			Attached bool   `json:"attached"`
		} `json:"targetInfos"`
	}
	if err := c.CDP.Call(ctx, "", "Target.getTargets", map[string]any{}, &targets); err != nil {
		return err
	}
	for _, t := range targets.TargetInfos {
		if t.Type != "page" {
			continue
		}
		var s struct {
			SessionID string `json:"sessionId"`
		}
		if err := c.CDP.Call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": t.TargetID, "flatten": true}, &s); err != nil {
			return err
		}
		defer c.CDP.Call(context.Background(), "", "Target.detachFromTarget", map[string]any{"sessionId": s.SessionID}, nil)
		return c.CDP.Call(ctx, s.SessionID, "Input.insertText", map[string]any{"text": text}, nil)
	}
	return errors.New("no page to type into")
}
