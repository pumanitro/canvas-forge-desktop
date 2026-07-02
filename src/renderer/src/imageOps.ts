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

// Whole-image RESTYLE: redraw the base subject in the STYLE of the reference(s), keeping
// the base's subject/framing. Borrow look only (palette/materials/letterforms), never the
// reference's layout/text. Output at the base's aspect ratio.
function restylePrompt(userPrompt: string, refCount: number, W: number, H: number): string {
  const lines = [
    'You are restyling one small piece of game-UI art.',
    'IMAGE 1 is the BASE. Keep its subject, silhouette, composition and framing (for example a single icon or object, centered as it is in IMAGE 1).'
  ]
  if (refCount > 0) {
    lines.push(
      `The other ${refCount} image(s) are STYLE REFERENCES. Copy ONLY their look: color palette, metal/gold materials, lighting, glow, rendering style and letterforms, and apply that look to the subject of IMAGE 1.`
    )
  }
  lines.push(
    userPrompt.trim() ? `Instruction: "${userPrompt.trim()}".` : 'Re-render the subject of IMAGE 1 in the reference style.',
    'Do NOT copy the reference layout, its words, numbers or extra objects. Borrow the STYLE only. Show ONLY the IMAGE 1 subject, centered, on a clean transparent background.',
    `Output ONE image at the SAME width-to-height aspect ratio as IMAGE 1 (about ${W} by ${H}). No borders, frames, padding or letterboxing.`
  )
  return lines.join('\n')
}

