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
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
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

// cleanupLimit bounds a call that tidies up after another (closing a hidden page, detaching):
// it runs when the caller's own context may have ended, and a Chrome that stopped answering must
// not hold the IP check or the input that made it forever.
const cleanupLimit = 5 * time.Second

// cleanup sends one tidying call on its own bound, whatever happened to the caller's context.
func (c *CDP) cleanup(method string, params any) {
	ctx, cancel := context.WithTimeout(context.Background(), cleanupLimit)
	defer cancel()
	_ = c.Call(ctx, "", method, params, nil)
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

// hiddenPageRetry is how often a refused hidden page is asked for again.
const hiddenPageRetry = 250 * time.Millisecond

// createHiddenPage opens about:blank in the browser context without showing it. A visible page in
// a new browser context gets a window of its own, which flashes onto the user's screen, so there
// is no visible fallback. Chrome refuses hidden targets while it has no page of its own ("Hidden
// target can be created only when remote debugging is enabled"): at wake the agent checks as soon
// as DevTools answers, often before Chrome has restored its first window, and after a restart
// Chrome is briefly without one. The request is repeated until Chrome takes it or the check's
// time is up.
func (c *Chrome) createHiddenPage(ctx context.Context, browserContextID string) (string, error) {
	params := map[string]any{"url": "about:blank", "browserContextId": browserContextID, "background": true, "focus": false, "hidden": true}
	var refused error
	for {
		var t struct {
			TargetID string `json:"targetId"`
		}
		err := c.CDP.Call(ctx, "", "Target.createTarget", params, &t)
		if err == nil {
			return t.TargetID, nil
		}
		if ctx.Err() == nil {
			refused = err // Chrome's reason says more than the deadline that follows it
		}
		select {
		case <-ctx.Done():
			if refused != nil {
				return "", refused
			}
			return "", ctx.Err()
		case <-time.After(hiddenPageRetry):
		}
	}
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
	defer c.CDP.cleanup("Target.disposeBrowserContext", map[string]any{"browserContextId": bc.BrowserContextID})

	var out []string
	for _, u := range echoURLs {
		targetID, err := c.createHiddenPage(ctx, bc.BrowserContextID)
		if err != nil {
			return out, err
		}
		var s struct {
			SessionID string `json:"sessionId"`
		}
		if err := c.CDP.Call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, &s); err != nil {
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
		err = c.CDP.Call(ctx, s.SessionID, "Runtime.evaluate", map[string]any{"expression": expr, "awaitPromise": true, "returnByValue": true}, &r)
		c.CDP.cleanup("Target.closeTarget", map[string]any{"targetId": targetID})
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
		defer c.CDP.cleanup("Target.detachFromTarget", map[string]any{"sessionId": s.SessionID})
		return c.CDP.Call(ctx, s.SessionID, "Input.insertText", map[string]any{"text": text}, nil)
	}
	return errors.New("no page to type into")
}

// DropFiles drops files on the page under a point of the remote screen, as a file dragged in from
// the desktop would be (CDP Input.dispatchDragEvent). The page is a visible tab whose viewport has
// the point, the focused one first; false means there is none (the tab strip, the address bar).
// The viewport is the bottom of the window (toolbars and info bars sit above it) at the page's
// device pixel ratio, which includes its zoom.
func (c *Chrome) DropFiles(ctx context.Context, x, y int, paths []string) (bool, error) {
	var targets struct {
		TargetInfos []struct {
			TargetID string `json:"targetId"`
			Type     string `json:"type"`
		} `json:"targetInfos"`
	}
	if err := c.CDP.Call(ctx, "", "Target.getTargets", map[string]any{}, &targets); err != nil {
		return false, err
	}
	type spot struct {
		session string
		x, y    float64
	}
	var found *spot
	var sessions []string
	defer func() {
		for _, s := range sessions {
			c.CDP.cleanup("Target.detachFromTarget", map[string]any{"sessionId": s})
		}
	}()
	for _, t := range targets.TargetInfos {
		if t.Type != "page" {
			continue
		}
		var w struct {
			Bounds struct {
				Left, Top, Height float64
				WindowState       string `json:"windowState"`
			} `json:"bounds"`
		}
		if err := c.CDP.Call(ctx, "", "Browser.getWindowForTarget", map[string]any{"targetId": t.TargetID}, &w); err != nil || w.Bounds.WindowState == "minimized" {
			continue
		}
		var s struct {
			SessionID string `json:"sessionId"`
		}
		if err := c.CDP.Call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": t.TargetID, "flatten": true}, &s); err != nil {
			return false, err
		}
		sessions = append(sessions, s.SessionID)
		var r struct {
			Result struct {
				Value []json.RawMessage `json:"value"`
			} `json:"result"`
		}
		expr := `[document.visibilityState === "visible", document.hasFocus(), innerWidth, innerHeight, devicePixelRatio]`
		if err := c.CDP.Call(ctx, s.SessionID, "Runtime.evaluate", map[string]any{"expression": expr, "returnByValue": true}, &r); err != nil || len(r.Result.Value) != 5 {
			continue
		}
		var visible, focused bool
		var width, height, ratio float64
		for i, v := range []any{&visible, &focused, &width, &height, &ratio} {
			_ = json.Unmarshal(r.Result.Value[i], v)
		}
		if !visible || width <= 0 || height <= 0 || ratio <= 0 {
			continue
		}
		top := w.Bounds.Top + w.Bounds.Height - height*ratio
		px, py := (float64(x)-w.Bounds.Left)/ratio, (float64(y)-top)/ratio
		if px < 0 || py < 0 || px >= width || py >= height {
			continue
		}
		if found == nil || focused {
			found = &spot{s.SessionID, px, py}
		}
		if focused {
			break
		}
	}
	if found == nil {
		return false, nil
	}
	// Copy, link and move: whichever the page asks for, as with a file manager's drag.
	data := map[string]any{"items": []any{}, "files": paths, "dragOperationsMask": 1 | 2 | 16}
	for _, kind := range []string{"dragEnter", "dragOver", "drop"} {
		params := map[string]any{"type": kind, "x": found.x, "y": found.y, "data": data}
		if err := c.CDP.Call(ctx, found.session, "Input.dispatchDragEvent", params, nil); err != nil {
			return false, err
		}
	}
	return true, nil
}
