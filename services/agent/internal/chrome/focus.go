package chrome

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// focusExpression reads, without changing anything on the page, whether the page has the keyboard
// focus and which keyboard its focused element wants: [state, keyboard, visible, innerHeight,
// devicePixelRatio]. state 0: the page does not have the focus; 1: it has, not in a text field;
// 2: the focus is in a cross-origin frame, which is a target of its own; 3: a text field, whose
// keyboard is an inputmode (text, search, email, url, tel, numeric or decimal). Shadow roots and
// same-origin frames are followed down to the element itself. It never reads a field's value.
const focusExpression = `(() => {
  const d = document, visible = d.visibilityState === "visible";
  const out = (state, keyboard) => [state, keyboard || "", visible, innerHeight, devicePixelRatio];
  if (!d.hasFocus()) return out(0);
  let e = d.activeElement;
  for (;;) {
    if (e && e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; }
    if (e && (e.tagName === "IFRAME" || e.tagName === "FRAME")) {
      let inner = null;
      try { inner = e.contentDocument; } catch (_) {}
      if (!inner) return out(2);
      e = inner.activeElement;
      continue;
    }
    break;
  }
  if (!e) return out(1);
  const asked = String(e.inputMode || "").toLowerCase();
  if (asked === "none") return out(1);
  const hint = ["text", "search", "email", "url", "tel", "numeric", "decimal"].includes(asked) ? asked : "";
  if (e.isContentEditable) return out(3, hint || "text");
  if (e.tagName === "TEXTAREA") return e.readOnly || e.disabled ? out(1) : out(3, hint || "text");
  if (e.tagName !== "INPUT" || e.readOnly || e.disabled) return out(1);
  const keyboards = { text: "text", search: "search", email: "email", url: "url", tel: "tel", password: "text",
    number: "decimal", date: "numeric", time: "numeric", "datetime-local": "numeric", month: "numeric", week: "numeric" };
  return keyboards[e.type] ? out(3, hint || keyboards[e.type]) : out(1);
})()`

const (
	// focusEvalLimit bounds one page's answer: a page busy with script answers late, and a frozen
	// background tab not at all, while the sample is wanted within the tap's few hundred ms.
	focusEvalLimit = 150 * time.Millisecond
	// browserBarKeyboard is the keyboard for Chrome's address bar, which takes searches as well as
	// addresses: the URL keyboard has no space bar.
	browserBarKeyboard = "search"
	// browserBarButtons is the width at the right of Chrome's toolbar and tab strip, in remote
	// pixels, whose buttons open a bubble that takes the focus off the page without a text field
	// (the profile menu, extensions, downloads; the window's own buttons above them).
	browserBarButtons = 120
)

type pageFocus struct {
	state    int
	keyboard string
	visible  bool
	height   float64
	ratio    float64
}

type windowBounds struct {
	Left, Top, Width, Height float64
}

// inBrowserBar is whether a remote point lies in Chrome's tab strip or toolbar, where the address
// bar is: above the page's viewport (the bottom of the window, `height` CSS pixels at `ratio`) and
// left of the toolbar's buttons. Back, forward and reload leave the focus on the page, so the
// left end needs no exception.
func inBrowserBar(x, y float64, w windowBounds, height, ratio float64) bool {
	viewportTop := w.Top + w.Height - height*ratio
	return y >= w.Top && y < viewportTop && x >= w.Left && x < w.Left+w.Width-browserBarButtons
}

// focusReader reads where the keyboard focus is, repeatedly, for one tap. It keeps one DevTools
// session per page or frame it has read, until Close.
type focusReader struct {
	c        *Chrome
	x, y     float64
	mu       sync.Mutex
	sessions map[string]string // targetId -> sessionId
	windows  map[string]windowBounds
}

type targetInfo struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
}

// TextFocus opens a reading of the keyboard focus for a viewer's tap at (x, y) on the remote
// screen (agent.Browser). sample answers with the keyboard a focused text field wants, "" when the
// focus is elsewhere, and false when nothing could tell. Chrome's own address bar is not a page: a
// tap in the toolbar that took the focus off every page put it there (or in the tab search).
func (c *Chrome) TextFocus(ctx context.Context, x, y int) (func(context.Context) (string, bool), func(), error) {
	r := &focusReader{c: c, x: float64(x), y: float64(y), sessions: map[string]string{}, windows: map[string]windowBounds{}}
	return r.sample, r.close, nil
}

func (r *focusReader) close() {
	r.mu.Lock()
	sessions := r.sessions
	r.sessions = map[string]string{}
	r.mu.Unlock()
	for _, s := range sessions {
		r.c.CDP.cleanup("Target.detachFromTarget", map[string]any{"sessionId": s})
	}
}

