package neko

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Lines as neko 3.2 prints them (the browser image, two viewer sessions).
const metricsText = `# HELP neko_capture_streamsink_frames Total number of video frames created by the pipeline.
# TYPE neko_capture_streamsink_frames counter
neko_capture_streamsink_frames{codec_name="h264",codec_type="video",video_id="full"} 48041
neko_capture_streamsink_frames{codec_name="h264",codec_type="video",video_id="high"} 30010
neko_capture_streamsink_frames{codec_name="opus",codec_type="audio",video_id="audio"} 9
neko_capture_streamsink_bytes{codec_name="h264",codec_type="video",video_id="full"} 2.74690031e+08
neko_capture_pipelines_total{codec_name="h264",codec_type="video",submodule="streamsink",video_id="full"} 67
neko_capture_pipelines_total{codec_name="h264",codec_type="video",submodule="streamsrc",video_id="webcam"} 3
neko_capture_pipelines_active{codec_name="h264",codec_type="video",submodule="streamsink",video_id="full"} 1
neko_capture_pipelines_active{codec_name="h264",codec_type="video",submodule="streamsink",video_id="high"} 0
neko_capture_pipelines_active{codec_name="vp8",codec_type="video",submodule="streamsrc",video_id="webcam"} 1
neko_capture_pipelines_total{codec_name="opus",codec_type="audio",submodule="streamsink",video_id="audio"} 59
neko_webrtc_transport_layer_nacks{session_id="admin-1--67pi"} 10009
neko_webrtc_transport_layer_nacks{session_id="admin-2--x1"} 1
neko_webrtc_receiver_report_total_lost{session_id="admin-1--67pi"} 2374
process_cpu_seconds_total 1930.87
go_goroutines 41
`

func TestMetricsReadsLevelsResendsAndCPU(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/metrics" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(metricsText))
	}))
	defer srv.Close()
	c, err := (&Relay{BaseURL: srv.URL + "/"}).Metrics(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if c.Frames["full"] != 48041 || c.Frames["high"] != 30010 || c.Bytes["full"] != 274690031 || c.Starts["full"] != 67 {
		t.Fatalf("levels: %+v", c)
	}
	if c.Active["full"] != 1 || c.Active["high"] != 0 || len(c.Active) != 2 {
		t.Fatalf("running levels: %+v", c.Active)
	}
	if _, audio := c.Frames["audio"]; audio || c.Starts["webcam"] != 0 || len(c.Starts) != 1 {
		t.Fatalf("audio and input pipelines must be left out: %+v", c)
	}
	if c.NACKs != 10010 || c.Lost != 2374 || c.CPUSeconds != 1930.87 {
		t.Fatalf("sessions and cpu: %+v", c)
	}
}

func TestMetricsNeedNeko(t *testing.T) {
	if _, err := (&Relay{}).Metrics(context.Background()); err == nil {
		t.Fatal("no base url must fail")
	}
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	if _, err := (&Relay{BaseURL: srv.URL}).Metrics(context.Background()); err == nil {
		t.Fatal("a 404 must fail")
	}
}
