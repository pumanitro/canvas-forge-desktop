// The "how do I point an AI agent at this canvas?" panel.
//
// It exists because the answer has a step people can't guess and will hit every single time:
// an MCP client reads its server list ONCE, at startup, so `mcp add` appears to do nothing
// until the client restarts. A line of text in the sidebar can't carry that. This can — and it
// shows LIVE status, so "did it work?" is answerable from inside the app instead of by squinting
// at the agent's error message.

import { useEffect, useState } from 'react'

export type McpInfo = {
  enabled: boolean
  port: number | null
  url: string | null
  error: string | null
  toolCount: number
  toolNames: string[]
  lastCallAt: number | null
  clients: { name: string; at: number; calls: number }[]
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/** Copy-to-clipboard button that confirms itself, so a click never looks like a no-op. */
function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={'mcp-copy' + (done ? ' done' : '')}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          // Clipboard API is focus-gated in some situations; the legacy path still works.
          const ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        setDone(true)
        window.setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? '✓ Copied' : label}
    </button>
  )
}

export default function McpPanel({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<McpInfo | null>(null)

  // Poll while open: the interesting fields (who is attached, when they last called) change
  // underneath us as the user sets their agent up, and a stale panel would be worse than none.
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      window.api
        .mcpInfo()
        .then((i) => {
          if (alive) setInfo(i as McpInfo)
        })
        .catch(() => {})
    }
    tick()
    const t = window.setInterval(tick, 2500)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const url = info?.url ?? 'http://127.0.0.1:4830/mcp'
  const addCmd = `claude mcp add --transport http canvas-forge ${url}`
  const jsonCfg = JSON.stringify({ mcpServers: { 'canvas-forge': { type: 'http', url } } }, null, 2)
  const live = !!info?.port
  const attached = info?.clients ?? []

  return (
    <div className="mcp-backdrop" onClick={onClose}>
      <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <span className={'mcp-dot' + (live ? ' on' : '')} />
            Agent access
          </h2>
          <button className="mcp-x" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </header>

        <div className="mcp-body">
          <p className="mcp-lede">
            Canvas Forge speaks <b>MCP</b>, so an AI agent can see what you have selected and
            generate straight onto this canvas — the results appear here, laid out clear of your
            existing art, exactly as if you had clicked the buttons yourself.
          </p>

          {/* --- status ------------------------------------------------------------------ */}
          <section className="mcp-status">
            {info && !info.enabled ? (
              <div className="mcp-bad">Disabled by CANVAS_FORGE_MCP=0 — remove it and restart.</div>
            ) : info?.error ? (
              <div className="mcp-bad">{info.error}</div>
            ) : live ? (
              <>
                <div className="mcp-row">
                  <span className="mcp-k">Listening</span>
                  <code className="mcp-url">{url}</code>
                  <Copy text={url} label="Copy URL" />
                </div>
                <div className="mcp-row">
                  <span className="mcp-k">Tools</span>
                  <span>{info?.toolCount ?? 0} available</span>
                </div>
                <div className="mcp-row">
                  <span className="mcp-k">Connected</span>
                  {attached.length ? (
                    <span>
                      {attached.map((c) => (
                        <span key={c.name} className="mcp-client">
                          {c.name} <em>({ago(c.at)})</em>
                        </span>
                      ))}
                      {info?.lastCallAt ? (
                        <em className="mcp-dim"> · last call {ago(info.lastCallAt)}</em>
                      ) : null}
                    </span>
                  ) : (
                    <span className="mcp-dim">nothing attached yet — follow the steps below</span>
                  )}
                </div>
              </>
            ) : (
              <div className="mcp-dim">Starting…</div>
            )}
          </section>

          {/* --- connect ----------------------------------------------------------------- */}
          <h3>Connect Claude Code</h3>
          <ol className="mcp-steps">
            <li>
              Run this once, in any terminal:
              <div className="mcp-code">
                <code>{addCmd}</code>
                <Copy text={addCmd} />
              </div>
            </li>
            <li>
              <b>Restart the session.</b> A client reads its server list only when it starts, so the
              tools will not appear in a session that was already running.
              <div className="mcp-code">
                <code>claude --continue</code>
                <Copy text="claude --continue" />
              </div>
              <span className="mcp-dim">
                — reconnects while keeping your conversation. A brand-new session works too.
              </span>
            </li>
            <li>
              Check it above: your client should show up next to <b>Connected</b>. Then just ask —
              <i>“look at what I’ve selected”</i>.
            </li>
          </ol>

          <h3>Any other client</h3>
          <p className="mcp-dim">
            It is plain Streamable HTTP on localhost. Claude Desktop and friends take a config
            block; a browser tab cannot reach <code>127.0.0.1</code>, so claude.ai will not work.
          </p>
          <div className="mcp-code">
            <pre>{jsonCfg}</pre>
            <Copy text={jsonCfg} />
          </div>

          {/* --- capabilities ------------------------------------------------------------ */}
          <h3>What an agent can do here</h3>
          <ul className="mcp-caps">
            <li>
              <b>See</b> the image you have selected, at whatever resolution it needs
            </li>
            <li>
              <b>Generate</b> a change into the region you marked — 1-10 variations, one prompt per
              run if you want to explore different ideas at once
            </li>
            <li>
              <b>Extract</b> an element to transparency, <b>remove backgrounds</b>, <b>restyle</b>{' '}
              with a built-in style guide
            </li>
            <li>
              <b>Paste</b> images in, <b>copy</b> them to your clipboard, switch projects
            </li>
          </ul>
          <p className="mcp-note">
            Every tool defaults to your current selection —{' '}
            <b>clicking an image in the app is the instruction</b>. Nothing works while this window
            is closed: the tools live inside the app, so leave it running.
          </p>
        </div>
      </div>
    </div>
  )
}
