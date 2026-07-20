import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Gemini image API (same REST endpoint as the web version), run in the MAIN process
// so the key never touches the renderer. Keys come from (in order): env vars,
// userData/settings.json { geminiKey }, and a .env / .env.local in the project (dev).

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function fromSettings(): string[] {
  try {
    const s = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    return s.geminiKey ? [String(s.geminiKey)] : []
  } catch {
    return []
  }
}

function fromEnvFiles(): string[] {
  const keys: string[] = []
  for (const f of ['.env', '.env.local']) {
    const p = join(process.cwd(), f)
    if (!existsSync(p)) continue
    const txt = readFileSync(p, 'utf8')
    const m = txt.match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m)
    if (m) keys.push(m[1])
    for (const mm of txt.matchAll(/^\s*GEMINI_API_KEY_\d+\s*=\s*(.+?)\s*$/gm)) keys.push(mm[1])
  }
  return keys
}

function loadKeys(): string[] {
  const keys: string[] = []
  const push = (v?: string): void => {
    if (!v) return
    const k = String(v).replace(/^["']|["']$/g, '').trim()
    if (k && !keys.includes(k)) keys.push(k)
  }
  push(process.env.GEMINI_API_KEY)
  for (let i = 2; i <= 9; i++) push(process.env[`GEMINI_API_KEY_${i}`])
  fromSettings().forEach(push)
  fromEnvFiles().forEach(push)
  return keys
}

export function hasKey(): boolean {
  return loadKeys().length > 0
}

function dataUrlToInline(d: string): { mime_type: string; data: string } {
  const m = d.match(/^data:([^;]+);base64,([\s\S]*)$/)
  if (!m) throw new Error('expected a base64 data URL')
  return { mime_type: m[1], data: m[2] }
}

// "Magic select": ask a vision model for the tight bounding box of a described
// element. Returns box_2d [ymin, xmin, ymax, xmax] normalized 0..1000, or null.
export async function geminiDetect(opts: {
  image: string
  description: string
  model?: string
}): Promise<{ box: [number, number, number, number] | null }> {
  const keys = loadKeys()
  if (!keys.length) throw new Error('No Gemini API key set. Add one in Settings (or a .env with GEMINI_API_KEY).')
  const model = opts.model || 'gemini-2.5-flash'
  const prompt = [
    `Detect this single element in the image: "${opts.description.trim()}".`,
    'Return its bounding box as box_2d in the format [ymin, xmin, ymax, xmax],',
    'where each value is an INTEGER normalized to 0-1000: (0,0) is the image TOP-LEFT and',
    '(1000,1000) is the BOTTOM-RIGHT; ymin/ymax are vertical, xmin/xmax are horizontal.',
    'The box must TIGHTLY enclose the ENTIRE element (all of it) with minimal margin.',
    'Respond with ONLY minified JSON {"box_2d":[ymin,xmin,ymax,xmax]} (or {"box_2d":null} if the element is not present).'
  ].join(' ')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }, { inline_data: dataUrlToInline(opts.image) }] }],
    // temperature 0 + thinking DISABLED → far more accurate/consistent boxes (per Google's guidance)
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }
    }
  })

  let lastErr = ''
  for (let i = 0; i < keys.length; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': keys[i] }, body })
    if (res.ok) {
      const dataJson = await res.json()
      const parts = dataJson?.candidates?.[0]?.content?.parts ?? []
      const text = parts.map((p: { text?: string }) => p.text).filter(Boolean).join('')
      if (!text) throw new Error('no detection returned')
      let box: unknown = null
      try {
        box = (JSON.parse(text) as { box_2d?: unknown }).box_2d
      } catch {
        const m = text.match(/\[[^\]]*\]/)
        if (m) box = JSON.parse(m[0])
      }
      if (!Array.isArray(box) || box.length !== 4 || box.some((n) => typeof n !== 'number')) return { box: null }
      return { box: (box as number[]).map(Number) as [number, number, number, number] }
    }
    const t = (await res.text()).slice(0, 700)
    lastErr = `Detect HTTP ${res.status}: ${t}`
    const quota = res.status === 429 || /quota|RESOURCE_EXHAUSTED|prepayment/i.test(t)
    if (quota && i < keys.length - 1) continue
    throw new Error(lastErr)
  }
  throw new Error(lastErr || 'detection failed')
}

