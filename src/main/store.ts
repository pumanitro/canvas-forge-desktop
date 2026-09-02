import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

// Real files on disk under the app's userData dir:
//   Projects/<id>.json        one file per project (self-contained, with embedded images)
//   Projects/<id>.meta.json   the same project's summary: name, dates, image count, cover
//   projectOrder.json         sidebar order, as a bare list of project ids
//   prompts.json              recent prompt history
//   settings.json             { geminiKey }
//
// A project JSON embeds every image as a base64 data URL and runs to hundreds of
// megabytes. The sidebar only needs a name and a thumbnail per project, so it reads
// the meta sidecars — a few KB each — and the full JSON is parsed only for the
// project actually being opened. Loading every JSON at startup, as this used to,
// put 1.3 GB of strings into the renderer before the first frame.

export type ProjectMeta = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  imageCount: number
  /** Small WebP data URL of the project's mini-map, painted by the renderer. */
  cover?: string
}

type StoredProject = {
  id: string
  name?: string
  images?: unknown[]
  createdAt?: number
  updatedAt?: number
}

function projectsDir(): string {
  const d = join(app.getPath('userData'), 'Projects')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function jsonPath(id: string): string {
  return join(projectsDir(), `${id}.json`)
}
function metaPath(id: string): string {
  return join(projectsDir(), `${id}.meta.json`)
}

function readMeta(id: string): ProjectMeta | null {
  try {
    const m = JSON.parse(readFileSync(metaPath(id), 'utf8')) as ProjectMeta
    return m && m.id === id ? m : null
  } catch {
    return null
  }
}

function writeMeta(m: ProjectMeta): void {
  writeFileSync(metaPath(m.id), JSON.stringify(m))
}

function metaOf(p: StoredProject, cover?: string): ProjectMeta {
  return {
    id: p.id,
    name: p.name || 'Untitled',
    createdAt: p.createdAt || 0,
    updatedAt: p.updatedAt || 0,
    imageCount: Array.isArray(p.images) ? p.images.length : 0,
    cover
  }
}

/** Every project's summary. A project that has no sidecar yet (written by an
 *  older build) gets parsed once here and its sidecar created — the same cost
 *  the old code paid on every launch, paid one last time. */
export function loadProjects(): ProjectMeta[] {
  const dir = projectsDir()
  const out: ProjectMeta[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.meta.json')) continue
    const id = f.slice(0, -'.json'.length)
    const meta = readMeta(id)
    if (meta) {
      out.push(meta)
      continue
    }
    try {
      const p = JSON.parse(readFileSync(join(dir, f), 'utf8')) as StoredProject
      const m = metaOf(p)
      writeMeta(m)
      out.push(m)
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/** The full project, images and all. Name and dates come from the sidecar when
 *  it has one: a rename only rewrites the sidecar, not the multi-hundred-MB JSON. */
export function loadProject(id: string): unknown | null {
  try {
    const p = JSON.parse(readFileSync(jsonPath(id), 'utf8')) as StoredProject
    const m = readMeta(id)
    if (m) {
      p.name = m.name
      p.updatedAt = m.updatedAt
    }
    return p
  } catch {
    return null
  }
}

export function saveProject(p: StoredProject): void {
  writeFileSync(jsonPath(p.id), JSON.stringify(p))
  // Keep whatever cover the renderer last painted; it sends a fresh one separately.
  writeMeta(metaOf(p, readMeta(p.id)?.cover))
}

/** Update summary fields without touching the project JSON. */
export function patchProjectMeta(id: string, patch: Partial<Pick<ProjectMeta, 'name' | 'updatedAt' | 'cover'>>): ProjectMeta | null {
  let m = readMeta(id)
  if (!m) {
    // No sidecar yet (or it was deleted by hand): rebuild it from the JSON first.
    try {
      m = metaOf(JSON.parse(readFileSync(jsonPath(id), 'utf8')) as StoredProject)
    } catch {
      return null
    }
  }
  const next = { ...m, ...patch }
  writeMeta(next)
  return next
}

export function deleteProject(id: string): void {
  for (const f of [jsonPath(id), metaPath(id)]) if (existsSync(f)) unlinkSync(f)
}

// The sidebar order lives in its own file rather than as a field on each project:
// project JSONs embed their images and run to megabytes, so rewriting every one of
// them just to swap two cards would be absurd. This is a bare id list — ids that no
// longer exist are ignored on load, so deletes need no bookkeeping here.
function orderPath(): string {
  return join(app.getPath('userData'), 'projectOrder.json')
}

export function loadProjectOrder(): string[] {
  try {
    const v = JSON.parse(readFileSync(orderPath(), 'utf8'))
    return Array.isArray(v) ? (v as string[]) : []
  } catch {
    return []
  }
}

export function saveProjectOrder(ids: string[]): void {
  writeFileSync(orderPath(), JSON.stringify(ids))
}

function promptsPath(): string {
  return join(app.getPath('userData'), 'prompts.json')
}

export function loadPrompts(): string[] {
  try {
    return JSON.parse(readFileSync(promptsPath(), 'utf8'))
  } catch {
    return []
  }
}

export function addPrompt(prompt: string): string[] {
  const clean = prompt.trim()
  const cur = loadPrompts()
  const next = [clean, ...cur.filter((p) => p !== clean)].slice(0, 30)
  writeFileSync(promptsPath(), JSON.stringify(next))
  return next
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): { geminiKey?: string } {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

export function setSetting(key: string, value: unknown): void {
  const s = getSettings() as Record<string, unknown>
  s[key] = value
  writeFileSync(settingsPath(), JSON.stringify(s))
}
