package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// focusAgent is an agent with one admitted viewer ("viewer1" on "relay1") whose frames to the
// gateway arrive on the returned channel, the features message already read.
func focusAgent(t *testing.T, browser *fakeBrowser) (*Agent, *inputSession, <-chan map[string]any, context.Context) {
	t.Helper()
	g, srv := newGateway(t)
	c, _, err := websocket.Dial(context.Background(), "ws"+srv.URL[len("http"):]+"/v1/agent", &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Instance-Id": []string{"inst1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	remote := <-g.conns
	frames := make(chan map[string]any, 16)
	go func() {
		for {
			_, data, err := remote.Read(context.Background())
			if err != nil {
				return
			}
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			frames <- m
		}
	}()
	session := &inputSession{done: make(chan struct{}), got: make(chan json.RawMessage, 16)}
	a := New(Config{}, browser, inputRelay{session}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.conn = c
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	openReadyViewer(t, a, ctx, "viewer1", "relay1")
	select {
	case m := <-frames:
		data, _ := m["data"].(map[string]any)
		payload, _ := data["payload"].(map[string]any)
		if m["t"] != "viewer" || m["sessionId"] != "viewer1" || m["relayId"] != "relay1" || data["event"] != "cloudbrowser/features" || payload["textFocus"] != true {
			t.Fatalf("the viewer was not told that the agent answers focus questions: %v", m)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no features message when the viewer's relay opened")
	}
	return a, session, frames, ctx
}

func ask(a *Agent, ctx context.Context, id int) {
	q, _ := json.Marshal(map[string]any{"t": "neko", "data": map[string]any{"event": "cloudbrowser/focus", "payload": map[string]any{"id": id, "x": 640, "y": 120}}})
	a.fromViewer(ctx, "viewer1", q, "relay1")
}

// answers collects the focus answers that arrive within `within`, as id → keyboards in order.
func answers(t *testing.T, frames <-chan map[string]any, within time.Duration) [][2]any {
	t.Helper()
	var out [][2]any
	deadline := time.After(within)
	for {
		select {
		case m := <-frames:
			data, _ := m["data"].(map[string]any)
			if m["t"] != "viewer" || data["event"] != "cloudbrowser/focus" {
				t.Fatalf("unexpected frame: %v", m)
			}
			if m["sessionId"] != "viewer1" || m["relayId"] != "relay1" {
				t.Fatalf("answer for the wrong relay: %v", m)
			}
			payload, _ := data["payload"].(map[string]any)
			out = append(out, [2]any{payload["id"], payload["keyboard"]})
		case <-deadline:
			return out
		}
	}
}

func TestFocusQuestionIsAnsweredAndNeverReachesNeko(t *testing.T) {
	browser := &fakeBrowser{focus: []focusReading{{"", true}, {"", true}, {"email", true}}}
	a, session, frames, ctx := focusAgent(t, browser)
	ask(a, ctx, 7)
	got := answers(t, frames, 2*focusSettle)
	if len(got) != 1 || got[0][0] != float64(7) || got[0][1] != "email" {
		t.Fatalf("want one early answer for the email field, got %v", got)
	}
	select {
	case m := <-session.got:
		t.Fatalf("the focus question reached neko: %s", m)
	default:
	}
	browser.mu.Lock()
	defer browser.mu.Unlock()
	if len(browser.focusAt) != 1 || browser.focusAt[0] != [2]int{640, 120} || browser.focusDone != 1 {
		t.Fatalf("reading opened for %v, released %d times", browser.focusAt, browser.focusDone)
	}
}

func TestFocusAnswersEarlyOnlyForANewTextField(t *testing.T) {
	for _, c := range []struct {
		name     string
		readings []focusReading
		want     [][2]any
	}{
		// Already in a text field (a tap in it again): no change, answered as it settled.
		{"unchanged text field", []focusReading{{"text", true}}, [][2]any{{float64(1), "text"}}},
		// Out of a text field: answered as it settled.
		{"left the text field", []focusReading{{"text", true}, {"", true}}, [][2]any{{float64(1), ""}}},
		// From one field to another kind, through no field (a label's click): the new one early.
		{"another kind of field", []focusReading{{"text", true}, {"", true}, {"tel", true}}, [][2]any{{float64(1), "tel"}}},
		// The first reading unknown (the page busy): any text field counts as new.
		{"first reading unknown", []focusReading{{"", false}, {"search", true}}, [][2]any{{float64(1), "search"}}},
		// Into a field and out again before the focus settled: both.
		{"in and out", []focusReading{{"", true}, {"text", true}, {"", true}}, [][2]any{{float64(1), "text"}, {float64(1), ""}}},
		// Nothing could tell: no answer.
		{"unknown", []focusReading{{"", false}}, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			browser := &fakeBrowser{focus: c.readings}
			a, _, frames, ctx := focusAgent(t, browser)
			ask(a, ctx, 1)
			got := answers(t, frames, 2*focusSettle)
			if len(got) != len(c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("got %v, want %v", got, c.want)
				}
			}
		})
	}
}

func TestNewerFocusQuestionOvertakesAndClosingEndsIt(t *testing.T) {
	browser := &fakeBrowser{focus: []focusReading{{"text", true}}}
	a, _, frames, ctx := focusAgent(t, browser)
	ask(a, ctx, 1)
	ask(a, ctx, 2)
	got := answers(t, frames, 2*focusSettle)
	if len(got) != 1 || got[0][0] != float64(2) {
		t.Fatalf("want only the newer question answered, got %v", got)
	}
	ask(a, ctx, 3)
	a.closeViewer("viewer1", "relay1")
	if got := answers(t, frames, 2*focusSettle); len(got) != 0 {
		t.Fatalf("a closed viewer's question was answered: %v", got)
	}
	browser.mu.Lock()
	defer browser.mu.Unlock()
	if browser.focusDone != 3 {
		t.Fatalf("readings released %d times, want 3", browser.focusDone)
	}
}

func TestFocusAskedReadsOnlyTheQuestion(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"event":"cloudbrowser/focus","payload":{"id":3,"x":1,"y":2}}`:     true,
		`{"event":"control/keydown","payload":{"keysym":97}}`:               false,
		`{"event":"clipboard/set","payload":{"text":"cloudbrowser/focus"}}`: false,
		`{"event":"cloudbrowser/focusing","payload":{}}`:                    false,
		`not json cloudbrowser/focus`:                                       false,
	} {
		q, ok := focusAsked(json.RawMessage(raw))
		if ok != want || (ok && (q.ID != 3 || q.X != 1 || q.Y != 2)) {
			t.Fatalf("%s: got %+v %v", raw, q, ok)
		}
	}
}
