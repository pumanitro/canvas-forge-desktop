// The sidebar card for a project: a mini-map of its newest images, painted into
// one small WebP and stored in the project's meta sidecar. Painted here, in the
// renderer, because that is where the image decoders are; the main process just
// files it. Without this the card had to be built from the project's images —
// which meant every project had to be loaded to draw the sidebar at all.

import type { ImageNode } from './types'
import { lodProxy } from './lod'
import { isStoredSrc } from './pixels'

export const COVER_W = 186
export const COVER_H = 104
/** Newest images a cover paints. At 186 px wide, more than this is confetti. */
export const COVER_MAX = 12

const DPR = 2

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('cover: image failed'))
    // A cf-img tier is another origin: without this the canvas it is drawn on
    // is tainted and convertToBlob refuses. The protocol answers CORS.
    if (isStoredSrc(url)) img.crossOrigin = 'anonymous'
    img.src = url
  })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('cover: proxy timed out')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

/** Returns a `data:image/webp` URL, or null when there is nothing to paint. */
export async function renderCover(images: ImageNode[]): Promise<string | null> {
  const visible = images.filter((n) => !n.hidden)
  const shown = visible.length > COVER_MAX ? visible.slice(-COVER_MAX) : visible
  if (!shown.length) return null

  // Frame the card around what it paints (not the whole canvas), so a project
  // whose newest images sit in one corner still fills its card.
  const minX = Math.min(...shown.map((n) => n.x))
  const minY = Math.min(...shown.map((n) => n.y))
  const maxX = Math.max(...shown.map((n) => n.x + n.w))
  const maxY = Math.max(...shown.map((n) => n.y + n.h))
  const bw = maxX - minX || 1
  const bh = maxY - minY || 1
  const pad = 8
  const s = Math.min((COVER_W - 2 * pad) / bw, (COVER_H - 2 * pad) / bh)
  const offX = (COVER_W - bw * s) / 2 - minX * s
  const offY = (COVER_H - bh * s) / 2 - minY * s

  const oc = new OffscreenCanvas(COVER_W * DPR, COVER_H * DPR)
  const ctx = oc.getContext('2d')
  if (!ctx) return null
  ctx.scale(DPR, DPR)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // The 160 px tier is plenty for a 186 px card, and the same proxy the Layers
  // panel uses, so it is usually already built.
  const urls = await Promise.all(shown.map((n) => withTimeout(lodProxy(n, 160), 10000).catch(() => null)))
  let painted = 0
  for (let i = 0; i < shown.length; i++) {
    const url = urls[i]
    if (!url) continue
    try {
      const img = await loadImage(url)
      const n = shown[i]
      ctx.drawImage(img, n.x * s + offX, n.y * s + offY, n.w * s, n.h * s)
      painted++
    } catch {
      /* skip this one */
    }
  }
  if (!painted) return null
  const blob = await oc.convertToBlob({ type: 'image/webp', quality: 0.8 })
  return blobToDataUrl(blob)
}
