// Level-of-detail proxies for canvas images.
//
// Every ImageNode carries its pixels as a natural-resolution data URL, and a
// generation off gemini-3-pro-image is 1536x2048. Handing that straight to an
// <img> costs nW*nH*4 bytes of decoded bitmap — 12.6 MB apiece — and the browser
// keeps one for every node painted on the canvas, every row of the Layers list
// and every image inside every project card in the sidebar. Forty generations is
// half a gigabyte of tiles, which is the point where the compositor gives up:
//   ERROR:cc/tiles/tile_manager.cc  tile memory limits exceeded
//
// So downscale each node once into a few fixed tiers, hand the small one to
// anything drawing small, and fall back to the original only when a node is
// genuinely being viewed near full size. A card in the sidebar is ~150 px wide;
// asking for 1536 px of pixels to fill it is three orders of magnitude of waste.
//
// Two kinds of node come through here. A SAVED node's src is a cf-img:// URL
// (see pixels.ts): its tiers are URLs too, served — and built, once — by the
// main process, and Chromium's image cache does the keeping and evicting; none
// of the machinery below runs for it. Everything below is for a node that still
// holds a data URL because it has not been saved yet.

import { useEffect, useState } from 'react'
import { isStoredSrc, storedTier } from './pixels'

/** Longest-edge sizes we keep proxies at, ascending. */
export const TIERS = [160, 512, 1280] as const

/** How many proxies of each tier to keep once they are no longer on screen.
 *  Small ones are cheap and shared by the sidebar and Layers panel, so keep
 *  plenty; big ones are only worth holding for nodes recently looked at. */
const KEEP: Record<number, number> = { 160: 512, 512: 48, 1280: 12 }

const MAX_PARALLEL = 3

type Entry = { url: string; bytes: number; used: number }

/** `${nodeId}:${tier}` -> proxy. Map insertion order doubles as the LRU queue. */
const cache = new Map<string, Entry>()
const inFlight = new Set<string>()

/** A build waiting for a worker slot. `pinned` jobs (cover rendering) have a
 *  promise waiting on them and are never dropped, but always yield to whatever
 *  is on screen. */
type Job = { key: string; pinned: boolean; run: () => void }
const queue: Job[] = []
let active = 0

/** Counts render passes of the canvas (see useLodVersion). A proxy request is
 *  stamped with the pass it was made in, so the queue can tell "on screen right
 *  now" from "was on screen three pans ago". Without this the queue is FIFO and
 *  scrolling through a big canvas builds every node you passed, in order, while
 *  the ones actually in front of you wait at the back of the line. */
let pass = 0
const wantedPass = new Map<string, number>()

const listeners = new Set<() => void>()
let emitScheduled = false

/** Advances every time subscribers are told to repaint. Each proxy remembers the
 *  tick it was last asked for, which is how eviction knows what is on screen. */
let tick = 0

/** Proxies arrive one at a time; coalesce the notifications into a single frame
 *  so a canvas of forty nodes re-renders once, not forty times. */
function emit(): void {
  if (emitScheduled) return
  emitScheduled = true
  const flush = (): void => {
    emitScheduled = false
    tick++
    for (const l of listeners) l()
  }
  // rAF does not fire while the window is hidden (another Space, minimised),
  // and anything awaiting a proxy — cover rendering on save — would wait until
  // the user next looked at the app. A timer still runs, if throttled.
  if (document.visibilityState === 'hidden') setTimeout(flush, 0)
  else requestAnimationFrame(flush)
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Re-render the subscriber whenever a new proxy becomes available. One listener
 *  per component that paints many nodes, not one per node. */
export function useLodVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => subscribe(() => setV((x) => x + 1)), [])
  // Every render of the canvas is a new pass: the lodSrc calls that follow are
  // the current on-screen set, and anything not re-requested is off screen.
  pass++
  return v
}

function key(id: string, tier: number): string {
  return `${id}:${tier}`
}

function drop(k: string): void {
  const e = cache.get(k)
  if (!e) return
  URL.revokeObjectURL(e.url)
  cache.delete(k)
}

