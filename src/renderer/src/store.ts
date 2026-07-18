import type { Project } from './types'

// Disk-backed persistence via the main process (replaces the web IndexedDB store).
export async function loadProjects(): Promise<Project[]> {
  const [loaded, order] = await Promise.all([
    window.api.loadProjects(),
    window.api.loadProjectOrder()
  ])
  const ps = (loaded as Project[]) || []
  const rank = new Map((order || []).map((id, i) => [id, i] as const))
  // Projects the user has placed keep that order; anything unranked (first run
  // before an order file exists, or a project added outside the app) falls to the
  // end by recency — which on first run is every project, i.e. the old behaviour.
  return ps.sort((a, b) => {
    const ra = rank.get(a.id) ?? Infinity
    const rb = rank.get(b.id) ?? Infinity
    return ra === rb ? b.updatedAt - a.updatedAt : ra - rb
  })
}

export function saveProjectOrder(ids: string[]): Promise<unknown> {
  return window.api.saveProjectOrder(ids)
}
export function saveProject(p: Project): Promise<unknown> {
  return window.api.saveProject(p)
}
export function removeProject(id: string): Promise<unknown> {
  return window.api.deleteProject(id)
}
export function loadPrompts(): Promise<string[]> {
  return window.api.loadPrompts()
}
export function addPrompt(p: string): Promise<string[]> {
  return window.api.addPrompt(p)
}
