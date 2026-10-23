package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Bridge input steps (contracts ActionStep), executed in order inside the VM through the
// bridge's neko session: the same control events the live view sends, so a click or a shortcut
// from a coding agent behaves exactly like the user's. Composite steps (a double-click, a chord,
// a drag) run here, with fixed pacing, instead of as separate network round trips.

const (
	pressGap    = 25 * time.Millisecond
	clickGap    = 70 * time.Millisecond
	dragGap     = 16 * time.Millisecond
	typeGap     = 8 * time.Millisecond
	maxSteps    = 32
	maxTypeText = 4000
	// sendCost bounds what one input event costs besides its pacing (a write to neko on the
	// loopback interface): with the pacing it makes step.cost's estimate of an action's length.
	sendCost = time.Millisecond
)

type step struct {
	Type      string   `json:"type"`
	X, Y      *int     `json:"-"`
	Button    string   `json:"button,omitempty"`
	Count     int      `json:"count,omitempty"`
	Modifiers []string `json:"modifiers,omitempty"`
	Down      *bool    `json:"down,omitempty"`
	Path      []point  `json:"path,omitempty"`
	DeltaX    int      `json:"deltaX,omitempty"`
	DeltaY    int      `json:"deltaY,omitempty"`
	Keys      []string `json:"keys,omitempty"`
	Key       string   `json:"key,omitempty"`
	Text      string   `json:"text,omitempty"`
	Ms        int      `json:"ms,omitempty"`
}

type point struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// stepError is a refused step: why ("invalid" or "unknown_key") and which one.
type stepError struct {
	reason string
	index  int
	err    error
}

func (e *stepError) Error() string { return fmt.Sprintf("step %d: %v", e.index, e.err) }

var errUnknownKey = errors.New("unknown key")

// parseSteps validates the steps and estimates how long they take to run, pacing included, so
// an action that cannot finish within maxActDuration is refused before any of it runs.
func parseSteps(raw []json.RawMessage) ([]step, time.Duration, error) {
	if len(raw) == 0 || len(raw) > maxSteps {
		return nil, 0, errors.New("step count")
	}
	steps := make([]step, 0, len(raw))
	var cost time.Duration
	for i, r := range raw {
		var s step
		var xy struct {
			X *int `json:"x"`
			Y *int `json:"y"`
		}
		if json.Unmarshal(r, &s) != nil || json.Unmarshal(r, &xy) != nil {
			return nil, 0, &stepError{reason: "invalid", index: i, err: errors.New("step")}
		}
		s.X, s.Y = xy.X, xy.Y
		if err := s.validate(); err != nil {
			reason := "invalid"
			if errors.Is(err, errUnknownKey) {
				reason = "unknown_key"
			}
			return nil, 0, &stepError{reason: reason, index: i, err: err}
		}
		steps = append(steps, s)
		cost += s.cost()
	}
	return steps, cost, nil
}

