// MCP (Model Context Protocol) server — lets an AI agent drive the LIVE canvas.
//
// It runs INSIDE the app rather than as a separate process, because everything worth
// exposing (what's selected, where things sit, the generation pipeline with all its
// prompt engineering and magenta-keying) lives in the renderer. A standalone server
// would have to re-implement all of it against the project JSON and would immediately
// drift; instead every tool call is forwarded to the running renderer over IPC and
// executed by the SAME code paths the buttons use. Results therefore land on the canvas
// laid out exactly as if you had clicked Generate yourself.
//
// Transport is Streamable HTTP on 127.0.0.1 (MCP's current standard). We answer each
// POST with a single JSON response rather than an SSE stream — allowed by the spec, and
// there is nothing to push: every tool is request/response.
//
//   claude mcp add --transport http canvas-forge http://127.0.0.1:4830/mcp
//
// Disable with CANVAS_FORGE_MCP=0, move it with CANVAS_FORGE_MCP_PORT.

import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'

const DEFAULT_PORT = 4830
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = '2025-06-18'
const MAX_BODY = 64 * 1024 * 1024 // an add_image payload is base64 pixels; a screenshot is ~5 MB

// ---------------------------------------------------------------------------
// renderer RPC: main asks the window to do the thing, and waits for its answer
// ---------------------------------------------------------------------------

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
const pending = new Map<string, Pending>()

/** Result shape every renderer handler returns (see renderer/src/mcpBridge.ts). */
type BridgeResult = {
  text?: string
  json?: unknown
  images?: { dataUrl: string; label?: string }[]
}

function callRenderer(method: string, params: unknown, timeoutMs: number): Promise<BridgeResult> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.webContents.isDestroyed()) {
    return Promise.reject(new Error('The Canvas Forge window is not open.'))
  }
  const id = randomUUID()
  return new Promise<BridgeResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(
        new Error(
          `Canvas Forge did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`
        )
      )
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    win.webContents.send('mcp:call', { id, method, params })
  })
}

// ---------------------------------------------------------------------------
// tool catalogue
// ---------------------------------------------------------------------------

type Tool = {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  /** Generation tools call an image model N times — they need minutes, not seconds. */
  timeoutMs?: number
  readOnly?: boolean
}

const NODE_ID = {
  type: 'string',
  description: 'Id of the image to act on. Omit to use whatever is selected in the app right now.'
}
const REGION = {
  type: 'object',
  description:
    'Sub-region of that image, in its NATURAL PIXELS (origin = image top-left). Omit to use the region currently marked in the app, or the whole image when nothing is marked. Everything OUTSIDE the region is kept as-is, so mark only what should change.',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' }
  },
  required: ['x', 'y', 'w', 'h'],
  additionalProperties: false
}
const MODEL = {
  type: 'string',
  enum: ['gemini-3-pro-image', 'gemini-2.5-flash-image'],
  description:
    'gemini-3-pro-image = Best (Nano Banana Pro, the default). gemini-2.5-flash-image = Fast.'
}
const RUNS = {
  type: 'integer',
  minimum: 1,
  maximum: 10,
  description:
    'How many variations to produce (1-10, default 1). They are laid out in a row, clear of existing art.'
}
const WAIT = {
  type: 'boolean',
  description:
    'Wait for the results (default true). false returns a jobId immediately — poll it with job_status.'
}
const RETURN_IMAGES = {
  type: 'boolean',
  description:
    'Send the finished pixels back so you can look at them (default true, downscaled to 512px).'
}

