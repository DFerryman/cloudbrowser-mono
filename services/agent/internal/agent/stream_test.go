package agent

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestStreamDeltaPerLevelResendsAndCPU(t *testing.T) {
	at := time.Unix(1000, 0)
	last := streamSample{at: at, busy: 1000, steal: 10, total: 4000, cpu: true, counters: &StreamCounters{
		Frames: map[string]float64{"full": 1000, "high": 500, "medium": 200, "low": 70, "square": 0},
		Bytes:  map[string]float64{"full": 1e6, "high": 5e5, "medium": 2e5, "low": 7e4},
		Starts: map[string]float64{"full": 1, "high": 1, "medium": 1, "low": 1},
		Active: map[string]float64{"full": 1, "medium": 1, "low": 1},
		NACKs:  10, Lost: 4, CPUSeconds: 100,
	}}
	cur := streamSample{at: at.Add(15 * time.Second), busy: 1900, steal: 160, total: 7000, cpu: true, counters: &StreamCounters{
		// full ran the whole interval at 29 fps; high started once and ran 3 s; medium stopped after
		// 2 s; low ran and produced nothing (its encoder stalled); square never ran.
		Frames: map[string]float64{"full": 1435, "high": 590, "medium": 230, "low": 70, "square": 0},
		Bytes:  map[string]float64{"full": 1e6 + 5.625e6, "high": 5e5 + 6.75e5, "medium": 2e5 + 3e5, "low": 7e4},
		Starts: map[string]float64{"full": 1, "high": 2, "medium": 1, "low": 1},
		Active: map[string]float64{"full": 1, "high": 1, "low": 1},
		NACKs:  70, Lost: 9, CPUSeconds: 112,
	}}
	got := streamDelta(last, cur)
	want := map[string]any{
		"seconds": 15.0,
		"levels": map[string]any{
			"full":   map[string]any{"fps": 29.0, "kbps": 3000.0, "starts": 0.0, "whole": true},
			"high":   map[string]any{"fps": 6.0, "kbps": 360.0, "starts": 1.0, "whole": false},
			"medium": map[string]any{"fps": 2.0, "kbps": 160.0, "starts": 0.0, "whole": false},
			"low":    map[string]any{"fps": 0.0, "kbps": 0.0, "starts": 0.0, "whole": true},
		},
		"nacks": 60.0, "lost": 5.0, "nekoCpuPct": 80.0, "cpuPct": 30.0, "stealPct": 5.0,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestStreamDeltaSkipsCountersThatWentBack(t *testing.T) {
	at := time.Unix(1000, 0)
	last := streamSample{at: at, counters: &StreamCounters{Frames: map[string]float64{"full": 5000}, NACKs: 100, CPUSeconds: 50}}
	// neko restarted: its counters start again from nothing.
	cur := streamSample{at: at.Add(15 * time.Second), counters: &StreamCounters{Frames: map[string]float64{"full": 300}, Starts: map[string]float64{"full": 1}, NACKs: 2, CPUSeconds: 3}}
	got := streamDelta(last, cur)
	if levels := got["levels"].(map[string]any); len(levels) != 0 {
		t.Fatalf("levels %v", levels)
	}
	for _, k := range []string{"nacks", "nekoCpuPct", "cpuPct"} {
		if _, ok := got[k]; ok {
			t.Fatalf("%s reported across a restart: %v", k, got)
		}
	}
}

type countingNeko struct {
	fakeNeko
	counters StreamCounters
	err      error
}

func (n *countingNeko) StreamCounters(context.Context) (StreamCounters, error) {
	return n.counters, n.err
}

func TestStreamReportOnlyWhileViewersAreConnected(t *testing.T) {
	n := &countingNeko{counters: StreamCounters{Frames: map[string]float64{"full": 10}}}
	a := New(Config{}, nil, n, nil, nil)
	data := map[string]any{}
	a.streamReport(context.Background(), 1, data)
	if _, ok := data["stream"]; ok {
		t.Fatal("the first heartbeat with a viewer only takes the baseline")
	}
	n.counters = StreamCounters{Frames: map[string]float64{"full": 40}}
	a.streamLast.at = a.streamLast.at.Add(-time.Second)
	a.streamReport(context.Background(), 1, data)
	if levels, ok := data["stream"].(map[string]any)["levels"].(map[string]any); !ok || levels["full"] == nil {
		t.Fatalf("stream %v", data["stream"])
	}
	// No viewer: nothing, and the next viewer starts a new baseline.
	data = map[string]any{}
	a.streamReport(context.Background(), 0, data)
	a.streamReport(context.Background(), 1, data)
	if _, ok := data["stream"]; ok || a.streamLast == nil {
		t.Fatalf("stream %v", data)
	}
	// neko unreadable: the report carries what else it knows, here only its interval.
	n.err = errors.New("down")
	a.streamLast.at = a.streamLast.at.Add(-time.Second)
	a.streamReport(context.Background(), 1, data)
	if s := data["stream"].(map[string]any); len(s) != 1 || s["seconds"] == nil {
		t.Fatalf("stream %v", s)
	}
}
