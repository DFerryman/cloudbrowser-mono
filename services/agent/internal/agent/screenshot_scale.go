package agent

import (
	"bytes"
	"image"
	"image/draw"
	"image/jpeg"
	"math"
)

// Scaled screenshots (automation protocol 2): a request may ask for its screenshot to fit in a
// box (maxWidth, maxHeight), the size a coding agent's vision model reads without resampling it
// again. The image keeps the screen's aspect ratio and is never enlarged; coordinates on the wire
// stay native screen pixels, and the meta names both sizes so the gateway can map between them.

// shotBox is the box a screenshot must fit in; zero means no bound on that side.
type shotBox struct{ maxWidth, maxHeight int }

// screenshotBox reads a request's bounds; false when one is outside minShotSide..maxShotSide.
func screenshotBox(req automationRequest) (shotBox, bool) {
	var box shotBox
	for _, side := range []struct {
		v   *int
		out *int
	}{{req.MaxWidth, &box.maxWidth}, {req.MaxHeight, &box.maxHeight}} {
		if side.v == nil {
			continue
		}
		if *side.v < minShotSide || *side.v > maxShotSide {
			return shotBox{}, false
		}
		*side.out = *side.v
	}
	return box, true
}

// fit is the size of a width×height screen scaled down to fit the box, aspect kept.
func (b shotBox) fit(width, height int) (int, int) {
	scale := 1.0
	if b.maxWidth > 0 && width > b.maxWidth {
		scale = float64(b.maxWidth) / float64(width)
	}
	if b.maxHeight > 0 && height > b.maxHeight {
		scale = min(scale, float64(b.maxHeight)/float64(height))
	}
	if scale >= 1 {
		return width, height
	}
	w := max(1, int(math.Round(float64(width)*scale)))
	h := max(1, int(math.Round(float64(height)*scale)))
	// Rounding must not step over the box.
	if b.maxWidth > 0 {
		w = min(w, b.maxWidth)
	}
	if b.maxHeight > 0 {
		h = min(h, b.maxHeight)
	}
	return w, h
}

// scaleJPEG decodes a JPEG, scales it to width×height by area averaging (each output pixel is
// the mean of the screen pixels it covers, so text stays as legible as the size allows), and
// encodes it again at quality. neko's JPEG decodes to Y'CbCr planes, which are scaled as they
// are; anything else goes through RGBA.
func scaleJPEG(data []byte, width, height, quality int) ([]byte, error) {
	src, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	var out image.Image
	switch img := src.(type) {
	case *image.YCbCr:
		sb := img.Bounds()
		dst := image.NewYCbCr(image.Rect(0, 0, width, height), img.SubsampleRatio)
		db := dst.Bounds()
		scalePlane(img.Y, img.YStride, sb.Dx(), sb.Dy(), dst.Y, dst.YStride, db.Dx(), db.Dy(), 1)
		scw, sch := chromaSize(sb, img.SubsampleRatio)
		dcw, dch := chromaSize(db, dst.SubsampleRatio)
		scalePlane(img.Cb, img.CStride, scw, sch, dst.Cb, dst.CStride, dcw, dch, 1)
		scalePlane(img.Cr, img.CStride, scw, sch, dst.Cr, dst.CStride, dcw, dch, 1)
		out = dst
	case *image.Gray:
		sb := img.Bounds()
		dst := image.NewGray(image.Rect(0, 0, width, height))
		scalePlane(img.Pix, img.Stride, sb.Dx(), sb.Dy(), dst.Pix, dst.Stride, width, height, 1)
		out = dst
	default:
		sb := src.Bounds()
		rgba := image.NewRGBA(image.Rect(0, 0, sb.Dx(), sb.Dy()))
		draw.Draw(rgba, rgba.Bounds(), src, sb.Min, draw.Src)
		dst := image.NewRGBA(image.Rect(0, 0, width, height))
		scalePlane(rgba.Pix, rgba.Stride, sb.Dx(), sb.Dy(), dst.Pix, dst.Stride, width, height, 4)
		out = dst
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, out, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// chromaSize is the size of the chroma planes of a Y'CbCr image with bounds r (as image.YCbCr
// lays them out for a rectangle at the origin).
func chromaSize(r image.Rectangle, ratio image.YCbCrSubsampleRatio) (int, int) {
	w, h := r.Dx(), r.Dy()
	switch ratio {
	case image.YCbCrSubsampleRatio422:
		return (w + 1) / 2, h
	case image.YCbCrSubsampleRatio420:
		return (w + 1) / 2, (h + 1) / 2
	case image.YCbCrSubsampleRatio440:
		return w, (h + 1) / 2
	case image.YCbCrSubsampleRatio411:
		return (w + 3) / 4, h
	case image.YCbCrSubsampleRatio410:
		return (w + 3) / 4, (h + 1) / 2
	}
	return w, h
}

// span is one source pixel's share of an output pixel.
type span struct {
	index  int
	weight float32
}

// areaSpans lists, for each of the dst output positions along one axis, the source positions it
// covers and how much of each (the weights of one output position add up to 1).
func areaSpans(src, dst int) [][]span {
	out := make([][]span, dst)
	ratio := float64(src) / float64(dst)
	for i := range out {
		start, end := float64(i)*ratio, float64(i+1)*ratio
		for j := int(start); j < src && float64(j) < end; j++ {
			cover := math.Min(end, float64(j+1)) - math.Max(start, float64(j))
			if cover > 0 {
				out[i] = append(out[i], span{j, float32(cover / ratio)})
			}
		}
	}
	return out
}

// scalePlane area-averages a plane of interleaved 8-bit channels from sw×sh to dw×dh: across
// each row first, then down each column.
func scalePlane(src []uint8, sstride, sw, sh int, dst []uint8, dstride, dw, dh, channels int) {
	if sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0 {
		return
	}
	cols, rows := areaSpans(sw, dw), areaSpans(sh, dh)
	across := make([]float32, sh*dw*channels)
	for y := 0; y < sh; y++ {
		row := src[y*sstride:]
		out := across[y*dw*channels:]
		for x, spans := range cols {
			for c := 0; c < channels; c++ {
				var v float32
				for _, sp := range spans {
					v += float32(row[sp.index*channels+c]) * sp.weight
				}
				out[x*channels+c] = v
			}
		}
	}
	for y, spans := range rows {
		out := dst[y*dstride:]
		for x := 0; x < dw*channels; x++ {
			var v float32
			for _, sp := range spans {
				v += across[sp.index*dw*channels+x] * sp.weight
			}
			out[x] = uint8(min(255, max(0, v+0.5)))
		}
	}
}
