// Matting inference worker — a forked child process that owns ONNX Runtime.
//
// Why a child process and not the main process:
//   1. Inference is ~4 s of blocking native CPU work. On main it would freeze every IPC channel
//      (and so the whole UI) for its duration.
//   2. The model's weights + activations are ~1 GB resident. A child can be dropped after an idle
//      period to hand that memory back; the main process cannot.
//   3. A native crash here kills only this process, not the app.
//
// The child is the Electron binary re-executed as plain Node (ELECTRON_RUN_AS_NODE=1) — see
// matte.ts. It still uses Electron's V8, which matters for the arena flag below.
import ort, { type InferenceSession } from 'onnxruntime-node'

// CRITICAL — both flags, and a naive port crashes without them.
//
// ONNX Runtime reserves memory in large contiguous blocks in two independent places: the "BFC"
// arena allocator, and the memory-pattern planner (which, after one run, pre-plans a single block
// sized from the shapes it observed). Electron swaps in Node/V8's allocator, which traps
// (EXC_BREAKPOINT / SIGTRAP) instead of returning null when it won't serve a request that big — so
// inference dies inside the native allocator with no JS error to catch. The identical model and
// binary run fine under stock `node`, which makes this very easy to misdiagnose as a bad model,
// a threading bug, or plain OOM.
//
// The two flags fail differently, which is worth knowing:
//   enableCpuMemArena: false   — without it the FIRST run dies. Nothing above ~320×320 works.
//   enableMemPattern:  false   — without it the first run succeeds and every LATER run dies, i.e.
//                                the feature appears to work and then breaks on second use.
// With both off, ORT allocates per-tensor through plain malloc on every run; the session can then
// be kept warm indefinitely. Costs a few percent throughput. Verified: repeated 1024×1024 runs hold
// steady at ~500 MB RSS.
const SESSION_OPTS = { enableCpuMemArena: false, enableMemPattern: false }

type Spec = {
  size: number
  // Per-model input scaling. U²-Net divides by the image's own max channel value (its reference
  // implementation's `image/np.max(image)`); BiRefNet uses plain 1/255. Applying U²-Net's rule to
  // BiRefNet silently degrades the matte, so it's part of the model spec rather than a constant.
  scale: 'max' | '255'
  // Whether the graph's output is already a probability. U²-Net ends in sigmoid; BiRefNet emits raw
  // logits (measured: roughly -13..-0.3 on a blank input), so those need squashing before use.
  sigmoid: boolean
}

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

let session: InferenceSession | null = null
let loadedPath = ''

async function ensureSession(modelPath: string): Promise<InferenceSession> {
  if (session && loadedPath === modelPath) return session
  session = await ort.InferenceSession.create(modelPath, SESSION_OPTS)
  loadedPath = modelPath
  return session!
}

// RGBA bytes (size×size, from the renderer's canvas) → normalised CHW float32.
function toTensor(rgba: Uint8Array, spec: Spec): Float32Array {
  const plane = spec.size * spec.size
  const chw = new Float32Array(3 * plane)

  let div = 255
  if (spec.scale === 'max') {
    let max = 1
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] > max) max = rgba[i]
      if (rgba[i + 1] > max) max = rgba[i + 1]
      if (rgba[i + 2] > max) max = rgba[i + 2]
    }
    div = max
  }

  for (let p = 0; p < plane; p++) {
    chw[p] = (rgba[p * 4] / div - MEAN[0]) / STD[0]
    chw[plane + p] = (rgba[p * 4 + 1] / div - MEAN[1]) / STD[1]
    chw[2 * plane + p] = (rgba[p * 4 + 2] / div - MEAN[2]) / STD[2]
  }
  return chw
}

async function run(modelPath: string, rgba: Uint8Array, spec: Spec): Promise<Float32Array> {
  const sess = await ensureSession(modelPath)
  const feeds: Record<string, unknown> = {}
  feeds[sess.inputNames[0]] = new ort.Tensor('float32', toTensor(rgba, spec), [
    1,
    3,
    spec.size,
    spec.size
  ])

  const out = await sess.run(feeds as never)
  // U²-Net exposes seven deep-supervision heads (d0…d6); the first is the fused prediction and the
  // one its own reference code uses. BiRefNet exposes exactly one. Taking [0] is right for both.
  const pred = out[sess.outputNames[0]].data as Float32Array

  const plane = spec.size * spec.size
  const alpha = new Float32Array(plane)
  if (spec.sigmoid) {
    for (let i = 0; i < plane; i++) alpha[i] = 1 / (1 + Math.exp(-pred[i]))
  } else {
    // Already a probability — clamp only. Deliberately NOT min-max normalised: that is what the
    // U²-Net reference does, but it is a per-image contrast stretch, so an image whose subject
    // fills the frame (no confident background anywhere) gets its least-certain pixel forced to
    // fully transparent, punching holes through the subject.
    for (let i = 0; i < plane; i++) alpha[i] = pred[i] < 0 ? 0 : pred[i] > 1 ? 1 : pred[i]
  }
  return alpha
}

process.on(
  'message',
  async (msg: { id: number; modelPath: string; rgba: Uint8Array; spec: Spec }) => {
    try {
      const alpha = await run(msg.modelPath, msg.rgba, msg.spec)
      process.send!({ id: msg.id, ok: true, alpha })
    } catch (e) {
      process.send!({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
)
