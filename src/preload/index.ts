import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  gemini: (opts: { prompt: string; images: string[]; model: string; aspectRatio?: string }) =>
    ipcRenderer.invoke('gemini:generate', opts) as Promise<{ image?: string; error?: string }>,
  loadProjects: () => ipcRenderer.invoke('projects:load'),
  saveProject: (p: unknown) => ipcRenderer.invoke('projects:save', p),
  deleteProject: (id: string) => ipcRenderer.invoke('projects:delete', id),
  loadPrompts: () => ipcRenderer.invoke('prompts:load') as Promise<string[]>,
  addPrompt: (p: string) => ipcRenderer.invoke('prompts:add', p) as Promise<string[]>,
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<{ geminiKey?: string; hasKey: boolean }>,
  setKey: (key: string) => ipcRenderer.invoke('settings:setKey', key) as Promise<{ hasKey: boolean }>,
  exportProject: (p: unknown) => ipcRenderer.invoke('project:export', p) as Promise<{ path?: string; canceled?: boolean }>,
  importProject: () => ipcRenderer.invoke('project:import') as Promise<{ project?: unknown; canceled?: boolean; error?: string }>,
  savePng: (dataUrl: string, name: string) =>
    ipcRenderer.invoke('image:savePng', { dataUrl, name }) as Promise<{ path?: string; canceled?: boolean; error?: string }>,
  revealItem: (path: string) => ipcRenderer.invoke('shell:showItem', path) as Promise<{ ok?: boolean }>,
  exportZip: (items: { name: string; dataUrl: string }[], name: string) =>
    ipcRenderer.invoke('image:exportZip', { items, name }) as Promise<{ path?: string; count?: number; canceled?: boolean; error?: string }>,
  copyImage: (dataUrl: string) => ipcRenderer.invoke('clipboard:writeImage', dataUrl) as Promise<{ ok?: boolean; error?: string }>,
  detect: (opts: { image: string; description: string }) =>
    ipcRenderer.invoke('gemini:detect', opts) as Promise<{ box?: [number, number, number, number] | null; error?: string }>
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
