import type { Project } from './types'

// Disk-backed persistence via the main process (replaces the web IndexedDB store).
export async function loadProjects(): Promise<Project[]> {
  const ps = ((await window.api.loadProjects()) as Project[]) || []
  return ps.sort((a, b) => b.updatedAt - a.updatedAt)
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
