package agent

import (
	"context"
	"encoding/json"
	"time"

	"github.com/dferryman/cloudbrowser-mono/services/agent/internal/protocol"
)

// Input control between the user's live view and a coding agent's bridge (docs/agent-access.md).
// Every input path, viewer and bridge alike, passes through this one state: who holds input now
// (controller), who may hold it (mode, persisted by the api so a takeover survives restarts), and
// a control epoch: a bridge action decided on a screenshot taken before control last left the
// agent is refused when it is dispatched.
//
//   - A real input from the user (a click, a key, a scroll, pasted text, a dropped file) takes
//     control at once: the epoch advances, the running bridge action is stopped, keys and buttons
//     the bridge left held are released, then that same input is executed. While a bridge is
//     connected the mode also becomes `user`, which only the user's explicit hand-back ends.
//     Without that pause (no bridge was connected), a bridge may take control only once the
//     user has given no real input for userActiveFor.
//   - Pointer movement while the bridge controls is not forwarded: it would change the hover
//     state the bridge is looking at. The last position is replayed before a click takes over.
//   - A remote screen change is not a takeover; it voids coordinates (screenVersion) instead.
const (
	ctlNone  = "none"
	ctlAgent = "agent"
	ctlUser  = "user"

	modeAgent   = "agent"
	modeUser    = "user"
	modePrivacy = "privacy"
)

type controlState struct {
	controller string
	mode       string
	access     bool
	epoch      int64
	// leftEpoch is the epoch at which control last left the agent (a takeover, a pause, access
	// turned off) or was handed back to it: a screenshot taken before it may show a screen the
	// user changed since (checkBasis). The agent's own claims advance epoch, not leftEpoch, so
	// several actions can be decided on one screenshot.
	leftEpoch int64
	// The user's last real input; pointer movement does not count.
	userInputAt time.Time
	// The viewer's last pointer position withheld while the bridge controls (x, y, known).
	pointer struct {
		x, y  int
		known bool
	}
}

func (a *Agent) controlSnapshot() protocol.ControlState {
	return protocol.ControlState{Controller: a.control.controller, Mode: a.control.mode, Epoch: a.control.epoch}
}

// bridgeConnected is whether any bridge session is open (callers hold a.mu).
func (a *Agent) bridgeConnected() bool { return len(a.automations) > 0 }

// userInputKind classifies a viewer frame: "input" takes control, "move" is pointer movement,
// "" is signaling or desktop configuration that never changes control.
func userInputKind(f protocol.ViewerFrame) string {
	switch f.T {
	case "ime", "file_begin":
		return "input"
	case "file_chunk", "file_end", "file_cancel":
		return ""
	case "neko":
		var m struct {
			Event string `json:"event"`
		}
		if json.Unmarshal(f.Data, &m) != nil {
			return ""
		}
		switch m.Event {
		case "control/move":
			return "move"
		case "control/scroll", "control/buttondown", "control/buttonup", "control/keydown", "control/keyup",
			"control/paste", "control/cut", "control/copy", "control/select_all", "clipboard/set", "control/buttonpress", "control/keypress":
			return "input"
		}
	}
	return ""
}

// arbitrateViewer decides what to do with a viewer frame before it is relayed: forward it, drop
// it (pointer movement under bridge control), or take control first. It returns frames to send
// to neko ahead of this one (a withheld pointer position) and whether to forward the frame.
func (a *Agent) arbitrateViewer(ctx context.Context, f protocol.ViewerFrame) (ahead []json.RawMessage, forward bool) {
	kind := userInputKind(f)
	a.mu.Lock()
	if kind == "input" {
		a.control.userInputAt = time.Now()
	}
	withheld := a.control.controller == ctlAgent && a.bridgeConnected()
	if kind == "move" && withheld {
		var m struct {
			Payload struct {
				X, Y int
			} `json:"payload"`
		}
		if json.Unmarshal(f.Data, &m) == nil {
			a.control.pointer.x, a.control.pointer.y, a.control.pointer.known = m.Payload.X, m.Payload.Y, true
		}
		a.mu.Unlock()
		return nil, false
	}
	if kind != "input" || a.control.controller == ctlUser {
		a.mu.Unlock()
		return nil, true
	}
	// A real input: switch control atomically, then let this input through.
	if withheld && a.control.pointer.known {
		p := a.control.pointer
		raw, _ := json.Marshal(map[string]any{"event": "control/move", "payload": map[string]int{"x": p.x, "y": p.y}})
		ahead = append(ahead, raw)
	}
	a.control.pointer.known = false
	a.control.controller = ctlUser
	a.control.epoch++
	a.control.leftEpoch = a.control.epoch
	reason := "user_input"
	if a.bridgeConnected() && a.control.mode == modeAgent {
		a.control.mode = modeUser
	}
	state := a.controlSnapshot()
	sessions := a.automationList()
	a.mu.Unlock()
	for _, s := range sessions {
		s.interrupt("control_changed")
		s.releaseHeld()
	}
	a.publishControl(ctx, state, reason)
	return ahead, true
}

