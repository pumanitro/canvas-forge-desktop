// Where a node's pixels come from, on the renderer side.
//
// A node that has been saved carries `src = cf-img://<projectId>/<nodeId>/full`
// (about 40 bytes) rather than its base64: the main process serves those bytes
// on demand — and downscaled tiers of them — over the cf-img protocol
// (main/pixels.ts). Painting needs nothing here: <img src={lodSrc(node)}> is a
// URL Chromium fetches and decodes for the nodes actually on screen. Anything
// that needs the PIXELS as data — a Gemini call, the clipboard, Save PNG, an
// export — asks resolvePixels() for them, which fetches that one node's
// original bytes at that moment and nothing else.
//
// A node that was created or edited since the last save still holds a data URL;
// the next save writes it to disk and swaps the URL in (see Studio.persist).

const IMG_URL_PREFIX = 'cf-img://'

export function isStoredSrc(src: string): boolean {
  return src.startsWith(IMG_URL_PREFIX)
}

/** `cf-img://p/n/full?v=2` → `cf-img://p/n/512?v=2`. */
export function storedTier(src: string, tier: number | 'full'): string {
  const q = src.indexOf('?')
  const base = q < 0 ? src : src.slice(0, q)
  const tail = q < 0 ? '' : src.slice(q)
  return base.slice(0, base.lastIndexOf('/') + 1) + tier + tail
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

/** The node's original bytes as a data URL — what every image operation
 *  consumes. A data URL comes back as-is; a stored node is fetched. */
export async function resolvePixels(node: { src: string }): Promise<string> {
  const { src } = node
  if (!isStoredSrc(src)) return src
  const r = await fetch(src)
  if (!r.ok) throw new Error(`Could not read that image from the project (${r.status}).`)
  return blobToDataUrl(await r.blob())
}

/** resolvePixels for a batch of runs: one fetch shared by every run, with the
 *  failure delivered where the runs await it rather than as an unhandled
 *  rejection the moment it happens. */
export function pixelsOf(node: { src: string }): Promise<string> {
  const p = resolvePixels(node)
  p.catch(() => {})
  return p
}
