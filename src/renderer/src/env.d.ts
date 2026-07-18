/// <reference types="vite/client" />

import type { Project } from './types'

// Bundled style-guide reference art, inlined as a base64 data URL at build time.
declare module '*.png?inline' {
  const src: string
  export default src
}

declare global {
  interface Window {
    api: {
      gemini: (opts: { prompt: string; images: string[]; model: string; aspectRatio?: string }) => Promise<{ image?: string; error?: string }>
      loadProjects: () => Promise<Project[]>
      saveProject: (p: Project) => Promise<unknown>
      deleteProject: (id: string) => Promise<unknown>
      loadProjectOrder: () => Promise<string[]>
      saveProjectOrder: (ids: string[]) => Promise<unknown>
      loadPrompts: () => Promise<string[]>
      addPrompt: (p: string) => Promise<string[]>
      getSettings: () => Promise<{ geminiKey?: string; hasKey: boolean }>
      setKey: (key: string) => Promise<{ hasKey: boolean }>
      exportProject: (p: Project) => Promise<{ path?: string; canceled?: boolean }>
      importProject: () => Promise<{ project?: Project; canceled?: boolean; error?: string }>
      savePng: (dataUrl: string, name: string) => Promise<{ path?: string; canceled?: boolean; error?: string }>
      revealItem: (path: string) => Promise<{ ok?: boolean }>
      exportZip: (items: { name: string; dataUrl: string }[], name: string) => Promise<{ path?: string; count?: number; canceled?: boolean; error?: string }>
      copyImage: (dataUrl: string) => Promise<{ ok?: boolean; error?: string }>
      detect: (opts: { image: string; description: string }) => Promise<{ box?: [number, number, number, number] | null; error?: string }>
      matteStatus: (id: string) => Promise<{ ready: boolean; size: number }>
      matteEnsure: (id: string) => Promise<{ ok: boolean; error?: string }>
      matteRun: (id: string, rgba: Uint8Array) => Promise<{ alpha?: Float32Array; error?: string }>
      onMatteProgress: (cb: (p: { id: string; progress: number }) => void) => () => void
    }
  }
}

export {}