const TOOLS: Tool[] = [
  {
    name: 'get_state',
    title: 'Read the canvas',
    readOnly: true,
    description:
      'What is on the canvas right now: the open project, the images (id, name, position, size, the prompt that made it), what is selected, and any generation still running. No pixels — call get_image for those. Start here. A project can hold hundreds of images, so the list is paged (50 at a time, canvas order) with prompts clipped; `imageCount` and `shown` tell you what you got. The selection is always returned in full under `selection.images`.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'How many images to list (default 50, max 200 — page with offset for more).'
        },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many, to page through a big canvas.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_image',
    title: 'See an image',
    readOnly: true,
    description:
      'Return the actual pixels of a canvas image so you can look at it. Defaults to the image selected in the app — this is how you "see what the user selected".',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: NODE_ID,
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Several images at once. Overrides nodeId. Use "selected" to mean the current selection.'
        },
        region: REGION,
        maxSize: {
          type: 'integer',
          description:
            'Longest edge in pixels (default 1024). Lower it when you only need to judge composition.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'select',
    title: 'Select on the canvas',
    description:
      'Move the app selection: pick image(s), and optionally mark a region inside one of them. What you select here is what the user sees highlighted, and what the other tools default to.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'Images to select.' },
        nodeId: NODE_ID,
        region: REGION,
        wholeFrame: {
          type: 'boolean',
          description: 'Mark the whole image edge-to-edge instead of a sub-region.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'add_image',
    title: 'Paste an image onto the canvas',
    description:
      'Drop an image you already have (a PNG/JPEG as base64 or a data URL) onto the canvas at natural resolution. Placed clear of existing art unless you give x/y. This is the paste side of copy-paste.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'data: URL or bare base64 PNG/JPEG/WebP.' },
        name: { type: 'string', description: 'Layer name shown in the Layers panel.' },
        x: { type: 'number', description: 'World x of the top-left corner. Omit to auto-place.' },
        y: { type: 'number', description: 'World y of the top-left corner. Omit to auto-place.' },
        select: { type: 'boolean', description: 'Select it after adding (default true).' }
      },
      required: ['image'],
      additionalProperties: false
    }
  },
  {
    name: 'copy_image',
    title: 'Copy an image to the OS clipboard',
    description:
      'Put a canvas image on the system clipboard (with alpha), ready to paste into Figma, Photoshop, Slack — anywhere. Defaults to the selection.',
    inputSchema: {
      type: 'object',
      properties: { nodeId: NODE_ID },
      additionalProperties: false
    }
  },
  {
    name: 'duplicate',
    title: 'Duplicate images',
    description:
      'Copy image(s) on the canvas, offset next to the originals. Defaults to the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' } },
        nodeId: NODE_ID
      },
      additionalProperties: false
    }
  },
  {
    name: 'delete_images',
    title: 'Delete images from the canvas',
    description:
      "Remove image(s) from the canvas. Undoable in the app with Cmd+Z. Deletes the selection when you pass nothing, so say which ids you mean unless you're certain.",
    inputSchema: {
      type: 'object',
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'Ids to remove.' },
        nodeId: NODE_ID
      },
      additionalProperties: false
    }
  },
  {
    name: 'generate',
    title: 'Generate / edit on the canvas',
    timeoutMs: 12 * 60_000,
    description:
      "The main tool: regenerate an image with your change applied, exactly like the app's Generate button. The model redraws the WHOLE image but only the marked region changes, so the result is seamless and stays on-style. Results are placed to the right of the source, clear of everything else, and become real canvas images. Ask for several runs to explore variations, or give one prompt per run to explore different ideas at once.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to change about the marked region, e.g. "make the ring silver".'
        },
        prompts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'One prompt per run — explore several different ideas in one batch. Overrides prompt/runs.'
        },
        nodeId: NODE_ID,
        region: REGION,
        references: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Up to 4 visual guides for the new content: data URLs, bare base64, or "node:<id>" to reuse a canvas image. The model borrows their look, never their content.'
        },
        runs: RUNS,
        model: MODEL,
        wait: WAIT,
        returnImages: RETURN_IMAGES
      },
      required: ['prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'extract',
    title: 'Cut an element out',
    timeoutMs: 12 * 60_000,
    description:
      'Isolate one element as a transparent, text-free cutout ("isolate"), or throw the foreground away and reconstruct the scene behind it ("background"). Name the element in the prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Which element, e.g. "the gold ring". Omit for the main foreground element.'
        },
        nodeId: NODE_ID,
        region: REGION,
        mode: {
          type: 'string',
          enum: ['isolate', 'background'],
          description:
            'isolate (default) = keep only that element, transparent. background = keep only the scene behind.'
        },
        runs: RUNS,
        model: MODEL,
        wait: WAIT,
        returnImages: RETURN_IMAGES
      },
      additionalProperties: false
    }
  },
  {
    name: 'remove_background',
    title: 'Remove a background',
    timeoutMs: 12 * 60_000,
    description:
      'Cut everything behind the subject to transparency, keeping its pixels, framing and resolution exactly. mechanical = instant flood-fill, perfect for flat backgrounds. ai = the model handles complex ones. precise = a local matting network with soft edges (one-time 224 MB download).',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: NODE_ID,
        mode: {
          type: 'string',
          enum: ['mechanical', 'ai', 'precise'],
          description: 'Default mechanical.'
        },
        wait: WAIT,
        returnImages: RETURN_IMAGES
      },
      additionalProperties: false
    }
  },
  {
    name: 'restyle',
    title: 'Restyle with a built-in style guide',
    timeoutMs: 12 * 60_000,
    description:
      'Re-render a WHOLE image in one of the bundled art directions, keeping its layout and composition. The guide supplies its own reference art and prompt — call list_style_guides first for the ids.',
    inputSchema: {
      type: 'object',
      properties: {
        guideId: { type: 'string', description: 'From list_style_guides.' },
        nodeId: NODE_ID,
        materials: {
          type: 'array',
          items: { type: 'string' },
          description: "Which of the guide's materials to apply. Omit for all of them."
        },
        prompt: { type: 'string', description: 'Extra instruction layered on top of the guide.' },
        runs: RUNS,
        model: MODEL,
        wait: WAIT,
        returnImages: RETURN_IMAGES
      },
      required: ['guideId'],
      additionalProperties: false
    }
  },
  {
    name: 'list_style_guides',
    title: 'List style guides',
    readOnly: true,
    description:
      'The built-in art directions available to restyle, with their ids, materials and descriptions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'job_status',
    title: 'Check a generation job',
    readOnly: true,
    timeoutMs: 12 * 60_000,
    description: 'Where a job from wait:false got to. Set wait:true to block until it finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        wait: { type: 'boolean', description: 'Block until the job finishes (default false).' },
        returnImages: RETURN_IMAGES
      },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'list_projects',
    title: 'List projects',
    readOnly: true,
    description: 'Every project in the sidebar, and which one is open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'open_project',
    title: 'Open a project',
    description:
      'Switch the app to another project. Match by id, or by name if you only know that.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        name: { type: 'string', description: 'Case-insensitive; must match exactly one project.' }
      },
      additionalProperties: false
    }
  }
]

