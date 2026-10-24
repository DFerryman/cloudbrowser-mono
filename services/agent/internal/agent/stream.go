package agent

import (
	"context"
	"math"
	"time"
)

// StreamCounters are neko's cumulative counts for the live view (neko.Counters): per video level
// the frames and bytes encoded, the pipeline starts and whether it runs now, viewers' NACKs and
// losses, neko's CPU.
type StreamCounters struct {
	Frames     map[string]float64
	Bytes      map[string]float64
	Starts     map[string]float64
	Active     map[string]float64
	NACKs      float64
	Lost       float64
	CPUSeconds float64
}

// streamCounter is a Neko that can read its counters (neko on the VM).
type streamCounter interface {
	StreamCounters(ctx context.Context) (StreamCounters, error)
}

// cpuClock is a Host that reads the VM's CPU times (host.Linux).
type cpuClock interface {
	CPUTimes() (busy, steal, total uint64, err error)
}

// streamReadLimit keeps a slow neko from holding up the heartbeat.
const streamReadLimit = 2 * time.Second

type streamSample struct {
	at                 time.Time
	counters           *StreamCounters
	busy, steal, total uint64
	cpu                bool
}

// streamReport adds `stream` to a heartbeat while a viewer is connected: what the VM itself saw of
// the live view since the previous heartbeat (docs/connection-diagnostics.md, "vm stream"). The
// first heartbeat of a run of viewers only takes the baseline. Only the heartbeat loop calls it.
func (a *Agent) streamReport(ctx context.Context, viewers int, data map[string]any) {
	if viewers == 0 {
		a.streamLast = nil
		return
	}
	cur := streamSample{at: time.Now()}
	if n, ok := a.neko.(streamCounter); ok {
		rctx, cancel := context.WithTimeout(ctx, streamReadLimit)
		if c, err := n.StreamCounters(rctx); err == nil {
			cur.counters = &c
		}
		cancel()
	}
	if h, ok := a.cfg.Host.(cpuClock); ok {
		if busy, steal, total, err := h.CPUTimes(); err == nil {
			cur.busy, cur.steal, cur.total, cur.cpu = busy, steal, total, true
		}
	}
	last := a.streamLast
	a.streamLast = &cur
	if last != nil {
		if report := streamDelta(*last, cur); report != nil {
			data["stream"] = report
		}
	}
}

// streamDelta is the change between two samples: per level the frames per second and kbit/s
// encoded, the pipelines started and whether it ran the whole interval (only then is its frame
// rate the encoder's), NACKs and packets lost as viewers reported them, neko's CPU (percent of one
// core) and the VM's (percent of all, and stolen by the hypervisor). A level that ran is reported
// even with no frame: its encoder stalled. A counter that went back (neko restarted) says nothing
// for this interval.
func streamDelta(last, cur streamSample) map[string]any {
	secs := cur.at.Sub(last.at).Seconds()
	if secs <= 0 {
		return nil
	}
	report := map[string]any{"seconds": round(secs, 1)}
	if last.counters != nil && cur.counters != nil {
		l, c := last.counters, cur.counters
		levels := map[string]any{}
		for id, frames := range c.Frames {
			df, ds := frames-l.Frames[id], c.Starts[id]-l.Starts[id]
			running := l.Active[id] > 0 && c.Active[id] > 0
			if df < 0 || ds < 0 || (df == 0 && ds == 0 && !running) {
				continue
			}
			db := math.Max(0, c.Bytes[id]-l.Bytes[id])
			levels[id] = map[string]any{"fps": round(df/secs, 1), "kbps": math.Round(db * 8 / secs / 1000), "starts": ds, "whole": running && ds == 0}
		}
		report["levels"] = levels
		if d := c.NACKs - l.NACKs; d >= 0 {
			report["nacks"] = d
		}
		if d := c.Lost - l.Lost; d >= 0 {
			report["lost"] = d
		}
		if d := c.CPUSeconds - l.CPUSeconds; d >= 0 {
			report["nekoCpuPct"] = math.Round(d / secs * 100)
		}
	}
	if last.cpu && cur.cpu && cur.total > last.total && cur.busy >= last.busy && cur.steal >= last.steal {
		dt := float64(cur.total - last.total)
		report["cpuPct"] = math.Round(float64(cur.busy-last.busy) / dt * 100)
		report["stealPct"] = math.Round(float64(cur.steal-last.steal) / dt * 100)
	}
	return report
}

func round(v float64, digits int) float64 {
	p := math.Pow(10, float64(digits))
	return math.Round(v*p) / p
}
