import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'

// Real files on disk under the app's userData dir:
//   Projects/<id>/project.json   the project: name, dates, and every image's
//                                geometry + prompt — but NOT its pixels
//   Projects/<id>/img/<nodeId>.png|jpg|webp   the pixels, one file per image
//   Projects/<id>.meta.json      summary sidecar for the sidebar: name, dates,
//                                image count, small cover
//   Projects/<id>.json.bak       a legacy single-file project, kept after migration
//   projectOrder.json            sidebar order, as a bare list of project ids
//   prompts.json                 recent prompt history
//   settings.json                { geminiKey }
//
// Why pixels live in their own files: a project used to be ONE json with every
// image embedded as a base64 data URL. At ~110 generations that json passed
// 510 MB, which is longer than the longest string V8 will build, and every save
// died with "RangeError: Invalid string length" — silently, for twenty minutes,
// until the project was reloaded from disk and an afternoon of work was gone.
// Now project.json stays a few hundred KB, an image is written exactly once
// (nodes are immutable per id: an edit makes a new node), and a save is cheap.

export type ProjectMeta = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  imageCount: number
  /** Small WebP data URL of the project's mini-map, painted by the renderer. */
  cover?: string
}

type StoredNode = {
  id: string
  src?: string
  /** Path of the pixel file relative to the project dir (on-disk form only). */
  file?: string
  /** The same pixel file as a bare extension, implying img/<id>.<ext>. Written
   *  by other builds of the app; both spellings are read and written. */
  img?: string
  [k: string]: unknown
}

type StoredProject = {
  id: string
  name?: string
  images?: StoredNode[]
  createdAt?: number
  updatedAt?: number
}