func (s *step) validate() error {
	coord := func(p *int) bool { return p == nil || (*p >= 0 && *p <= 0xffff) }
	if !coord(s.X) || !coord(s.Y) || (s.X == nil) != (s.Y == nil) {
		return errors.New("coordinates")
	}
	if s.Button == "" {
		s.Button = "left"
	}
	if _, ok := x11Buttons[s.Button]; !ok {
		return errors.New("button")
	}
	for _, m := range s.Modifiers {
		if _, ok := keysymForName(m); !ok {
			return fmt.Errorf("modifier %q: %w", m, errUnknownKey)
		}
		if !isModifier(m) {
			return errors.New("modifier")
		}
	}
	switch s.Type {
	case "move":
		if s.X == nil {
			return errors.New("move needs a point")
		}
	case "click":
		if s.Count == 0 {
			s.Count = 1
		}
		if s.Count < 1 || s.Count > 3 {
			return errors.New("count")
		}
	case "button":
		if s.Down == nil {
			return errors.New("button needs down")
		}
	case "drag":
		if len(s.Path) < 2 || len(s.Path) > 64 {
			return errors.New("path")
		}
		for _, p := range s.Path {
			if p.X < 0 || p.Y < 0 || p.X > 0xffff || p.Y > 0xffff {
				return errors.New("path point")
			}
		}
	case "scroll":
		if s.DeltaX < -100 || s.DeltaX > 100 || s.DeltaY < -100 || s.DeltaY > 100 {
			return errors.New("delta")
		}
	case "key":
		if len(s.Keys) == 0 || len(s.Keys) > 6 {
			return errors.New("keys")
		}
		for _, k := range s.Keys {
			if _, ok := keysymForName(k); !ok {
				return fmt.Errorf("key %q: %w", k, errUnknownKey)
			}
		}
	case "keyhold":
		if s.Down == nil {
			return errors.New("keyhold needs down")
		}
		if _, ok := keysymForName(s.Key); !ok {
			return fmt.Errorf("key %q: %w", s.Key, errUnknownKey)
		}
	case "type", "paste":
		if s.Text == "" || len(s.Text) > maxTypeText*4 || utf8.RuneCountInString(s.Text) > maxTypeText || !utf8.ValidString(s.Text) {
			return errors.New("text")
		}
	case "wait":
		if s.Ms < 0 || time.Duration(s.Ms)*time.Millisecond > maxWaitStep {
			return errors.New("wait")
		}
	default:
		return errors.New("type")
	}
	return nil
}

// cost is how long runSteps takes for the step: its input events, its pacing and waits, and the
// pause after every step.
func (s *step) cost() time.Duration {
	d := pressGap
	if len(s.Modifiers) > 0 {
		d += time.Duration(2*len(s.Modifiers))*sendCost + pressGap
	}
	if s.X != nil && s.Type != "move" {
		d += sendCost + pressGap // the move to the point first
	}
	switch s.Type {
	case "move", "button", "scroll", "keyhold", "paste":
		d += sendCost
	case "click":
		d += time.Duration(s.Count)*(2*sendCost+pressGap) + time.Duration(s.Count-1)*clickGap
	case "drag":
		d += 3*sendCost + pressGap + 2*clickGap + time.Duration(len(s.Path)-1)*(sendCost+dragGap)
	case "key":
		d += time.Duration(2*len(s.Keys)) * (sendCost + pressGap)
	case "type":
		d += typeCost(s.Text)
	case "wait":
		d += time.Duration(s.Ms) * time.Millisecond
	}
	return d
}

// typeCost follows typeText: a printable ASCII character, Enter or Tab is up to four key events
// and a typeGap; each run of other characters is one paste and a clickGap.
func typeCost(text string) time.Duration {
	var d time.Duration
	pasting := false
	for _, r := range text {
		if r >= 0x80 {
			if !pasting {
				d += sendCost + clickGap
			}
			pasting = true
			continue
		}
		pasting = false
		if r == '\n' || r == '\r' || r == '\t' || (r >= 0x20 && r <= 0x7e) {
			d += 4*sendCost + typeGap
		}
	}
	return d
}

var x11Buttons = map[string]int64{"left": 1, "middle": 2, "right": 3, "back": 8, "forward": 9}

var namedKeysyms = map[string]int64{
	"Backspace": 0xff08, "Tab": 0xff09, "Enter": 0xff0d, "Return": 0xff0d, "Pause": 0xff13, "ScrollLock": 0xff14,
	"Escape": 0xff1b, "Home": 0xff50, "ArrowLeft": 0xff51, "ArrowUp": 0xff52, "ArrowRight": 0xff53, "ArrowDown": 0xff54,
	"Left": 0xff51, "Up": 0xff52, "Right": 0xff53, "Down": 0xff54,
	"PageUp": 0xff55, "PageDown": 0xff56, "End": 0xff57, "PrintScreen": 0xff61, "Insert": 0xff63, "ContextMenu": 0xff67,
	"NumLock": 0xff7f, "CapsLock": 0xffe5, "Delete": 0xffff, "Shift": 0xffe1, "Control": 0xffe3, "Ctrl": 0xffe3,
	"Alt": 0xffe9, "Meta": 0xffeb, "Super": 0xffeb, "Space": 0x0020, " ": 0x0020,
}

