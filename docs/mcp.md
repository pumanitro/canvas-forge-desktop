# Driving Canvas Forge from an AI agent (MCP)

Canvas Forge ships an [MCP](https://modelcontextprotocol.io) server **inside the app**. While
the app is running, an agent can read what you have selected, look at the actual pixels, and
generate straight onto your canvas — the results appear in your window, laid out clear of your
existing art, exactly as if you had clicked Generate yourself.

## Connect

**In the app:** click **Agent access** at the bottom of the sidebar. The panel there carries the
whole procedure with copy buttons, and shows live status — which port it is on, how many tools,
and *which clients are actually attached and when they last called*. That last part matters
because a listening port and a connected agent look identical from the outside, so "did it work?"
is otherwise unanswerable without reading the agent's error message.

The chip itself is the at-a-glance version: grey = off, gold = ready, green = an agent is attached.

Or straight from a terminal, with Canvas Forge running:

```bash
claude mcp add --transport http canvas-forge http://127.0.0.1:4830/mcp
claude --continue     # a client reads its server list only at startup — see the gotcha below
```

Any MCP client works — it is plain Streamable HTTP on localhost. The address is also written to
`<userData>/mcp.json`, and `GET /health` answers without a handshake if you just want to know
whether the app is up.

| Env var | Effect |
| --- | --- |
| `CANVAS_FORGE_MCP=0` | Don't start the server at all |
| `CANVAS_FORGE_MCP_PORT` | Listen somewhere other than 4830 |

The server binds to `127.0.0.1` only and rejects non-localhost `Origin` headers, but it has no
authentication: anything already running on your machine can reach it, like any dev server.

## The tools

Everything defaults to **what is selected in the app**, so pointing at an image with the mouse is
usually the whole argument.

| Tool | What it does |
| --- | --- |
| `get_state` | Open project, the images (id, position, size, originating prompt), the selection, running jobs. Start here. Paged — see below. |
| `get_image` | The actual pixels, so the agent can look. Downscaled to 1024px by default. |
| `select` | Move the app's selection; optionally mark a region inside an image. |
| `add_image` | Paste a base64/data-URL image onto the canvas at natural resolution. |
| `copy_image` | Put an image on the OS clipboard, alpha intact. |
| `duplicate` / `delete_images` | Copy or remove images (both undoable with Cmd+Z). |
| `generate` | The main one — regenerate with your change applied to the marked region. 1-10 runs, optional per-run prompts, optional reference images. |
| `extract` | Cut one element out to a transparent PNG, or keep only the background. |
| `remove_background` | `mechanical` / `ai` / `precise` — the same three engines as the toolbar. |
| `restyle` | Re-render a whole image in a built-in style guide (`list_style_guides` for the ids). |
| `job_status` | Poll a job dispatched with `wait: false`. |
| `list_projects` / `open_project` | Switch which project the app is showing. |

Regions are given in the image's **natural pixels**, origin top-left. Positions returned by
`get_state` are world coordinates on the infinite canvas.

Generation tools block until the results land (~15-60s per run) and return the finished images
for the agent to judge. Pass `wait: false` to get a `jobId` back immediately instead.

### Sizes

A project here can hold hundreds of images, each carrying the (sometimes ~800-character) prompt
that produced it — listing a 357-image canvas whole is ~370 KB of JSON, which overflows an
agent's tool-result limit outright rather than merely being slow. So:

- `get_state` lists **50 images at a time** (`limit`, max 200, plus `offset`) with prompts clipped
  to 140 characters. `imageCount` and `shown` tell you what you're looking at. The **selection is
  always returned in full** under `selection.images`, whatever page you asked for.
- `get_image` returns at most **8 images** per call, downscaled to 1024px (`maxSize`). When it
  clips, it says so.

### Gotcha: clients snapshot the server at connect time

An MCP client reads the tool list **once, when it connects**. If you change a tool's schema in
`src/main/mcp.ts`, a client that is already connected keeps the old one — and will silently drop
arguments the old schema didn't declare. Restart the client (for Claude Code, `claude --continue`
keeps the conversation) after changing tool definitions.

## How it works

```
agent ──HTTP/JSON-RPC──▶ main process ──IPC──▶ renderer ──▶ the same callbacks the buttons call
                          (src/main/mcp.ts)     (src/renderer/src/mcpBridge.ts)
```

The server deliberately does **not** re-implement anything. Every tool forwards to the running
renderer, which executes it through the identical code path the UI uses — `generateOn`,
`doExtract`, `doRemoveBg`, `restyleOn`, all landing in `runGeneration`. That is what guarantees
an agent's results carry the same prompt engineering, the same tone lock and magenta keying, and
the same collision-free placement as a hand-clicked run, and that the two can't drift apart.

It also means the tools only see the **currently open project** — `open_project` first if you
need another one.
