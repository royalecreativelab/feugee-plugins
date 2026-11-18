# Feugee Hermes Bridge — Figma

Hermes drives the Figma file that is open in **Figma Desktop**, through a development plugin. Same model as Hermes Bridge for After Effects / Premiere: native MCP tools in every Hermes surface, a clear "open the plugin" error when it is closed.

Why it exists: the remote Figma MCP (`mcp.figma.com`, `use_figma`) runs scripts in Figma's cloud runtime, which only has Google + Figma-hosted fonts. Local fonts (Geist Serif, Feugee, Gilroy) fail there, so text had to be outlined. Scripts sent through this bridge run inside the desktop app: local fonts load, text stays live, `figma.createImage` works.

```
Hermes (Desktop / CLI / Telegram / cron)
   │ stdio MCP: mcp_servers.figma_bridge → bin/hb-figma-mcp.js
   ▼
bin/hb-figma-relay.js   127.0.0.1:3846  (auto-started, one per Mac, endpoint.json + bearer token)
   ▲ long-poll /poll, /result
plugin UI iframe (dist/ui.html) ⇄ plugin sandbox (dist/code.js) → Figma Plugin API, local fonts
```

## Tools (`mcp__figma_bridge__*`)

| Tool | What |
|---|---|
| `use_figma` | Run Plugin API JS in the open file (top-level `await`/`return`, one undo step per call, nodes serialized to `{id,name,type}`). |
| `get_screenshot` | `exportAsync` with real local fonts → file under `~/Library/Application Support/HermesBridgeFigma/shots/`. |
| `place_image` | Local image file → IMAGE fill on a node (`figma.createImage`). |
| `import_svg` | SVG file/string → editable vectors (`createNodeFromSvg`). |
| `list_fonts` | Fonts the desktop app can load (includes local). |
| `get_status` | Which files have the plugin open. |

Pass `fileKey` when the plugin runs in more than one file.

## Install (once)

1. `node build.js`
2. Figma Desktop → any design file → **Plugins → Development → Import plugin from manifest…** → pick `manifest.json` in this folder.
3. Hermes: `hermes -p royale mcp add figma_bridge --command <node> --args <abs>/bin/hb-figma-mcp.js` (already done for royale).

## Use

Open the file in Figma Desktop → **Plugins → Development → Feugee Hermes Bridge**. Keep the window open (it can be collapsed). Running another plugin closes it. The status bar shows `Connected` once any Hermes session has started the relay.

## Test

`node tests/smoke.js` — proxy ↔ relay ↔ fake plugin round trip, closed-plugin error, sandbox serializer under a figma mock.