/** Trim a tier back to its KEEP limit — but never drop a proxy that was asked
 *  for this frame or last. If more nodes are on screen than the limit allows,
 *  the tier simply runs over: it cannot hold fewer than what is being painted.
 *  Evicting a visible proxy makes its node rebuild it, which evicts the next
 *  visible one, and the whole canvas blinks between tiers forever. */
function evict(tier: number): void {
  const limit = KEEP[tier] ?? 32
  const suffix = `:${tier}`
  const keys: string[] = []
  for (const k of cache.keys()) if (k.endsWith(suffix)) keys.push(k)
  let excess = keys.length - limit
  for (const k of keys) {
    if (excess <= 0) break
    const e = cache.get(k)
    if (!e || e.used >= tick - 1) continue
    drop(k)
    excess--
  }
}

function touch(k: string): void {
  const e = cache.get(k)
  if (!e) return
  e.used = tick
  // Re-insert to move it to the back of the LRU queue.
  cache.delete(k)
  cache.set(k, e)
}

/** Rank for picking the next build: the most recently wanted first, so the
 *  current screen always beats the previous one; pinned jobs last. */
function rank(j: Job): number {
  return j.pinned ? -1 : (wantedPass.get(j.key) ?? 0)
}

function pump(): void {
  while (active < MAX_PARALLEL && queue.length) {
    // Anything not asked for in the last two passes has scrolled out of view.
    // Drop it rather than spend a decode on a node nobody is looking at; if it
    // comes back it re-enqueues at the front.
    for (let i = queue.length - 1; i >= 0; i--) {
      const j = queue[i]
      if (!j.pinned && (wantedPass.get(j.key) ?? 0) < pass - 1) {
        queue.splice(i, 1)
        inFlight.delete(j.key)
      }
    }
    if (!queue.length) break
    let best = 0
    for (let i = 1; i < queue.length; i++) if (rank(queue[i]) > rank(queue[best])) best = i
    const job = queue.splice(best, 1)[0]
    active++
    job.run()
  }
}

/** Nodes carry their pixels as `data:` URLs, and the renderer's CSP has no
 *  `connect-src data:` — `fetch(node.src)` throws "Failed to fetch". Decode the
 *  base64 by hand instead, which also keeps the image decode itself off the main
 *  thread once it reaches createImageBitmap. */
function srcToBlob(src: string): Promise<Blob> {
  if (!src.startsWith('data:')) return fetch(src).then((r) => r.blob())
  const comma = src.indexOf(',')
  const head = src.slice(0, comma)
  const body = src.slice(comma + 1)
  const mime = /:(.*?)[;,]/.exec(head)?.[1] || 'image/png'
  if (!head.includes(';base64')) {
    return Promise.resolve(new Blob([decodeURIComponent(body)], { type: mime }))
  }
  const bin = atob(body)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return Promise.resolve(new Blob([arr], { type: mime }))
}

async function build(id: string, src: string, tier: number, pinned = false): Promise<void> {
  const k = key(id, tier)
  if (cache.has(k) || inFlight.has(k)) return
  inFlight.add(k)
  const run = (): void => {
    void (async () => {
      try {
        const blob = await srcToBlob(src)
        const bmp = await createImageBitmap(blob)
        const scale = Math.min(1, tier / Math.max(bmp.width, bmp.height))
        const w = Math.max(1, Math.round(bmp.width * scale))
        const h = Math.max(1, Math.round(bmp.height * scale))
        const oc = new OffscreenCanvas(w, h)
        const ctx = oc.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bmp, 0, 0, w, h)
        bmp.close()
        // WebP keeps the alpha that Extract cutouts depend on, at a fraction of
        // the PNG the node was stored as.
        const out = await oc.convertToBlob({ type: 'image/webp', quality: 0.82 })
        cache.set(k, { url: URL.createObjectURL(out), bytes: out.size, used: tick })
        evict(tier)
        emit()
      } catch {
        /* leave it uncached — callers fall back to the original src */
      } finally {
        inFlight.delete(k)
        active--
        pump()
      }
    })()
  }
  queue.push({ key: k, pinned, run })
  pump()
}

type Sized = { id: string; src: string; nW: number; nH: number }

