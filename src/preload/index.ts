import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  gemini: (opts: { prompt: string; images: string[]; model: string; aspectRatio?: string }) =>
    ipcRenderer.invoke('gemini:generate', opts) as Promise<{ image?: string; error?: string }>,
  variants: (opts: { image: string; prompt: string; count: number }) =>
    ipcRenderer.invoke('gemini:variants', opts) as Promise<{ variants?: { label: string; prompt: string }[]; note?: string; error?: string }>,
  loadProjects: () => ipcRenderer.invoke('projects:load'),
  loadProject: (id: string) => ipcRenderer.invoke('projects:loadOne', id),
  // Resolves with the cf-img URL now standing in for every data URL that was saved.
  saveProject: (p: unknown) =>
    ipcRenderer.invoke('projects:save', p) as Promise<{ rewritten: Record<string, string> }>,
  // Progress of a one-time legacy-project migration (or an import): done/total images.
  onProjectMigrating: (cb: (p: { id: string; done: number; total: number }) => void) => {
    const h = (_e: unknown, p: { id: string; done: number; total: number }): void => cb(p)
    ipcRenderer.on('projects:migrating', h)
    return () => ipcRenderer.off('projects:migrating', h)
  },
  patchProjectMeta: (id: string, patch: { name?: string; updatedAt?: number; cover?: string }) =>
    ipcRenderer.invoke('projects:patchMeta', { id, patch }),
  deleteProject: (id: string) => ipcRenderer.invoke('projects:delete', id),
  loadProjectOrder: () => ipcRenderer.invoke('projects:loadOrder') as Promise<string[]>,
  saveProjectOrder: (ids: string[]) => ipcRenderer.invoke('projects:saveOrder', ids),
  loadPrompts: () => ipcRenderer.invoke('prompts:load') as Promise<string[]>,
  addPrompt: (p: string) => ipcRenderer.invoke('prompts:add', p) as Promise<string[]>,
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<{ geminiKey?: string; hasKey: boolean }>,
  setKey: (key: string) => ipcRenderer.invoke('settings:setKey', key) as Promise<{ hasKey: boolean }>,
  exportProject: (p: unknown) =>
    ipcRenderer.invoke('project:export', p) as Promise<{
      path?: string
      canceled?: boolean
      error?: string
    }>,
  importProject: () => ipcRenderer.invoke('project:import') as Promise<{ project?: unknown; canceled?: boolean; error?: string }>,
  savePng: (dataUrl: string, name: string) =>
    ipcRenderer.invoke('image:savePng', { dataUrl, name }) as Promise<{ path?: string; canceled?: boolean; error?: string }>,
  revealItem: (path: string) => ipcRenderer.invoke('shell:showItem', path) as Promise<{ ok?: boolean }>,
  exportZip: (items: { name: string; dataUrl: string }[], name: string) =>
    ipcRenderer.invoke('image:exportZip', { items, name }) as Promise<{ path?: string; count?: number; canceled?: boolean; error?: string }>,
  copyImage: (dataUrl: string) => ipcRenderer.invoke('clipboard:writeImage', dataUrl) as Promise<{ ok?: boolean; error?: string }>,
  detect: (opts: { image: string; description: string }) =>
    ipcRenderer.invoke('gemini:detect', opts) as Promise<{ box?: [number, number, number, number] | null; error?: string }>,
  matteStatus: (id: string) => ipcRenderer.invoke('matte:status', id) as Promise<{ ready: boolean; size: number }>,
  matteEnsure: (id: string) => ipcRenderer.invoke('matte:ensure', id) as Promise<{ ok: boolean; error?: string }>,
  matteRun: (id: string, rgba: Uint8Array) =>
    ipcRenderer.invoke('matte:run', { id, rgba }) as Promise<{ alpha?: Float32Array; error?: string }>,
  // Download progress for the matting model (0..1). Returns an unsubscribe fn.
  onMatteProgress: (cb: (p: { id: string; progress: number }) => void) => {
    const h = (_e: unknown, p: { id: string; progress: number }): void => cb(p)
    ipcRenderer.on('matte:progress', h)
    return () => ipcRenderer.off('matte:progress', h)
  },

  // --- MCP: the main process forwards agent tool calls here; the renderer answers ---
  onMcpCall: (cb: (msg: { id: string; method: string; params: unknown }) => void) => {
    const h = (_e: unknown, msg: { id: string; method: string; params: unknown }): void => cb(msg)
    ipcRenderer.on('mcp:call', h)
    return () => ipcRenderer.off('mcp:call', h)
  },
  mcpResult: (id: string, payload: { data?: unknown; error?: string }) =>
    ipcRenderer.send('mcp:result', { id, ...payload }),
  mcpInfo: () =>
    ipcRenderer.invoke('mcp:info') as Promise<{
      enabled: boolean
      port: number | null
      url: string | null
      error: string | null
      toolCount: number
      toolNames: string[]
      lastCallAt: number | null
      clients: { name: string; at: number; calls: number }[]
    }>
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type Api = typeof api
