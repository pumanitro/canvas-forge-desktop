import { clamp } from './util'
import { matteAlpha } from './matte'

// All image processing happens here in the renderer via the 2D canvas — so the
// desktop app needs no native modules (sharp) at all. Gemini itself is called in
// the main process through window.api.gemini (keeps the key out of the renderer).

type Pt = { x: number; y: number }
type Box = { x: number; y: number; w: number; h: number }

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}
function makeCanvas(w: number, h: number): { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, w)
  cv.height = Math.max(1, h)
  const ctx = cv.getContext('2d')!
  return { cv, ctx }
}
async function gemini(prompt: string, model: string, images: string[], aspectRatio?: string): Promise<string> {
  const r = await window.api.gemini({ prompt, model, images, aspectRatio })
  if (r.error || !r.image) throw new Error(r.error || 'no image returned')
  return r.image
}

// The only output shapes the image API accepts. Anything else is rejected, so we snap.
const ASPECTS: [string, number][] = [
  ['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3],
  ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9]
]
// Nearest allowed aspect to the real artwork, compared in log space so 21:9 doesn't swallow
// everything wide (a 2x ratio error reads the same whether it lands above or below).
export function nearestAspect(w: number, h: number): string {
  const target = Math.log(w / h)
  let best = ASPECTS[0]
  for (const a of ASPECTS) if (Math.abs(Math.log(a[1]) - target) < Math.abs(Math.log(best[1]) - target)) best = a
  return best[0]
}

// Letterbox an image onto a canvas with the TARGET aspect ratio (dark neutral padding).
// CRITICAL: Gemini shapes its output after the input images — a wide reference (a text
// strip) makes it return a WIDE image, which our composite then squashes ("stretched"
// results). Padding every secondary image to the artwork's aspect prevents that.
async function padToAspect(src: string, targetW: number, targetH: number): Promise<string> {
  const img = await loadImg(src)
  const PW = 688
  const PH = Math.max(1, Math.round((PW * targetH) / targetW))
  const { cv, ctx } = makeCanvas(PW, PH)
  ctx.fillStyle = '#17181d'
  ctx.fillRect(0, 0, PW, PH)
  const s = Math.min(PW / img.naturalWidth, PH / img.naturalHeight) * 0.9
  const dw = img.naturalWidth * s
  const dh = img.naturalHeight * s
  ctx.drawImage(img, (PW - dw) / 2, (PH - dh) / 2, dw, dh)
  return cv.toDataURL('image/png')
}

