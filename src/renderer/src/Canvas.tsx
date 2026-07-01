
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageNode, Project } from './types'
import { clamp, uid } from './util'
import { addPrompt, loadPrompts } from './store'
import { imageEdit, imageExtract, imageExtractBackground, imageRemoveBg } from './imageOps'

type View = { x: number; y: number; zoom: number }
type Tool = 'move' | 'rect' | 'draw' | 'magic'
/** How the Extract button cuts: isolate the named element, or keep only the background. */
type ExtractMode = 'isolate' | 'background'
type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Pt = { x: number; y: number }
type Rect = { x: number; y: number; w: number; h: number }
/** A region selection tied to one image, in world coords. `stroke` set ⇒ brush draw. */
type Sel = { imgId: string; x: number; y: number; w: number; h: number; stroke?: Pt[]; brush?: number }
/** An in-flight generation slot (loading placeholder), in world coords. */
type PendingSlot = { id: string; jobId: string; label: string; x: number; y: number; w: number; h: number }

type Drag =
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'move'; ids: string[]; starts: { id: string; x: number; y: number }[]; sx: number; sy: number; pushed: boolean }
  | {
      kind: 'resize'
      id: string
      corner: Corner
      ix: number
      iy: number
      iw: number
      ih: number
      aspect: number
      pushed: boolean
    }
  | { kind: 'rect'; id: string; sx: number; sy: number }
  | { kind: 'draw'; id: string; lastSx: number; lastSy: number }
  | { kind: 'band'; sx: number; sy: number; additive: boolean; toggleId?: string }
  | { kind: 'refrect'; id: string; sx: number; sy: number }
  | { kind: 'selresize'; id: string; corner: Corner; ax: number; ay: number }
  | { kind: 'slotmove'; id: string; sx: number; sy: number; ox: number; oy: number }

const MIN_ZOOM = 0.05
const MAX_ZOOM = 8

// Clipboard + undo history live at MODULE scope so they SURVIVE switching projects.
// The Canvas is keyed by project.id and remounts per project, but a cut must stay on
// the clipboard (to paste into another project) and each project's undo stack must
// persist (so you can switch back and Cmd+Z the cut). Keyed by project id for undo.
const clipboardStore: { nodes: ImageNode[] } = { nodes: [] }
const undoStore = new Map<string, ImageNode[][]>()

// crop a region (natural px) of a node's image to a PNG data URL (for references)
function cropNodeRegion(src: string, bx: number, by: number, bw: number, bh: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = Math.max(1, bw)
      c.height = Math.max(1, bh)
      const ctx = c.getContext('2d')
      if (!ctx) return reject(new Error('no ctx'))
      ctx.drawImage(img, bx, by, bw, bh, 0, 0, bw, bh)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('load failed'))
    img.src = src
  })
}