const INSTRUCTIONS = [
  'Canvas Forge is a running desktop app for generating and editing game-UI artwork on an infinite canvas.',
  'These tools drive that live window: what you change, the user watches happen.',
  '',
  'Call get_state first — it tells you what is open, what exists and what the user has selected.',
  'get_image shows you the actual pixels (defaults to the selection, so "look at what I selected" just works).',
  'generate / extract / remove_background / restyle create REAL images on the canvas, positioned automatically',
  "clear of existing art, using the same pipeline as the app's own buttons.",
  '',
  'Most tools default to the current selection, so the user pointing at something in the app IS the argument.',
  'Generation takes ~20-60s per run and returns the results for you to judge; iterate from there.'
].join('\n')

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

type RpcId = string | number | null
type RpcMessage = {
  jsonrpc?: string
  id?: RpcId
  method?: string
  params?: Record<string, unknown>
}

type RpcReply = {
  jsonrpc: string
  id: RpcId
  result?: unknown
  error?: { code: number; message: string }
}
const ok = (id: RpcId, result: unknown): RpcReply => ({ jsonrpc: '2.0', id, result })
const fail = (id: RpcId, code: number, message: string): RpcReply => ({
  jsonrpc: '2.0',
  id,
  error: { code, message }
})

function toContent(r: BridgeResult): unknown[] {
  const content: unknown[] = []
  if (r.text) content.push({ type: 'text', text: r.text })
  if (r.json !== undefined) content.push({ type: 'text', text: JSON.stringify(r.json, null, 2) })
  for (const img of r.images ?? []) {
    const m = img.dataUrl.match(/^data:([^;]+);base64,([\s\S]*)$/)
    if (!m) continue
    if (img.label) content.push({ type: 'text', text: img.label })
    content.push({ type: 'image', data: m[2], mimeType: m[1] })
  }
  if (!content.length) content.push({ type: 'text', text: 'Done.' })
  return content
}

