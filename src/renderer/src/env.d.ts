/// <reference types="vite/client" />

import type { Project } from './types'

declare global {
  interface Window {
    api: {
      gemini: (opts: { prompt: string; images: string[]; model: string }) => Promise<{ image?: string; error?: string }>
      loadProjects: () => Promise<Project[]>
      saveProject: (p: Project) => Promise<unknown>
      deleteProject: (id: string) => Promise<unknown>
      loadPrompts: () => Promise<string[]>
      addPrompt: (p: string) => Promise<string[]>
      getSettings: () => Promise<{ geminiKey?: string; hasKey: boolean }>
      setKey: (key: string) => Promise<{ hasKey: boolean }>
      exportProject: (p: Project) => Promise<{ path?: string; canceled?: boolean }>
      importProject: () => Promise<{ project?: Project; canceled?: boolean; error?: string }>
      savePng: (dataUrl: string, name: string) => Promise<{ path?: string; canceled?: boolean; error?: string }>
      revealItem: (path: string) => Promise<{ ok?: boolean }>
      copyImage: (dataUrl: string) => Promise<{ ok?: boolean; error?: string }>
      detect: (opts: { image: string; description: string }) => Promise<{ box?: [number, number, number, number] | null; error?: string }>
    }
  }
}

export {}
