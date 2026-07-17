// Stage ONNX Runtime Web's engine files where the renderer can load them.
//
// Remove BG (Precise) runs U²-Net through ORT, which fetches two runtime files at inference time:
// the .wasm binary and its .mjs Emscripten loader glue. matte.ts points ORT at `public/ort/…`
// (resolved from document.baseURI so it works in dev and the packaged file:// build alike). These
// files are ~26 MB of tooling that `npm install` already provides in node_modules, so rather than
// commit them we copy them into public/ort/ here — run automatically by the predev/prebuild npm
// hooks. public/ort/ is gitignored; a fresh clone is made whole by `npm run dev` or `npm run build`.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'onnxruntime-web', 'dist')
const to = join(root, 'src', 'renderer', 'public', 'ort')

// The JSEP build (the files also cover the plain-WASM CPU execution provider we actually run on).
const files = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']

mkdirSync(to, { recursive: true })
for (const f of files) {
  const src = join(from, f)
  if (!existsSync(src)) {
    console.error(`[copy-ort-runtime] missing ${src} — is onnxruntime-web installed?`)
    process.exit(1)
  }
  const dst = join(to, f)
  // Skip the 26 MB copy when the destination is already up to date (keeps dev startup snappy).
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue
  copyFileSync(src, dst)
  console.log(`[copy-ort-runtime] ${f}`)
}
