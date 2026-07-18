// Background-removal matting: model management + the worker process that runs inference.
//
// Inference lives in the main process (via a child) rather than the renderer because the renderer
// can only reach ONNX Runtime through WebAssembly, and WASM here is single-threaded — cross-origin
// isolation (COOP/COEP) is unavailable on the file:// renderer of a packaged build, so the threaded
// build can't be used. Measured, a 1024×1024 matting net costs ~53 s that way versus ~4 s on the
// native runtime. That gap is the whole reason this moved out of the renderer.
import { app } from 'electron'
import { fork, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

export type ModelId = 'birefnet-lite' | 'u2netp'

type ModelDef = {
  file: string
  url?: string
  bytes?: number
  size: number
  scale: 'max' | '255'
  sigmoid: boolean
  label: string
}

// Both entries are MIT-licensed and safe to ship. Deliberately absent: BRIA's RMBG-1.4/2.0, which
// are the obvious quality picks but are CC BY-NC — incompatible with this app's MIT licence. (rembg
// ships an RMBG session that downloads those weights silently, which is an easy trap to fall into.)
const MODELS: Record<ModelId, ModelDef> = {
  // BiRefNet, "lite" (Swin-T backbone). The quality tier Cloudflare independently benchmarked at
  // 0.87 IoU on DIS5K where U²-Net scores 0.39 — that gap is precisely the "complex subject" case
  // this feature kept failing. fp32 rather than fp16: fp16 targets GPU execution providers, and on
  // the CPU provider it just forces cast nodes around every op.
  'birefnet-lite': {
    file: 'birefnet-lite.onnx',
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx',
    bytes: 224005088,
    size: 1024,
    scale: '255',
    sigmoid: true,
    label: 'BiRefNet lite'
  },
  // Bundled fallback, so the feature still works offline / before the download completes. This is
  // U²-Netp — the 4.5 MB "portable" variant, the smallest model in the family — kept only because
  // it costs nothing to ship, not because it is good.
  u2netp: {
    file: 'u2netp.onnx',
    size: 320,
    scale: 'max',
    sigmoid: false,
    label: 'U²-Net (portable)'
  }
}

function modelsDir(): string {
  const d = join(app.getPath('userData'), 'Models')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

// The bundled fallback lives in resources/ (asarUnpack'd, so it is a real file on disk that the
// native runtime can open — ONNX Runtime cannot read through the asar archive).
function bundledPath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', file)
    : join(app.getAppPath(), 'resources', file)
}

export function modelPath(id: ModelId): string {
  const def = MODELS[id]
  return def.url ? join(modelsDir(), def.file) : bundledPath(def.file)
}

export function modelReady(id: ModelId): boolean {
  const p = modelPath(id)
  if (!existsSync(p)) return false
  const def = MODELS[id]
  // A truncated download (interrupted connection) leaves a plausible-looking file that fails deep
  // inside ORT with an unhelpful protobuf error, so size is checked rather than mere existence.
  return def.bytes ? statSync(p).size === def.bytes : true
}

/** Downloads a model if absent. `onProgress` receives 0..1. Resolves to the local path. */
export async function ensureModel(id: ModelId, onProgress?: (p: number) => void): Promise<string> {
  const def = MODELS[id]
  const dest = modelPath(id)
  if (!def.url || modelReady(id)) return dest

  const tmp = `${dest}.part`
  const res = await fetch(def.url)
  if (!res.ok || !res.body) throw new Error(`Model download failed: HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length')) || def.bytes || 0
  let seen = 0
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (c: Buffer) => {
    seen += c.length
    if (total) onProgress?.(seen / total)
  })

  try {
    await pipeline(body, createWriteStream(tmp))
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp)
    throw e
  }

  if (def.bytes && statSync(tmp).size !== def.bytes) {
    unlinkSync(tmp)
    throw new Error('Model download incomplete')
  }
  // Rename only once the bytes are all present, so an interrupted run can never leave a partial
  // file sitting at the real path where modelReady() would later trust it.
  renameSync(tmp, dest)
  onProgress?.(1)
  return dest
}

// ---- worker lifecycle -------------------------------------------------------------------------

let child: ChildProcess | null = null
let seq = 0
const pending = new Map<
  number,
  { resolve: (a: Float32Array) => void; reject: (e: Error) => void }
>()
let idleTimer: NodeJS.Timeout | null = null

// Keeping the child alive avoids paying the model load (~1.3 s) on every click, but its weights are
// ~1 GB resident, so it is dropped once the user has clearly stopped using the feature.
const IDLE_MS = 5 * 60 * 1000

function kill(err?: Error): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const c = child
  child = null
  if (err) for (const { reject } of pending.values()) reject(err)
  if (err) pending.clear()
  c?.removeAllListeners()
  c?.kill()
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => kill(), IDLE_MS)
}

function worker(): ChildProcess {
  if (child) return child
  const c = fork(join(__dirname, 'matteWorker.js'), [], {
    // Re-runs the Electron binary as plain Node. Without this the child would boot a full Electron
    // app (Chromium and all) instead of a bare script.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // 'advanced' uses the structured-clone algorithm, so the RGBA input and the alpha result cross
    // the process boundary as real typed arrays. The default JSON mode would stringify 4 MB of
    // pixels into a number-per-element array on each hop.
    serialization: 'advanced'
  })
  c.on('message', (m: { id: number; ok: boolean; alpha?: Float32Array; error?: string }) => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok && m.alpha) p.resolve(m.alpha)
    else p.reject(new Error(m.error ?? 'Matting failed'))
  })
  c.on('exit', (code, signal) => {
    if (child !== c) return
    kill(new Error(`Matting worker exited (${signal ?? code})`))
  })
  child = c
  return c
}

/** Runs the matte. `rgba` is size×size RGBA bytes; returns size×size alpha in 0..1. */
export async function runMatte(id: ModelId, rgba: Uint8Array): Promise<Float32Array> {
  const def = MODELS[id]
  const path = modelPath(id)
  if (!modelReady(id)) throw new Error(`Model ${def.label} is not downloaded`)

  const c = worker()
  const msgId = ++seq
  touchIdle()
  return new Promise<Float32Array>((resolve, reject) => {
    pending.set(msgId, { resolve, reject })
    c.send({
      id: msgId,
      modelPath: path,
      rgba,
      spec: { size: def.size, scale: def.scale, sigmoid: def.sigmoid }
    })
  })
}

export function matteInputSize(id: ModelId): number {
  return MODELS[id].size
}

export function shutdownMatte(): void {
  kill()
}