func isModifier(name string) bool {
	switch name {
	case "Shift", "Control", "Ctrl", "Alt", "Meta", "Super":
		return true
	}
	return false
}

// keysymForName follows packages/viewer/src/keyboard.ts: named keys, F1-F24, single characters
// (their code point, 0x01000000 + code point beyond Latin-1) and explicit `keysym:0x…`.
func keysymForName(name string) (int64, bool) {
	if sym, ok := namedKeysyms[name]; ok {
		return sym, true
	}
	if strings.HasPrefix(name, "keysym:") {
		v, err := strconv.ParseInt(strings.TrimPrefix(name, "keysym:"), 0, 64)
		return v, err == nil && v > 0 && v <= 0x1ffffff
	}
	if len(name) >= 2 && name[0] == 'F' {
		if n, err := strconv.Atoi(name[1:]); err == nil && n >= 1 && n <= 24 {
			return 0xffbe + int64(n) - 1, true
		}
	}
	if utf8.RuneCountInString(name) == 1 {
		r, _ := utf8.DecodeRuneInString(name)
		if r >= 0x20 {
			if r <= 0xff {
				return int64(r), true
			}
			return 0x01000000 + int64(r), true
		}
	}
	return 0, false
}

const (
	symShift = 0xffe1
	symEnter = 0xff0d
	symTab   = 0xff09
)

// shiftedSymbols are the US-layout characters that need Shift; keys sent with Shift held use
// the shifted symbol, as neko resolves a keysym against the current modifiers.
const softwareShifted = "~!@#$%^&*()_+{}|:\"<>?"

var shiftedKeysyms = func() map[int64]int64 {
	base := "`1234567890-=[]\\;',./"
	m := map[int64]int64{}
	for i := range base {
		m[int64(base[i])] = int64(softwareShifted[i])
	}
	return m
}()

func shiftedKeysym(sym int64) int64 {
	if sym >= 'a' && sym <= 'z' {
		return sym - 0x20
	}
	if s, ok := shiftedKeysyms[sym]; ok {
		return s
	}
	return sym
}

func modifierKeysym(sym int64) bool { return sym >= 0xffe1 && sym <= 0xffee }

// pacer waits between inputs unless the action was stopped.
func pace(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// key presses or releases one key and keeps the list of keys the bridge holds. The context
// check, the list and the send happen under s.mu, so releaseHeld (a takeover) either sees a
// press and releases it, or the stopped action never sends it. A release ignores the context: a
// stopped chord must still let go of its keys. It is sent only for a key the bridge still holds,
// since releaseHeld may have released it already and by then the same key can be the user's own.
func (a *Agent) key(ctx context.Context, s *automation, n NekoSession, down bool, sym int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if down {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := n.Send(nekoEvent("control/keydown", map[string]any{"keysym": sym})); err != nil {
			return err
		}
		s.heldKeys = append(s.heldKeys, sym)
		return nil
	}
	i := lastIndex(s.heldKeys, sym)
	if i < 0 {
		return nil
	}
	s.heldKeys = append(s.heldKeys[:i], s.heldKeys[i+1:]...)
	return n.Send(nekoEvent("control/keyup", map[string]any{"keysym": sym}))
}

// button is key for mouse buttons.
func (a *Agent) button(ctx context.Context, s *automation, n NekoSession, down bool, code int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if down {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := n.Send(nekoEvent("control/buttondown", map[string]any{"code": code})); err != nil {
			return err
		}
		s.heldBtns = append(s.heldBtns, code)
		return nil
	}
	i := lastIndex(s.heldBtns, code)
	if i < 0 {
		return nil
	}
	s.heldBtns = append(s.heldBtns[:i], s.heldBtns[i+1:]...)
	return n.Send(nekoEvent("control/buttonup", map[string]any{"code": code}))
}

func lastIndex(held []int64, v int64) int {
	for i := len(held) - 1; i >= 0; i-- {
		if held[i] == v {
			return i
		}
	}
	return -1
}

func (a *Agent) move(ctx context.Context, n NekoSession, x, y int) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return n.Send(nekoEvent("control/move", map[string]any{"x": x, "y": y}))
}