/** 1x1 transparent GIF — costs nothing to decode. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** Past this shrink factor, showing the original "just until the proxy lands" is
 *  the whole bug: a sidebar card is 186 px wide, so falling back to a 1536 px
 *  source there decodes 12 MB to paint a postage stamp. Above the threshold we
 *  hold a blank frame for the fraction of a second the proxy takes instead. */
const NEVER_FULL_RATIO = 4

/**
 * The src to paint `node` with when it will occupy `wantPx` device pixels on its
 * longest edge. Returns the smallest proxy that still covers that size, the best
 * proxy already built while a better one renders, or the original when the node
 * is being viewed large (or is small enough that a proxy would not save
 * anything). Safe to call during render — generation is kicked off in the
 * background and `useLodVersion` re-renders when it lands.
 */
export function lodSrc(node: Sized, wantPx: number): string {
  const natural = Math.max(node.nW || 0, node.nH || 0)
  if (!natural) return node.src

  let want: number | null = null
  for (const t of TIERS) {
    if (t >= wantPx) {
      want = t
      break
    }
  }
  // Bigger on screen than our largest proxy, or so small natively that a proxy
  // would be a copy of the original: paint the real thing.
  if (want === null || natural <= want) return node.src

  // On disk already: the tier is just another URL to fetch.
  if (isStoredSrc(node.src)) return storedTier(node.src, want)

  const k = key(node.id, want)
  const hit = cache.get(k)
  if (hit) {
    touch(k)
    return hit.url
  }

  // Stamp before build(): it returns early when the job is already queued, and
  // the stamp is what keeps a still-visible job from being dropped as stale.
  wantedPass.set(k, pass)
  void build(node.id, node.src, want)

  // Nothing at the right tier yet. A smaller proxy is blurry but instant and
  // costs nothing extra; anything is better than decoding the full-res original
  // for a node that is 40 px wide.
  for (const t of TIERS) {
    if (t >= want) break
    const fk = key(node.id, t)
    const e = cache.get(fk)
    if (e) {
      touch(fk) // it is on screen right now, even if it is the wrong size
      return e.url
    }
  }
  // Nothing cached at all. Only reach for the original when it is close enough
  // to the size being drawn to be worth its decode.
  return natural / Math.max(wantPx, 1) >= NEVER_FULL_RATIO ? BLANK : node.src
}

/** A proxy at exactly `tier`, built if need be — for code that wants the pixels
 *  rather than something to put in an <img> right now (cover rendering). */
export function lodProxy(node: Sized, tier: (typeof TIERS)[number]): Promise<string> {
  const natural = Math.max(node.nW || 0, node.nH || 0)
  if (!natural || natural <= tier) return Promise.resolve(node.src)
  if (isStoredSrc(node.src)) return Promise.resolve(storedTier(node.src, tier))
  const k = key(node.id, tier)
  const hit = cache.get(k)
  if (hit) {
    touch(k)
    return Promise.resolve(hit.url)
  }
  // build() returns once the job is queued, not when it lands; the landing is
  // announced through the subscriber list like any other proxy. A failed build
  // never resolves this — callers race it against a timeout.
  return new Promise((resolve) => {
    const unsub = subscribe(() => {
      const e = cache.get(k)
      if (!e) return
      unsub()
      touch(k)
      resolve(e.url)
    })
    void build(node.id, node.src, tier, true)
  })
}

/** Forget proxies for nodes that no longer exist (project switch, deletions). */
export function pruneLod(liveIds: Iterable<string>): void {
  const live = new Set(liveIds)
  for (const k of [...cache.keys()]) {
    if (!live.has(k.slice(0, k.lastIndexOf(':')))) drop(k)
  }
}

/** Drop every tier for one node — call after its pixels are replaced in place,
 *  or the canvas keeps painting the pre-edit proxy. */
export function invalidateLod(id: string): void {
  for (const t of TIERS) drop(key(id, t))
  emit()
}

export function lodStats(): { entries: number; bytes: number; building: number; queued: number; pass: number } {
  let bytes = 0
  for (const e of cache.values()) bytes += e.bytes
  return { entries: cache.size, bytes, building: active, queued: queue.length, pass }
}

// Dev-only peek from the devtools console / CDP: window.__lodStats()
if (import.meta.env.DEV) (window as unknown as { __lodStats: typeof lodStats }).__lodStats = lodStats
