import { app, shell, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, Menu } from 'electron'
import { join } from 'path'
import { writeFileSync, readFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { geminiGenerate, geminiDetect, hasKey } from './gemini'
import { loadProjects, saveProject, deleteProject, loadPrompts, addPrompt, getSettings, setSetting } from './store'

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

function registerIpc(): void {
  // --- Gemini (never exposes the key to the renderer) ---
  ipcMain.handle('gemini:generate', async (_e, opts: { prompt: string; images: string[]; model: string }) => {
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

  // --- projects / prompts / settings (files on disk) ---
  ipcMain.handle('projects:load', () => loadProjects())
  ipcMain.handle('projects:save', (_e, p) => saveProject(p))
  ipcMain.handle('projects:delete', (_e, id: string) => deleteProject(id))
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

  // reveal a saved file in Finder / Explorer (highlights it in its folder)
  ipcMain.handle('shell:showItem', (_e, filePath: string) => {
    if (filePath) shell.showItemInFolder(filePath)
    return { ok: true }
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
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
    buildAppMenu()
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
