// Precise background removal via a real image-matting network (U²-Net), run LOCALLY in the renderer
// with ONNX Runtime Web on the WASM (SIMD) CPU backend. Unlike the generative "AI" mode (which
// repaints the background magenta) this is a purpose-built segmentation/matting model — the same
// class of tool Figma/Photoroom use: it predicts a per-pixel foreground alpha with soft edges and
// never regenerates or reframes the image. We apply that alpha to the pristine original.
import * as ort from 'onnxruntime-web'
import modelUrl from './models/u2netp.onnx?url'

// ORT's inference engine ships as two runtime files it fetches lazily: the .wasm binary and its
// .mjs Emscripten loader glue. Left to itself ORT resolves them relative to its OWN bundled module
// (in dev, `/node_modules/.vite/deps/…`) — a path the dev server doesn't have, so it returns the
// SPA fallback HTML and the wasm compile dies with "expected magic word … found 3c 21 64 6f"
// (`<!do`, i.e. `<!doctype html>`). We can't fix that with a `?url` import either: Vite's built-in
// `.wasm` handling intercepts it and hands back a JS wrapper, not the binary.
//
// So the two files live in the renderer's `public/ort/` — copied verbatim into the build, never
// run through Vite's module pipeline — and we hand ORT absolute URLs built from `document.baseURI`.
// That base is the directory of index.html, which resolves correctly in BOTH worlds: dev
// (`http://localhost:6771/ort/…`) and the packaged file:// renderer (`…/out/renderer/ort/…`), with
// no dependence on ORT's own module location.
const ortBase = new URL('ort/', document.baseURI)

// Single thread avoids the cross-origin-isolation (COOP/COEP) requirement of threaded WASM. We ship
// the JSEP build's runtime files (they also serve plain WASM), but run on the WASM CPU EP, not
// WebGPU: u2netp's MaxPool uses ceil_mode, which the WebGPU provider can't compute ("using ceil()
// in shape computation is not yet supported for MaxPool") and it errors at inference rather than
// falling back. On the CPU EP the op is supported, and a 4.5 MB net at 320×320 runs fast anyway.
ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = {
  wasm: new URL('ort-wasm-simd-threaded.jsep.wasm', ortBase).href,
  mjs: new URL('ort-wasm-simd-threaded.jsep.mjs', ortBase).href
}

let sessionP: Promise<ort.InferenceSession> | null = null
function session(): Promise<ort.InferenceSession> {
  if (!sessionP) {
    sessionP = ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm']
    })
  }
  return sessionP
}

const S = 320 // U²-Net input size
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

// Returns a per-pixel foreground alpha (0..1), length W*H, for the given image.
export async function matteAlpha(img: HTMLImageElement, W: number, H: number): Promise<Float32Array> {
  const sess = await session()

  // Preprocess: resize to 320×320, scale by max pixel, per-channel normalize, to CHW float32.
  const inCv = document.createElement('canvas')
  inCv.width = S
  inCv.height = S
  const ictx = inCv.getContext('2d')!
  ictx.drawImage(img, 0, 0, S, S)
  const px = ictx.getImageData(0, 0, S, S).data
  let max = 1
  for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2])
  const plane = S * S
  const chw = new Float32Array(3 * plane)
  for (let p = 0; p < plane; p++) {
    chw[p] = (px[p * 4] / max - MEAN[0]) / STD[0]
    chw[plane + p] = (px[p * 4 + 1] / max - MEAN[1]) / STD[1]
    chw[2 * plane + p] = (px[p * 4 + 2] / max - MEAN[2]) / STD[2]
  }

  const feeds: Record<string, ort.Tensor> = {}
  feeds[sess.inputNames[0]] = new ort.Tensor('float32', chw, [1, 3, S, S])
  const out = await sess.run(feeds)
  const pred = out[sess.outputNames[0]].data as Float32Array // [1,1,320,320]

  // Min-max normalize the raw prediction to 0..1.
  let mi = Infinity
  let ma = -Infinity
  for (let i = 0; i < plane; i++) {
    if (pred[i] < mi) mi = pred[i]
    if (pred[i] > ma) ma = pred[i]
  }
  const range = ma - mi || 1

  // Rasterize the 320×320 matte, then let the canvas bilinearly resize it to W×H.
  const mCv = document.createElement('canvas')
  mCv.width = S
  mCv.height = S
  const mctx = mCv.getContext('2d')!
  const mImg = mctx.createImageData(S, S)
  for (let i = 0; i < plane; i++) {
    const a = Math.round(((pred[i] - mi) / range) * 255)
    mImg.data[i * 4] = a
    mImg.data[i * 4 + 1] = a
    mImg.data[i * 4 + 2] = a
    mImg.data[i * 4 + 3] = 255
  }
  mctx.putImageData(mImg, 0, 0)

  const fCv = document.createElement('canvas')
  fCv.width = W
  fCv.height = H
  const fctx = fCv.getContext('2d')!
  fctx.imageSmoothingEnabled = true
  fctx.drawImage(mCv, 0, 0, W, H)
  const fd = fctx.getImageData(0, 0, W, H).data
  const alpha = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) alpha[i] = fd[i * 4] / 255
  return alpha
}