// sendChord presses the keys in order and releases them in reverse; a letter under Shift is
// sent as its shifted symbol. Every key it pressed is released, also when it is stopped halfway:
// an interrupted Control+Alt+Delete must not leave Control and Alt held for the user.
func (a *Agent) sendChord(ctx context.Context, s *automation, n NekoSession, names []string) error {
	shift := false
	for _, name := range names {
		if name == "Shift" {
			shift = true
		}
	}
	var syms []int64
	for _, name := range names {
		sym, ok := keysymForName(name)
		if !ok {
			return errors.New("key")
		}
		if shift && !modifierKeysym(sym) {
			sym = shiftedKeysym(sym)
		}
		syms = append(syms, sym)
	}
	pressed := 0
	var err error
	for _, sym := range syms {
		if err = a.key(ctx, s, n, true, sym); err != nil {
			break
		}
		pressed++
		if err = pace(ctx, pressGap); err != nil {
			break
		}
	}
	for i := pressed - 1; i >= 0; i-- {
		if e := a.key(ctx, s, n, false, syms[i]); e != nil && err == nil {
			err = e
		}
		if err == nil {
			err = pace(ctx, pressGap)
		}
	}
	return err
}

// withModifiers holds the modifiers around body and releases them whatever happens to it.
func (a *Agent) withModifiers(ctx context.Context, s *automation, n NekoSession, mods []string, body func() error) error {
	var syms []int64
	var err error
	for _, m := range mods {
		sym, _ := keysymForName(m)
		if err = a.key(ctx, s, n, true, sym); err != nil {
			break
		}
		syms = append(syms, sym)
	}
	if err == nil && len(syms) > 0 {
		err = pace(ctx, pressGap)
	}
	if err == nil {
		err = body()
	}
	for i := len(syms) - 1; i >= 0; i-- {
		if e := a.key(ctx, s, n, false, syms[i]); err == nil {
			err = e
		}
	}
	return err
}