// Nano Banana regenerates the whole card with a slight GLOBAL tone shift, so even the parts it
// was told to "keep the same" come back on a drifted palette — the card looks off vs the
// original. Re-map the model's output onto the original's tone using ONLY the pixels OUTSIDE
// the marked element (plus a seam margin): a per-channel gain + offset fit (match mean and
// spread). Because the fit is derived from the parts that shouldn't change, it corrects the
// global drift without ever fighting the intended change to the marked element.
function alignTone(
  gen: { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D },
  orig: { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D },
  region: { selX: number; selY: number; selW: number; selH: number },
  margin: number,
  W: number,
  H: number
): void {
  const gImg = gen.ctx.getImageData(0, 0, W, H)
  const gd = gImg.data
  const od = orig.ctx.getImageData(0, 0, W, H).data
  const x0 = region.selX - margin
  const x1 = region.selX + region.selW + margin
  const y0 = region.selY - margin
  const y1 = region.selY + region.selH + margin
  const step = Math.max(1, Math.round(Math.sqrt((W * H) / 40000))) // cap at ~40k samples
  const sg = [0, 0, 0]
  const so = [0, 0, 0]
  const sg2 = [0, 0, 0]
  const so2 = [0, 0, 0]
  let n = 0
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue // skip region + seam band
      const i = (y * W + x) * 4
      if (od[i + 3] < 250 || gd[i + 3] < 250) continue // only compare solid pixels
      for (let c = 0; c < 3; c++) {
        sg[c] += gd[i + c]
        so[c] += od[i + c]
        sg2[c] += gd[i + c] * gd[i + c]
        so2[c] += od[i + c] * od[i + c]
      }
      n++
    }
  }
  if (n < 200) return // too few unchanged samples to trust a fit
  const a = [1, 1, 1]
  const b = [0, 0, 0]
  let drift = 0
  for (let c = 0; c < 3; c++) {
    const mg = sg[c] / n
    const mo = so[c] / n
    const varG = sg2[c] / n - mg * mg
    const varO = so2[c] / n - mo * mo
    // Alignment-free histogram match: scale the model's spread to the original's (std ratio),
    // then re-centre the mean. Unlike a least-squares fit this needs NO pixel correspondence,
    // so a whole-card regeneration (whose pixels don't line up with the original) can't collapse
    // the gain and wash the card out. On near-flat surroundings std is ill-conditioned → offset.
    a[c] = varG > 9 ? clamp(Math.sqrt(varO / varG), 0.6, 1.6) : 1
    b[c] = mo - a[c] * mg
    drift += Math.abs(a[c] - 1) + Math.abs(b[c]) / 255
  }
  if (drift < 0.03) return // the model already matched — leave it untouched
  for (let i = 0; i < gd.length; i += 4) {
    gd[i] = clamp(a[0] * gd[i] + b[0], 0, 255)
    gd[i + 1] = clamp(a[1] * gd[i + 1] + b[1], 0, 255)
    gd[i + 2] = clamp(a[2] * gd[i + 2] + b[2], 0, 255)
  }
  gen.ctx.putImageData(gImg, 0, 0)
}
function removeBgPrompt(): string {
  return [
    'You are a precise background-removal tool.',
    'Keep the MAIN foreground subject of this image EXACTLY as it is: identical shape, silhouette, edges, proportions, position, scale, colors, materials, lighting, and any text, numbers or symbols on it. Do not redraw, restyle, move, add to or crop the subject.',
    'Keep the subject at the EXACT same pixel position and scale, with the EXACT same empty margins/padding around it (left, right, top and bottom). Do NOT zoom in, recenter, rotate, rescale or fill the margins — only the background colour changes.',
    'Replace ONLY the background (everything that is not the main subject) with a SOLID, FLAT, PERFECTLY UNIFORM pure MAGENTA (#FF00FF / rgb(255,0,255)). No gradient, no shadow, no vignette, no border, no leftover background detail. The magenta must be uniform so it can be keyed out to transparency.',
    'Output at the SAME pixel dimensions and framing as the input.'
  ].join('\n')
}
// Key a uniform magenta (#FF00FF) background out to transparency, with light despill.
function keyOutMagenta(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const id = ctx.getImageData(0, 0, w, h)
  const d = id.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    const mag = Math.min(r, b) - g // magentaness
    if (mag > 60) {
      const a = clamp(Math.round((255 * (160 - mag)) / 100), 0, 255)
      d[i + 3] = Math.min(d[i + 3], a)
    }
    if (mag > 0 && d[i + 3] > 0) {
      const spill = Math.min(Math.min(r, b) - g, mag) * 0.6
      if (spill > 0) {
        d[i] = Math.max(g, r - spill)
        d[i + 2] = Math.max(g, b - spill)
      }
    }
  }
  ctx.putImageData(id, 0, 0)
}

