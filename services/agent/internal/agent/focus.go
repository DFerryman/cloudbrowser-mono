package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/protocol"
)

// A touch viewer's on-screen keyboard follows the remote focus (agent 0.7.0). Right before a
// tap's click, the viewer asks where the focus goes, in a neko-shaped message on its relay that
// never reaches neko:
//
//	{"event":"cloudbrowser/focus","payload":{"id":3,"x":640,"y":120}}
//
// The first reading is then from before the click. The agent answers on the same relay with the
// keyboard a focused text field wants ("" when the focus is not in one) as soon as the focus is in
// a text field it was not in before, and with where the focus settled focusSettle after the
// question, unless that is what it already answered:
//
//	{"event":"cloudbrowser/focus","payload":{"id":3,"keyboard":"email"}}
//
// A question that the next one overtakes, or that Chrome cannot answer, gets no answer. A viewer
// learns that the agent answers from featuresMessage, sent when its relay opens.
const (
	focusEvent  = "cloudbrowser/focus"
	focusEvery  = 25 * time.Millisecond
	focusSettle = 400 * time.Millisecond
)

var featuresMessage = json.RawMessage(`{"event":"cloudbrowser/features","payload":{"textFocus":true}}`)

type focusQuestion struct {
	ID int64 `json:"id"`
	X  int   `json:"x"`
	Y  int   `json:"y"`
}

// focusAsked reads a viewer's neko message as a focus question; any other message is neko's.
func focusAsked(data json.RawMessage) (focusQuestion, bool) {
	if !bytes.Contains(data, []byte(focusEvent)) {
		return focusQuestion{}, false
	}
	var m struct {
		Event   string        `json:"event"`
		Payload focusQuestion `json:"payload"`
	}
	if json.Unmarshal(data, &m) != nil || m.Event != focusEvent {
		return focusQuestion{}, false
	}
	return m.Payload, true
}

type focusWatch struct{ cancel context.CancelFunc }

// watchFocus answers one focus question, in the background: the read loop goes on to the tap's
// click right away. A newer question from the same viewer ends it.
func (a *Agent) watchFocus(ctx context.Context, sessionID, relayID string, q focusQuestion) {
	wctx, cancel := context.WithTimeout(ctx, focusSettle+2*time.Second)
	w := &focusWatch{cancel: cancel}
	a.mu.Lock()
	if a.focusWatches == nil {
		a.focusWatches = map[string]*focusWatch{}
	}
	if previous := a.focusWatches[sessionID]; previous != nil {
		previous.cancel()
	}
	a.focusWatches[sessionID] = w
	a.mu.Unlock()
	go func() {
		defer func() {
			cancel()
			a.mu.Lock()
			if a.focusWatches[sessionID] == w {
				delete(a.focusWatches, sessionID)
			}
			a.mu.Unlock()
		}()
		sample, done, err := a.browser.TextFocus(wctx, q.X, q.Y)
		if err != nil {
			return
		}
		defer done()
		deadline := time.Now().Add(focusSettle)
		before, knownBefore := sample(wctx)
		settled, known := before, knownBefore
		answered, hasAnswered := "", false
		for time.Now().Before(deadline) {
			select {
			case <-wctx.Done():
				return
			case <-time.After(focusEvery):
			}
			keyboard, ok := sample(wctx)
			if wctx.Err() != nil {
				return
			}
			if !ok {
				continue
			}
			settled, known = keyboard, true
			if keyboard != "" && (!knownBefore || keyboard != before) && !(hasAnswered && keyboard == answered) {
				a.answerFocus(wctx, sessionID, relayID, q.ID, keyboard)
				answered, hasAnswered = keyboard, true
			}
		}
		if known && !(hasAnswered && settled == answered) {
			a.answerFocus(wctx, sessionID, relayID, q.ID, settled)
		}
	}()
}

func (a *Agent) answerFocus(ctx context.Context, sessionID, relayID string, id int64, keyboard string) {
	a.mu.Lock()
	current := a.sessions[sessionID] != nil && a.relayIDs[sessionID] == relayID
	a.mu.Unlock()
	if !current {
		return
	}
	msg, _ := json.Marshal(map[string]any{"event": focusEvent, "payload": map[string]any{"id": id, "keyboard": keyboard}})
	_ = a.write(ctx, protocol.ToViewer{T: "viewer", SessionID: sessionID, RelayID: relayID, Data: msg})
}

// endFocusWatch stops a closing viewer's question.
func (a *Agent) endFocusWatch(sessionID string) {
	a.mu.Lock()
	w := a.focusWatches[sessionID]
	delete(a.focusWatches, sessionID)
	a.mu.Unlock()
	if w != nil {
		w.cancel()
	}
}
