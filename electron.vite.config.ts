import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // Pin the dev renderer to its own port so it never collides with another Vite
    // project on the default 5173 (which would make Electron load the wrong app).
    server: { port: 6771, strictPort: true },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
