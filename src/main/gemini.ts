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

// images: array of data URLs. Returns a PNG data URL, or throws.
export async function geminiGenerate(opts: {
  prompt: string
  images: string[]
  model: string
}): Promise<string> {
  const keys = loadKeys()
  if (!keys.length) throw new Error('No Gemini API key set. Add one in Settings (or a .env with GEMINI_API_KEY).')

  const parts: unknown[] = [{ text: opts.prompt }, ...opts.images.map((d) => ({ inline_data: dataUrlToInline(d) }))]
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`
  const body = JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'] } })

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