async function handleMessage(msg: RpcMessage): Promise<unknown | null> {
  const id = msg.id ?? null
  const isRequest = msg.id !== undefined && msg.id !== null
  const method = msg.method

  // Notifications (notifications/initialized, notifications/cancelled, …) get no reply.
  if (!isRequest) return null

  switch (method) {
    case 'initialize': {
      const asked = String((msg.params?.protocolVersion as string) ?? '')
      // Remember who connected, so the in-app panel can answer "is my agent actually attached?"
      // rather than only "is the port open?" — the two look identical from the outside.
      const who = msg.params?.clientInfo as { name?: string; version?: string } | undefined
      noteClient(who?.name ? String(who.name) : 'unknown client')
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'canvas-forge', title: 'Canvas Forge', version: app.getVersion() },
        instructions: INSTRUCTIONS
      })
    }
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: !!t.readOnly, openWorldHint: false }
        }))
      })
    // We don't advertise these capabilities, but clients probe anyway — an empty list
    // is friendlier than "method not found" showing up in their logs.
    case 'resources/list':
      return ok(id, { resources: [] })
    case 'resources/templates/list':
      return ok(id, { resourceTemplates: [] })
    case 'prompts/list':
      return ok(id, { prompts: [] })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return fail(id, -32602, `Unknown tool: ${name}`)
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {}
      noteCall()
      try {
        const r = await callRenderer(tool.name, args, tool.timeoutMs ?? 60_000)
        return ok(id, { content: toContent(r) })
      } catch (e) {
        // Tool failures are results, not protocol errors — the model should see and react to them.
        return ok(id, {
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
          isError: true
        })
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`)
  }
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

let server: Server | null = null
let boundPort: number | null = null
let lastError: string | null = null
const sessions = new Set<string>()

// Who has connected, most recent first. Fed by `initialize`; a client that restarts simply
// refreshes its own entry rather than adding a second one.
type ClientRec = { name: string; at: number; calls: number }
const clients: ClientRec[] = []
let lastCallAt = 0

function noteClient(name: string): void {
  const existing = clients.find((c) => c.name === name)
  if (existing) {
    existing.at = Date.now()
    existing.calls = 0 // fresh connection ⇒ fresh count
    clients.sort((a, b) => b.at - a.at)
    return
  }
  clients.unshift({ name, at: Date.now(), calls: 0 })
  if (clients.length > 6) clients.length = 6
}

function noteCall(): void {
  lastCallAt = Date.now()
  if (clients[0]) clients[0].calls++
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {}
): void {
  if (body === undefined) {
    res.writeHead(status, headers)
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('request too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// DNS-rebinding guard: a browser page can't send application/json cross-origin without a
// preflight (which we never approve), but validating Origin is cheap and is what the spec asks
// for. Real MCP clients send no Origin header at all.
function originAllowed(req: IncomingMessage): boolean {
  const o = req.headers.origin
  if (!o) return true
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(o))
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url || '/').split('?')[0]

  if (!originAllowed(req)) {
    send(res, 403, { error: 'origin not allowed' })
    return
  }

  if (path === '/health' && req.method === 'GET') {
    const win = BrowserWindow.getAllWindows()[0]
    send(res, 200, {
      ok: true,
      app: 'canvas-forge',
      version: app.getVersion(),
      windowOpen: !!win && !win.webContents.isDestroyed()
    })
    return
  }

  if (path !== '/mcp') {
    send(res, 404, { error: 'not found — the MCP endpoint is /mcp' })
    return
  }

  // No server-initiated messages, so there is nothing to stream on GET.
  if (req.method === 'GET') {
    send(res, 405, undefined, { allow: 'POST, DELETE' })
    return
  }
  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id']
    if (typeof sid === 'string') sessions.delete(sid)
    send(res, 204)
    return
  }
  if (req.method !== 'POST') {
    send(res, 405, undefined, { allow: 'POST, DELETE' })
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readBody(req))
  } catch {
    send(res, 400, fail(null, -32700, 'Parse error'))
    return
  }

  const batch = Array.isArray(parsed)
  const messages = (batch ? parsed : [parsed]) as RpcMessage[]
  const isInit = messages.some((m) => m.method === 'initialize')

  const replies: unknown[] = []
  for (const m of messages) {
    try {
      const r = await handleMessage(m)
      if (r) replies.push(r)
    } catch (e) {
      replies.push(fail(m.id ?? null, -32603, e instanceof Error ? e.message : String(e)))
    }
  }

  const headers: Record<string, string> = {}
  if (isInit) {
    const sid = randomUUID()
    sessions.add(sid)
    headers['mcp-session-id'] = sid
  }

  // All-notifications payload → nothing to answer with.
  if (!replies.length) {
    send(res, 202, undefined, headers)
    return
  }
  send(res, 200, batch ? replies : replies[0], headers)
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

function infoPath(): string {
  return join(app.getPath('userData'), 'mcp.json')
}

export type McpInfo = {
  enabled: boolean
  port: number | null
  url: string | null
  error: string | null
  toolCount: number
  toolNames: string[]
  lastCallAt: number | null
  clients: { name: string; at: number; calls: number }[]
}

export function mcpInfo(): McpInfo {
  return {
    enabled: process.env.CANVAS_FORGE_MCP !== '0',
    port: boundPort,
    url: boundPort ? `http://127.0.0.1:${boundPort}/mcp` : null,
    error: lastError,
    toolCount: TOOLS.length,
    toolNames: TOOLS.map((t) => t.name),
    lastCallAt: lastCallAt || null,
    clients: clients.map((c) => ({ ...c }))
  }
}