// Bleed the nearest fully-opaque colour outward into the semi-transparent EDGE band (up to a few
// px), keeping each pixel's alpha. Kills the colour-contaminated fringe left when a subject is cut
// off a coloured background — a magenta halo, or a light/white matte ring — without touching the
// solid interior (so a blue gem, etc. stays its own colour).
function decontaminateEdges(ctx: CanvasRenderingContext2D, w: number, h: number, depth = 4): void {
  const id = ctx.getImageData(0, 0, w, h)
  const d = id.data
  const dist = new Int16Array(w * h).fill(-1)
  const qx: number[] = []
  const qy: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] >= 250) {
        dist[y * w + x] = 0
        qx.push(x)
        qy.push(y)
      }
    }
  }
  for (let head = 0; head < qx.length; head++) {
    const x = qx[head]
    const y = qy[head]
    const dd = dist[y * w + x]
    if (dd >= depth) continue
    const si = (y * w + x) * 4
    const nb = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1]
    ]
    for (const [nx, ny] of nb) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nj = ny * w + nx
      if (dist[nj] !== -1 || d[nj * 4 + 3] >= 250) continue
      dist[nj] = dd + 1
      d[nj * 4] = d[si]
      d[nj * 4 + 1] = d[si + 1]
      d[nj * 4 + 2] = d[si + 2]
      qx.push(nx)
      qy.push(ny)
    }
  }
  ctx.putImageData(id, 0, 0)
}
function bgExtractPrompt(userPrompt?: string): string {
  const what = userPrompt?.trim() ? ` The background to keep is: "${userPrompt.trim()}".` : ''
  return [
    'You are a precise background-extraction and cleanup tool.',
    'COMPLETELY REMOVE every foreground element from this image: all panels, cards, list rows, bars, scrollbars, frames, plaques, badges, buttons, icons, widgets, characters and objects, plus ALL text, numbers and labels.',
    'Repaint the ENTIRE area they covered with a natural, continuous extension of the BACKGROUND scene or surface that sits behind them, as if those elements had never been there (inpaint the walls, floor, sky, texture, etc. straight through).' + what,
    'Leave NO trace of the removed elements: no ghost, no faint silhouette, no outline, no rectangle, no darker/lighter patch, no leftover edge or seam. The result must read as a clean, complete standalone background image.',
    'Keep the parts of the background that are already visible exactly as-is: same art style, perspective, lighting, palette, materials and framing. Do not add any new objects, characters or text.',
    'Output an OPAQUE image at the SAME pixel dimensions and framing as the input.'
  ].join('\n')
}
function extractPrompt(userPrompt?: string): string {
  const what = userPrompt?.trim() ? `the following element: "${userPrompt.trim()}"` : 'the single main foreground element / icon / object'
  return [
    'You are a precise asset-extraction tool, like a designer cutting one element out of a UI.',
    `From this image crop, extract and isolate ${what}.`,
    'Render ONLY that element — cleanly and completely cut out — keeping its EXACT shape, proportions, aspect ratio, scale, position within the frame, colors, materials, lighting and art style.',
    'Remove ALL text, letters, numbers, words and labels from the element, so it is delivered blank / unlabeled.',
    'Place the element on a SOLID, FLAT, PURE MAGENTA (#FF00FF / rgb(255,0,255)) background and NOTHING else: no other objects, no drop shadow on the background, no border, no text. The magenta must be perfectly uniform so it can be keyed out to transparency.',
    'Output at the SAME pixel dimensions and framing as the input crop.'
  ].join('\n')
}

// Prompt for a whole-card edit: the model regenerates the ENTIRE card in one pass and
// changes ONLY the magenta-marked element, returning a complete, fully OPAQUE card.
function wholeCardEditPrompt(
  userPrompt: string,
  refCount: number,
  r: { selX: number; selY: number; selW: number; selH: number; W: number; H: number }
): string {
  const pctX = Math.round((r.selX / r.W) * 100)
  const pctY = Math.round((r.selY / r.H) * 100)
  const pctW = Math.round((r.selW / r.W) * 100)
  const pctH = Math.round((r.selH / r.H) * 100)
  const lines = [
    'You are editing one piece of game-UI CARD artwork. The LAST image is the FULL card to edit.',
    'A MAGENTA RECTANGLE has been drawn on it to mark the ONE element you must change. The rectangle is only an annotation — NEVER draw it, or any magenta, in your output.'
  ]
  if (refCount > 0) {
    lines.push(
      'The image(s) before it are STYLE REFERENCES, letterboxed on dark padding (ignore the padding). Borrow ONLY the look the instruction asks for (palette, metal/gold finish, lighting, letterforms). Never copy their text, numbers, layout or objects.'
    )
  }
  lines.push(
    userPrompt.trim()
      ? `Change ONLY the marked element, exactly as follows: "${userPrompt.trim()}".`
      : refCount > 0
        ? 'Restyle ONLY the marked element to match the reference look.'
        : 'Cleanly redraw ONLY the marked element so it fits the card.',
    `The marked element is about ${pctW}% wide and ${pctH}% tall, positioned around ${pctX}% from the left and ${pctY}% from the top.`,
    'Regenerate and return the ENTIRE card as ONE coherent image at the SAME dimensions, aspect ratio and framing as the input. Keep everything OUTSIDE the marked element visually the same — same layout, silhouette, art style, metal, gem, banner, colours and lighting — so ONLY the marked element changes.',
    'The output MUST be FULLY OPAQUE: paint every pixel. No transparency, no alpha, no see-through or empty areas — render any inner window or panel as solid painted artwork.',
    'Match the art style, lighting, colour temperature, palette and materials across the whole card so the edit is seamless: no visible boundary, box, outline, seam, halo, glow or blur.',
    'Output ONLY the final full card image.'
  )
  return lines.join('\n')
}

