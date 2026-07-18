<!-- Canvas Forge in action: the infinite canvas with imported game-UI frames, extracted
     icons and reconstructed background scenes, the project sidebar, the Layers edge tab,
     and the tool toolbar. -->
![Canvas Forge: infinite canvas for AI image editing](docs/screenshot.png)

# Canvas Forge

A desktop **infinite canvas for AI image editing**. Paste an image, select any region, describe a change, and Gemini regenerates *only* that region in place. Built for game‑UI and asset work: extract elements onto transparency, remove backgrounds, restyle from references, run many edits at once, and save straight to disk.

Canvas Forge is an Electron app (macOS‑first) built with electron‑vite + React + TypeScript. Image processing runs locally in the renderer via the 2D canvas; the one exception is the precise background‑removal matting network, which runs natively in a worker process (see below). The Google Gemini API is called from the main process so your API key never touches the renderer.

## Features

### AI editing

- **Local region inpainting (generative fill).** Box‑ or brush‑select part of an image, type a prompt, and only that area is regenerated; the result is composited back over the pristine original so nothing outside the selection drifts. Small selections are edited in a **zoomed crop with a drawn marker** (the element is large enough for the model to actually see) — far more faithful than mask images for tiny icons.
- **✨ Magic select.** Describe an element ("the keys counter, top right") and Gemini object detection returns a tight bounding box as your selection. All selections are corner‑resizable to fine‑tune.
- **References that don't warp your image.** Box‑select regions of any image as visual guides for a generation. References are letterboxed to the artwork's aspect ratio before being sent — otherwise Gemini shapes its output after them and the result comes back stretched. An aspect guard fails loudly instead of compositing a squashed result.
- **Whole‑frame restyle.** Double‑click a frame to select it edge‑to‑edge, attach a reference, and re‑render the subject in the reference's style; the result is contain‑fitted to the original resolution, never distorted.
- **Extract, two algorithms.** *Isolate element* cuts the named element onto a transparent background with text removed; *Background only* deletes the foreground + text and keeps the reconstructed background scene.
- **Remove background, three engines.** *Remove BG* flood‑fills a flat background (instant, exact, no model). *Remove BG (AI)* has Gemini paint the background magenta and chroma‑keys it out, for complex scenes. *Remove BG (Precise)* runs a real matting network — **BiRefNet** at 1024×1024 — locally, then refines the mask against the original with a guided filter so edges follow actual hair and contours instead of a blurred silhouette. Always a single, deterministic result.
- **1–10 variations** per run, laid out side by side. **Model choice:** Best (Gemini 3 Pro Image / "Nano Banana Pro", best text fidelity) or Fast (Gemini 2.5 Flash Image).

### Concurrency

- **Many jobs at once.** Extractions and generations run as detached, concurrent jobs — fire several and keep working. Each shows an animated loading placeholder that is **draggable** (pre‑position where the result will land) and **cancellable** individually. New results are auto‑placed clear of existing images so nothing overlaps.

### Canvas & layers

- **Figma‑style Layers panel.** A slim `☰ Layers` tab on the sidebar edge docks a panel next to the project pane: every image is a named layer (double‑click to rename), elements sitting on top of a frame **nest under it automatically**, and each row has show/hide and bring‑forward/send‑backward controls. Transparent cutouts composite for real — drop a cutout on a frame and see through its gaps.
- **Multi‑select & group move.** Rubber‑band from empty canvas, `Shift`+drag a lasso from anywhere (even starting on a frame), `Shift`+click to add/remove one. Dragging any selected frame moves the whole group.
- **Full clipboard.** `Cmd/Ctrl+C` copy · `Cmd/Ctrl+X` cut · `Cmd/Ctrl+V` pastes **at your cursor**. The clipboard survives switching projects (cut in one project, paste into another, undo in either) and pasting an OS‑clipboard image (screenshot, browser image) always adds it to the canvas.
- **Non‑destructive.** Originals are always kept; results appear beside them. Per‑project undo history survives project switches.

### Projects & export

- **Local projects on disk.** Projects, prompt history and settings are real files in the app's user‑data folder. Export/import a project as a single file.
- **Save & share.** Save any image as a PNG with a "Reveal in Finder" shortcut, copy it to the OS clipboard (alpha preserved), or select many and **Export ZIP** — a single archive of all selected images as PNGs (dependency‑free ZIP writer).

## Keyboard shortcuts

- `V` move · `M` box select · `D` draw (brush) select · `W` ✨ magic
- Double‑click a frame = select the whole frame · `Shift`+drag = lasso · drag a selected frame = move the group
- `Space`+drag or scroll to pan · `Cmd`+scroll to zoom
- `Cmd/Ctrl+C/X/V` copy / cut / paste at cursor · `Cmd/Ctrl+D` duplicate
- `Cmd/Ctrl+S` save project · `Cmd/Ctrl+Z` undo · `Cmd/Ctrl+Enter` run the current Generate

## Getting started

```bash
npm install
npm run dev      # launches the desktop app
```

Provide a Google Gemini API key one of these ways (checked in order): a `GEMINI_API_KEY` (and optional `GEMINI_API_KEY_2…9` for quota fallback) in your environment, a `.env` / `.env.local` in the project root, or the app's settings file. **The key stays in the main process and is never bundled or committed** (`.env*` is git‑ignored).

## Build

```bash
npm run typecheck
npm run build         # type‑checks then builds
npm run build:mac     # package a macOS app (electron‑builder)
```

## Tech stack

electron‑vite · Electron · React · TypeScript · Google Gemini image API. Image processing (crop, feathered‑mask composite, magenta chroma‑key, reference letterboxing, guided‑filter matte refinement) is done with the 2D canvas — no `sharp`. The dev renderer is pinned to port 6771 so it never collides with another Vite project.

### Precise background removal

The matting network is the one native dependency (`onnxruntime-node`). It runs in a forked worker process rather than the renderer or the main process, for three reasons: the renderer can only reach ONNX Runtime through single‑threaded WebAssembly (~53 s per image at 1024² versus ~4 s native — a packaged `file://` renderer can't be cross‑origin isolated, so threaded WASM is unavailable); inference blocks for seconds, which would freeze main; and the model is ~500 MB resident, so a worker can be dropped after five idle minutes.

The model is **BiRefNet lite** (MIT, 224 MB), downloaded from Hugging Face on first use into `userData/Models/` and cached. Until it arrives, a bundled 4.5 MB U²‑Netp acts as an offline fallback. BRIA's RMBG models are deliberately *not* used: they score well but are CC BY‑NC, which is incompatible with this project's MIT licence.

Two ONNX Runtime session options are load‑bearing and must not be removed — see the comment in `src/main/matteWorker.ts`. Electron replaces the global allocator with V8's, which traps instead of failing soft on the large contiguous blocks ORT wants; without `enableCpuMemArena: false` the first run crashes, and without `enableMemPattern: false` the *second* run crashes.

## License

[MIT](LICENSE) © 2026 pumanitro