// Annotated-crop edit (small selections): no mask images — Nano Banana follows a drawn
// MARKER + semantic instruction far more reliably than a separate black/white mask
// (masks made it paste refs / draw mask-edge scribbles). The magenta rectangle exists
// only in the input; the model is told to remove it, and we composite only the region
// interior back anyway. Validated live 2026-07-02 (key recolor test, gens 3+4).
function markedEditPrompt(userPrompt: string, refCount: number): string {
  const lines = [
    'You are editing one small piece of game-UI art.',
    'The LAST image is the ARTWORK to edit. A MAGENTA RECTANGLE has been drawn on it as a marker: it surrounds the ONE element you must edit. The rectangle is only an annotation — NEVER draw it, or any magenta, in your output.'
  ]
  if (refCount > 0) {
    lines.push(
      `The image(s) before it are COLOR / STYLE REFERENCES, shown letterboxed on a dark background (ignore the dark padding). Take from them ONLY the look the instruction asks for (palette, gold/metal finish, lighting). Do NOT copy their text, numbers, layout or objects into the artwork.`
    )
  }
  lines.push(
    userPrompt.trim()
      ? `Instruction for the marked element: "${userPrompt.trim()}".`
      : 'Restyle the marked element to match the reference look.',
    'Modify ONLY the marked element. Keep its exact shape, silhouette, position, size and identity unless the instruction says otherwise — a recolor changes colors/materials, never the drawing itself. Never erase it and never replace it with background.',
    'Everything OUTSIDE the marked element must stay EXACTLY identical to the artwork: same stone, text, letters, numbers, lighting and framing, pixel for pixel.',
    'Output ONE image at the SAME dimensions, aspect ratio and framing as the ARTWORK (the last image), with the magenta marker removed.'
  )
  return lines.join('\n')
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
    'You are doing a precise, LOCAL inpaint (generative fill) on a piece of game-UI artwork.',
    'IMAGE 1 is the FULL original artwork. It is your base and your context for the exact art style, lighting, palette and layout.',
    'IMAGE 2 is a MASK aligned pixel-for-pixel to IMAGE 1: pure black everywhere except one WHITE region. That white region is the ONLY area you may change. IMAGE 2 is guidance only: never draw, trace, tint or output the mask, its edges or its colors.',
    'IMAGE 3 is a CLOSE-UP CROP of exactly what the white region contains right now. That existing content is your BASE for the edit.'
  ]
  if (refCount > 0) {
    lines.push(
      `The final ${refCount} image(s) are REFERENCES for style, color and material. Borrow their look (palette, gold/metal finish, lighting, letterform style) as the instruction directs. Do NOT paste their text, numbers, layout or objects into the region unless the instruction explicitly asks for that.`
    )
  }
  lines.push(
    userPrompt.trim()
      ? `Instruction for the white region: "${userPrompt.trim()}".`
      : refCount > 0
        ? 'Restyle the existing content of the white region to match the reference look.'
        : 'Fill the white region consistently with the surrounding artwork.',
    'Unless the instruction explicitly says to remove or replace the element, MODIFY the existing content shown in IMAGE 3: keep its shape, silhouette, position and identity, changing only what the instruction asks (for example its colors or materials). NEVER erase it, and NEVER fill the region with plain background, stone or empty wall unless the instruction asks for removal.',
    `The white region is about ${pctW}% wide and ${pctH}% tall, positioned around ${pctX}% from the left and ${pctY}% from the top. Keep the edited content at that size and position.`,
    'Return the ENTIRE image at the SAME dimensions as IMAGE 1. Every pixel OUTSIDE the white region must stay identical to IMAGE 1 (same shapes, letters, numbers, symbols, colors and lighting). Do not restyle, shift, recolor or garble anything outside the region.',
    'INSIDE the white region, integrate the edit so it matches the artwork style, lighting, palette, perspective, materials and edges. It must be seamless, with no visible box, border, frame, outline, seam or leftover mask tint.',
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
  transparent?: boolean
}): Promise<string> {
  const img = await loadImg(p.src)
  const W = img.naturalWidth
  const H = img.naturalHeight
  const selX = clamp(Math.round(p.bbox.x), 0, W - 1)
  const selY = clamp(Math.round(p.bbox.y), 0, H - 1)
  const selW = clamp(Math.round(p.bbox.w), 1, W - selX)
  const selH = clamp(Math.round(p.bbox.h), 1, H - selY)
  const refs = (p.references || []).slice(0, 4)

  // WHOLE-image restyle: the selection covers (essentially) the whole node → don't do
  // masked inpaint. Redraw the subject guided by refs + prompt, and FIT the result into the
  // core dimensions PRESERVING ASPECT (no stretch/squish), keeping the core resolution.
  // Coverage-based so a near-full box (not just a pixel-exact double-click) still restyles.
  // Gated to reference-driven restyles or transparent icons, so a whole-frame prompt-only
  // edit on an opaque frame still goes through inpaint (and keeps its own background).
  const isWhole = !p.stroke && selW * selH >= 0.82 * W * H && (refs.length > 0 || !!p.transparent)
  if (isWhole) {
    const paddedRefs = await Promise.all(refs.map((r) => padToAspect(r, W, H)))
    const genUrl = await gemini(restylePrompt(p.prompt, refs.length, W, H), p.model, [p.src, ...paddedRefs])
    const gen = await loadImg(genUrl)
    const gw = gen.naturalWidth || W
    const gh = gen.naturalHeight || H
    const s = Math.min(W / gw, H / gh) // contain: preserve aspect, never distort
    const dw = Math.round(gw * s)
    const dh = Math.round(gh * s)
    const out = makeCanvas(W, H)
    out.ctx.drawImage(gen, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh)
    return out.cv.toDataURL('image/png')
  }

  // SMALL selections: edit a CROP around the region so the element is LARGE (a key at
  // ~2% of a big frame is invisible at full-frame scale — the model paints a blob).
  // The region is pointed at with a drawn MAGENTA MARKER + semantic instruction (no
  // mask images — Nano Banana follows annotations far better). We paste only the
  // feathered region interior back onto the pristine original.
  const small = selW * selH <= 0.2 * W * H
  const feather = clamp(Math.round(Math.min(selW, selH) * 0.06), 4, 48)

  if (small) {
    const off = feather + 6 // marker sits outside the composited area (past the feather spread)
    const margin = Math.max(Math.round(Math.max(selW, selH) * 0.6), 64, off + 12)
    const cropX = clamp(selX - margin, 0, W)
    const cropY = clamp(selY - margin, 0, H)
    const cw = clamp(selX + selW + margin, 1, W) - cropX
    const ch = clamp(selY + selH + margin, 1, H) - cropY
    const er = { selX: selX - cropX, selY: selY - cropY, selW, selH }
    const estroke = p.stroke
      ? { points: p.stroke.points.map((pt) => ({ x: pt.x - cropX, y: pt.y - cropY })), radius: p.stroke.radius }
      : undefined

    // The ARTWORK: the crop with the magenta marker rectangle drawn around the selection
    const ann = makeCanvas(cw, ch)
    ann.ctx.drawImage(img, cropX, cropY, cw, ch, 0, 0, cw, ch)
    ann.ctx.strokeStyle = '#FF00FF'
    ann.ctx.lineWidth = Math.max(3, Math.round(Math.min(cw, ch) * 0.01))
    ann.ctx.strokeRect(er.selX - off, er.selY - off, selW + 2 * off, selH + 2 * off)

    // refs are letterboxed to the crop's aspect (else they reshape the output), artwork LAST
    const paddedRefs = await Promise.all(refs.map((r) => padToAspect(r, cw, ch)))
    const genUrl = await gemini(markedEditPrompt(p.prompt, refs.length), p.model, [...paddedRefs, ann.cv.toDataURL('image/png')])
    const gen = await loadImg(genUrl)

    // Guard: if the model still returned a different shape, compositing would paste a
    // squashed fragment — fail loudly instead so the user can just re-run.
    const ga = gen.naturalWidth / gen.naturalHeight
    if (Math.abs(ga / (cw / ch) - 1) > 0.08) {
      throw new Error('The model returned a differently-shaped image. Run it again (or remove very wide/tall references).')
    }

    // Scale the result to the crop's dimensions, keep only the feathered region, paste back.
    const genCv = makeCanvas(cw, ch)
    genCv.ctx.drawImage(gen, 0, 0, cw, ch)
    const softMask = makeCanvas(cw, ch)
    softMask.ctx.filter = `blur(${feather}px)`
    softMask.ctx.fillStyle = '#fff'
    softMask.ctx.strokeStyle = '#fff'
    paintRegion(softMask.ctx, er, estroke)
    softMask.ctx.filter = 'none'
    genCv.ctx.globalCompositeOperation = 'destination-in'
    genCv.ctx.drawImage(softMask.cv, 0, 0)
    genCv.ctx.globalCompositeOperation = 'source-over'

    const out = makeCanvas(W, H)
    out.ctx.drawImage(img, 0, 0)
    out.ctx.drawImage(genCv.cv, cropX, cropY)
    return out.cv.toDataURL('image/png')
  }

  // LARGE selections: full-frame mask inpaint (the region is big enough to see).
  const region = { selX, selY, selW, selH }
  const hardMask = makeCanvas(W, H)
  hardMask.ctx.fillStyle = '#000'
  hardMask.ctx.fillRect(0, 0, W, H)
  hardMask.ctx.fillStyle = '#fff'
  hardMask.ctx.strokeStyle = '#fff'
  paintRegion(hardMask.ctx, region, p.stroke)
  const maskUrl = hardMask.cv.toDataURL('image/png')

  // IMAGE 3: a close-up of the region's CURRENT content, so the model edits what's
  // there instead of erasing it and inpainting background. Padded to the frame's
  // aspect (like the refs) so an odd-shaped region can't reshape the output.
  const closeup = makeCanvas(selW, selH)
  closeup.ctx.drawImage(img, selX, selY, selW, selH, 0, 0, selW, selH)
  const closeupUrl = await padToAspect(closeup.cv.toDataURL('image/png'), W, H)
  const paddedRefs = await Promise.all(refs.map((r) => padToAspect(r, W, H)))

  const prompt = inpaintPrompt(p.prompt, refs.length, { ...region, W, H })
  const genUrl = await gemini(prompt, p.model, [p.src, maskUrl, closeupUrl, ...paddedRefs])
  const gen = await loadImg(genUrl)

  // Scale the result to the original's exact dimensions (in case the model reframed).
  const genCv = makeCanvas(W, H)
  genCv.ctx.drawImage(gen, 0, 0, W, H)

  // Feathered white mask of the selection → keep only the region from the result.
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