// Generate: the AI regenerates the ENTIRE card in one pass, applying the change ONLY to the
// marked element. We use the model's whole coherent output directly — no masking, feather,
// transparency or compositing — so every result is a complete, fully opaque card with no seam
// or patch. A tone lock keeps the palette from drifting on reference-free element edits.
export async function imageEdit(p: {
  src: string
  bbox: Box
  prompt: string
  model: string
  stroke?: { points: Pt[]; radius: number }
  references?: string[]
  transparent?: boolean
}): Promise<string> {
  const img = await loadImg(p.src)
  const W = img.naturalWidth
  const H = img.naturalHeight
  const selX = clamp(Math.round(p.bbox.x), 0, W - 1)
  const selY = clamp(Math.round(p.bbox.y), 0, H - 1)
  const selW = clamp(Math.round(p.bbox.w), 1, W - selX)
  const selH = clamp(Math.round(p.bbox.h), 1, H - selY)
  const region = { selX, selY, selW, selH }
  const refs = (p.references || []).slice(0, 4)

  // The full card with a magenta marker box drawn around the element to change.
  const ann = makeCanvas(W, H)
  ann.ctx.drawImage(img, 0, 0)
  ann.ctx.strokeStyle = '#FF00FF'
  ann.ctx.lineWidth = Math.max(3, Math.round(Math.min(W, H) * 0.006))
  ann.ctx.strokeRect(selX, selY, selW, selH)

  // Style refs are letterboxed to the card's aspect (else they reshape the output); card LAST.
  const paddedRefs = await Promise.all(refs.map((r) => padToAspect(r, W, H)))
  const genUrl = await gemini(
    wholeCardEditPrompt(p.prompt, refs.length, { ...region, W, H }),
    p.model,
    [...paddedRefs, ann.cv.toDataURL('image/png')]
  )
  const gen = await loadImg(genUrl)

  // Use the model's whole coherent card, scaled to the exact original dimensions — opaque.
  const out = makeCanvas(W, H)
  out.ctx.drawImage(gen, 0, 0, W, H)

  // Lock the palette to the original (via the unchanged surroundings) on reference-free edits,
  // so a localized change can't drift the whole card's tone. Skip for ref-driven restyles.
  if (refs.length === 0) {
    const origFull = makeCanvas(W, H)
    origFull.ctx.drawImage(img, 0, 0)
    alignTone(out, origFull, region, Math.max(8, Math.round(Math.min(W, H) * 0.02)), W, H)
  }

  return out.cv.toDataURL('image/png')
}