export default function Canvas({
  project,
  onImagesChange,
}: {
  project: Project
  onImagesChange: (images: ImageNode[]) => void
}) {
  const [nodes, setNodes] = useState<ImageNode[]>(project.images)
  const nodesRef = useRef<ImageNode[]>(project.images)

  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 })
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])

  const [tool, setTool] = useState<Tool>('move')
  const toolRef = useRef(tool)
  useEffect(() => {
    toolRef.current = tool
  }, [tool])

  // multi-selection of image nodes (for move / delete as a group)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedIdsRef = useRef<string[]>([])
  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])
  // close the prompt-details popover whenever the selection changes
  useEffect(() => {
    setDetailOpen(false)
    setCopied(false)
  }, [selectedIds])
  // rubber-band group-select rectangle (world coords)
  const [band, setBand] = useState<Rect | null>(null)
  const bandRef = useRef<Rect | null>(null)
  const setBandSync = useCallback((b: Rect | null) => {
    bandRef.current = b
    setBand(b)
  }, [])

  // reference crops (visual guides for Generate) + "pick a reference" mode
  const [references, setReferences] = useState<{ id: string; src: string }[]>([])
  const [refPick, setRefPick] = useState(false)
  const refPickRef = useRef(false)
  useEffect(() => {
    refPickRef.current = refPick
  }, [refPick])
  const [refMarquee, setRefMarquee] = useState<Sel | null>(null)
  const refMarqueeRef = useRef<Sel | null>(null)
  const setRefMarq = useCallback((s: Sel | null) => {
    refMarqueeRef.current = s
    setRefMarquee(s)
  }, [])
  const addReferenceFromRegion = useCallback((m: Sel) => {
    const node = nodesRef.current.find((n) => n.id === m.imgId)
    if (!node) return
    const rx = node.nW / node.w
    const ry = node.nH / node.h
    const bx = Math.round((m.x - node.x) * rx)
    const by = Math.round((m.y - node.y) * ry)
    const bw = Math.max(1, Math.round(m.w * rx))
    const bh = Math.max(1, Math.round(m.h * ry))
    cropNodeRegion(node.src, bx, by, bw, bh).then((src) => setReferences((prev) => [...prev, { id: uid(), src }].slice(-4)))
  }, [])

  const [marquee, setMarquee] = useState<Sel | null>(null)
  const marqueeRef = useRef<Sel | null>(null)
  const [stroke, setStroke] = useState<Pt[] | null>(null)
  const strokeRef = useRef<Pt[] | null>(null)
  const [selection, setSelection] = useState<Sel | null>(null)
  const [promptText, setPromptText] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [model, setModel] = useState('gemini-3-pro-image')
  const [count, setCount] = useState(1)
  const [extractMode, setExtractMode] = useState<ExtractMode>('isolate') // what the Extract button does
  const [showHistory, setShowHistory] = useState(false) // recent-prompt chips collapsed by default
  // animated placeholder slots shown while variations generate — MANY jobs at once,
  // each slot tagged with its jobId so concurrent extractions/generations don't clobber.
  // A slot is the SOURCE OF TRUTH for where its result lands: it is placed clear of
  // existing images, is draggable, and the finished node appears at the slot's position.
  const [pending, setPending] = useState<PendingSlot[]>([])
  // mirror of `pending` kept in sync synchronously, so placement/drag/worker read live positions
  const pendingRef = useRef<PendingSlot[]>([])
  const updatePending = useCallback((fn: (p: PendingSlot[]) => PendingSlot[]) => {
    pendingRef.current = fn(pendingRef.current)
    setPending(pendingRef.current)
  }, [])
  // ids of freshly-added nodes that should play the reveal animation
  const [revealIds, setRevealIds] = useState<string[]>([])
  // prompt-details popover for a selected generated image
  const [detailOpen, setDetailOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [brushScreen, setBrushScreen] = useState(28)
  const brushRef = useRef(28)
  useEffect(() => {
    brushRef.current = brushScreen
  }, [brushScreen])
  const [hover, setHover] = useState<Pt | null>(null)
  const [copyToast, setCopyToast] = useState<string | null>(null)
  // path of the last-saved PNG → drives the "Saved · Reveal in Finder" toast
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // magic select: describe an element → Gemini returns a tight bounding box
  const [magic, setMagic] = useState<{ imgId: string; x: number; y: number } | null>(null)
  const [magicText, setMagicText] = useState('')
  const [magicBusy, setMagicBusy] = useState(false)
  const [magicErr, setMagicErr] = useState<string | null>(null)

  const [spaceMode, setSpaceMode] = useState(false)
  const [panning, setPanning] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [vp, setVp] = useState({ w: 0, h: 0 })

  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const spaceDownRef = useRef(false)
  // undo history for THIS project, restored from the module store so it survives remounts
  const undoRef = useRef<ImageNode[][]>(undoStore.get(project.id) ?? [])
  // one AbortController per in-flight job (keyed by jobId) so a job can be cancelled
  // from its own placeholder without touching the other jobs running alongside it.
  const jobAborts = useRef<Map<string, AbortController>>(new Map())
  const pasteCountRef = useRef(0) // cascade offset for repeated pastes
  const mouseClientRef = useRef<{ x: number; y: number } | null>(null) // last cursor pos → paste-at-cursor

  useEffect(() => {
    loadPrompts().then(setHistory)
  }, [])

  // ---- node helpers (stable; read refs) ----
  const apply = useCallback(
    (next: ImageNode[]) => {
      nodesRef.current = next
      setNodes(next)
      onImagesChange(next)
    },
    [onImagesChange]
  )
  const nodeById = useCallback((id: string | null) => (id ? nodesRef.current.find((n) => n.id === id) || null : null), [])
  const updateNode = useCallback(
    (id: string, patch: Partial<ImageNode>) => {
      const next = nodesRef.current.map((n) => (n.id === id ? { ...n, ...patch } : n))
      nodesRef.current = next
      setNodes(next)
      onImagesChange(next)
    },
    [onImagesChange]
  )
  const pushHistory = useCallback(() => {
    undoRef.current.push(nodesRef.current)
    if (undoRef.current.length > 60) undoRef.current.shift()
    undoStore.set(project.id, undoRef.current) // persist across project switches
  }, [project.id])
  const undo = useCallback(() => {
    const prev = undoRef.current.pop()
    if (prev) apply(prev)
    undoStore.set(project.id, undoRef.current)
  }, [apply, project.id])

  const setMarq = useCallback((s: Sel | null) => {
    marqueeRef.current = s
    setMarquee(s)
  }, [])
  const setStrokePts = useCallback((p: Pt[] | null) => {
    strokeRef.current = p
    setStroke(p)
  }, [])
  const clearSelection = useCallback(() => {
    setSelection(null)
    setMarq(null)
    setStrokePts(null)
    setReferences([])
    setRefPick(false)
    setRefMarq(null)
  }, [setMarq, setStrokePts, setRefMarq])

  // ---- transforms (stable) ----
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const r = viewportRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
  }, [])
  const clampToNode = useCallback((id: string, p: Pt): Pt => {
    const n = nodesRef.current.find((x) => x.id === id)
    if (!n) return p
    return { x: clamp(p.x, n.x, n.x + n.w), y: clamp(p.y, n.y, n.y + n.h) }
  }, [])
  const w2s = (wx: number, wy: number) => ({ x: wx * view.zoom + view.x, y: wy * view.zoom + view.y })

  // ---- viewport size ----
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const update = () => setVp({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- add image at NATURAL resolution (no quality loss); frame the first one ----
  const addImage = useCallback(
    (src: string, atClient?: { x: number; y: number }) => {
      const img = new window.Image()
      img.onload = () => {
        const nW = img.naturalWidth
        const nH = img.naturalHeight
        const el = viewportRef.current
        if (!el || !nW || !nH) return
        const r = el.getBoundingClientRect()
        const v = viewRef.current
        const wasEmpty = nodesRef.current.length === 0
        const w = nW
        const h = nH
        const sx = atClient ? atClient.x - r.left : r.width / 2
        const sy = atClient ? atClient.y - r.top : r.height / 2
        const wx = (sx - v.x) / v.zoom
        const wy = (sy - v.y) / v.zoom
        const node: ImageNode = { id: uid(), src, x: wx - w / 2, y: wy - h / 2, w, h, nW, nH }
        pushHistory()
        apply([...nodesRef.current, node])
        setSelectedIds([node.id])
        if (wasEmpty) {
          const z = clamp(Math.min((r.width - 80) / w, (r.height - 80) / h, 1), MIN_ZOOM, MAX_ZOOM)
          setView({ x: r.width / 2 - (node.x + w / 2) * z, y: r.height / 2 - (node.y + h / 2) * z, zoom: z })
        }
      }
      img.src = src
    },
    [apply, pushHistory]
  )
  const fileToImage = useCallback(
    (file: File, atClient?: { x: number; y: number }) => {
      const reader = new FileReader()
      reader.onload = () => addImage(String(reader.result), atClient)
      reader.readAsDataURL(file)
    },
    [addImage]
  )

  // duplicate / paste node copies (keeps src + prompt metadata), selected on arrival.
  // `world` set → drop the group centered at that point (paste-at-cursor); else cascade-offset.
  const pasteNodes = useCallback(
    (sources: ImageNode[], world?: Pt | null) => {
      if (!sources.length) return
      pushHistory()
      let dx: number
      let dy: number
      if (world) {
        const minX = Math.min(...sources.map((n) => n.x))
        const minY = Math.min(...sources.map((n) => n.y))
        const maxX = Math.max(...sources.map((n) => n.x + n.w))
        const maxY = Math.max(...sources.map((n) => n.y + n.h))
        dx = world.x - (minX + maxX) / 2
        dy = world.y - (minY + maxY) / 2
      } else {
        pasteCountRef.current += 1
        dx = dy = (40 / viewRef.current.zoom) * pasteCountRef.current
      }
      const copies = sources.map((n) => ({ ...n, id: uid(), x: n.x + dx, y: n.y + dy }))
      apply([...nodesRef.current, ...copies])
      const ids = copies.map((c) => c.id)
      setSelectedIds(ids)
      setRevealIds((r) => [...r, ...ids])
    },
    [apply, pushHistory]
  )

  // ---- paste ----
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = document.activeElement?.tagName
      if (t === 'INPUT' || t === 'TEXTAREA') return
      // where the cursor is (for dropping the paste there)
      const c = mouseClientRef.current
      const vpEl = viewportRef.current
      let inVp = false
      if (c && vpEl) {
        const r = vpEl.getBoundingClientRect()
        inVp = c.x >= r.left && c.x <= r.right && c.y >= r.top && c.y <= r.bottom
      }
      // 1) A real image on the OS clipboard (screenshot, browser image, file) → add it as
      //    a NEW image on the canvas. This WINS over the in-app clipboard, so pasting an
      //    external image always works (previously a lingering in-app cut/copy blocked it).
      const items = e.clipboardData?.items
      let imgFile: File | null = null
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            imgFile = items[i].getAsFile()
            break
          }
        }
      }
      if (imgFile) {
        e.preventDefault()
        fileToImage(imgFile, inVp && c ? { x: c.x, y: c.y } : undefined)
        clipboardStore.nodes = [] // an external image supersedes a stale in-app cut/copy
        return
      }
      // 2) Otherwise, an in-app cut/copy of node(s) → drop the copies at the cursor.
      if (clipboardStore.nodes.length) {
        e.preventDefault()
        const world = inVp && c ? screenToWorld(c.x, c.y) : null
        pasteNodes(clipboardStore.nodes, world)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [fileToImage, pasteNodes, screenToWorld])

  // ---- keyboard ----
  useEffect(() => {
    const isTyping = () => {
      const t = document.activeElement?.tagName
      return t === 'INPUT' || t === 'TEXTAREA'
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ' && !isTyping()) {
        spaceDownRef.current = true
        setSpaceMode(true)
        e.preventDefault()
        return
      }
      if (isTyping()) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelectedIds(nodesRef.current.map((n) => n.id))
        clearSelection()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        if (selectedIds.length) {
          e.preventDefault()
          const set = new Set(selectedIds)
          clipboardStore.nodes = nodesRef.current.filter((n) => set.has(n.id)).map((n) => ({ ...n }))
          pasteCountRef.current = 0
          // also copy the image itself to the OS clipboard (single selection)
          if (selectedIds.length === 1) {
            const n = nodesRef.current.find((x) => x.id === selectedIds[0])
            if (n) {
              window.api.copyImage(n.src)
              setCopyToast('Image copied to clipboard')
              window.setTimeout(() => setCopyToast(null), 1400)
            }
          }
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x') {
        if (selectedIds.length) {
          e.preventDefault()
          const set = new Set(selectedIds)
          // copy the selection to the in-app clipboard, then remove it (paste re-places it)
          clipboardStore.nodes = nodesRef.current.filter((n) => set.has(n.id)).map((n) => ({ ...n }))
          pasteCountRef.current = 0
          pushHistory()
          apply(nodesRef.current.filter((n) => !set.has(n.id)))
          setSelectedIds([])
          clearSelection()
          setCopyToast(`Cut ${set.size} image${set.size > 1 ? 's' : ''}. Cmd/Ctrl+V to paste`)
          window.setTimeout(() => setCopyToast(null), 1800)
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        if (selectedIds.length) {
          e.preventDefault()
          const set = new Set(selectedIds)
          pasteNodes(nodesRef.current.filter((n) => set.has(n.id)))
        }
        return
      }
      if (e.key === 'v' || e.key === 'V') setTool('move')
      else if (e.key === 'm' || e.key === 'M') setTool('rect')
      else if (e.key === 'd' || e.key === 'D' || e.key === 'b' || e.key === 'B') setTool('draw')
      else if (e.key === 'w' || e.key === 'W') setTool('magic')
      else if (e.key === '[') setBrushScreen((s) => clamp(s - 4, 6, 90))
      else if (e.key === ']') setBrushScreen((s) => clamp(s + 4, 6, 90))
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.length) {
          e.preventDefault()
          pushHistory()
          const del = new Set(selectedIds)
          apply(nodesRef.current.filter((n) => !del.has(n.id)))
          setSelectedIds([])
          clearSelection()
        }
      } else if (e.key === 'Escape') {
        if (refPickRef.current) {
          setRefPick(false)
          setRefMarq(null)
          return
        }
        clearSelection()
        setSelectedIds([])
        setBandSync(null)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        spaceDownRef.current = false
        setSpaceMode(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [undo, pushHistory, apply, selectedIds, clearSelection, setBandSync, pasteNodes])

  // ---- wheel ----
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0015)
        const nz = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)
        const cx = e.clientX - r.left
        const cy = e.clientY - r.top
        const wx = (cx - v.x) / v.zoom
        const wy = (cy - v.y) / v.zoom
        setView({ x: cx - wx * nz, y: cy - wy * nz, zoom: nz })
      } else {
        setView({ x: v.x - e.deltaX, y: v.y - e.deltaY, zoom: v.zoom })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- window-level pointer move/up (robust: no reliance on pointer capture) ----
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouseClientRef.current = { x: e.clientX, y: e.clientY }
      if (toolRef.current === 'draw') {
        const r = viewportRef.current?.getBoundingClientRect()
        if (r) {
          const x = e.clientX - r.left
          const y = e.clientY - r.top
          setHover(x >= 0 && y >= 0 && x <= r.width && y <= r.height ? { x, y } : null)
        }
      }
      const drag = dragRef.current
      if (!drag) return
      if (drag.kind === 'pan') {
        const v = viewRef.current
        setView({ x: drag.ox + (e.clientX - drag.sx), y: drag.oy + (e.clientY - drag.sy), zoom: v.zoom })
        return
      }
      const w = screenToWorld(e.clientX, e.clientY)
      if (drag.kind === 'move') {
        if (!drag.pushed) {
          pushHistory()
          drag.pushed = true
        }
        const dx = w.x - drag.sx
        const dy = w.y - drag.sy
        const starts = new Map(drag.starts.map((s) => [s.id, s]))
        apply(
          nodesRef.current.map((n) => {
            const s = starts.get(n.id)
            return s ? { ...n, x: s.x + dx, y: s.y + dy } : n
          })
        )
      } else if (drag.kind === 'resize') {
        if (!drag.pushed) {
          pushHistory()
          drag.pushed = true
        }
        const { corner, ix, iy, iw, ih, aspect } = drag
        let anchorX: number
        let anchorY: number
        let newW: number
        if (corner === 'se') {
          anchorX = ix
          anchorY = iy
          newW = Math.max(20, w.x - anchorX)
        } else if (corner === 'ne') {
          anchorX = ix
          anchorY = iy + ih
          newW = Math.max(20, w.x - anchorX)
        } else if (corner === 'sw') {
          anchorX = ix + iw
          anchorY = iy
          newW = Math.max(20, anchorX - w.x)
        } else {
          anchorX = ix + iw
          anchorY = iy + ih
          newW = Math.max(20, anchorX - w.x)
        }
        const newH = newW / aspect
        const nx = corner === 'se' || corner === 'ne' ? anchorX : anchorX - newW
        const ny = corner === 'se' || corner === 'sw' ? anchorY : anchorY - newH
        updateNode(drag.id, { x: nx, y: ny, w: newW, h: newH })
      } else if (drag.kind === 'selresize') {
        const node = nodesRef.current.find((n) => n.id === drag.id)
        if (!node) return
        const px = clamp(w.x, node.x, node.x + node.w)
        const py = clamp(w.y, node.y, node.y + node.h)
        const x0 = Math.min(drag.ax, px)
        const y0 = Math.min(drag.ay, py)
        const x1 = Math.max(drag.ax, px)
        const y1 = Math.max(drag.ay, py)
        setSelection({ imgId: drag.id, x: x0, y: y0, w: Math.max(2, x1 - x0), h: Math.max(2, y1 - y0) })
      } else if (drag.kind === 'rect') {
        const node = nodesRef.current.find((n) => n.id === drag.id)
        if (!node) return
        const x0 = clamp(Math.min(drag.sx, w.x), node.x, node.x + node.w)
        const y0 = clamp(Math.min(drag.sy, w.y), node.y, node.y + node.h)
        const x1 = clamp(Math.max(drag.sx, w.x), node.x, node.x + node.w)
        const y1 = clamp(Math.max(drag.sy, w.y), node.y, node.y + node.h)
        setMarq({ imgId: drag.id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
      } else if (drag.kind === 'draw') {
        if (Math.hypot(e.clientX - drag.lastSx, e.clientY - drag.lastSy) < 2.5) return
        drag.lastSx = e.clientX
        drag.lastSy = e.clientY
        const next = strokeRef.current ? [...strokeRef.current, clampToNode(drag.id, w)] : [clampToNode(drag.id, w)]
        setStrokePts(next)
      } else if (drag.kind === 'band') {
        const x0 = Math.min(drag.sx, w.x)
        const y0 = Math.min(drag.sy, w.y)
        setBandSync({ x: x0, y: y0, w: Math.abs(w.x - drag.sx), h: Math.abs(w.y - drag.sy) })
      } else if (drag.kind === 'refrect') {
        const node = nodesRef.current.find((n) => n.id === drag.id)
        if (!node) return
        const x0 = clamp(Math.min(drag.sx, w.x), node.x, node.x + node.w)
        const y0 = clamp(Math.min(drag.sy, w.y), node.y, node.y + node.h)
        const x1 = clamp(Math.max(drag.sx, w.x), node.x, node.x + node.w)
        const y1 = clamp(Math.max(drag.sy, w.y), node.y, node.y + node.h)
        setRefMarq({ imgId: drag.id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
      } else if (drag.kind === 'slotmove') {
        // move a loading placeholder — its result will land wherever it ends up
        const dx = w.x - drag.sx
        const dy = w.y - drag.sy
        pendingRef.current = pendingRef.current.map((s) => (s.id === drag.id ? { ...s, x: drag.ox + dx, y: drag.oy + dy } : s))
        setPending(pendingRef.current)
      }
    }
    const onUp = () => {
      const drag = dragRef.current
      dragRef.current = null
      setPanning(false)
      if (!drag) return
      const z = viewRef.current.zoom
      if (drag.kind === 'rect') {
        const m = marqueeRef.current
        if (m && m.w * z > 8 && m.h * z > 8) {
          setReferences([])
          setSelection(m)
          setErr(null)
        } else setMarq(null)
      } else if (drag.kind === 'draw') {
        const pts = strokeRef.current
        if (pts && pts.length >= 1) {
          const wb = brushRef.current / z
          const minX = Math.min(...pts.map((p) => p.x)) - wb
          const minY = Math.min(...pts.map((p) => p.y)) - wb
          const maxX = Math.max(...pts.map((p) => p.x)) + wb
          const maxY = Math.max(...pts.map((p) => p.y)) + wb
          setReferences([])
          setSelection({ imgId: drag.id, x: minX, y: minY, w: maxX - minX, h: maxY - minY, stroke: pts, brush: wb })
          setErr(null)
        } else setStrokePts(null)
      } else if (drag.kind === 'refrect') {
        const m = refMarqueeRef.current
        if (m && m.w * z > 6 && m.h * z > 6) addReferenceFromRegion(m)
        setRefMarq(null)
        setRefPick(false)
      } else if (drag.kind === 'band') {
        const b = bandRef.current
        const tiny = !b || (b.w * z < 6 && b.h * z < 6)
        if (drag.toggleId && tiny) {
          // shift-click on a frame with no drag → toggle just that frame
          const cur = selectedIdsRef.current
          setSelectedIds(cur.includes(drag.toggleId) ? cur.filter((id) => id !== drag.toggleId) : [...cur, drag.toggleId])
        } else if (b) {
          const hit = nodesRef.current
            .filter((n) => n.x < b.x + b.w && n.x + n.w > b.x && n.y < b.y + b.h && n.y + n.h > b.y)
            .map((n) => n.id)
          setSelectedIds(drag.additive ? Array.from(new Set([...selectedIdsRef.current, ...hit])) : hit)
        }
        setBandSync(null)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [screenToWorld, clampToNode, pushHistory, updateNode, apply, setMarq, setStrokePts, setBandSync, setRefMarq, addReferenceFromRegion])

  // ---- pointer down ----
  const beginDrag = (e: React.PointerEvent, drag: Drag) => {
    e.stopPropagation()
    dragRef.current = drag
    if (drag.kind === 'pan') setPanning(true)
  }
  const beginPan = (e: React.PointerEvent) => {
    const v = viewRef.current
    beginDrag(e, { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y })
  }
  const onViewportPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    if (e.button === 1 || spaceDownRef.current) {
      beginPan(e)
      return
    }
    if (refPickRef.current) return // during reference-pick, only clicks on images count
    if (tool === 'move' && e.button === 0) {
      // empty-canvas drag = rubber-band group select
      const w = screenToWorld(e.clientX, e.clientY)
      const additive = e.shiftKey || e.metaKey
      if (!additive) setSelectedIds([])
      clearSelection()
      setBandSync({ x: w.x, y: w.y, w: 0, h: 0 })
      beginDrag(e, { kind: 'band', sx: w.x, sy: w.y, additive })
    } else {
      beginPan(e)
    }
  }
  const startMove = (e: React.PointerEvent, ids: string[], w: Pt) => {
    const idset = new Set(ids)
    const starts = nodesRef.current.filter((n) => idset.has(n.id)).map((n) => ({ id: n.id, x: n.x, y: n.y }))
    beginDrag(e, { kind: 'move', ids, starts, sx: w.x, sy: w.y, pushed: false })
  }
  const onNodePointerDown = (e: React.PointerEvent, node: ImageNode) => {
    if (e.button === 1 || spaceDownRef.current) {
      beginPan(e)
      return
    }
    if (e.button !== 0) return
    const w = screenToWorld(e.clientX, e.clientY)
    if (refPickRef.current) {
      // box-select a region on any image to add it as a reference
      setRefMarq({ imgId: node.id, x: w.x, y: w.y, w: 0, h: 0 })
      beginDrag(e, { kind: 'refrect', id: node.id, sx: w.x, sy: w.y })
      return
    }
    if (tool === 'magic') {
      e.stopPropagation()
      const r = viewportRef.current!.getBoundingClientRect()
      setSelectedIds([node.id])
      clearSelection()
      setMagic({ imgId: node.id, x: e.clientX - r.left, y: e.clientY - r.top })
      setMagicText('')
      setMagicErr(null)
      return
    }
    if (tool === 'rect') {
      setSelectedIds([node.id])
      setSelection(null)
      setStrokePts(null)
      setMarq({ imgId: node.id, x: w.x, y: w.y, w: 0, h: 0 })
      beginDrag(e, { kind: 'rect', id: node.id, sx: w.x, sy: w.y })
    } else if (tool === 'draw') {
      setSelectedIds([node.id])
      setSelection(null)
      setMarq(null)
      setStrokePts([clampToNode(node.id, w)])
      beginDrag(e, { kind: 'draw', id: node.id, lastSx: e.clientX, lastSy: e.clientY })
    } else {
      e.stopPropagation()
      if (e.shiftKey || e.metaKey) {
        // Shift/Cmd on a frame: start an ADDITIVE rubber-band (lasso) so you can select
        // several even when frames are packed. A shift-CLICK with no drag toggles this one.
        setBandSync({ x: w.x, y: w.y, w: 0, h: 0 })
        beginDrag(e, { kind: 'band', sx: w.x, sy: w.y, additive: true, toggleId: node.id })
      } else {
        const ids = selectedIds.includes(node.id) && selectedIds.length > 1 ? selectedIds : [node.id]
        setSelectedIds(ids)
        startMove(e, ids, w)
      }
    }
  }
  const onHandlePointerDown = (e: React.PointerEvent, node: ImageNode, corner: Corner) => {
    if (e.button !== 0) return
    beginDrag(e, {
      kind: 'resize',
      id: node.id,
      corner,
      ix: node.x,
      iy: node.y,
      iw: node.w,
      ih: node.h,
      aspect: node.w / node.h || 1,
      pushed: false,
    })
  }
  // resize a rect selection (magic / box) by dragging a corner; anchor = opposite corner
  const onSelHandlePointerDown = (e: React.PointerEvent, s: Sel, corner: Corner) => {
    if (e.button !== 0) return
    const ax = corner === 'nw' || corner === 'sw' ? s.x + s.w : s.x
    const ay = corner === 'nw' || corner === 'ne' ? s.y + s.h : s.y
    beginDrag(e, { kind: 'selresize', id: s.imgId, corner, ax, ay })
  }

  // Find a spot near (baseX, baseY) for a block of size blockW×blockH that doesn't
  // overlap any existing node or in-flight slot — drops straight down past collisions.
  const placeFree = useCallback((baseX: number, baseY: number, blockW: number, blockH: number): { x: number; y: number } => {
    const gap = 22
    const occ: Rect[] = [
      ...nodesRef.current.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
      ...pendingRef.current.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h })),
    ]
    let y = baseY
    for (let k = 0; k < 400; k++) {
      const colliders = occ.filter((o) => baseX < o.x + o.w + gap && baseX + blockW > o.x - gap && y < o.y + o.h + gap && y + blockH > o.y - gap)
      if (!colliders.length) break
      y = Math.max(...colliders.map((o) => o.y + o.h)) + gap // jump just below the lowest collider
    }
    return { x: baseX, y }
  }, [])

  // ---- shared 1..N runner: DETACHED job. Fires N requests, lays results out clear of
  // existing images, and does NOT block the UI — the caller closes the popover
  // immediately, so the user can select + dispatch another job while this one runs.
  const runGeneration = useCallback(
    (params: {
      perform: () => Promise<string>
      prompt: string
      action: 'edit' | 'extract'
      model: string
      res: { w: number; h: number; nW: number; nH: number; transparent?: boolean }
      baseX: number
      baseY: number
      colW: number
    }) => {
      const N = clamp(count, 1, 10)
      const jobId = uid()
      const ac = new AbortController()
      jobAborts.current.set(jobId, ac)
      pushHistory()
      const label = params.action === 'extract' ? 'Extracting' : N > 1 ? 'Variation' : 'Generating'
      // place the whole N-wide block clear of existing images + other in-flight slots
      const blockW = (N - 1) * params.colW + params.res.w
      const spot = placeFree(params.baseX, params.baseY, blockW, params.res.h)
      const slots: PendingSlot[] = Array.from({ length: N }, (_, i) => ({
        id: uid(),
        jobId,
        label: N > 1 ? `${label} ${i + 1}` : label,
        x: spot.x + i * params.colW,
        y: spot.y,
        w: params.res.w,
        h: params.res.h,
      }))
      updatePending((prev) => [...prev, ...slots])

      // run the workers in the background (not awaited by the caller)
      void (async () => {
        const newIds: string[] = []
        const errors: string[] = []
        let next = 0
        const worker = async () => {
          for (;;) {
            const i = next++
            if (i >= N) break
            try {
              const image = await params.perform()
              if (ac.signal.aborted) break
              // land the result where its placeholder currently is (the user may have dragged it)
              const cur = pendingRef.current.find((s) => s.id === slots[i].id)
              const newNode: ImageNode = {
                id: uid(),
                src: image,
                x: cur ? cur.x : spot.x + i * params.colW,
                y: cur ? cur.y : spot.y,
                w: params.res.w,
                h: params.res.h,
                nW: params.res.nW,
                nH: params.res.nH,
                prompt: params.prompt || undefined,
                model: params.model,
                createdAt: Date.now(),
                transparent: params.res.transparent,
              }
              apply([...nodesRef.current, newNode])
              setRevealIds((r) => [...r, newNode.id])
              newIds.push(newNode.id)
            } catch (e) {
              if ((e as Error).name !== 'AbortError') errors.push((e as Error).message || 'failed')
            } finally {
              updatePending((prev) => prev.filter((s) => s.id !== slots[i].id))
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, N) }, () => worker()))
        jobAborts.current.delete(jobId)
        updatePending((prev) => prev.filter((s) => s.jobId !== jobId)) // sweep any stragglers
        if (ac.signal.aborted) return
        if (newIds.length > 0) {
          if (params.prompt.trim()) addPrompt(params.prompt).then(setHistory)
        } else {
          const msg = errors[0] || 'failed'
          setCopyToast(msg.length > 90 ? msg.slice(0, 89) + '…' : msg)
          window.setTimeout(() => setCopyToast(null), 4000)
        }
      })()
    },
    [count, pushHistory, apply, placeFree, updatePending]
  )

  // Generate: regenerate the selected region (1..N variations) to the right.
  const runEdit = useCallback(() => {
    const sel = selection
    if (!sel || (!promptText.trim() && references.length === 0)) return
    const node = nodeById(sel.imgId)
    if (!node) return
    const rx = node.nW / node.w
    const ry = node.nH / node.h
    const bbox = { x: (sel.x - node.x) * rx, y: (sel.y - node.y) * ry, w: sel.w * rx, h: sel.h * ry }
    const strokeReq = sel.stroke
      ? { points: sel.stroke.map((p) => ({ x: (p.x - node.x) * rx, y: (p.y - node.y) * ry })), radius: (sel.brush ?? 0) * rx }
      : undefined
    const src = node.src
    const refs = references.map((r) => r.src)
    const prompt = promptText
    const mdl = model
    const gap = Math.max(24, node.w * 0.05)
    runGeneration({
      perform: () => imageEdit({ src, bbox, prompt, model: mdl, stroke: strokeReq, references: refs }),
      prompt,
      action: 'edit',
      model: mdl,
      res: { w: node.w, h: node.h, nW: node.nW, nH: node.nH },
      baseX: node.x + node.w + gap,
      baseY: node.y,
      colW: node.w + gap,
    })
    // detach: close the popover + clear selection so another region can be started now
    clearSelection()
    setPromptText('')
    setErr(null)
  }, [selection, promptText, model, references, nodeById, runGeneration, clearSelection])

  // Extract a selection (a drawn region OR a whole frame). `mode` picks the algorithm:
  //   isolate    → cut the described element out, text removed, transparent background
  //   background → remove the foreground + text, keep only the (opaque) background scene
  const doExtract = useCallback(
    (sel: Sel, prompt: string, mode: ExtractMode = 'isolate') => {
      const node = nodeById(sel.imgId)
      if (!node) return
      const rx = node.nW / node.w
      const ry = node.nH / node.h
      const bbox = { x: (sel.x - node.x) * rx, y: (sel.y - node.y) * ry, w: sel.w * rx, h: sel.h * ry }
      const src = node.src
      const mdl = model
      const gap = Math.max(24, node.w * 0.05)
      const perform =
        mode === 'background'
          ? () => imageExtractBackground({ src, bbox, prompt, model: mdl })
          : () => imageExtract({ src, bbox, prompt, model: mdl })
      runGeneration({
        perform,
        prompt,
        action: 'extract',
        model: mdl,
        // keep the element's exact on-canvas size + aspect ratio; isolate is transparent, background is opaque
        res: { w: sel.w, h: sel.h, nW: Math.max(1, Math.round(bbox.w)), nH: Math.max(1, Math.round(bbox.h)), transparent: mode !== 'background' },
        baseX: node.x + node.w + gap,
        baseY: node.y,
        colW: sel.w + gap,
      })
      // detach: close the popover so another element can be extracted right away
      clearSelection()
      setPromptText('')
      setErr(null)
    },
    [model, nodeById, runGeneration, clearSelection]
  )
  const runExtract = useCallback(() => {
    if (selection) doExtract(selection, promptText, extractMode)
  }, [selection, promptText, extractMode, doExtract])

  // Remove background: cut everything behind the subject to transparency (whole image).
  const doRemoveBg = useCallback(
    (n: ImageNode) => {
      const src = n.src
      const mdl = model
      const gap = Math.max(24, n.w * 0.05)
      runGeneration({
        perform: () => imageRemoveBg({ src, model: mdl }),
        prompt: '',
        action: 'extract',
        model: mdl,
        res: { w: n.w, h: n.h, nW: n.nW, nH: n.nH, transparent: true },
        baseX: n.x + n.w + gap,
        baseY: n.y,
        colW: n.w + gap,
      })
    },
    [model, runGeneration]
  )

  // Cancel just the prompt popover (does NOT stop already-dispatched jobs).
  const cancelPrompt = () => {
    clearSelection()
    setPromptText('')
    setErr(null)
  }

  // Cancel one in-flight job from its placeholder (leaves other jobs running).
  const cancelJob = (jobId: string) => {
    jobAborts.current.get(jobId)?.abort()
    jobAborts.current.delete(jobId)
    setPending((prev) => prev.filter((s) => s.jobId !== jobId))
  }

  // Magic select: describe an element → Gemini returns its tight bounding box → Box selection
  const runMagic = useCallback(async () => {
    if (!magic || !magicText.trim()) return
    const node = nodeById(magic.imgId)
    if (!node) return
    setMagicBusy(true)
    setMagicErr(null)
    try {
      const r = await window.api.detect({ image: node.src, description: magicText })
      if (r.error) throw new Error(r.error)
      if (!r.box) {
        setMagicErr('Could not find that element — try describing it differently.')
        setMagicBusy(false)
        return
      }
      const raw = r.box.map(Number)
      // Gemini returns [ymin,xmin,ymax,xmax]; normally 0-1000 ints, sometimes 0-1 floats.
      const maxv = Math.max(...raw.map((v) => Math.abs(v)))
      const norm = maxv <= 1.5 ? 1 : 1000
      const [ymin, xmin, ymax, xmax] = raw
      let x0 = clamp(Math.min(xmin, xmax) / norm, 0, 1)
      let y0 = clamp(Math.min(ymin, ymax) / norm, 0, 1)
      let x1 = clamp(Math.max(xmin, xmax) / norm, 0, 1)
      let y1 = clamp(Math.max(ymin, ymax) / norm, 0, 1)
      // small padding so the box never clips the element's edges (it's resizable after)
      const padX = (x1 - x0) * 0.03
      const padY = (y1 - y0) * 0.03
      x0 = clamp(x0 - padX, 0, 1)
      y0 = clamp(y0 - padY, 0, 1)
      x1 = clamp(x1 + padX, 0, 1)
      y1 = clamp(y1 + padY, 0, 1)
      if (x1 - x0 < 0.004 || y1 - y0 < 0.004) {
        setMagicErr('Got a degenerate box — try describing the element differently.')
        setMagicBusy(false)
        return
      }
      const sel: Sel = {
        imgId: node.id,
        x: node.x + x0 * node.w,
        y: node.y + y0 * node.h,
        w: (x1 - x0) * node.w,
        h: (y1 - y0) * node.h
      }
      setReferences([])
      setSelectedIds([node.id])
      setSelection(sel)
      setMagic(null)
      setMagicText('')
    } catch (e) {
      setMagicErr((e as Error).message || 'detection failed')
    } finally {
      setMagicBusy(false)
    }
  }, [magic, magicText, nodeById])
  const modelShort = (m?: string) => (m === 'gemini-2.5-flash-image' ? 'Flash' : m === 'gemini-3-pro-image' ? 'Pro' : '')
  const fmtDate = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const copyPrompt = async (text: string) => {
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // fall back to the legacy path (e.g. when the clipboard API is focus-gated)
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        /* clipboard unavailable */
      }
    }
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1300)
    }
  }

  // ---- zoom controls ----
  const zoomAround = (factor: number, cx: number, cy: number) => {
    const v = viewRef.current
    const nz = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)
    const wx = (cx - v.x) / v.zoom
    const wy = (cy - v.y) / v.zoom
    setView({ x: cx - wx * nz, y: cy - wy * nz, zoom: nz })
  }
  const zoomBtn = (factor: number) => zoomAround(factor, vp.w / 2, vp.h / 2)
  const resetZoom = () => zoomAround(1 / viewRef.current.zoom, vp.w / 2, vp.h / 2)
  const fit = () => {
    const ns = nodesRef.current
    if (!ns.length || !vp.w || !vp.h) {
      setView({ x: 0, y: 0, zoom: 1 })
      return
    }
    const minX = Math.min(...ns.map((n) => n.x))
    const minY = Math.min(...ns.map((n) => n.y))
    const maxX = Math.max(...ns.map((n) => n.x + n.w))
    const maxY = Math.max(...ns.map((n) => n.y + n.h))
    const bw = maxX - minX
    const bh = maxY - minY
    const z = clamp(Math.min((vp.w - 80) / bw, (vp.h - 80) / bh), MIN_ZOOM, MAX_ZOOM)
    setView({ x: vp.w / 2 - (minX + bw / 2) * z, y: vp.h / 2 - (minY + bh / 2) * z, zoom: z })
  }

  // ---- render ----
  const single = selectedIds.length === 1 ? selectedIds[0] : null
  const liveNode = single ? nodeById(single) : null
  const showHandles = tool === 'move' && liveNode && !spaceMode && !panning && !selection && !magic
  const cursorClass = refPick ? 'select' : panning ? 'panning' : spaceMode ? 'pan' : tool === 'rect' || tool === 'magic' ? 'select' : tool === 'draw' ? 'draw' : ''

  // treat a whole image node as a full-frame selection (for Edit/Extract on the frame)
  const savePngFor = async (n: ImageNode): Promise<void> => {
    const r = await window.api.savePng(n.src, n.prompt || 'canvas-forge')
    if (r?.canceled) return
    if (r?.error) {
      setCopyToast(r.error)
      window.setTimeout(() => setCopyToast(null), 4000)
      return
    }
    if (r?.path) {
      setSavedPath(r.path)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSavedPath(null), 8000)
    }
  }

  const fullFrame = (n: ImageNode): Sel => ({ imgId: n.id, x: n.x, y: n.y, w: n.w, h: n.h })
  const openMagicFor = (n: ImageNode): void => {
    const s = w2s(n.x + n.w / 2, n.y)
    setSelectedIds([n.id])
    clearSelection()
    setMagic({ imgId: n.id, x: s.x, y: Math.max(60, s.y + 30) })
    setMagicText('')
    setMagicErr(null)
  }

  const selRect = selection || marquee
  const selScreen = selRect ? { ...w2s(selRect.x, selRect.y), w: selRect.w * view.zoom, h: selRect.h * view.zoom } : null
  const showRect = (marquee && !selection) || (selection && !selection.stroke)
  const strokeToShow = stroke || selection?.stroke || null
  const strokeBrushWorld = selection?.brush ?? brushScreen / view.zoom
  const strokeScreen = strokeToShow ? strokeToShow.map((p) => w2s(p.x, p.y)) : null
  const strokeWidthPx = strokeBrushWorld * view.zoom * 2
  const bandScreen = band ? { ...w2s(band.x, band.y), w: band.w * view.zoom, h: band.h * view.zoom } : null

  let popLeft = 0
  let popTop = 0
  if (selScreen) {
    popLeft = clamp(selScreen.x, 8, Math.max(8, vp.w - 320 - 8))
    popTop = clamp(selScreen.y + selScreen.h + 10, 8, Math.max(8, vp.h - 200))
  }

  return (
    <div
      ref={viewportRef}
      className={`viewport ${cursorClass}${dropping ? ' dropping' : ''}`}
      onPointerDown={onViewportPointerDown}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        const f = e.dataTransfer.files?.[0]
        if (f && f.type.startsWith('image/')) fileToImage(f, { x: e.clientX, y: e.clientY })
      }}
      style={{
        backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
    >
      <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        {nodes.map((n) => (
          <div
            key={n.id}
            className={'node' + (selectedIds.includes(n.id) ? ' selected' : '') + (revealIds.includes(n.id) ? ' reveal' : '') + (n.transparent ? ' transparent' : '')}
            style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
            onPointerDown={(e) => onNodePointerDown(e, n)}
            onDoubleClick={() => {
              // double-click = select the WHOLE frame edge-to-edge + open the popover
              // (single click just moves it around)
              if (tool !== 'move') return
              setSelectedIds([n.id])
              setSelection(fullFrame(n))
              setErr(null)
            }}
            onAnimationEnd={() => revealIds.includes(n.id) && setRevealIds((r) => r.filter((id) => id !== n.id))}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={n.src} alt="" draggable={false} />
          </div>
        ))}
      </div>

      <div className="overlay">
        {bandScreen ? (
          <div className="band-select" style={{ left: bandScreen.x, top: bandScreen.y, width: bandScreen.w, height: bandScreen.h }} />
        ) : null}

        {showHandles && liveNode
          ? (['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => {
              const px = c === 'nw' || c === 'sw' ? liveNode.x : liveNode.x + liveNode.w
              const py = c === 'nw' || c === 'ne' ? liveNode.y : liveNode.y + liveNode.h
              const s = w2s(px, py)
              const cur = c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize'
              return (
                <div key={c} className="handle" style={{ left: s.x, top: s.y, cursor: cur }} onPointerDown={(e) => onHandlePointerDown(e, liveNode, c)} />
              )
            })
          : null}

        {showRect && selScreen ? (
          <div className="marquee" style={{ left: selScreen.x, top: selScreen.y, width: selScreen.w, height: selScreen.h }} />
        ) : null}

        {/* drag handles to fine-tune a box / magic selection */}
        {selection && !selection.stroke
          ? (['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => {
              const px = c === 'nw' || c === 'sw' ? selection.x : selection.x + selection.w
              const py = c === 'nw' || c === 'ne' ? selection.y : selection.y + selection.h
              const s = w2s(px, py)
              const cur = c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize'
              return <div key={'sh' + c} className="handle" style={{ left: s.x, top: s.y, cursor: cur }} onPointerDown={(e) => onSelHandlePointerDown(e, selection, c)} />
            })
          : null}

        {refMarquee
          ? (() => {
              const s = w2s(refMarquee.x, refMarquee.y)
              return <div className="ref-marquee" style={{ left: s.x, top: s.y, width: refMarquee.w * view.zoom, height: refMarquee.h * view.zoom }} />
            })()
          : null}
        {refPick ? <div className="refpick-banner">Box-select a region on any image to add a reference · Esc to cancel</div> : null}

        {strokeScreen && strokeScreen.length ? (
          <svg className="stroke-svg" width={vp.w} height={vp.h}>
            {strokeScreen.length === 1 ? (
              <>
                <circle cx={strokeScreen[0].x} cy={strokeScreen[0].y} r={strokeBrushWorld * view.zoom} className="stroke-brush" />
                <circle cx={strokeScreen[0].x} cy={strokeScreen[0].y} r={3} className="stroke-line" />
              </>
            ) : (
              <>
                <polyline points={strokeScreen.map((p) => `${p.x},${p.y}`).join(' ')} className="stroke-brush" style={{ strokeWidth: strokeWidthPx }} />
                <polyline points={strokeScreen.map((p) => `${p.x},${p.y}`).join(' ')} className="stroke-line" />
              </>
            )}
          </svg>
        ) : null}

        {tool === 'draw' && hover && !panning ? (
          <div className="brush-cursor" style={{ left: hover.x, top: hover.y, width: brushScreen * 2, height: brushScreen * 2 }} />
        ) : null}

        {/* animated placeholders where each variation will land (one per concurrent job).
            Draggable: move it now to reserve where the finished image should appear. */}
        {pending.map((s) => {
          const r = w2s(s.x, s.y)
          return (
            <div
              key={s.id}
              className="gen-slot"
              style={{ left: r.x, top: r.y, width: s.w * view.zoom, height: s.h * view.zoom }}
              title="Drag to move where this result will land"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                const wpt = screenToWorld(e.clientX, e.clientY)
                beginDrag(e, { kind: 'slotmove', id: s.id, sx: wpt.x, sy: wpt.y, ox: s.x, oy: s.y })
              }}
            >
              <div className="gen-slot-badge">
                <span className="ring" />
                {s.label}
              </div>
              <button className="gen-slot-x" title="Cancel this job" onPointerDown={(e) => e.stopPropagation()} onClick={() => cancelJob(s.jobId)}>
                ×
              </button>
            </div>
          )
        })}

        {/* prompt caption / details for a selected generated image */}
        {single && liveNode && liveNode.prompt ? (
          detailOpen ? (
            <div
              className="node-detail"
              style={{
                left: clamp(w2s(liveNode.x, liveNode.y).x, 8, Math.max(8, vp.w - 308)),
                top: clamp(w2s(0, liveNode.y).y + 8, 8, Math.max(8, vp.h - 200)),
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="nd-head">
                <span className="nd-title">Prompt</span>
                {liveNode.model ? <span className="np-model">{modelShort(liveNode.model)}</span> : null}
                <button className="nd-x" title="Close" onClick={() => setDetailOpen(false)}>
                  ×
                </button>
              </div>
              <div className="nd-prompt">{liveNode.prompt}</div>
              {liveNode.createdAt ? <div className="nd-meta">Generated {fmtDate(liveNode.createdAt)}</div> : null}
              <div className="nd-actions">
                <button className="btn primary" onClick={() => copyPrompt(liveNode.prompt!)}>
                  {copied ? 'Copied!' : 'Copy prompt'}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="node-prompt"
              style={{ left: clamp(w2s(liveNode.x + liveNode.w / 2, liveNode.y).x, 100, Math.max(100, vp.w - 100)), top: Math.max(26, w2s(0, liveNode.y).y - 8) }}
              title="Click for details"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setDetailOpen(true)}
            >
              <span className="np-text">“{liveNode.prompt}”</span>
              {liveNode.model ? <span className="np-model">{modelShort(liveNode.model)}</span> : null}
            </button>
          )
        ) : null}

        {selection && selScreen ? (
          <div className="prompt-pop" style={{ left: popLeft, top: popTop }} onPointerDown={(e) => e.stopPropagation()}>
            <textarea
              autoFocus
              placeholder="Generate: describe the change. Extract: name the element (optional, e.g. “the gold ring”)."
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  runEdit()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelPrompt()
                }
              }}
            />
            <div className="prompt-tip">Tip: cover only what you want changed. Any text under the selection gets redrawn.</div>
            {history.length ? (
              <div className="prompt-history">
                <button className="ph-toggle" onClick={() => setShowHistory((v) => !v)} title="Reuse a recent prompt">
                  {showHistory ? '▾' : '▸'} Recent prompts
                </button>
                {showHistory ? (
                  <div className="prompt-chips">
                    {history.slice(0, 6).map((p) => (
                      <button key={p} className="chip" title={p} onClick={() => setPromptText(p)}>
                        {p.length > 28 ? p.slice(0, 27) + '…' : p}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {err ? <div className="prompt-err">{err}</div> : null}
            {refPick ? <div className="prompt-tip refpick">Drag a box on any image to add it as a reference · Esc to cancel</div> : null}
            <div className="prompt-refs">
              <span className="pr-label">Refs</span>
              {references.map((r) => (
                <span key={r.id} className="pr-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.src} alt="" />
                  <button className="pr-x" title="Remove reference" onClick={() => setReferences((prev) => prev.filter((x) => x.id !== r.id))}>
                    ×
                  </button>
                </span>
              ))}
              <button
                className={'pr-add' + (refPick ? ' on' : '')}
                onClick={() => setRefPick((v) => !v)}
                title="Add a reference by box-selecting a region on any image"
              >
                {refPick ? 'Pick…' : '+ Add'}
              </button>
            </div>
            <div className="prompt-controls">
              <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="gemini-3-pro-image">Best (Nano Banana Pro)</option>
                <option value="gemini-2.5-flash-image">Fast (Flash)</option>
              </select>
              <label className="count-ctl" title="What the Extract button does">
                <span>Extract</span>
                <select value={extractMode} onChange={(e) => setExtractMode(e.target.value as ExtractMode)}>
                  <option value="isolate">Isolate element</option>
                  <option value="background">Background only</option>
                </select>
              </label>
              <label className="count-ctl" title="How many variations to generate">
                <span>Runs</span>
                <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {Array.from({ length: 10 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="prompt-tip extract-hint">
              {extractMode === 'background'
                ? 'Extract → Background only: deletes the panels, icons and text and keeps just the scene behind them (opaque). Best on the whole frame.'
                : 'Extract → Isolate element: cuts the one element you name out on a transparent background (text removed).'}
            </div>
            <div className="prompt-actions">
              <button className="btn" onClick={cancelPrompt}>
                Cancel
              </button>
              <button
                className="btn"
                onClick={runExtract}
                title={
                  extractMode === 'background'
                    ? 'Remove the foreground + text, keep only the background scene (name it above, optional)'
                    : 'Cut out the named element on a transparent background, text removed (name it above, optional)'
                }
              >
                {count > 1 ? `Extract ${count}` : 'Extract'}
              </button>
              <button className="btn primary" onClick={runEdit} disabled={!promptText.trim() && references.length === 0}>
                {count > 1 ? `Generate ${count}` : 'Generate'}
              </button>
            </div>
          </div>
        ) : null}

        {magic ? (
          <div
            className="magic-pop"
            style={{ left: clamp(magic.x, 8, Math.max(8, vp.w - 300)), top: clamp(magic.y, 8, Math.max(8, vp.h - 150)) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="mp-title">✨ Magic select</div>
            <input
              className="mp-input"
              autoFocus
              placeholder="Describe the element (e.g. “the keys counter, top right”)"
              value={magicText}
              disabled={magicBusy}
              onChange={(e) => setMagicText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  runMagic()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMagic(null)
                }
              }}
            />
            {magicErr ? <div className="prompt-err">{magicErr}</div> : null}
            <div className="prompt-actions">
              <button className="btn" onClick={() => setMagic(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={runMagic} disabled={magicBusy || !magicText.trim()}>
                {magicBusy ? 'Finding…' : 'Find'}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <div className="seg">
          <button className={tool === 'move' ? 'on' : ''} onClick={() => setTool('move')} title="Move / select (V)">
            Move
          </button>
          <button className={tool === 'rect' ? 'on' : ''} onClick={() => setTool('rect')} title="Box select (M)">
            Box
          </button>
          <button className={tool === 'draw' ? 'on' : ''} onClick={() => setTool('draw')} title="Draw select (D)">
            Draw
          </button>
          <button className={tool === 'magic' ? 'on' : ''} onClick={() => setTool('magic')} title="Magic select — click an image and describe an element (W)">
            ✨ Magic
          </button>
        </div>
        {tool === 'draw' ? (
          <>
            <div className="sep" />
            <span className="brush-label">Brush</span>
            <input className="brush-range" type="range" min={6} max={90} value={brushScreen} onChange={(e) => setBrushScreen(Number(e.target.value))} title="Brush size ([ / ])" />
          </>
        ) : null}
        {selectedIds.length > 1 ? (
          <>
            <div className="sep" />
            <span className="sel-count">{selectedIds.length} selected</span>
            <button
              className="tbtn danger"
              title="Delete selected (Delete)"
              onClick={() => {
                pushHistory()
                const del = new Set(selectedIdsRef.current)
                apply(nodesRef.current.filter((n) => !del.has(n.id)))
                setSelectedIds([])
              }}
            >
              Delete
            </button>
          </>
        ) : null}
        <div className="sep" />
        <button className="tbtn" onClick={() => zoomBtn(1 / 1.2)} title="Zoom out">
          −
        </button>
        <button className="zoom" onClick={resetZoom} title="Reset to 100%">
          {Math.round(view.zoom * 100)}%
        </button>
        <button className="tbtn" onClick={() => zoomBtn(1.2)} title="Zoom in">
          +
        </button>
        <button className="tbtn" onClick={fit} title="Fit to content">
          Fit
        </button>
        <div className="sep" />
        <button className="tbtn" onClick={undo} title="Undo (Cmd/Ctrl+Z)">
          Undo
        </button>
        {single && liveNode && !selection && !magic ? (
          <>
            <div className="sep" />
            <button className="tbtn" title="Magic-select an element in this image (W)" onClick={() => openMagicFor(liveNode)}>
              ✨ Magic
            </button>
            <button className="tbtn" title="Select the whole frame, then type what to Extract or Generate" onClick={() => setSelection(fullFrame(liveNode))}>
              Whole frame
            </button>
            <button className="tbtn" title="Remove the background: keep the subject, make everything behind it transparent" onClick={() => doRemoveBg(liveNode)}>
              Remove BG
            </button>
            <button className="tbtn" title="Save this image as a PNG file" onClick={() => savePngFor(liveNode)}>
              Save PNG
            </button>
          </>
        ) : null}
      </div>

      {nodes.length === 0 ? (
        <div className="empty-hint">
          <div className="big">Paste an image to begin</div>
          <div>
            Press <kbd>Cmd/Ctrl+V</kbd> or drop a file here
          </div>
        </div>
      ) : null}

      {copyToast ? <div className="toast">{copyToast}</div> : null}
      {savedPath ? (
        <div className="toast saved-toast">
          <span className="saved-msg">
            Saved <b>{savedPath.split('/').pop()}</b>
          </span>
          <button className="saved-reveal" onClick={() => window.api.revealItem(savedPath)}>
            Reveal in Finder
          </button>
          <button className="saved-x" title="Dismiss" onClick={() => setSavedPath(null)}>
            ×
          </button>
        </div>
      ) : null}
    </div>
  )
}
