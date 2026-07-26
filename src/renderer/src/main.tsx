import './globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { startBridge } from './mcpBridge'

// Open the channel the MCP server drives the canvas through (main/mcp.ts).
startBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