export function registerMcpIpc(): void {
  ipcMain.on('mcp:result', (_e, msg: { id: string; data?: BridgeResult; error?: string }) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.data ?? {})
  })
  ipcMain.handle('mcp:info', () => mcpInfo())
}

export function startMcpServer(): void {
  if (process.env.CANVAS_FORGE_MCP === '0') return
  const port = Number(process.env.CANVAS_FORGE_MCP_PORT) || DEFAULT_PORT

  const s = createServer((req, res) => {
    void onRequest(req, res).catch((e) => {
      try {
        send(res, 500, fail(null, -32603, e instanceof Error ? e.message : String(e)))
      } catch {
        /* response already gone */
      }
    })
  })
  s.on('error', (e: NodeJS.ErrnoException) => {
    lastError =
      e.code === 'EADDRINUSE'
        ? `Port ${port} is already in use — set CANVAS_FORGE_MCP_PORT to a free port.`
        : e.message
    console.error('[mcp]', lastError)
    server = null
    boundPort = null
  })
  s.listen(port, '127.0.0.1', () => {
    server = s
    boundPort = port
    lastError = null
    console.log(`[mcp] Canvas Forge MCP server on http://127.0.0.1:${port}/mcp`)
    try {
      writeFileSync(
        infoPath(),
        JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, port, pid: process.pid })
      )
    } catch {
      /* discovery file is a convenience, not a requirement */
    }
  })
}

export function stopMcpServer(): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error('Canvas Forge is shutting down.'))
  }
  pending.clear()
  server?.close()
  server = null
  boundPort = null
  try {
    if (existsSync(infoPath())) unlinkSync(infoPath())
  } catch {
    /* best effort */
  }
}
