import { clamp } from './util'

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
async function gemini(prompt: string, model: string, images: string[]): Promise<string> {
  const r = await window.api.gemini({ prompt, model, images })
  if (r.error || !r.image) throw new Error(r.error || 'no image returned')
  return r.image
}

// Full-frame inpaint: the model sees the WHOLE artwork (IMAGE 1) for context, a MASK
// (IMAGE 2) marking exactly where to edit, and optional references, then returns the
// whole frame. We composite only the masked region back, so the rest stays identical.
function inpaintPrompt(
  userPrompt: string,
  refCount: number,
  r: { selX: number; selY: number; selW: number; selH: number; W: number; H: number }
): string {
  const pctX = Math.round((r.selX / r.W) * 100)
  const pctY = Math.round((r.selY / r.H) * 100)
  const pctW = Math.round((r.selW / r.W) * 100)
  const pctH = Math.round((r.selH / r.H) * 100)
  const lines = [
    'You are doing a precise, LOCAL inpaint on a piece of game-UI artwork (like Photoshop Generative Fill).',
    'IMAGE 1 is the FULL original artwork. It is your base and your context for the exact art style, lighting, palette and layout.',
    'IMAGE 2 is a MASK aligned pixel-for-pixel to IMAGE 1: pure black everywhere except one WHITE region. That white region is the ONLY area you may change. IMAGE 2 is guidance only: never draw, trace, tint or output the mask, its edges or its colors.'
  ]
  if (refCount > 0) {
    lines.push(`The remaining ${refCount} image(s) are REFERENCES: the visual content and style to place inside the white region.`)
  }
  lines.push(
    userPrompt.trim()
      ? `What to render inside the white region: "${userPrompt.trim()}".`
      : refCount > 0
        ? 'Place the reference content inside the white region, fitted naturally.'
        : 'Fill the white region consistently with the surrounding artwork.',
    `The white region is about ${pctW}% wide and ${pctH}% tall, positioned around ${pctX}% from the left and ${pctY}% from the top. Draw the new content to fill that region at that size and position.`,
    'Return the ENTIRE image at the SAME dimensions as IMAGE 1. Every pixel OUTSIDE the white region must stay identical to IMAGE 1 (same shapes, letters, numbers, symbols, colors and lighting). Do not restyle, shift, recolor or garble anything outside the region.',
    'INSIDE the white region, integrate the new content so it matches the artwork style, lighting, palette, perspective, materials and edges. It must be seamless, with no visible box, border, frame, outline, seam or leftover mask tint.',
    'Output ONLY the final image.'
  )
  return lines.join('\n')
}

