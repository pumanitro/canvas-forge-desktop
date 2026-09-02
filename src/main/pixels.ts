// The cf-img:// protocol: how the renderer gets pixels.
//
//   cf-img://<projectId>/<nodeId>/full          the original bytes, as stored
//   cf-img://<projectId>/<nodeId>/160|512|1280  a proxy with that longest edge
//
// The renderer paints a node with the tier its on-screen size calls for (see
// renderer/src/lod.ts) and Chromium fetches, decodes and caches each URL like any
// other image — only for nodes that are actually painted, since the canvas
// culls to the viewport. A tier that is not on disk yet is made here on first
// request and written to lod/ for every later open.
//
// Encoding is where the time goes, not resizing: a 1280 px PNG costs ~110 ms of
// the main thread, the same JPEG ~4 ms at a sixth of the size. So a tier is a
// JPEG when the image is opaque and a PNG when any pixel is not — the alpha
// that Extract cutouts and Remove BG results rely on survives, and the rest
// (most of a project) is cheap. One decode of the original is shared by all of
// a node's tiers while they are being made.
//
// Responses carry immutable cache headers: a node's bytes never change under a
// given URL (an in-place replacement bumps ?v=), so a proxy that was fetched
// once is never fetched again in the session.

import { nativeImage, net, protocol, type NativeImage } from 'electron'
import { copyFileSync, mkdirSync, writeFileSync } from 'fs'
import { pathToFileURL } from 'url'
import {
  IMG_SCHEME,
  MIME_BY_EXT,
  TIERS,
  extOf,
  imgFileFor,
  isSafeId,
  lodDir,
  lodFileFor,
  lodPath
} from './store'

/** Must run before app.whenReady(): a scheme registered later is treated as a
 *  plain, non-standard scheme that fetch() and CORS refuse. */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMG_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: false
      }
    }
  ])
}

type Decoded = { img: NativeImage; width: number; height: number; opaque: boolean }

/** Originals decoded for tier building, kept for a few seconds so the other
 *  tiers of the same node (usually requested in the same frame) reuse them. */
const decoded = new Map<string, Decoded>()
/** Tier builds in flight, by file path. */
const building = new Map<string, Promise<string | null>>()

const JPEG_QUALITY = 88

function hasAlpha(img: NativeImage): boolean {
  const bmp = img.toBitmap() // BGRA, premultiplied
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] !== 255) return true
  return false
}

function decodeOriginal(key: string, full: string): Decoded | null {
  const hit = decoded.get(key)
  if (hit) return hit
  const img = nativeImage.createFromPath(full)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  const d: Decoded = { img, width, height, opaque: !hasAlpha(img) }
  decoded.set(key, d)
  setTimeout(() => decoded.delete(key), 8000).unref()
  return d
}

/** The tier file for one node, made if need be. null when the original cannot
 *  be decoded — the caller serves the original instead. */
function ensureTier(pid: string, nid: string, full: string, size: number): Promise<string | null> {
  const have = lodFileFor(pid, nid, size)
  if (have) return Promise.resolve(have)
  const key = `${pid}/${nid}/${size}`
  const inFlight = building.get(key)
  if (inFlight) return inFlight
  const job = (async () => {
    const t0 = Date.now()
    const d = decodeOriginal(`${pid}/${nid}`, full)
    if (!d) return null
    mkdirSync(lodDir(pid), { recursive: true })
    const longest = Math.max(d.width, d.height)
    let file: string
    if (size >= longest * 0.8 && extOf(full) === 'png') {
      // A proxy that would barely be smaller than the original is not worth an
      // encode: the original stands in for it.
      file = lodPath(pid, nid, size, 'png')
      copyFileSync(full, file)
    } else {
      const small =
        d.width >= d.height
          ? d.img.resize({ width: Math.min(size, d.width), quality: 'best' })
          : d.img.resize({ height: Math.min(size, d.height), quality: 'best' })
      file = lodPath(pid, nid, size, d.opaque ? 'jpg' : 'png')
      writeFileSync(file, d.opaque ? small.toJPEG(JPEG_QUALITY) : small.toPNG())
    }
    console.log(
      `[pixels] ${key} from ${d.width}x${d.height} ${d.opaque ? 'jpg' : 'png'} in ${Date.now() - t0} ms`
    )
    return file
  })().finally(() => building.delete(key))
  building.set(key, job)
  return job
}

function reply(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain' } })
}

async function serveFile(file: string): Promise<Response> {
  const mime = MIME_BY_EXT[extOf(file)] ?? 'application/octet-stream'
  const headers = {
    'content-type': mime,
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*'
  }
  const r = await net.fetch(pathToFileURL(file).toString())
  if (!r.ok) return reply(404, 'missing')
  return new Response(r.body, { status: 200, headers })
}

/** Runs after app.whenReady(). */
export function registerImageProtocol(): void {
  protocol.handle(IMG_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return reply(400, 'bad url')
    }
    const pid = url.hostname
    const [nid, tier] = url.pathname.split('/').filter(Boolean)
    if (!isSafeId(pid, true) || !isSafeId(nid) || !tier) return reply(400, 'bad path')
    const full = imgFileFor(pid, nid)
    if (!full) return reply(404, `no image ${pid}/${nid}`)
    if (tier === 'full') return serveFile(full)
    const size = Number(tier)
    if (!(TIERS as readonly number[]).includes(size)) return reply(400, 'bad tier')
    let file: string | null = null
    try {
      file = await ensureTier(pid, nid, full, size)
    } catch (e) {
      console.error('[pixels] tier build failed:', e instanceof Error ? e.message : e)
    }
    // An undecodable format has no proxy: the original is the right answer anyway.
    return serveFile(file ?? full)
  })
}
