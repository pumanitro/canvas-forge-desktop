
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import Canvas from './Canvas'
import type { ImageNode, Project } from './types'
import { loadProjects, removeProject, saveProject, saveProjectOrder } from './store'
import { uid } from './util'

const THUMB_W = 186
const THUMB_H = 104

function makeProject(name: string): Project {
  const t = Date.now()
  return { id: uid(), name, images: [], createdAt: t, updatedAt: t }
}

function ProjectThumb({ images }: { images: ImageNode[] }) {
  if (!images.length) return <div className="thumb empty">Empty</div>
  const minX = Math.min(...images.map((n) => n.x))
  const minY = Math.min(...images.map((n) => n.y))
  const maxX = Math.max(...images.map((n) => n.x + n.w))
  const maxY = Math.max(...images.map((n) => n.y + n.h))
  const bw = maxX - minX || 1
  const bh = maxY - minY || 1
  const pad = 8
  const s = Math.min((THUMB_W - 2 * pad) / bw, (THUMB_H - 2 * pad) / bh)
  const offX = (THUMB_W - bw * s) / 2 - minX * s
  const offY = (THUMB_H - bh * s) / 2 - minY * s
  return (
    <div className="thumb" style={{ width: THUMB_W, height: THUMB_H }}>
      {images.map((n) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={n.id}
          src={n.src}
          alt=""
          draggable={false}
          style={{ position: 'absolute', left: n.x * s + offX, top: n.y * s + offY, width: n.w * s, height: n.h * s }}
        />
      ))}
    </div>
  )
}

export default function Studio() {
  const [projects, setProjects] = useState<Project[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // latest values for the global Cmd+S listener (avoids re-registering on every change)
  const projectsRef = useRef<Project[]>([])
  const currentIdRef = useRef<string | null>(null)
  useEffect(() => {
    projectsRef.current = projects
  }, [projects])
  useEffect(() => {
    currentIdRef.current = currentId
  }, [currentId])

  useEffect(() => {
    let alive = true
    loadProjects().then((ps) => {
      if (!alive) return
      if (ps.length === 0) {
        const p = makeProject('Untitled')
        saveProject(p)
        ps = [p]
      }
      setProjects(ps)
      setCurrentId(ps[0].id)
      setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const current = projects.find((p) => p.id === currentId) || null

  const flashToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1600)
  }, [])

  // Debounced auto-save of the current project.
  useEffect(() => {
    if (!ready || !current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const p = current
    saveTimer.current = setTimeout(() => saveProject(p), 350)
  }, [current, ready])

  // Cmd/Ctrl+S → save into the project (NOT the browser "save page to Desktop").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const cur = projectsRef.current.find((p) => p.id === currentIdRef.current)
        if (cur) {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveProject(cur)
          flashToast(`Saved “${cur.name}”`)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flashToast])

  const handleImagesChange = useCallback(
    (images: ImageNode[]) => {
      setProjects((prev) =>
        prev.map((p) => (p.id === currentId ? { ...p, images, updatedAt: Date.now() } : p))
      )
    },
    [currentId]
  )

  // The sidebar order is persisted as a bare id list (see main/store.ts). Re-commit it
  // on every structural change so the visible order always survives a restart — without
  // this, only reordered projects would be ranked and new ones would jump to the bottom.
  const commitOrder = useCallback((list: Project[]): void => {
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

  const createProject = () => {
    const p = makeProject('Untitled')
    const next = [p, ...projects]
    setProjects(next)
    commitOrder(next)
    setCurrentId(p.id)
    saveProject(p)
    setEditingName(p.id)
  }

  const renameProject = (id: string, name: string) => {
    const clean = name.trim() || 'Untitled'
    setProjects((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, name: clean } : p))
      const p = next.find((x) => x.id === id)
      if (p) saveProject(p)
      return next
    })
  }

  const deleteProject = (id: string) => {
    const p = projects.find((x) => x.id === id)
    if (p && p.images.length > 0 && !confirm(`Delete "${p.name}"? This can't be undone.`)) return
    removeProject(id)
    let next = projects.filter((x) => x.id !== id)
    if (!next.length) {
      const np = makeProject('Untitled')
      saveProject(np)
      next = [np]
    }
    if (id === currentId) setCurrentId(next[0].id)
    setProjects(next)
    commitOrder(next)
  }

  const importProject = async () => {
    const r = await window.api.importProject()
    if (r?.canceled) return
    if (r?.error || !r?.project) {
      flashToast(r?.error || 'Import failed')
      return
    }
    let p = r.project as Project
    if (projects.some((x) => x.id === p.id)) p = { ...p, id: uid(), name: `${p.name || 'Untitled'} (imported)` }
    await saveProject(p)
    const next = [p, ...projects.filter((x) => x.id !== p.id)]
    setProjects(next)
    commitOrder(next)
    setCurrentId(p.id)
    flashToast(`Imported “${p.name}”`)
  }

  const exportProject = async (p: Project) => {
    const r = await window.api.exportProject(p)
    if (r?.path) flashToast('Exported to file')
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
              <ProjectThumb images={p.images} />
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
      </aside>

      <main className="stage">
        {ready && current ? <Canvas key={current.id} project={current} onImagesChange={handleImagesChange} /> : null}
        {toast ? <div className="toast">{toast}</div> : null}
      </main>
    </div>
  )
}
