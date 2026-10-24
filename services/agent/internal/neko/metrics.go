package neko

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Counters are neko's cumulative counts the live view's health is read from (GET /metrics on
// the loopback interface, Prometheus text). Each map is by video level (full, high, …).
type Counters struct {
	// Frames and Bytes the level's encoder produced; a frame rate below the level's own (neko.yaml)
	// means the encoder fell behind.
	Frames map[string]float64
	Bytes  map[string]float64
	// Starts counts the level's pipeline starts: one per viewer joining it or switching to it.
	Starts map[string]float64
	// Active is 1 while the level's pipeline runs (a viewer watches it), else 0.
	Active map[string]float64
	// NACKs and Lost are what viewers' RTCP reported, summed over every session neko has had.
	NACKs float64
	Lost  float64
	// CPUSeconds is neko's own process, its encoders included.
	CPUSeconds float64
}

// metricsLimit bounds the body read: neko keeps a few lines per viewer session it has had.
const metricsLimit = 8 << 20

// Metrics reads neko's counters. It needs BaseURL; nothing it reads names a viewer.
func (r *Relay) Metrics(ctx context.Context) (Counters, error) {
	if r.BaseURL == "" {
		return Counters{}, errors.New("neko metrics need a base url")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(r.BaseURL, "/")+"/metrics", nil)
	if err != nil {
		return Counters{}, err
	}
	resp, err := r.httpClient().Do(req)
	if err != nil {
		return Counters{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Counters{}, errors.New("neko metrics: status " + strconv.Itoa(resp.StatusCode))
	}
	return parseMetrics(io.LimitReader(resp.Body, metricsLimit))
}

func parseMetrics(body io.Reader) (Counters, error) {
	c := Counters{Frames: map[string]float64{}, Bytes: map[string]float64{}, Starts: map[string]float64{}, Active: map[string]float64{}}
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64<<10), 64<<10)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || line[0] == '#' {
			continue
		}
		name, labels, value, ok := sample(line)
		if !ok {
			continue
		}
		switch name {
		case "neko_capture_streamsink_frames", "neko_capture_streamsink_bytes", "neko_capture_pipelines_total", "neko_capture_pipelines_active":
			// Video levels only: audio has its own pipeline, and the webcam ones take input.
			if labels["codec_type"] != "video" || (strings.HasPrefix(name, "neko_capture_pipelines_") && labels["submodule"] != "streamsink") {
				continue
			}
			id := labels["video_id"]
			if id == "" {
				continue
			}
			switch name {
			case "neko_capture_streamsink_frames":
				c.Frames[id] = value
			case "neko_capture_streamsink_bytes":
				c.Bytes[id] = value
			case "neko_capture_pipelines_active":
				c.Active[id] = value
			default:
				c.Starts[id] = value
			}
		case "neko_webrtc_transport_layer_nacks":
			c.NACKs += value
		case "neko_webrtc_receiver_report_total_lost":
			c.Lost += value
		case "process_cpu_seconds_total":
			c.CPUSeconds = value
		}
	}
	return c, sc.Err()
}

// sample splits `name{a="x",b="y"} value` (labels optional); a label value never holds a quote here.
func sample(line string) (name string, labels map[string]string, value float64, ok bool) {
	rest := line
	if i := strings.IndexByte(line, '{'); i >= 0 {
		j := strings.IndexByte(line, '}')
		if j < i {
			return "", nil, 0, false
		}
		name, rest = line[:i], line[j+1:]
		labels = map[string]string{}
		for _, pair := range strings.Split(line[i+1:j], ",") {
			k, v, found := strings.Cut(pair, "=")
			if found {
				labels[strings.TrimSpace(k)] = strings.Trim(v, `"`)
			}
		}
	} else {
		sp := strings.IndexByte(line, ' ')
		if sp < 0 {
			return "", nil, 0, false
		}
		name, rest = line[:sp], line[sp:]
	}
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return "", nil, 0, false
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return "", nil, 0, false
	}
	return name, labels, v, true
}