// Paint the selection shape (rounded rect, or the brush stroke) in FULL-image coords.
function paintRegion(
  ctx: CanvasRenderingContext2D,
  region: { selX: number; selY: number; selW: number; selH: number },
  stroke?: { points: Pt[]; radius: number }
): void {
  if (stroke && stroke.points.length >= 1) {
    const r = Math.max(1, Math.round(stroke.radius))
    if (stroke.points.length === 1) {
      const pt = stroke.points[0]
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.lineWidth = 2 * r
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      stroke.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)))
      ctx.stroke()
    }
  } else {
    const rr = clamp(Math.round(Math.min(region.selW, region.selH) * 0.08), 0, 24)
    ctx.beginPath()
    ctx.roundRect(region.selX, region.selY, region.selW, region.selH, rr)
    ctx.fill()
  }
}
function removeBgPrompt(): string {
  return [
    'You are a precise background-removal tool.',
    'Keep the MAIN foreground subject of this image EXACTLY as it is: identical shape, silhouette, edges, proportions, position, scale, colors, materials, lighting, and any text, numbers or symbols on it. Do not redraw, restyle, move, add to or crop the subject.',
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
function bgExtractPrompt(userPrompt?: string): string {
  const what = userPrompt?.trim() ? ` The background to keep is: "${userPrompt.trim()}".` : ''
  return [
    'You are a precise background-extraction tool.',
    'From this image, REMOVE every foreground element (icons, buttons, panels, badges, UI widgets, characters, objects) and ALL text, numbers and labels.',
    'Reconstruct and KEEP ONLY the background scene or surface that sits behind them, plausibly filling in the areas the removed elements covered so the background is complete, continuous and seamless.' + what,
    'Preserve the background exactly where it is already visible: same style, perspective, lighting, palette, materials and framing. Do not add any new objects or text.',
    'Output an opaque image at the SAME pixel dimensions and framing as the input.'
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

// Generate: regenerate a selected region IN PLACE. The model receives the FULL frame
// (for context so it places/scales/lights the new content correctly), a MASK marking
// the region, and optional references; we then composite only the masked region back
// onto the pristine original so nothing outside the selection can drift.
export async function imageEdit(p: {
  src: string
  bbox: Box
  prompt: string
  model: string
  stroke?: { points: Pt[]; radius: number }
  references?: string[]
}): Promise<string> {
  const img = await loadImg(p.src)
  const W = img.naturalWidth
  const H = img.naturalHeight
  const selX = clamp(Math.round(p.bbox.x), 0, W - 1)
  const selY = clamp(Math.round(p.bbox.y), 0, H - 1)
  const selW = clamp(Math.round(p.bbox.w), 1, W - selX)
  const selH = clamp(Math.round(p.bbox.h), 1, H - selY)
  const region = { selX, selY, selW, selH }

  // IMAGE 2: a crisp full-size black/white mask that tells the model WHERE to edit.
  const hardMask = makeCanvas(W, H)
  hardMask.ctx.fillStyle = '#000'
  hardMask.ctx.fillRect(0, 0, W, H)
  hardMask.ctx.fillStyle = '#fff'
  hardMask.ctx.strokeStyle = '#fff'
  paintRegion(hardMask.ctx, region, p.stroke)
  const maskUrl = hardMask.cv.toDataURL('image/png')

  // Send the full frame + mask + references; get the full frame back.
  const refs = (p.references || []).slice(0, 4)
  const prompt = inpaintPrompt(p.prompt, refs.length, { ...region, W, H })
  const genUrl = await gemini(prompt, p.model, [p.src, maskUrl, ...refs])
  const gen = await loadImg(genUrl)

  // Scale the result to the original's exact dimensions (in case the model reframed).
  const genCv = makeCanvas(W, H)
  genCv.ctx.drawImage(gen, 0, 0, W, H)

  // Feathered white mask of the selection → keep only the region from the result.
  const feather = clamp(Math.round(Math.min(selW, selH) * 0.06), 4, 48)
  const softMask = makeCanvas(W, H)
  softMask.ctx.filter = `blur(${feather}px)`
  softMask.ctx.fillStyle = '#fff'
  softMask.ctx.strokeStyle = '#fff'
  paintRegion(softMask.ctx, region, p.stroke)
  softMask.ctx.filter = 'none'

  genCv.ctx.globalCompositeOperation = 'destination-in'
  genCv.ctx.drawImage(softMask.cv, 0, 0)
  genCv.ctx.globalCompositeOperation = 'source-over'

  // Composite the edited region over the untouched original.
  const out = makeCanvas(W, H)
  out.ctx.drawImage(img, 0, 0)
  out.ctx.drawImage(genCv.cv, 0, 0)
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

// Remove background: keep the whole subject as-is, cut everything behind it to
// transparency (Gemini paints the background magenta, we key it out). Same dimensions.
export async function imageRemoveBg(p: { src: string; model: string }): Promise<string> {
  const img = await loadImg(p.src)
  const W = img.naturalWidth
  const H = img.naturalHeight
  const genUrl = await gemini(removeBgPrompt(), p.model, [p.src])
  const gen = await loadImg(genUrl)
  const cv = makeCanvas(W, H)
  cv.ctx.drawImage(gen, 0, 0, W, H)
  keyOutMagenta(cv.ctx, W, H)
  return cv.cv.toDataURL('image/png')
}