// Whole-image RESTYLE (style guides): re-render the WHOLE artwork in the style of the bundled
// reference art, keeping its layout, text and composition. No magenta marker and no "keep
// everything outside the same" — for a whole-image restyle there IS no outside, and the marker
// would sit on the outermost pixels. `prompt` arrives fully built (see styleguides/index.ts) so
// the preview panel can show the user the exact text we send.
//
// Image order is load-bearing: the BASE goes FIRST and the prompt names "the FIRST attached
// image" as the restyle target. (imageEdit does the opposite — refs first, card last — and says
// so in its own prompt. Each is self-consistent; don't cross the wires.)
export async function imageRestyle(p: {
  src: string
  prompt: string
  model: string
  references: string[]
}): Promise<string> {
  const img = await loadImg(p.src)
  const W = img.naturalWidth
  const H = img.naturalHeight
  const refs = p.references.slice(0, 3) // base + 3 refs = the 4-image cap

  // Letterbox refs to the artwork's aspect — an unpadded ref reshapes the output (see padToAspect).
  const paddedRefs = await Promise.all(refs.map((r) => padToAspect(r, W, H)))
  const genUrl = await gemini(p.prompt, p.model, [p.src, ...paddedRefs], nearestAspect(W, H))
  const gen = await loadImg(genUrl)

  // Contain-fit into the original resolution: preserve aspect, never stretch. The aspect lock
  // makes a mismatch unlikely, but a snapped enum is never an EXACT match for arbitrary pixel
  // dimensions, so the letterbox is what keeps the result from being squashed.
  const gw = gen.naturalWidth || W
  const gh = gen.naturalHeight || H
  const s = Math.min(W / gw, H / gh)
  const dw = Math.round(gw * s)
  const dh = Math.round(gh * s)
  const out = makeCanvas(W, H)
  out.ctx.drawImage(gen, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh)
  return out.cv.toDataURL('image/png')
}

// Extract: isolate the selected element as a transparent, text-free cutout (same ratio).
export async function imageExtract(p: { src: string; bbox: Box; prompt: string; model: string }): Promise<string> {
  const img = await loadImg(p.src)
  const W = img.naturalWidth
  const H = img.naturalHeight
  const selX = clamp(Math.round(p.bbox.x), 0, W - 1)
  const selY = clamp(Math.round(p.bbox.y), 0, H - 1)
  const selW = clamp(Math.round(p.bbox.w), 1, W - selX)
  const selH = clamp(Math.round(p.bbox.h), 1, H - selY)

  const crop = makeCanvas(selW, selH)
  crop.ctx.drawImage(img, selX, selY, selW, selH, 0, 0, selW, selH)
  const genUrl = await gemini(extractPrompt(p.prompt), p.model, [crop.cv.toDataURL('image/png')])
  const gen = await loadImg(genUrl)

  const cv = makeCanvas(selW, selH)
  cv.ctx.drawImage(gen, 0, 0, selW, selH)
  keyOutMagenta(cv.ctx, selW, selH)
  return cv.cv.toDataURL('image/png')
}

// Extract background: remove the foreground elements + text and keep only the (opaque)
// reconstructed background scene of the selection. Same dimensions.
export async function imageExtractBackground(p: { src: string; bbox: Box; prompt: string; model: string }): Promise<string> {
  const img = await loadImg(p.src)
  const W = img.naturalWidth
  const H = img.naturalHeight
  const selX = clamp(Math.round(p.bbox.x), 0, W - 1)
  const selY = clamp(Math.round(p.bbox.y), 0, H - 1)
  const selW = clamp(Math.round(p.bbox.w), 1, W - selX)
  const selH = clamp(Math.round(p.bbox.h), 1, H - selY)

  const crop = makeCanvas(selW, selH)
  crop.ctx.drawImage(img, selX, selY, selW, selH, 0, 0, selW, selH)
  const genUrl = await gemini(bgExtractPrompt(p.prompt), p.model, [crop.cv.toDataURL('image/png')])
  const gen = await loadImg(genUrl)

  const cv = makeCanvas(selW, selH)
  cv.ctx.drawImage(gen, 0, 0, selW, selH)
  return cv.cv.toDataURL('image/png')
}

