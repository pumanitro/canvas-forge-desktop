import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

// Real files on disk under the app's userData dir:
//   Projects/<id>.json   one file per project (self-contained, with embedded images)
//   prompts.json         recent prompt history
//   settings.json        { geminiKey }

function projectsDir(): string {
  const d = join(app.getPath('userData'), 'Projects')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function loadProjects(): unknown[] {
  const dir = projectsDir()
  const out: unknown[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => ((b as { updatedAt?: number }).updatedAt || 0) - ((a as { updatedAt?: number }).updatedAt || 0))
}

export function saveProject(p: { id: string }): void {
  writeFileSync(join(projectsDir(), `${p.id}.json`), JSON.stringify(p))
}

export function deleteProject(id: string): void {
  const f = join(projectsDir(), `${id}.json`)
  if (existsSync(f)) unlinkSync(f)
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
