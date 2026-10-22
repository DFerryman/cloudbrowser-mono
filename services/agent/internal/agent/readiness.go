package agent

import (
	"context"
	"time"
)

type desktopProber interface{ Probe(context.Context) error }

func (a *Agent) recheckDesktop(ctx context.Context) {
	if _, ok := a.neko.(desktopProber); !ok || ctx.Err() != nil {
		return
	}
	select {
	case a.desktopProbeRequests <- struct{}{}:
	default:
	}
}

// The tunnel and Chrome CDP can both be healthy while desktop admission is broken. Probe the
// actual local login/WebSocket/init path on every reconnect; a failed probe keeps heartbeats
// and commands alive and retries without claiming that the desktop is ready.
func (a *Agent) reportReadiness(ctx context.Context, chromeMajor int) {
	probe, checked := a.neko.(desktopProber)
	a.mu.Lock()
	if ctx.Err() != nil {
		a.mu.Unlock()
		return
	}
	a.desktopReady = false
	a.desktopFailure = ""
	a.mu.Unlock()
	for {
		started := time.Now()
		var err error
		if checked {
			pctx, cancel := context.WithTimeout(ctx, 31*time.Second)
			err = probe.Probe(pctx)
			cancel()
		}
		if ctx.Err() != nil {
			return
		}
		code := ""
		if err != nil {
			code = failureCode(err)
		}
		a.mu.Lock()
		if ctx.Err() != nil {
			a.mu.Unlock()
			return
		}
		a.desktopReady = checked && err == nil
		a.desktopFailure = code
		a.mu.Unlock()
		a.log.Info("desktop readiness", "checked", checked, "ready", checked && err == nil, "code", code, "elapsedMs", time.Since(started).Milliseconds())
		if err == nil {
			_ = a.event(ctx, "ready", map[string]any{"chromeMajor": chromeMajor, "agentVersion": Version, "desktopChecked": checked, "desktopReady": checked})
			if !checked {
				return
			}
			// A failed viewer asks for a coalesced recheck. Do not continually create admin
			// sessions while healthy, and do not mark all viewers unhealthy on one failure.
			select {
			case <-ctx.Done():
				return
			case <-a.desktopProbeRequests:
				continue
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(a.cfg.DesktopProbeRetry):
		}
	}
}