// claimForBridge gives a bridge input control if the mode allows it. Callers hold a.mu. The
// returned reason is empty on success or why the request is refused.
func (a *Agent) claimForBridge() (changed bool, reason string) {
	switch {
	case !a.control.access:
		return false, "agent_access_off"
	case a.control.mode == modePrivacy:
		return false, "control_privacy"
	case a.control.mode == modeUser:
		return false, "control_user"
	case a.control.controller == ctlUser && time.Since(a.control.userInputAt) < userActiveFor:
		// The user is at work, though no pause was persisted (they took control while no bridge
		// was connected): the agent may take over only once they have left it alone for a while.
		return false, "user_active"
	}
	if a.control.controller == ctlAgent {
		return false, ""
	}
	a.control.controller = ctlAgent
	a.control.epoch++
	a.control.pointer.known = false
	return true, ""
}

// applyControl is the user's choice, relayed by the api: hand control back (`agent`), keep it
// (`user`), privacy pause, or turning agent access off altogether.
func (a *Agent) applyControl(ctx context.Context, mode string, access *bool, reason string) {
	a.setControl(ctx, mode, access, reason, false)
}

// restoreControl applies the control state the gateway persisted, from its welcome. A stricter
// mode the VM holds (privacy > user > agent) stays: a takeover made while the tunnel was down, or
// whose control_state never reached the api, must not be undone by a reconnect, and only an
// explicit automation_control relaxes it. The state is published either way, so the gateway
// learns the VM's; a takeover the api has not recorded is reported as the user_input it was,
// which the api persists.
func (a *Agent) restoreControl(ctx context.Context, persisted string, access bool) {
	a.setControl(ctx, persisted, &access, "restored", true)
}

func modeRank(mode string) int {
	switch mode {
	case modePrivacy:
		return 2
	case modeUser:
		return 1
	}
	return 0
}

func (a *Agent) setControl(ctx context.Context, mode string, access *bool, reason string, restore bool) {
	a.mu.Lock()
	if restore && modeRank(a.control.mode) > modeRank(mode) {
		if a.control.mode == modeUser && mode == modeAgent {
			reason = "user_input"
		}
		mode = a.control.mode
	}
	changed, left := false, false
	if access != nil && *access != a.control.access {
		a.control.access = *access
		changed = true
		left = !*access
	}
	if mode == modeAgent || mode == modeUser || mode == modePrivacy {
		if mode != a.control.mode {
			a.control.mode = mode
			changed, left = true, true
		}
		if mode == modeAgent && a.control.controller == ctlUser {
			// Hand-back: nobody holds control until the bridge's next action or the user's next input.
			a.control.controller = ctlNone
			changed = true
		}
		if mode != modeAgent && a.control.controller == ctlAgent {
			a.control.controller = ctlUser
			changed = true
		}
	}
	if !changed && !restore {
		a.mu.Unlock()
		return
	}
	if changed {
		a.control.epoch++
		if left {
			a.control.leftEpoch = a.control.epoch
		}
	}
	state := a.controlSnapshot()
	sessions := a.automationList()
	stopping := changed && (state.Mode != modeAgent || state.Controller != ctlAgent)
	accessOff := !a.control.access
	a.mu.Unlock()
	if stopping {
		for _, s := range sessions {
			s.interrupt("control_changed")
			s.releaseHeld()
		}
	}
	if accessOff {
		for _, s := range sessions {
			a.endAutomation(s)
		}
	}
	a.publishControl(ctx, state, reason)
}

// publishControl tells the gateway (which fans out to viewers and persists the mode) and every
// bridge session about a change.
func (a *Agent) publishControl(ctx context.Context, state protocol.ControlState, reason string) {
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_ = a.write(wctx, protocol.ControlStateFrame{T: "control_state", Control: state, Reason: reason})
	a.mu.Lock()
	sessions := a.automationList()
	a.mu.Unlock()
	for _, s := range sessions {
		s.push(wctx, map[string]any{"t": "control", "control": state, "reason": reason})
	}
}
