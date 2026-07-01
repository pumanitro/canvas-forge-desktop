
import { useCallback, useEffect, useRef, useState } from 'react'
import Canvas from './Canvas'
import type { ImageNode, Project } from './types'
import { loadProjects, removeProject, saveProject } from './store'
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

  const createProject = () => {
    const p = makeProject('Untitled')
    setProjects((prev) => [p, ...prev])
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
    setProjects((prev) => {
      const next = prev.filter((x) => x.id !== id)
      if (id === currentId) {
        if (next.length) setCurrentId(next[0].id)
        else {
          const np = makeProject('Untitled')
          saveProject(np)
          setCurrentId(np.id)
          return [np]
        }
      }
      return next
    })
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
    setProjects((prev) => [p, ...prev.filter((x) => x.id !== p.id)])
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
        <div className="proj-list">
          {projects.map((p) => (
            <div
              key={p.id}
              className={'proj-card' + (p.id === currentId ? ' active' : '')}
              onClick={() => setCurrentId(p.id)}
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
          <kbd>V</kbd> move · <kbd>M</kbd> box · <kbd>D</kbd> draw · <kbd>W</kbd> ✨magic
          <br />
          drag empty = select many · <kbd>Shift</kbd>+drag = lasso · drag a selected one to move all
          <br />
          <kbd>Space</kbd>+drag / scroll to pan · <kbd>Cmd</kbd>+scroll zoom
          <br />
          <b>⤓</b> export project to a file · <b>Import</b> to open one
        </div>
      </aside>

      <main className="stage">
        {ready && current ? <Canvas key={current.id} project={current} onImagesChange={handleImagesChange} /> : null}
        {toast ? <div className="toast">{toast}</div> : null}
      </main>
    </div>
  )
}
