/// <reference types="vite/client" />

import type { Project, ProjectSummary } from './types'

// Bundled style-guide reference art, inlined as a base64 data URL at build time.
declare module '*.png?inline' {
  const src: string
  export default src
}

declare global {
  interface Window {
    api: {
      gemini: (opts: { prompt: string; images: string[]; model: string; aspectRatio?: string }) => Promise<{ image?: string; error?: string }>
      variants: (opts: { image: string; prompt: string; count: number }) => Promise<{
        variants?: { label: string; prompt: string }[]
        note?: string
        error?: string
      }>
      loadProjects: () => Promise<ProjectSummary[]>
      loadProject: (id: string) => Promise<Project | null>
      saveProject: (p: Project) => Promise<{ rewritten: Record<string, string> }>
      onProjectMigrating: (cb: (p: { id: string; done: number; total: number }) => void) => () => void
      patchProjectMeta: (id: string, patch: { name?: string; updatedAt?: number; cover?: string }) => Promise<ProjectSummary | null>
      deleteProject: (id: string) => Promise<unknown>
      loadProjectOrder: () => Promise<string[]>
      saveProjectOrder: (ids: string[]) => Promise<unknown>
      loadPrompts: () => Promise<string[]>
      addPrompt: (p: string) => Promise<string[]>
      getSettings: () => Promise<{ geminiKey?: string; hasKey: boolean }>
      setKey: (key: string) => Promise<{ hasKey: boolean }>
      exportProject: (p: Project) => Promise<{ path?: string; canceled?: boolean; error?: string }>
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
      // MCP bridge (see main/mcp.ts + mcpBridge.ts)
      onMcpCall: (cb: (msg: { id: string; method: string; params: unknown }) => void) => () => void
      mcpResult: (id: string, payload: { data?: unknown; error?: string }) => void
      mcpInfo: () => Promise<{
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
  }
}

export {}