function projectsDir(): string {
  const d = join(app.getPath('userData'), 'Projects')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function projectDir(id: string): string {
  return join(projectsDir(), id)
}
function projectJsonPath(id: string): string {
  return join(projectDir(id), 'project.json')
}
function legacyPath(id: string): string {
  return join(projectsDir(), `${id}.json`)
}
function metaPath(id: string): string {
  return join(projectsDir(), `${id}.meta.json`)
}

// ---- pixels <-> files ----

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

function dataUrlToBuffer(src: string): { buf: Buffer; ext: string } | null {
  const m = /^data:([^;,]+)(;base64)?,/.exec(src)
  if (!m) return null
  const mime = m[1]
  const body = src.slice(m[0].length)
  const buf = m[2] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8')
  return { buf, ext: EXT_BY_MIME[mime] || 'bin' }
}

function fileToDataUrl(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}

// ---- meta sidecar ----

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

// ---- v2 read / write ----

/** Write the project as project.json + one file per image. Only images whose
 *  file is missing get written; files for images no longer in the project are
 *  removed. Never throws on a single bad image — it is kept inline instead. */
function writeProjectDir(p: StoredProject): void {
  const dir = projectDir(p.id)
  const imgDir = join(dir, 'img')
  mkdirSync(imgDir, { recursive: true })

  const keep = new Set<string>()
  const images: StoredNode[] = []
  for (const n of p.images || []) {
    const out: StoredNode = { ...n }
    delete out.src
    delete out.file
    let placed = false
    if (typeof n.src === 'string' && n.src.startsWith('data:')) {
      const parsed = dataUrlToBuffer(n.src)
      if (parsed) {
        const file = `img/${n.id}.${parsed.ext}`
        const abs = join(dir, file)
        if (!existsSync(abs)) writeFileSync(abs, parsed.buf)
        out.file = file
        // `img` carries the same thing as a bare extension. Older builds of this
        // app wrote only that field and read only that field, so a project saved
        // here has to stay readable by them — and vice versa (see readProjectDir).
        out.img = parsed.ext
        keep.add(`${n.id}.${parsed.ext}`)
        placed = true
      }
    }
    if (!placed && typeof n.src === 'string') out.src = n.src // odd src: keep inline
    images.push(out)
  }
  // Drop pixel files nobody references any more (deleted nodes).
  for (const f of readdirSync(imgDir)) if (!keep.has(f)) unlinkSync(join(imgDir, f))

  const body: StoredProject = { ...p, images }
  // Write to a temp file and rename so a crash mid-write never leaves a torn json.
  const tmp = projectJsonPath(p.id) + '.tmp'
  writeFileSync(tmp, JSON.stringify(body))
  renameSync(tmp, projectJsonPath(p.id))
}

function readProjectDir(id: string): StoredProject | null {
  try {
    const p = JSON.parse(readFileSync(projectJsonPath(id), 'utf8')) as StoredProject
    const dir = projectDir(id)
    p.images = (p.images || []).map((n) => {
      const out: StoredNode = { ...n }
      // Two spellings exist on disk: `file` is a path relative to the project dir,
      // `img` is only the extension and implies img/<nodeId>.<ext>. A project
      // written by another build of the app uses the second one; reading just the
      // first left every node with no pixels and the canvas came up blank.
      const rel =
        typeof n.file === 'string' && n.file
          ? n.file
          : typeof n.img === 'string' && n.img
            ? `img/${n.id}.${n.img}`
            : null
      if (rel) {
        try {
          out.src = fileToDataUrl(join(dir, rel))
        } catch {
          out.src = '' // file missing: keep the node, the renderer shows it empty
        }
      }
      delete out.file
      delete out.img
      return out
    })
    return p
  } catch {
    return null
  }
}

/** A legacy single-file project: parse it once, write it out as a directory,
 *  and keep the original as .bak. Returns the parsed project, or null. */
function migrateLegacy(id: string): StoredProject | null {
  const src = legacyPath(id)
  if (!existsSync(src)) return null
  try {
    const p = JSON.parse(readFileSync(src, 'utf8')) as StoredProject
    writeProjectDir(p)
    renameSync(src, `${src}.bak`)
    return p
  } catch {
    return null
  }
}

// ---- public API (unchanged shape) ----

function listProjectIds(): string[] {
  const dir = projectsDir()
  const ids = new Set<string>()
  for (const f of readdirSync(dir)) {
    const abs = join(dir, f)
    if (statSync(abs).isDirectory() && existsSync(join(abs, 'project.json'))) {
      ids.add(f)
      continue
    }
    if (!f.endsWith('.json')) continue
    const id = f.slice(0, -'.json'.length)
    // A project id never contains a dot, so anything left over here is a sidecar
    // or a retired copy — `<id>.meta.json`, `<id>.legacy.json`, a hand-made
    // `<id>.backup.json`. Treating those as projects put phantom duplicate cards
    // in the sidebar, each claiming the same image count as the real project.
    if (id.includes('.')) continue
    ids.add(id)
  }
  return [...ids]
}

/** Every project's summary. A project with no sidecar yet gets one built — from
 *  its small project.json, or (legacy) by parsing the big single json once. */
export function loadProjects(): ProjectMeta[] {
  const out: ProjectMeta[] = []
  for (const id of listProjectIds()) {
    const meta = readMeta(id)
    if (meta) {
      out.push(meta)
      continue
    }
    try {
      let p: StoredProject | null = null
      if (existsSync(projectJsonPath(id))) {
        p = JSON.parse(readFileSync(projectJsonPath(id), 'utf8')) as StoredProject
      } else {
        p = JSON.parse(readFileSync(legacyPath(id), 'utf8')) as StoredProject
      }
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
 *  it has one: a rename only rewrites the sidecar. */
export function loadProject(id: string): unknown | null {
  let p: StoredProject | null = existsSync(projectJsonPath(id)) ? readProjectDir(id) : migrateLegacy(id)
  if (!p) return null
  const m = readMeta(id)
  if (m) {
    p = { ...p, name: m.name, updatedAt: m.updatedAt }
  }
  return p
}

export function saveProject(p: StoredProject): void {
  writeProjectDir(p)
  // A legacy file that is still around would shadow nothing (the dir wins on
  // load), but it is half a gigabyte of stale data: retire it.
  if (existsSync(legacyPath(p.id))) renameSync(legacyPath(p.id), `${legacyPath(p.id)}.bak`)
  // Keep whatever cover the renderer last painted; it sends a fresh one separately.
  writeMeta(metaOf(p, readMeta(p.id)?.cover))
}

/** Update summary fields without touching the project itself. */
export function patchProjectMeta(
  id: string,
  patch: Partial<Pick<ProjectMeta, 'name' | 'updatedAt' | 'cover'>>
): ProjectMeta | null {
  let m = readMeta(id)
  if (!m) {
    try {
      const raw = existsSync(projectJsonPath(id)) ? projectJsonPath(id) : legacyPath(id)
      m = metaOf(JSON.parse(readFileSync(raw, 'utf8')) as StoredProject)
    } catch {
      return null
    }
  }
  const next = { ...m, ...patch }
  writeMeta(next)
  return next
}

export function deleteProject(id: string): void {
  if (existsSync(projectDir(id))) rmSync(projectDir(id), { recursive: true, force: true })
  for (const f of [legacyPath(id), `${legacyPath(id)}.bak`, metaPath(id)]) if (existsSync(f)) unlinkSync(f)
}

// The sidebar order lives in its own file rather than as a field on each project:
// rewriting a project just to swap two cards would be absurd. This is a bare id
// list — ids that no longer exist are ignored on load, so deletes need no
// bookkeeping here.
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
