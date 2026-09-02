// Renderer half of the MCP bridge (see main/mcp.ts for the server and the reasoning).
//
// The main process owns the protocol; this file owns the DOING. Components register
// handlers for the tool names they can service — Canvas registers the canvas ones,
// Studio the project ones — and they close over live refs, so a tool call always acts
// on what is on screen at that moment rather than on a stale snapshot.

import type { ImageNode } from './types'
import { resolvePixels } from './pixels'

/** What a handler returns; main turns this into MCP content blocks. */
export type BridgeResult = {
  text?: string
  json?: unknown
  images?: { dataUrl: string; label?: string }[]
}
export type BridgeHandler = (
  params: Record<string, unknown>
) => Promise<BridgeResult> | BridgeResult

const handlers = new Map<string, BridgeHandler>()

/** Register a batch of handlers; returns an unregister fn (only removes ones still ours). */
export function registerBridge(map: Record<string, BridgeHandler>): () => void {
  for (const [name, fn] of Object.entries(map)) handlers.set(name, fn)
  return () => {
    for (const [name, fn] of Object.entries(map))
      if (handlers.get(name) === fn) handlers.delete(name)
  }
}

// ---- which project's canvas is actually live -------------------------------
// Switching project is a React state change: setCurrentId returns immediately, but the Canvas
// for the new project only remounts (and re-registers its handlers) a tick later. So a naive
// open_project would return while the OLD canvas was still answering, and the very next
// get_state would describe the project you just navigated away from. Canvas announces itself
// here as it registers, and open_project waits for that announcement.

let activeProjectId: string | null = null
const waiters: (() => void)[] = []

export function setActiveProject(id: string): void {
  activeProjectId = id
  for (const notify of [...waiters]) notify()
}

export function awaitProject(id: string, timeoutMs = 5000): Promise<boolean> {
  if (activeProjectId === id) return Promise.resolve(true)
  return new Promise((resolve) => {
    const drop = (): void => {
      const i = waiters.indexOf(check)
      if (i >= 0) waiters.splice(i, 1)
    }
    const timer = setTimeout(() => {
      drop()
      resolve(false)
    }, timeoutMs)
    function check(): void {
      if (activeProjectId !== id) return
      clearTimeout(timer)
      drop()
      resolve(true)
    }
    waiters.push(check)
  })
}

// ---- generation jobs -------------------------------------------------------
// Generation is DETACHED in this app (fire a job, keep using the canvas), so an agent
// that doesn't want to block gets a jobId back and polls it. The record outlives the
// Canvas remount that a project switch causes, hence module scope.

export type JobRecord = {
  id: string
  kind: string
  prompt: string
  status: 'running' | 'done' | 'failed'
  nodeIds: string[]
  errors: string[]
  startedAt: number
  finishedAt?: number
  /** Resolved when the job settles — lets job_status(wait:true) block without polling. */
  done: Promise<void>
  settle: () => void
}

const jobs = new Map<string, JobRecord>()

export function startJob(id: string, kind: string, prompt: string): JobRecord {
  let settle: () => void = () => {}
  const done = new Promise<void>((r) => (settle = r))
  const rec: JobRecord = {
    id,
    kind,
    prompt,
    status: 'running',
    nodeIds: [],
    errors: [],
    startedAt: Date.now(),
    done,
    settle
  }
  jobs.set(id, rec)
  // Keep the map from growing forever across a long session.
  if (jobs.size > 60) {
    const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0]
    if (oldest && oldest.status !== 'running') jobs.delete(oldest.id)
  }
  return rec
}

export function finishJob(id: string, r: { ids: string[]; errors: string[] }): void {
  const rec = jobs.get(id)
  if (!rec) return
  rec.nodeIds = r.ids
  rec.errors = r.errors
  rec.status = r.ids.length ? 'done' : 'failed'
  rec.finishedAt = Date.now()
  rec.settle()
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id)
}

// ---- shared shapes ---------------------------------------------------------

/**
 * The summary of a canvas image an agent sees — everything but the pixels.
 * `promptChars > 0` clips the originating prompt: a batch generated from one long
 * restyle prompt repeats that ~800-char string on every node, which is what makes a
 * whole-canvas listing enormous. 0 keeps it whole (single-image and job replies).
 */
export function describeNode(
  n: ImageNode,
  selected: boolean,
  promptChars = 0
): Record<string, unknown> {
  const raw = n.prompt ?? undefined
  const prompt =
    raw && promptChars > 0 && raw.length > promptChars ? raw.slice(0, promptChars - 1) + '…' : raw
  return {
    id: n.id,
    name: n.name ?? null,
    x: Math.round(n.x),
    y: Math.round(n.y),
    w: Math.round(n.w),
    h: Math.round(n.h),
    pixels: `${n.nW}x${n.nH}`,
    transparent: n.transparent || undefined,
    hidden: n.hidden || undefined,
    selected: selected || undefined,
    prompt,
    model: n.model ?? undefined,
    createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : undefined
  }
}

/** An image argument — a data URL, a bare base64 blob, or "node:<id>" — as a
 *  data URL. A canvas node's pixels live on disk, so this is async. */
export async function resolveImageArg(
  v: string,
  lookup?: (id: string) => ImageNode | null
): Promise<string> {
  const s = v.trim()
  if (s.startsWith('node:')) {
    const n = lookup?.(s.slice(5).trim())
    if (!n) throw new Error(`No canvas image with id "${s.slice(5).trim()}".`)
    return resolvePixels(n)
  }
  return toDataUrl(s)
}

/** Accept a data URL or a bare base64 blob and hand back a data URL. */
export function toDataUrl(v: string): string {
  const s = v.trim()
  if (s.startsWith('data:')) return s
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s) || s.length < 32) {
    throw new Error('Expected a data: URL, bare base64 image data, or "node:<id>".')
  }
  const clean = s.replace(/\s+/g, '')
  // Sniff the format from the first bytes so the data URL's mime type is honest.
  const mime = clean.startsWith('iVBORw0KGgo')
    ? 'image/png'
    : clean.startsWith('/9j/')
      ? 'image/jpeg'
      : clean.startsWith('UklGR')
        ? 'image/webp'
        : clean.startsWith('R0lGOD')
          ? 'image/gif'
          : 'image/png'
  return `data:${mime};base64,${clean}`
}

// ---- transport -------------------------------------------------------------

let wired = false

/** Wire the IPC channel once, for the lifetime of the window. */
export function startBridge(): void {
  if (wired) return
  wired = true
  window.api.onMcpCall(async ({ id, method, params }) => {
    const fn = handlers.get(method)
    if (!fn) {
      // Almost always "the Canvas isn't mounted yet" rather than a genuinely unknown tool.
      window.api.mcpResult(id, {
        error: `Canvas Forge can't handle "${method}" right now — no project is open.`
      })
      return
    }
    try {
      const data = await fn((params as Record<string, unknown>) ?? {})
      window.api.mcpResult(id, { data })
    } catch (e) {
      window.api.mcpResult(id, { error: e instanceof Error ? e.message : String(e) })
    }
  })
}