// typeText types like the live view's software keyboard: ASCII as key strokes (Shift where the
// US layout needs it), anything else through neko's paste, with no Enter unless the text has one.
// A character whose key went down always comes up again, also when the action is stopped.
func (a *Agent) typeText(ctx context.Context, s *automation, n NekoSession, text string) error {
	var pending strings.Builder
	flush := func() error {
		if pending.Len() == 0 {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		err := n.Send(nekoEvent("control/paste", map[string]any{"text": pending.String()}))
		pending.Reset()
		if err != nil {
			return err
		}
		return pace(ctx, clickGap)
	}
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	for _, r := range text {
		if r >= 0x80 {
			pending.WriteRune(r)
			continue
		}
		if err := flush(); err != nil {
			return err
		}
		var sym int64
		shift := false
		switch {
		case r == '\n':
			sym = symEnter
		case r == '\t':
			sym = symTab
		case r >= 0x20 && r <= 0x7e:
			sym = int64(r)
			shift = strings.ContainsRune(softwareShifted, r) || (r >= 'A' && r <= 'Z')
		default:
			continue
		}
		if shift {
			if err := a.key(ctx, s, n, true, symShift); err != nil {
				return err
			}
		}
		err := a.key(ctx, s, n, true, sym)
		if err == nil {
			err = a.key(ctx, s, n, false, sym)
		}
		if shift {
			if e := a.key(ctx, s, n, false, symShift); err == nil {
				err = e
			}
		}
		if err != nil {
			return err
		}
		if err := pace(ctx, typeGap); err != nil {
			return err
		}
	}
	return flush()
}

// offScreen is the index of the first step with a point outside the screen, or -1. Nothing is
// checked while the screen is unknown (neither neko's init nor a screenshot told it yet).
func offScreen(steps []step, screen screenState) int {
	if screen.width == 0 {
		return -1
	}
	inside := func(x, y int) bool { return x < screen.width && y < screen.height }
	for i, st := range steps {
		if st.X != nil && !inside(*st.X, *st.Y) {
			return i
		}
		if st.Type == "drag" {
			for _, p := range st.Path {
				if !inside(p.X, p.Y) {
					return i
				}
			}
		}
	}
	return -1
}

// runSteps executes the steps; it returns the index of the first step that did not complete.
// Their points were checked against the screen (offScreen) when the action began; a screen
// change since stops the action.
func (a *Agent) runSteps(ctx context.Context, s *automation, n NekoSession, steps []step) (int, error) {
	for i, st := range steps {
		if ctx.Err() != nil {
			return i, ctx.Err()
		}
		var err error
		switch st.Type {
		case "move":
			err = a.move(ctx, n, *st.X, *st.Y)
		case "click":
			err = a.withModifiers(ctx, s, n, st.Modifiers, func() error {
				if st.X != nil {
					if err := a.move(ctx, n, *st.X, *st.Y); err != nil {
						return err
					}
					if err := pace(ctx, pressGap); err != nil {
						return err
					}
				}
				code := x11Buttons[st.Button]
				for c := 0; c < st.Count; c++ {
					if c > 0 {
						if err := pace(ctx, clickGap); err != nil {
							return err
						}
					}
					if err := a.button(ctx, s, n, true, code); err != nil {
						return err
					}
					err := pace(ctx, pressGap)
					// The button comes up even when the action stops between press and release.
					if e := a.button(ctx, s, n, false, code); err == nil {
						err = e
					}
					if err != nil {
						return err
					}
				}
				return nil
			})
		case "button":
			if st.X != nil {
				if err = a.move(ctx, n, *st.X, *st.Y); err != nil {
					break
				}
				if err = pace(ctx, pressGap); err != nil {
					break
				}
			}
			err = a.button(ctx, s, n, *st.Down, x11Buttons[st.Button])
		case "drag":
			err = a.withModifiers(ctx, s, n, st.Modifiers, func() error {
				code := x11Buttons[st.Button]
				first := st.Path[0]
				if err := a.move(ctx, n, first.X, first.Y); err != nil {
					return err
				}
				if err := pace(ctx, pressGap); err != nil {
					return err
				}
				if err := a.button(ctx, s, n, true, code); err != nil {
					return err
				}
				err := pace(ctx, clickGap)
				for _, p := range st.Path[1:] {
					if err != nil {
						break
					}
					if err = a.move(ctx, n, p.X, p.Y); err == nil {
						err = pace(ctx, dragGap)
					}
				}
				if err == nil {
					err = pace(ctx, clickGap)
				}
				// Released where the drag stopped if it was stopped: a button left down would
				// turn the user's next pointer movement into a drag.
				if e := a.button(ctx, s, n, false, code); err == nil {
					err = e
				}
				return err
			})
		case "scroll":
			err = a.withModifiers(ctx, s, n, st.Modifiers, func() error {
				if st.X != nil {
					if err := a.move(ctx, n, *st.X, *st.Y); err != nil {
						return err
					}
					if err := pace(ctx, pressGap); err != nil {
						return err
					}
				}
				control := false
				for _, m := range st.Modifiers {
					if m == "Control" || m == "Ctrl" {
						control = true
					}
				}
				if err := ctx.Err(); err != nil {
					return err
				}
				// neko's deltas are signed X11 wheel clicks: positive delta_y scrolls up.
				return n.Send(nekoEvent("control/scroll", map[string]any{"delta_x": -st.DeltaX, "delta_y": -st.DeltaY, "control_key": control}))
			})
		case "key":
			err = a.sendChord(ctx, s, n, st.Keys)
		case "keyhold":
			sym, _ := keysymForName(st.Key)
			err = a.key(ctx, s, n, *st.Down, sym)
		case "type":
			err = a.typeText(ctx, s, n, st.Text)
		case "paste":
			if err = ctx.Err(); err == nil {
				err = n.Send(nekoEvent("control/paste", map[string]any{"text": st.Text}))
			}
		case "wait":
			err = pace(ctx, time.Duration(st.Ms)*time.Millisecond)
		}
		if err != nil {
			return i, err
		}
		if err := pace(ctx, pressGap); err != nil {
			return i + 1, err
		}
	}
	return len(steps), nil
}
