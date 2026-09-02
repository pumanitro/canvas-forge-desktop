
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import Canvas from './Canvas'
import McpPanel from './McpPanel'
import type { ImageNode, Project, ProjectSummary, StoredRewrite } from './types'
import { loadProject, loadProjects, patchProjectMeta, removeProject, saveProject, saveProjectOrder } from './store'
import { awaitProject, registerBridge } from './mcpBridge'
import { COVER_H, COVER_W, renderCover } from './cover'
import { uid } from './util'

const THUMB_W = COVER_W
const THUMB_H = COVER_H

function makeProject(name: string): Project {
  const t = Date.now()
  return { id: uid(), name, images: [], createdAt: t, updatedAt: t }
}

/** A project card: one small pre-painted cover (see cover.ts), not the project's
 *  images. The sidebar no longer holds any project but the open one. */
function ProjectThumb({ summary }: { summary: ProjectSummary }): React.JSX.Element {
  if (!summary.imageCount) return <div className="thumb empty">Empty</div>
  if (!summary.cover) {
    // A project saved by an older build has no cover yet; it gets one the first
    // time it is opened.
    return (
      <div className="thumb empty">
        {summary.imageCount} image{summary.imageCount === 1 ? '' : 's'}
      </div>
    )
  }
  return (
    <div className="thumb" style={{ width: THUMB_W, height: THUMB_H }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={summary.cover}
        alt=""
        draggable={false}
        decoding="async"
        style={{ position: 'absolute', left: 0, top: 0, width: THUMB_W, height: THUMB_H }}
      />
    </div>
  )
}

export default function Studio() {
  // The sidebar holds summaries only. The one project that is open is `current`,
  // loaded from disk when it is selected — nothing else's images are in memory.
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [current, setCurrent] = useState<Project | null>(null)
  const [ready, setReady] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const coverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // latest values for the global Cmd+S listener (avoids re-registering on every change)
  const projectsRef = useRef<ProjectSummary[]>([])
  const currentIdRef = useRef<string | null>(null)
  const currentRef = useRef<Project | null>(null)
  // Set by every real edit, cleared by every save. Opening a project must not
  // count: it would push the whole multi-hundred-MB JSON back through IPC and
  // rewrite it unchanged, 350 ms after it was read.
  const dirtyRef = useRef(false)
  useEffect(() => {
    projectsRef.current = projects
  }, [projects])
  useEffect(() => {
    currentIdRef.current = currentId
  }, [currentId])
  useEffect(() => {
    currentRef.current = current
  }, [current])

  /** Reflect a full project's name/count/date back onto its sidebar summary. */
  const syncSummary = useCallback((p: Project, extra?: Partial<ProjectSummary>) => {
    setProjects((prev) =>
      prev.map((s) =>
        s.id === p.id ? { ...s, name: p.name, updatedAt: p.updatedAt, imageCount: p.images.length, ...extra } : s
      )
    )
  }, [])

  const flashToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1600)
  }, [])

  // A save writes any node still holding a data URL to disk and answers with the
  // cf-img URL that now stands for it. That answer goes to the Canvas (through the
  // `stored` prop) so the base64 leaves memory — from the live nodes, the undo stack
  // and the clipboard alike. `from` is the src that was sent: a node whose pixels
  // changed again while the save was in flight keeps its newer data URL.
  const [stored, setStored] = useState<StoredRewrite | null>(null)
  const storedSeq = useRef(0)
  const persist = useCallback(
    async (p: Project): Promise<void> => {
      const sent = new Map(p.images.map((n) => [n.id, n.src] as const))
      try {
        const r = await saveProject(p)
        const ids = r?.rewritten ? Object.keys(r.rewritten) : []
        if (!ids.length) return
        const map: StoredRewrite['map'] = {}
        for (const id of ids) map[id] = { from: sent.get(id) ?? '', to: r.rewritten[id] }
        setStored({ projectId: p.id, seq: ++storedSeq.current, map })
      } catch (e) {
        flashToast(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [flashToast]
  )
  /** The Canvas applied a rewrite: mirror it, without marking the project dirty. */
  const handleImagesStored = useCallback((images: ImageNode[]) => {
    setCurrent((prev) => (prev ? { ...prev, images } : prev))
  }, [])

  // A legacy single-file project is split into images + layout the first time it
  // is opened (main/store.ts). For the seconds that takes, say so.
  const [migrating, setMigrating] = useState<{ done: number; total: number } | null>(null)
  useEffect(
    () =>
      window.api.onProjectMigrating?.(({ done, total }) => {
        setMigrating(done >= total ? null : { done, total })
      }),
    []
  )

  useEffect(() => {
    let alive = true
    loadProjects().then((ps) => {
      if (!alive) return
      if (ps.length === 0) {
        const p = makeProject('Untitled')
        saveProject(p)
        setCurrent(p)
        ps = [{ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, imageCount: 0 }]
      }
      setProjects(ps)
      setCurrentId(ps[0].id)
      setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  // Selecting a card loads that project. Guarded so a slow load of project A
  // cannot land after the user has already clicked project B.
  const loadSeq = useRef(0)
  useEffect(() => {
    if (!currentId) return
    if (currentRef.current?.id === currentId) return // already have it (just created / imported)
    const seq = ++loadSeq.current
    // Flush any unsaved edits to the project we are leaving before it unmounts.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    if (coverTimer.current) {
      clearTimeout(coverTimer.current)
      coverTimer.current = null
    }
    const leaving = currentRef.current
    if (leaving && dirtyRef.current) {
      void persist(leaving)
      syncSummary(leaving)
    }
    dirtyRef.current = false
    setCurrent(null)
    loadProject(currentId).then((p) => {
      if (seq !== loadSeq.current) return
      setMigrating(null)
      if (!p) {
        flashToast('Could not open that project')
        return
      }
      setCurrent(p)
      syncSummary(p)
    })
  }, [currentId, syncSummary, persist, flashToast])

  // Debounced auto-save of the current project, and — on a slower clock, because
  // it decodes images — a fresh cover for its sidebar card.
  useEffect(() => {
    if (!ready || !current) return
    const p = current
    const dirty = dirtyRef.current
    if (dirty) {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        dirtyRef.current = false
        void persist(p)
        syncSummary(p)
      }, 350)
    }
    // A project saved by an older build arrives without a cover: paint one on
    // first open even though nothing changed.
    const needsCover = !projectsRef.current.find((s) => s.id === p.id)?.cover
    if (dirty || needsCover) {
      if (coverTimer.current) clearTimeout(coverTimer.current)
      coverTimer.current = setTimeout(() => {
        coverTimer.current = null
        void renderCover(p.images).then((cover) => {
          if (!cover) return
          if (currentRef.current?.id !== p.id) return // moved on; that project will get its own
          void patchProjectMeta(p.id, { cover })
          setProjects((prev) => prev.map((s) => (s.id === p.id ? { ...s, cover } : s)))
        })
      }, 1500)
    }
  }, [current, ready, syncSummary, persist])

  // Cmd/Ctrl+S → save into the project (NOT the browser "save page to Desktop").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const cur = currentRef.current
        if (cur) {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          dirtyRef.current = false
          void persist(cur)
          flashToast(`Saved “${cur.name}”`)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flashToast, persist])

  // ---- MCP: the project-level tools (the canvas ones live in Canvas.tsx) ----
  // Registered here because only Studio knows the project list and can switch between them.
  // Sidebar chip state. Polled slowly (the panel itself polls fast when open) so the chip can
  // say whether an agent is actually attached rather than only whether the port is open.
  const [mcpChip, setMcpChip] = useState<{ live: boolean; clients: number } | null>(null)
  const [mcpOpen, setMcpOpen] = useState(false)
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      window.api
        .mcpInfo?.()
        .then((i) => {
          if (alive) setMcpChip(i ? { live: !!i.port, clients: i.clients?.length ?? 0 } : null)
        })
        .catch(() => {})
    }
    tick()
    const t = window.setInterval(tick, 8000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])
  useEffect(() =>
    registerBridge({
      list_projects: () => ({
        json: {
          openProjectId: currentIdRef.current,
          projects: projectsRef.current.map((p) => ({
            id: p.id,
            name: p.name,
            images: p.imageCount,
            open: p.id === currentIdRef.current,
            updatedAt: new Date(p.updatedAt).toISOString()
          }))
        }
      }),
      open_project: async (params) => {
        const list = projectsRef.current
        let target = typeof params.projectId === 'string' ? list.find((p) => p.id === params.projectId) : undefined
        if (!target && typeof params.name === 'string') {
          const q = params.name.trim().toLowerCase()
          const hits = list.filter((p) => p.name.trim().toLowerCase() === q)
          if (hits.length > 1) throw new Error(`"${params.name}" matches ${hits.length} projects — use projectId.`)
          target = hits[0]
        }
        if (!target) {
          throw new Error(`No such project. Available: ${list.map((p) => `${p.name} (${p.id})`).join(', ')}`)
        }
        setCurrentId(target.id)
        // Don't answer until that project's canvas is the one serving tool calls, or the caller's
        // next get_state would still describe the project we just left.
        const live = await awaitProject(target.id)
        return {
          text:
            `Opened "${target.name}" — ${target.imageCount} image(s) on the canvas.` +
            (live ? '' : ' (the canvas is still loading — re-check with get_state)'),
          json: { id: target.id, name: target.name, images: target.imageCount }
        }
      }
    })
  , [])

  const handleImagesChange = useCallback((images: ImageNode[]) => {
    dirtyRef.current = true
    setCurrent((prev) => (prev ? { ...prev, images, updatedAt: Date.now() } : prev))
  }, [])

  // The sidebar order is persisted as a bare id list (see main/store.ts). Re-commit it
  // on every structural change so the visible order always survives a restart — without
  // this, only reordered projects would be ranked and new ones would jump to the bottom.
  const commitOrder = useCallback((list: ProjectSummary[]): void => {
    saveProjectOrder(list.map((p) => p.id))
  }, [])

  // ---- drag to reorder. Pointer events rather than HTML5 drag-and-drop: a card is
  // already a click (select) and double-click (rename) target, so a drag may only begin
  // past a small movement threshold — otherwise every click reads as a zero-distance drop.
  const listRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null)
  // Layout snapshot taken once, when the drag begins. The cards are about to be shoved
  // around with transforms, and getBoundingClientRect() reports those animated positions —
  // so measuring against it would make the drop target chase the animation it caused.
  // offsetTop/offsetHeight are layout values that transforms don't affect.
  const snapRef = useRef<{ el: HTMLElement; top: number; height: number }[]>([])
  const fromRef = useRef(-1)
  const grabRef = useRef(0) // where inside the card the pointer went down
  const pitchRef = useRef(0) // card-to-card spacing, i.e. one slot
  const targetRef = useRef<number | null>(null)
  const lastTargetRef = useRef<number | null>(null)
  const lastYRef = useRef(0)
  const suppressClickRef = useRef(false)
  const scrollVelRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [slot, setSlot] = useState<{ top: number; h: number } | null>(null)

  const onCardPointerDown = (e: ReactPointerEvent, id: string): void => {
    suppressClickRef.current = false // every fresh gesture re-arms the click
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, input')) return
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, active: false }
  }

  useEffect(() => {
    const THRESHOLD = 4 // px of travel before a click becomes a drag
    const EDGE = 52 // auto-scroll band at the top/bottom of the list

    // Carry the dragged card under the cursor, slide the others out of its way, and park
    // the dashed landing slot in the gap that opens. All of it is transform-only, so the
    // list never reflows and the snapshot stays the single source of truth for the drop.
    const layout = (clientY: number): void => {
      const list = listRef.current
      const snap = snapRef.current
      const from = fromRef.current
      if (!list || !snap.length || from < 0) return
      const inList = clientY - list.getBoundingClientRect().top + list.scrollTop
      const top = inList - grabRef.current
      const pitch = pitchRef.current
      const centre = top + snap[from].height / 2

      // Landing index = how many of the other cards the dragged one has passed.
      let target = 0
      for (let k = 0; k < snap.length; k++) {
        if (k !== from && centre > snap[k].top + snap[k].height / 2) target++
      }
      targetRef.current = target

      for (let k = 0; k < snap.length; k++) {
        if (k === from) {
          snap[k].el.style.transform = `translateY(${top - snap[k].top}px)`
          continue
        }
        // A card shifts by exactly one slot when the dragged card's departure and
        // arrival straddle it.
        const shift = k < from && k >= target ? pitch : k > from && k <= target ? -pitch : 0
        snap[k].el.style.transform = shift ? `translateY(${shift}px)` : ''
      }
      // Only re-render React when the landing index actually changes — otherwise every
      // pointermove would re-render the whole list at pointer frequency.
      if (target !== lastTargetRef.current) {
        lastTargetRef.current = target
        setSlot({ top: snap[0].top + target * pitch, h: snap[from].height })
      }
    }

    const tick = (): void => {
      const list = listRef.current
      if (list && scrollVelRef.current) {
        list.scrollTop += scrollVelRef.current
        layout(lastYRef.current) // keep following while the list scrolls under a still cursor
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    const onMove = (e: PointerEvent): void => {
      const d = dragRef.current
      const list = listRef.current
      if (!d || !list) return
      if (!d.active) {
        if (Math.abs(e.clientX - d.startX) < THRESHOLD && Math.abs(e.clientY - d.startY) < THRESHOLD) return
        const cards = Array.from(list.querySelectorAll('.proj-card')) as HTMLElement[]
        const snap = cards.map((el) => ({ el, top: el.offsetTop, height: el.offsetHeight }))
        const from = snap.findIndex((s) => s.el.dataset.id === d.id)
        if (from < 0) return
        snapRef.current = snap
        fromRef.current = from
        pitchRef.current = snap.length > 1 ? snap[1].top - snap[0].top : snap[0].height + 8
        grabRef.current = d.startY - list.getBoundingClientRect().top + list.scrollTop - snap[from].top
        lastTargetRef.current = null
        snap[from].el.style.zIndex = '10'
        d.active = true
        setDragId(d.id)
        if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick) // arm auto-scroll
      }
      lastYRef.current = e.clientY
      layout(e.clientY)
      const lr = list.getBoundingClientRect()
      scrollVelRef.current = e.clientY < lr.top + EDGE ? -10 : e.clientY > lr.bottom - EDGE ? 10 : 0
    }

    const onUp = (): void => {
      const d = dragRef.current
      const target = targetRef.current
      const from = fromRef.current
      dragRef.current = null
      targetRef.current = null
      lastTargetRef.current = null
      fromRef.current = -1
      scrollVelRef.current = 0
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      for (const s of snapRef.current) {
        s.el.style.transform = ''
        s.el.style.zIndex = ''
      }
      snapRef.current = []
      setDragId(null)
      setSlot(null)
      if (!d?.active) return
      suppressClickRef.current = true // a click always trails this pointerup — eat it
      if (target == null || from < 0 || target === from) return
      const cur = projectsRef.current
      const next = cur.slice()
      const [moved] = next.splice(from, 1)
      next.splice(target, 0, moved)
      setProjects(next)
      commitOrder(next)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [commitOrder])

  const summaryOf = (p: Project, cover?: string): ProjectSummary => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    imageCount: p.images.length,
    cover
  })

  /** Make a project we already hold in full the open one, without a disk round-trip. */
  const openLoaded = (p: Project): void => {
    loadSeq.current++ // cancel any load in flight for a previous selection
    setCurrent(p)
    setCurrentId(p.id)
  }

  const createProject = () => {
    const p = makeProject('Untitled')
    const next = [summaryOf(p), ...projects]
    setProjects(next)
    commitOrder(next)
    openLoaded(p)
    saveProject(p)
    setEditingName(p.id)
  }

  const renameProject = (id: string, name: string) => {
    const clean = name.trim() || 'Untitled'
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name: clean } : p)))
    if (currentRef.current?.id === id) {
      // The open project saves itself (debounced) and carries the name into its JSON.
      dirtyRef.current = true
      setCurrent((prev) => (prev ? { ...prev, name: clean } : prev))
    } else {
      // A closed project is not in memory; its name lives in the sidecar until it is
      // next opened, when loadProject overlays it — no need to rewrite a huge JSON.
      void patchProjectMeta(id, { name: clean })
    }
  }

  const deleteProject = (id: string) => {
    const p = projects.find((x) => x.id === id)
    if (p && p.imageCount > 0 && !confirm(`Delete "${p.name}"? This can't be undone.`)) return
    removeProject(id)
    let next = projects.filter((x) => x.id !== id)
    let fresh: Project | null = null
    if (!next.length) {
      fresh = makeProject('Untitled')
      saveProject(fresh)
      next = [summaryOf(fresh)]
    }
    setProjects(next)
    commitOrder(next)
    if (id === currentId) {
      if (fresh) openLoaded(fresh)
      else setCurrentId(next[0].id)
    }
  }

  // Main reads the file and files its images straight into the store (a clashing
  // id is reassigned there); what comes back is the KB-sized layout, already saved.
  const importProject = async () => {
    const r = await window.api.importProject()
    setMigrating(null)
    if (r?.canceled) return
    if (r?.error || !r?.project) {
      flashToast(r?.error || 'Import failed')
      return
    }
    const p = r.project as Project
    const next = [summaryOf(p), ...projects.filter((x) => x.id !== p.id)]
    setProjects(next)
    commitOrder(next)
    openLoaded(p)
    flashToast(`Imported “${p.name}”`)
  }

  const exportProject = async (s: ProjectSummary) => {
    // Only the open project is in memory; anything else is read from disk for the
    // export. Either way main inlines the images from the store into the file.
    const p = currentRef.current?.id === s.id ? currentRef.current : await loadProject(s.id)
    if (!p) {
      flashToast('Could not read that project')
      return
    }
    const r = await window.api.exportProject(p)
    if (r?.error) flashToast(r.error)
    else if (r?.path) flashToast('Exported to file')
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          Canvas Forge
        </div>
        <div className="side-actions">
          <button className="new-btn" onClick={createProject}>
            + New
          </button>
          <button className="new-btn" onClick={importProject} title="Open a project file from disk">
            Import
          </button>
        </div>
        <div className="proj-list" ref={listRef}>
          {slot ? <div className="drop-slot" style={{ top: slot.top, height: slot.h }} /> : null}
          {projects.map((p) => (
            <div
              key={p.id}
              data-id={p.id}
              className={
                'proj-card' + (p.id === currentId ? ' active' : '') + (dragId === p.id ? ' dragging' : '')
              }
              onPointerDown={(e) => onCardPointerDown(e, p.id)}
              onClick={() => {
                if (suppressClickRef.current) return // this click closed a drag, not a selection
                setCurrentId(p.id)
              }}
              onDoubleClick={() => setEditingName(p.id)}
            >
              <ProjectThumb summary={p} />
              <div className="proj-foot">
                {editingName === p.id ? (
                  <input
                    className="name-input"
                    autoFocus
                    defaultValue={p.name}
                    onBlur={(e) => {
                      renameProject(p.id, e.target.value)
                      setEditingName(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setEditingName(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="name" title={p.name}>
                    {p.name}
                  </span>
                )}
                <button
                  className="ex"
                  title="Export project to a file"
                  onClick={(e) => {
                    e.stopPropagation()
                    exportProject(p)
                  }}
                >
                  ⤓
                </button>
                <button
                  className="x"
                  title="Delete project"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteProject(p.id)
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="help">
          <b>Cmd/Ctrl+V</b> paste image · <b>Cmd/Ctrl+S</b> save
          <br />
          <b>Cmd/Ctrl+C</b> copy · <b>Cmd/Ctrl+X</b> cut · <b>Cmd/Ctrl+V</b> paste at cursor · <b>Cmd/Ctrl+D</b> duplicate
          <br />
          <kbd>V</kbd> move · <kbd>M</kbd> box · <kbd>D</kbd> draw · <kbd>W</kbd> ✨magic · <b>☰</b> layers
          <br />
          drag empty = select many · <kbd>Shift</kbd>+drag = lasso · drag a selected one to move all
          <br />
          <kbd>Space</kbd>+drag / scroll to pan · <kbd>Cmd</kbd>+scroll zoom
          <br />
          <b>⤓</b> export project to a file · <b>Import</b> to open one
          <br />
          drag a project card to reorder the list
        </div>

        {/* Always reachable: how to point an AI agent at this canvas, plus whether one is. */}
        <button
          className={'mcp-chip' + (mcpChip?.clients ? ' attached' : mcpChip?.live ? ' live' : '')}
          onClick={() => setMcpOpen(true)}
          title="How to connect an AI agent to this canvas (MCP)"
        >
          <span className="mcp-dot" />
          <span className="mcp-chip-label">Agent access</span>
          <span className="mcp-chip-state">
            {mcpChip?.clients
              ? `${mcpChip.clients} connected`
              : mcpChip?.live
                ? 'ready'
                : 'off'}
          </span>
          <span className="mcp-chip-i">ⓘ</span>
        </button>
      </aside>

      <main className="stage">
        {ready && current ? (
          <Canvas
            key={current.id}
            project={current}
            onImagesChange={handleImagesChange}
            stored={stored}
            onImagesStored={handleImagesStored}
          />
        ) : null}
        {migrating ? (
          <div className="toast">
            Converting project to the new format… {migrating.done}/{migrating.total} images
          </div>
        ) : toast ? (
          <div className="toast">{toast}</div>
        ) : null}
      </main>
      {mcpOpen ? <McpPanel onClose={() => setMcpOpen(false)} /> : null}
    </div>
  )
}
