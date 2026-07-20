import { app, shell, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, Menu } from 'electron'
import { join } from 'path'
import { writeFileSync, readFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { geminiGenerate, geminiDetect, geminiVariants, hasKey } from './gemini'
import {
  loadProjects,
  saveProject,
  deleteProject,
  loadProjectOrder,
  saveProjectOrder,
  loadPrompts,
  addPrompt,
  getSettings,
  setSetting
} from './store'
import { ensureModel, matteInputSize, modelReady, runMatte, shutdownMatte, type ModelId } from './matte'

// DEV ONLY: expose a Chrome DevTools Protocol endpoint so the app can be driven /
// inspected/tested over CDP (like a browser tab). Never enabled in a packaged build.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9333')
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e0f13',
    autoHideMenuBar: true,
    title: 'Canvas Forge',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  // registerAccelerator:false → the shortcut still shows in the menu and text
  // inputs keep native copy/paste on macOS, but the key ALSO reaches the canvas
  // renderer (so canvas Undo / Copy-image / Select-all / node copy-paste work).
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[]) : []),
    { role: 'fileMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', registerAccelerator: false },
        { role: 'redo', registerAccelerator: false },
        { type: 'separator' },
        { role: 'cut', registerAccelerator: false },
        { role: 'copy', registerAccelerator: false },
        { role: 'paste', registerAccelerator: false },
        { role: 'selectAll', registerAccelerator: false }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// --- minimal ZIP writer (STORE method; PNGs are already compressed) — no dependency ---
function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const crc = crc32(f.data)
    const size = f.data.length
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 8) // method 0 = store
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(size, 18)
    lh.writeUInt32LE(size, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    local.push(lh, nameBuf, f.data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(size, 20)
    ch.writeUInt32LE(size, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    offset += lh.length + nameBuf.length + size
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuf, eocd])
}

