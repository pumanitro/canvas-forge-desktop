// Shared types for the canvas + project store.

/** One image placed on the canvas. World coords + display size are in canvas
 *  units; nW/nH are the image's natural pixel size (what we send to the model). */
export type ImageNode = {
  id: string
  /** Where the pixels are: `cf-img://<projectId>/<id>/full` once saved (main
   *  serves the bytes on demand — see pixels.ts), a data URL until then. */
  src: string
  x: number // world x of top-left
  y: number // world y of top-left
  w: number // displayed width in world units
  h: number // displayed height in world units
  nW: number // natural pixel width
  nH: number // natural pixel height
  prompt?: string // the prompt this image was generated from (generated nodes only)
  model?: string // the model used to generate it
  createdAt?: number // epoch ms when it was generated
  transparent?: boolean // true for Extract results (transparent-background cutout)
  name?: string // user-given layer name (Layers panel)
  hidden?: boolean // hidden layers don't render and are skipped by band-select / Cmd+A
}

export type Project = {
  id: string
  name: string
  images: ImageNode[]
  createdAt: number
  updatedAt: number
}

/** What the sidebar knows about a project without opening it. Comes from the
 *  small `<id>.meta.json` sidecar, not the multi-hundred-MB project JSON. */
export type ProjectSummary = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  imageCount: number
  /** Small WebP data URL of the mini-map, painted by the renderer on save. */
  cover?: string
}

/** What a save hands back: for every node whose data URL main wrote to disk,
 *  the URL that now stands for it. `from` is the src that was sent, so a node
 *  edited again while the save was in flight keeps its newer pixels. */
export type StoredRewrite = {
  projectId: string
  seq: number
  map: Record<string, { from: string; to: string }>
}

/** Selection rectangle in the natural-pixel space of a single image. */
export type PixelBox = { x: number; y: number; w: number; h: number }

export type EditRequest = {
  image: string // data URL of the full source image
  bbox: PixelBox // selection bounding box in source-image natural pixels
  prompt: string
  model?: string
  // Free-draw "brush" selection: a center-line path + radius, in source pixels.
  stroke?: { points: { x: number; y: number }[]; radius: number }
  // Reference image crops (data URLs) used as visual guides for the new content.
  references?: string[]
}

export type EditResponse = { image: string } | { error: string }