// Band-limited edge defringe for a known background colour: within a few px of the transparent
// cut, re-estimate each pixel's coverage from how background-like it is and un-premultiply the
// background out of it. This neutralises the light/white matte halo that rings a subject cut off a
// coloured background — colour-corrected, so it stays clean over ANY new background — WITHOUT
// touching anything more than R px inside the edge (so a light interior panel, e.g. a tan text box,
// which sits far from the cut, is never dimmed or eaten).
function defringe(ctx: CanvasRenderingContext2D, W: number, H: number, bg: number[], R = 3, HImatte = 400): void {
  const id = ctx.getImageData(0, 0, W, H)
  const d = id.data
  const N = W * H
  const LO = 32
  const dist = new Int16Array(N).fill(-1)
  const q: number[] = []
  for (let i = 0; i < N; i++) {
    if (d[i * 4 + 3] < 20) {
      dist[i] = 0
      q.push(i)
    }
  }
  for (let head = 0; head < q.length; head++) {
    const i = q[head]
    if (dist[i] >= R) continue
    const x = i % W
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1]
    for (const j of nb) {
      if (j >= 0 && dist[j] === -1) {
        dist[j] = dist[i] + 1
        q.push(j)
      }
    }
  }
  for (let i = 0; i < N; i++) {
    if (dist[i] < 1 || d[i * 4 + 3] < 20) continue
    const cd = Math.abs(d[i * 4] - bg[0]) + Math.abs(d[i * 4 + 1] - bg[1]) + Math.abs(d[i * 4 + 2] - bg[2])
    const aeff = cd <= LO ? 0 : cd >= HImatte ? 1 : (cd - LO) / (HImatte - LO)
    if (aeff >= 1) continue
    const a = Math.round(aeff * 255)
    for (let c = 0; c < 3; c++) {
      d[i * 4 + c] = clamp(Math.round(bg[c] + ((d[i * 4 + c] - bg[c]) * 255) / Math.max(a, 1)), 0, 255)
    }
    d[i * 4 + 3] = Math.min(d[i * 4 + 3], a)
  }
  ctx.putImageData(id, 0, 0)
}

// Deterministic removal of a (near-)uniform background: flood-fill the background colour from the
// corners (the outer margin) AND any enclosed same-colour region above a size threshold (e.g. an
// empty art window inside a frame), with an anti-aliased alpha ramp at the boundary. The fill is
// CONNECTED, so the non-background subject (frame, gem, tan panel) blocks it and is never eaten —
// every detail and the exact resolution/padding survive.
function keyOutUniformBg(ctx: CanvasRenderingContext2D, W: number, H: number, bg: number[]): void {
  const id = ctx.getImageData(0, 0, W, H)
  const d = id.data
  const N = W * H
  const LO = 32
  const HI = 200
  const dd = new Int32Array(N)
  for (let i = 0; i < N; i++) {
    dd[i] = Math.abs(d[i * 4] - bg[0]) + Math.abs(d[i * 4 + 1] - bg[1]) + Math.abs(d[i * 4 + 2] - bg[2])
  }
  const state = new Uint8Array(N) // 0 unvisited · 1 remove · 2 kept small component
  const stack: number[] = []
  const seed = (i: number): void => {
    if (state[i] === 0 && dd[i] < HI) {
      state[i] = 1
      stack.push(i)
    }
  }
  seed(0)
  seed(W - 1)
  seed((H - 1) * W)
  seed(N - 1)
  while (stack.length) {
    const i = stack.pop() as number
    const x = i % W
    if (x > 0) seed(i - 1)
    if (x < W - 1) seed(i + 1)
    if (i >= W) seed(i - W)
    if (i < N - W) seed(i + W)
  }
  // Enclosed same-colour regions (an empty window/hole surrounded by the subject).
  const MIN = Math.max(64, Math.round(N * 0.002))
  for (let s = 0; s < N; s++) {
    if (state[s] !== 0 || dd[s] >= HI) continue
    const comp: number[] = [s]
    state[s] = 2
    for (let qi = 0; qi < comp.length; qi++) {
      const i = comp[qi]
      const x = i % W
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1]
      for (const j of nb) {
        if (j >= 0 && state[j] === 0 && dd[j] < HI) {
          state[j] = 2
          comp.push(j)
        }
      }
    }
    if (comp.length >= MIN) for (const i of comp) state[i] = 1
  }
  for (let i = 0; i < N; i++) {
    if (state[i] === 1) {
      const t = dd[i]
      const a = t <= LO ? 0 : t >= HI ? 255 : Math.round(((t - LO) / (HI - LO)) * 255)
      d[i * 4 + 3] = Math.min(d[i * 4 + 3], a)
    }
  }
  ctx.putImageData(id, 0, 0)
}