// Propose N alternative wordings of one edit instruction, for a varied batch.
//
// The image goes with the request on purpose: asked blind, a model invents variations that
// read well but don't fit the artwork — placements that collide with existing UI, colours that
// aren't in the palette. Seeing the frame is what makes the suggestions usable.
//
// The brief also lets it return FEWER than asked. An instruction with no dimension worth
// varying ("remove the drop shadow") has no six distinct readings, and a model forced to
// produce six will pad the list with near-duplicates or quietly drift off the request.
export async function geminiVariants(opts: {
  image: string
  prompt: string
  count: number
  model?: string
}): Promise<{ variants: { label: string; prompt: string }[]; note?: string }> {
  const keys = loadKeys()
  if (!keys.length) throw new Error('No Gemini API key set. Add one in Settings (or a .env with GEMINI_API_KEY).')
  const model = opts.model || 'gemini-2.5-flash'
  const brief = [
    'An artist is editing the attached artwork and wrote this instruction:',
    `"""${opts.prompt.trim()}"""`,
    '',
    `Write up to ${opts.count} alternative versions of that instruction, to run as a batch the artist picks from.`,
    'EVERY version must achieve the SAME thing the artist asked for. Vary only HOW it is done —',
    'the approach, placement, treatment or emphasis. Never change WHAT is being asked for, and',
    'never add a second unrelated change.',
    'Ground each one in what is actually visible in the attached image: real elements, real',
    'placements, the palette that is already there. Never propose something that would overlap or',
    'obscure existing artwork or UI.',
    'Write each prompt as a complete, standalone instruction in the artist\'s own plain voice —',
    'it is sent to an image model verbatim, so it must stand on its own without the others.',
    '',
    'Each entry has "label" (2-4 words naming what makes it distinct) and "prompt" (the full instruction).',
    `If the instruction has no real dimension worth varying, return FEWER than ${opts.count} and say why in "note".`,
    '',
    'Respond with ONLY minified JSON: {"variants":[{"label":"...","prompt":"..."}],"note":"..."}'
  ].join('\n')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const body = JSON.stringify({
    contents: [{ parts: [{ text: brief }, { inline_data: dataUrlToInline(opts.image) }] }],
    // Warm enough that the alternatives actually diverge — unlike detection, spread is the point.
    generationConfig: { temperature: 1, responseMimeType: 'application/json' }
  })

  let lastErr = ''
  for (let i = 0; i < keys.length; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': keys[i] }, body })
    if (res.ok) {
      const dataJson = await res.json()
      const parts = dataJson?.candidates?.[0]?.content?.parts ?? []
      const text = parts.map((p: { text?: string }) => p.text).filter(Boolean).join('')
      if (!text) throw new Error('no suggestions returned')
      let parsed: { variants?: unknown; note?: unknown }
      try {
        parsed = JSON.parse(text)
      } catch {
        const m = text.match(/\{[\s\S]*\}/)
        if (!m) throw new Error('could not read the suggestions')
        parsed = JSON.parse(m[0])
      }
      const raw = Array.isArray(parsed.variants) ? parsed.variants : []
      const variants = raw
        .map((v) => v as { label?: unknown; prompt?: unknown })
        .filter((v) => typeof v.prompt === 'string' && (v.prompt as string).trim())
        .slice(0, opts.count)
        .map((v) => ({ label: typeof v.label === 'string' ? v.label : '', prompt: (v.prompt as string).trim() }))
      if (!variants.length) throw new Error('no usable suggestions returned')
      return { variants, note: typeof parsed.note === 'string' ? parsed.note : undefined }
    }
    const t = (await res.text()).slice(0, 700)
    // Surface Google's own sentence, not the raw JSON envelope — this lands in a one-line note
    // under the rows, where a pasted error blob is unreadable.
    let msg = t
    try {
      msg = (JSON.parse(t) as { error?: { message?: string } })?.error?.message || t
    } catch {
      /* not JSON — keep the body */
    }
    lastErr = `Suggest failed (${res.status}): ${msg.trim()}`
    const quota = res.status === 429 || /quota|RESOURCE_EXHAUSTED|prepayment/i.test(t)
    if (quota && i < keys.length - 1) continue
    throw new Error(lastErr)
  }
  throw new Error(lastErr || 'suggestions failed')
}

// images: array of data URLs. Returns a PNG data URL, or throws.
// aspectRatio (e.g. '9:16') pins the output shape at the API level. Prose alone does NOT hold
// it: with several reference images attached, the model reshapes its output after them and
// silently returns the wrong orientation. Must be one of the API's accepted enum values.
export async function geminiGenerate(opts: {
  prompt: string
  images: string[]
  model: string
  aspectRatio?: string
}): Promise<string> {
  const keys = loadKeys()
  if (!keys.length) throw new Error('No Gemini API key set. Add one in Settings (or a .env with GEMINI_API_KEY).')

  const parts: unknown[] = [{ text: opts.prompt }, ...opts.images.map((d) => ({ inline_data: dataUrlToInline(d) }))]
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(opts.aspectRatio ? { imageConfig: { aspectRatio: opts.aspectRatio } } : {})
    }
  })

  let lastErr = ''
  for (let i = 0; i < keys.length; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': keys[i] },
      body
    })
    if (res.ok) {
      const dataJson = await res.json()
      const cps = dataJson?.candidates?.[0]?.content?.parts ?? []
      const inline = cps
        .map((p: { inlineData?: { data?: string }; inline_data?: { data?: string } }) => p.inlineData || p.inline_data)
        .find((d: { data?: string } | undefined) => d?.data)
      if (!inline?.data) throw new Error('Gemini returned no image')
      return `data:image/png;base64,${inline.data}`
    }
    const text = (await res.text()).slice(0, 1000)
    lastErr = `Gemini HTTP ${res.status}: ${text}`
    const quota = res.status === 429 || /quota|spending cap|RESOURCE_EXHAUSTED|prepayment/i.test(text)
    if (quota) {
      if (i < keys.length - 1) continue
      if (/prepayment|depleted|billing/i.test(text)) throw new Error('Gemini image credits are depleted. Add credits to your Google AI Studio account.')
      throw new Error('Gemini rate limit / quota hit. Wait a moment and try again.')
    }
    throw new Error(lastErr)
  }
  throw new Error(lastErr || 'Gemini request failed')
}
