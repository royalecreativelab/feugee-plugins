# Feugee HTML Import (Figma)

Imports a web page into Figma as **native, editable layers**: frames with auto layout, editable text (mixed weights, italics, links, letter spacing, line height), real image fills, and SVG icons as vectors. A local alternative to html.to.design that needs no account, no import quota and no Chrome extension.

## Install (development plugin)

1. `npm run build` (Node only, no dependencies). This writes `dist/`.
2. Figma desktop → **Plugins → Development → Import plugin from manifest…** → pick `manifest.json`.
3. Run **Feugee HTML Import**.

## Sources (card 01)

| Mode | Use for |
|---|---|
| **URL** | Public pages. Fetched through a CORS proxy (see below). |
| **HTML** | Paste markup or a full document. Set a base URL so relative assets resolve. |
| **File** | A `.html` file, or a `.json` made by the capture snippet. |
| **Capture** | Pages behind a login, on localhost/a private network, or in a specific UI state. Copy the snippet, paste it in that tab's DevTools console, then drop the downloaded `.json` here. Replaces html.to.design's Chrome extension. |

Options: desktop / tablet / mobile viewports (several at once, laid out side by side), light or dark page scheme, auto layout, flatten wrapper divs, SVG as vectors, match fonts via Google Fonts, run page scripts. Selecting an imported frame enables **Re-import** (also a relaunch button in the Figma sidebar).

## CORS proxy

Browsers block reading other sites from a plugin. Options in the panel:

- **Auto (default)**: local proxy first, then public ones; the first that works is reused for every asset of that import. Errors list each attempt (`local: not running · allorigins: timeout`).
- **Local (recommended)**: install once with `bash tools/install-proxy.sh` (LaunchAgent, starts at login, 127.0.0.1:8787 only; `--uninstall` to remove), or run `python3 tools/cors-proxy.py` by hand. Your URLs never leave the machine.
- Public: allorigins, codetabs. Unreliable (often down), fine for public pages, avoid for anything private. corsproxy.io was removed: it now answers 401 without an API key.
- Custom: any `https://…{url}` template.

## What it handles

- Auto layout inferred from real CSS (flex, grid rows/columns, block flow): padding, gap, alignment, `space-between`, HUG vs FILL. Containers with uneven spacing stay as plain frames instead of faking auto layout.
- App-shell pages (Framer, many SPAs) that scroll an inner container instead of the document are unrolled to full height.
- Transforms (rotate, scale, nested) via `relativeTransform`; shadows (incl. spread), blur, backdrop blur, blend modes, gradients (linear/radial), dashed/dotted borders, per-side borders and radii.
- Fonts: maps to what Figma has (generic families like `system-ui` or `monospace` resolved to installed faces). With *Match fonts* on, the page is measured with the same Google font Figma will use, so lines wrap identically. Substitutions are listed in the report.
- Form controls: inputs with placeholder or value, checked checkbox/radio glyphs.

## Known limits

- Canvas, video, iframes and WebGL are imported as their poster or a placeholder.
- Hover/variant components are not generated.
- Pages that only render after JS: tick *Run page scripts*, or use **Capture**.

## Tests

```bash
npm test          # build + e2e in real headless Chromium (light + dark) + builder in a strict Figma API mock
npm run test:smoke  # network: real sites through the local proxy, then the strict builder mock
npm run figma-run -- payload.json 0 0   # compose a use_figma script to rebuild a capture in a real Figma file
```

Chromium comes from the Playwright cache (`CHROME=/path/to/chrome` to override).

## Layout

`src/capture.js` reads the rendered DOM into a layout IR (browser side, no Figma API). `src/builder.js` turns the IR into nodes (Figma sandbox, no DOM). `src/loader.js` fetches and renders sources in a sandboxed iframe. `src/ui.html` + `src/ui.js` + `src/htmlimport.css` are the panel; the canonical Feugee `panel.css` is inlined byte-identical at build time from `../Feugelign_CEP/css/panel.css`.