// read evaluates focusExpression in each target at once; a target that cannot answer in time is
// left out.
func (r *focusReader) read(ctx context.Context, targets []targetInfo) map[string]pageFocus {
	var mu sync.Mutex
	var wg sync.WaitGroup
	out := map[string]pageFocus{}
	for _, t := range targets {
		wg.Add(1)
		go func(t targetInfo) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, focusEvalLimit)
			defer cancel()
			session, err := r.session(cctx, t.TargetID)
			if err != nil {
				return
			}
			var v struct {
				Result struct {
					Value []json.RawMessage `json:"value"`
				} `json:"result"`
			}
			if err := r.c.CDP.Call(cctx, session, "Runtime.evaluate", map[string]any{"expression": focusExpression, "returnByValue": true}, &v); err != nil || len(v.Result.Value) != 5 {
				if err != nil && cctx.Err() == nil {
					r.forget(t.TargetID) // the session ended (the page closed): attach again if it is still there
				}
				return
			}
			var f pageFocus
			for i, p := range []any{&f.state, &f.keyboard, &f.visible, &f.height, &f.ratio} {
				_ = json.Unmarshal(v.Result.Value[i], p)
			}
			mu.Lock()
			out[t.TargetID] = f
			mu.Unlock()
		}(t)
	}
	wg.Wait()
	return out
}

func (r *focusReader) forget(targetID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, targetID)
}

func (r *focusReader) session(ctx context.Context, targetID string) (string, error) {
	r.mu.Lock()
	s, ok := r.sessions[targetID]
	r.mu.Unlock()
	if ok {
		return s, nil
	}
	var a struct {
		SessionID string `json:"sessionId"`
	}
	if err := r.c.CDP.Call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, &a); err != nil {
		return "", err
	}
	r.mu.Lock()
	r.sessions[targetID] = a.SessionID
	r.mu.Unlock()
	return a.SessionID, nil
}

func (r *focusReader) sample(ctx context.Context) (string, bool) {
	var all struct {
		TargetInfos []targetInfo `json:"targetInfos"`
	}
	if err := r.c.CDP.Call(ctx, "", "Target.getTargets", map[string]any{}, &all); err != nil {
		return "", false
	}
	var pages, frames []targetInfo
	for _, t := range all.TargetInfos {
		switch t.Type {
		case "page":
			pages = append(pages, t)
		case "iframe":
			frames = append(frames, t)
		}
	}
	read := r.read(ctx, pages)
	if len(read) == 0 {
		return "", false
	}
	if keyboard, state := focused(read); state == 3 || state == 1 {
		return keyboard, true
	} else if state == 2 {
		if keyboard, state := focused(r.read(ctx, frames)); state == 3 || state == 1 {
			return keyboard, true
		}
		return "", false // a cross-origin frame in the page's own process: not readable
	}
	// No page has the focus: Chrome's own interface has it, if the tap was in its bar.
	for id, f := range read {
		if !f.visible || f.height <= 0 || f.ratio <= 0 {
			continue
		}
		w, ok := r.window(ctx, id)
		if ok && inBrowserBar(r.x, r.y, w, f.height, f.ratio) {
			return browserBarKeyboard, true
		}
	}
	return "", true
}

// focused is the focus among targets' readings, the most specific first: a text field, then
// another element, then a cross-origin frame (0 when no target has the focus). Only one has it,
// but a reading can catch the focus between two pages.
func focused(read map[string]pageFocus) (keyboard string, state int) {
	for _, want := range []int{3, 1, 2} {
		for _, f := range read {
			if f.state == want {
				return f.keyboard, want
			}
		}
	}
	return "", 0
}

func (r *focusReader) window(ctx context.Context, targetID string) (windowBounds, bool) {
	r.mu.Lock()
	w, ok := r.windows[targetID]
	r.mu.Unlock()
	if ok {
		return w, true
	}
	var v struct {
		Bounds struct {
			Left, Top, Width, Height float64
			WindowState              string `json:"windowState"`
		} `json:"bounds"`
	}
	if err := r.c.CDP.Call(ctx, "", "Browser.getWindowForTarget", map[string]any{"targetId": targetID}, &v); err != nil || v.Bounds.WindowState == "minimized" {
		return windowBounds{}, false
	}
	w = windowBounds{Left: v.Bounds.Left, Top: v.Bounds.Top, Width: v.Bounds.Width, Height: v.Bounds.Height}
	r.mu.Lock()
	r.windows[targetID] = w
	r.mu.Unlock()
	return w, true
}
