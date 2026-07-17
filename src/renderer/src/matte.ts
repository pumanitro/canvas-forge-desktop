// Precise background removal via a real image-matting network (U²-Net), run LOCALLY in the renderer
// with ONNX Runtime Web (WebGPU when available, WASM fallback). Unlike the generative "AI" mode
// (which repaints the background magenta) this is a purpose-built segmentation/matting model — the
// same class of tool Figma/Photoroom use: it predicts a per-pixel foreground alpha with soft edges
// and never regenerates or reframes the image. We apply that alpha to the pristine original.
import * as ort from 'onnxruntime-web'
import modelUrl from './models/u2netp.onnx?url'

// The renderer can't fetch external URLs, so ORT must load its WASM from the SAME-ORIGIN copy the
// bundler emits (ONNX references it via `new URL(..., import.meta.url)`, which Vite rewrites to a
// local asset). We therefore leave `wasmPaths` unset. Single thread avoids the cross-origin-
// isolation (COOP/COEP) requirement of threaded WASM; WebGPU does the heavy compute when present.
ort.env.wasm.numThreads = 1

let sessionP: Promise<ort.InferenceSession> | null = null
function session(): Promise<ort.InferenceSession> {
  if (!sessionP) {
    sessionP = ort.InferenceSession.create(modelUrl, {
      executionProviders: ['webgpu', 'wasm']
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