// Remove background: keep the whole subject exactly (pixels, position, resolution, padding) and cut
// everything behind it — AND any enclosed empty window — to transparency. Two engines:
//   'mechanical' — deterministic flood-fill of the (uniform) background colour: no model, so it is
//                  instant and can't reframe, clip the frame or leave a colour halo. Best for a
//                  subject on a solid/flat background.
//   'ai'         — the model paints the background magenta; we key that to an alpha mask and apply
//                  it to the pristine original. Handles photographic / complex backgrounds.
// 'auto' picks mechanical when the four corners agree (a solid background), else the AI engine.
export async function imageRemoveBg(p: {
  src: string
  model: string
  mode?: 'auto' | 'mechanical' | 'ai' | 'matte'
}): Promise<string> {
  const img = await loadImg(p.src)
  const W = img.naturalWidth
  const H = img.naturalHeight
  const out = makeCanvas(W, H)
  out.ctx.drawImage(img, 0, 0)

  // PRECISE: a real matting network predicts a soft foreground alpha; apply it straight to the
  // original (no colour key, no defringe needed — the matte is already soft-edged).
  if (p.mode === 'matte') {
    const alpha = await matteAlpha(img, W, H)
    const id = out.ctx.getImageData(0, 0, W, H)
    for (let i = 0; i < W * H; i++) id.data[i * 4 + 3] = Math.round(alpha[i] * 255)
    out.ctx.putImageData(id, 0, 0)
    return out.cv.toDataURL('image/png')
  }

  // Sample the four corners → background colour + how uniform it is.
  const c0 = out.ctx.getImageData(0, 0, W, H).data
  const corners = [
    [0, 0],
    [W - 1, 0],
    [0, H - 1],
    [W - 1, H - 1]
  ].map(([x, y]) => {
    const i = (y * W + x) * 4
    return [c0[i], c0[i + 1], c0[i + 2]]
  })
  const bg = [0, 1, 2].map((c) => Math.round(corners.reduce((s, pp) => s + pp[c], 0) / 4))
  const spread = Math.max(...corners.map((pp) => Math.abs(pp[0] - bg[0]) + Math.abs(pp[1] - bg[1]) + Math.abs(pp[2] - bg[2])))

  const mode = p.mode ?? 'auto'
  const mechanical = mode === 'mechanical' || (mode === 'auto' && spread < 48)

  if (mechanical) {
    keyOutUniformBg(out.ctx, W, H, bg)
  } else {
    const genUrl = await gemini(removeBgPrompt(), p.model, [p.src])
    const gen = await loadImg(genUrl)
    const mask = makeCanvas(W, H)
    mask.ctx.drawImage(gen, 0, 0, W, H)
    keyOutMagenta(mask.ctx, W, H)
    out.ctx.globalCompositeOperation = 'destination-in'
    out.ctx.drawImage(mask.cv, 0, 0)
    out.ctx.globalCompositeOperation = 'source-over'
  }

  // A solid-background matte leaves a light colour halo on the cut edge — whether it came from the
  // mechanical fill or the AI mask. The band-limited defringe neutralises it (needs a known bg
  // colour, so only when the corners are solid-ish; a genuinely photographic background is left to
  // the decontamination pass below).
  if (spread < 80) defringe(out.ctx, W, H, bg)

  decontaminateEdges(out.ctx, W, H)
  return out.cv.toDataURL('image/png')
}
