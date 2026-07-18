// Precise background removal: renderer half of the matting pipeline.
//
// The network itself runs in the main process (see src/main/matte.ts) — the renderer only prepares
// pixels and refines the result. What comes back is a mask at the model's own resolution (1024²),
// which for a 4000 px image is a 4× upscale. Blowing that up directly is what made earlier cutouts
// look soft and blobby: every edge became a smooth ramp several pixels wide with no relationship to
// where the actual edge in the photo is. So the mask is upsampled in float and then snapped back to
// real image edges with a guided filter before it is used.

export type MatteModel = 'birefnet-lite' | 'u2netp'
export const DEFAULT_MATTE_MODEL: MatteModel = 'birefnet-lite'

export async function matteModelReady(model: MatteModel = DEFAULT_MATTE_MODEL): Promise<boolean> {
  return (await window.api.matteStatus(model)).ready
}

export function onMatteProgress(cb: (progress: number) => void): () => void {
  return window.api.onMatteProgress((p) => cb(p.progress))
}

export async function ensureMatteModel(model: MatteModel = DEFAULT_MATTE_MODEL): Promise<void> {
  const r = await window.api.matteEnsure(model)
  if (!r.ok) throw new Error(r.error ?? 'Could not download the matting model')
}

// ---- separable box blur (O(n) per pass, via row prefix sums) -----------------------------------

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const pre = new Float32Array(Math.max(w, h) + 1)

  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[row + x]
    for (let x = 0; x < w; x++) {
      const lo = x - r < 0 ? 0 : x - r
      const hi = x + r >= w ? w - 1 : x + r
      tmp[row + x] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1)
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x]
    for (let y = 0; y < h; y++) {
      const lo = y - r < 0 ? 0 : y - r
      const hi = y + r >= h ? h - 1 : y + r
      out[y * w + x] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1)
    }
  }
  return out
}

// ---- guided filter (He et al.) ------------------------------------------------------------------
// Used here in the role its authors call "guided feathering": the coarse mask is the input and the
// full-resolution image is the guide, so the filter re-fits mask values to a local linear model of
// actual image intensity. Wherever the photo has an edge, the mask gets one; where the photo is
// flat, the mask stays smooth. That is the difference between an outline that follows the subject
// and one that merely approximates its silhouette.
function guidedFilter(
  guide: Float32Array,
  input: Float32Array,
  w: number,
  h: number,
  r: number,
  eps: number
): Float32Array {
  const n = w * h
  const II = new Float32Array(n)
  const IP = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    II[i] = guide[i] * guide[i]
    IP[i] = guide[i] * input[i]
  }

  const meanI = boxBlur(guide, w, h, r)
  const meanP = boxBlur(input, w, h, r)
  const corrI = boxBlur(II, w, h, r)
  const corrIP = boxBlur(IP, w, h, r)

  const a = new Float32Array(n)
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const varI = corrI[i] - meanI[i] * meanI[i]
    const covIP = corrIP[i] - meanI[i] * meanP[i]
    a[i] = covIP / (varI + eps)
    b[i] = meanP[i] - a[i] * meanI[i]
  }

  const meanA = boxBlur(a, w, h, r)
  const meanB = boxBlur(b, w, h, r)
  const q = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = meanA[i] * guide[i] + meanB[i]
    q[i] = v < 0 ? 0 : v > 1 ? 1 : v
  }
  return q
}

// Float bilinear upsample. Deliberately not done by drawing into a canvas: an ImageData round-trip
// quantises alpha to 8 bits *before* the 4× enlargement, so the ramp that the guided filter then
// has to work with arrives pre-banded.
function upsample(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh)
  const fx = sw / dw
  const fy = sh / dh
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const wy = sy - y0
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const wx = sx - x0
      const a = src[y0 * sw + x0] * (1 - wx) + src[y0 * sw + x1] * wx
      const b = src[y1 * sw + x0] * (1 - wx) + src[y1 * sw + x1] * wx
      out[y * dw + x] = a * (1 - wy) + b * wy
    }
  }
  return out
}

/**
 * Per-pixel foreground alpha (0..1), length W*H.
 *
 * The model must already be present — call ensureMatteModel() first so the 224 MB download can be
 * surfaced as progress rather than a silent stall.
 */
export async function matteAlpha(
  img: HTMLImageElement,
  W: number,
  H: number,
  model: MatteModel = DEFAULT_MATTE_MODEL
): Promise<Float32Array> {
  const { size } = await window.api.matteStatus(model)

  // Preprocess: plain (non-aspect-preserving) resize to the model's square input, matching how
  // these networks were trained and how their reference implementations feed them.
  const inCv = document.createElement('canvas')
  inCv.width = size
  inCv.height = size
  const ictx = inCv.getContext('2d', { willReadFrequently: true })!
  // A source PNG that already carries transparency would otherwise composite against black and be
  // read as a dark object, so transparent areas are flattened to mid-grey first — neutral, and it
  // keeps a re-run of Remove BG on an already-cut image from inventing a new subject.
  ictx.fillStyle = '#808080'
  ictx.fillRect(0, 0, size, size)
  ictx.drawImage(img, 0, 0, size, size)
  const rgba = new Uint8Array(ictx.getImageData(0, 0, size, size).data.buffer.slice(0))

  const res = await window.api.matteRun(model, rgba)
  if (res.error || !res.alpha) throw new Error(res.error ?? 'Matting failed')
  const low = res.alpha

  // Guide = luminance of the original at full resolution.
  const fullCv = document.createElement('canvas')
  fullCv.width = W
  fullCv.height = H
  const fctx = fullCv.getContext('2d', { willReadFrequently: true })!
  fctx.drawImage(img, 0, 0, W, H)
  const px = fctx.getImageData(0, 0, W, H).data
  const guide = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    guide[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255
  }

  const coarse = upsample(low, size, size, W, H)

  // The radius has to span the uncertainty introduced by the upscale — a mask enlarged k× is
  // ambiguous over roughly k pixels — so it is derived from the scale factor rather than fixed.
  // eps is small because the guide is normalised to 0..1 and the mask should follow even faint
  // edges; too large and the filter degenerates back into a plain blur.
  const scale = Math.max(W, H) / size
  const radius = Math.min(16, Math.max(2, Math.round(scale * 2)))
  return guidedFilter(guide, coarse, W, H, radius, 1e-4)
}