function registerIpc(): void {
  // --- Gemini (never exposes the key to the renderer) ---
  ipcMain.handle('gemini:generate', async (_e, opts: { prompt: string; images: string[]; model: string; aspectRatio?: string }) => {
    try {
      const image = await geminiGenerate(opts)
      return { image }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'gemini failed' }
    }
  })

  // --- magic select (bounding-box detection) ---
  ipcMain.handle('gemini:detect', async (_e, opts: { image: string; description: string }) => {
    try {
      return await geminiDetect(opts)
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'detect failed' }
    }
  })

  // --- per-run prompt suggestions for a varied batch ---
  ipcMain.handle('gemini:variants', async (_e, opts: { image: string; prompt: string; count: number }) => {
    try {
      return await geminiVariants(opts)
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'suggest failed' }
    }
  })

  // --- projects / prompts / settings (files on disk) ---
  ipcMain.handle('projects:load', () => loadProjects())
  ipcMain.handle('projects:save', (_e, p) => saveProject(p))
  ipcMain.handle('projects:delete', (_e, id: string) => deleteProject(id))
  ipcMain.handle('projects:loadOrder', () => loadProjectOrder())
  ipcMain.handle('projects:saveOrder', (_e, ids: string[]) => saveProjectOrder(ids))
  ipcMain.handle('prompts:load', () => loadPrompts())
  ipcMain.handle('prompts:add', (_e, p: string) => addPrompt(p))
  ipcMain.handle('settings:get', () => ({ ...getSettings(), hasKey: hasKey() }))
  ipcMain.handle('settings:setKey', (_e, key: string) => {
    setSetting('geminiKey', key)
    return { hasKey: hasKey() }
  })

  // --- native file dialogs ---
  ipcMain.handle('project:export', async (_e, project: { name?: string }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export project',
      defaultPath: `${(project.name || 'project').replace(/[^a-z0-9-_ ]/gi, '_')}.cfproj.json`,
      filters: [{ name: 'Canvas Forge Project', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { canceled: true }
    writeFileSync(filePath, JSON.stringify(project))
    return { path: filePath }
  })

  ipcMain.handle('project:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import project',
      properties: ['openFile'],
      filters: [{ name: 'Canvas Forge Project', extensions: ['json'] }]
    })
    if (canceled || !filePaths[0]) return { canceled: true }
    try {
      return { project: JSON.parse(readFileSync(filePaths[0], 'utf8')) }
    } catch {
      return { error: 'Could not read that project file.' }
    }
  })

  // copy an image to the system clipboard (for pasting into other apps)
  ipcMain.handle('clipboard:writeImage', (_e, dataUrl: string) => {
    try {
      const img = nativeImage.createFromDataURL(dataUrl)
      clipboard.writeImage(img)
      // also expose the raw PNG (preserves alpha for apps that read public.png)
      const m = dataUrl.match(/base64,([\s\S]*)$/)
      if (m) {
        try {
          clipboard.writeBuffer('public.png', Buffer.from(m[1], 'base64'))
        } catch {
          /* format not supported on this platform */
        }
      }
      return { ok: true }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'copy failed' }
    }
  })

  ipcMain.handle('image:savePng', async (_e, { dataUrl, name }: { dataUrl: string; name: string }) => {
    const m = dataUrl.match(/^data:image\/\w+;base64,([\s\S]*)$/)
    if (!m) return { error: 'not an image' }
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save image',
      defaultPath: `${(name || 'image').replace(/[^a-z0-9-_ ]/gi, '_')}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    })
    if (canceled || !filePath) return { canceled: true }
    writeFileSync(filePath, Buffer.from(m[1], 'base64'))
    return { path: filePath }
  })

  // bulk export: bundle N images (data URLs) into a single .zip of PNGs
  ipcMain.handle('image:exportZip', async (_e, { items, name }: { items: { name: string; dataUrl: string }[]; name: string }) => {
    const files: { name: string; data: Buffer }[] = []
    const used = new Set<string>()
    items.forEach((it, i) => {
      const m = it.dataUrl.match(/^data:image\/\w+;base64,([\s\S]*)$/)
      if (!m) return
      const base = ((it.name || '').replace(/[^a-z0-9-_ ]/gi, '_').trim().slice(0, 60) || `image-${i + 1}`)
      let fname = `${base}.png`
      let n = 2
      while (used.has(fname.toLowerCase())) fname = `${base}-${n++}.png`
      used.add(fname.toLowerCase())
      files.push({ name: fname, data: Buffer.from(m[1], 'base64') })
    })
    if (!files.length) return { error: 'nothing to export' }
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export selected images as ZIP',
      defaultPath: `${(name || 'canvas-forge').replace(/[^a-z0-9-_ ]/gi, '_')}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
    })
    if (canceled || !filePath) return { canceled: true }
    writeFileSync(filePath, makeZip(files))
    return { path: filePath, count: files.length }
  })

  // reveal a saved file in Finder / Explorer (highlights it in its folder)
  ipcMain.handle('shell:showItem', (_e, filePath: string) => {
    if (filePath) shell.showItemInFolder(filePath)
    return { ok: true }
  })

  // --- background-removal matting -------------------------------------------------------------
  // The good model is 224 MB, so it is fetched on first use rather than committed. The renderer
  // asks what's on disk, triggers the download (with progress), then submits pixels.
  ipcMain.handle('matte:status', (_e, id: ModelId) => ({
    ready: modelReady(id),
    size: matteInputSize(id)
  }))

  ipcMain.handle('matte:ensure', async (e, id: ModelId) => {
    try {
      await ensureModel(id, (p) => {
        if (!e.sender.isDestroyed()) e.sender.send('matte:progress', { id, progress: p })
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('matte:run', async (_e, { id, rgba }: { id: ModelId; rgba: Uint8Array }) => {
    try {
      return { alpha: await runMatte(id, rgba) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}

// Only allow ONE instance — a second launch just focuses the existing window.
// (Prevents multiple instances fighting for GPU/network resources and crashing.)
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.canvasforge')
    // On macOS the bundle's .icns supplies the dock icon, but an unpackaged run has no
    // bundle — without this, `npm run dev` shows the stock Electron icon instead of ours.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon)
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
    buildAppMenu()
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // The matting worker is a detached child; without this it outlives the app on quit.
  app.on('before-quit', () => shutdownMatte())
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
