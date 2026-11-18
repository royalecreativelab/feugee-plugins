#!/usr/bin/env node
/* Smoke test against REAL websites through the actual ui.html URL path,
   using tools/cors-proxy.py as the proxy. Checks the pipeline survives
   arbitrary markup: no exceptions, sane IR, images resolved, timing.
   usage: node tests/smoke-url.js https://example.com https://...        */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const PORT = 8791, CDP = 9334, PROXY = 8787;
const CHROME = process.env.CHROME || path.join(os.homedir(),
  "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const URLS = process.argv.slice(2).length ? process.argv.slice(2) : ["https://example.com/"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const p = list.find((t) => t.type === "page");
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(150);
  }
  throw new Error("no chrome");
}
function client(url) {
  const ws = new WebSocket(url); let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  return {
    ready: new Promise((r) => (ws.onopen = r)),
    send(method, params) { return new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); }); },
    async eval(expr) {
      const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    },
    close() { ws.close(); }
  };
}

(async () => {
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
  const proxy = process.env.NO_PROXY_SPAWN ? { kill() {} } : spawn("python3", [path.join(ROOT, "tools", "cors-proxy.py"), String(PROXY)], { stdio: "ignore" });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "fg-smoke-"));
  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${prof}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  let bad = 0;
  try {
    await sleep(700);
    const c = client(await target()); await c.ready;
    await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 680, deviceScaleFactor: 1, mobile: false });
    for (const url of URLS) {
      await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/dist/ui.html` });
      await sleep(1600);
      const t0 = Date.now();
      const res = await c.eval(`(async () => {
        window.__b = null;
        window.addEventListener('message', (e) => { const m = e.data && e.data.pluginMessage;
          if (m && m.type === 'build' && !window.__b) { window.__b = m;
            setTimeout(() => window.postMessage({ pluginMessage: { type: 'done', stats: m.docs.map(d => ({ label: d.label })) } }, '*'), 20); } });
        document.querySelector('#optProxy').value = '${process.env.PROXY || "auto"}';
        document.querySelector('#optScripts').checked = ${process.env.SCRIPTS === "1"};
        document.querySelector('#inUrl').value = ${JSON.stringify(url)};
        document.querySelector('[data-act=import]').click();
        for (let i = 0; i < 900 && !window.__b; i++) {
          await new Promise(r => setTimeout(r, 100));
          if (document.querySelector('#led').classList.contains('err')) break;
        }
        if (!window.__b) return { error: document.querySelector('#status').textContent };
        const d = window.__b.docs[0]; let n = 0, t = 0, al = 0, svg = 0, img = 0;
        (function w(x) { n++; if (x.type === 'text') t++; if (x.al) al++; if (x.type === 'svg') svg++; if (x.img) img++; (x.kids || []).forEach(w); })(d.root);
        const assets = {};
        for (const k in window.__b.assets) { const a = window.__b.assets[k], o = {};
          if (a.svg) o.svg = a.svg;
          if (a.bytes) { let s = ''; for (let i = 0; i < a.bytes.length; i++) s += String.fromCharCode(a.bytes[i]); o.b64 = btoa(s); }
          assets[k] = o; }
        window.__payload = JSON.stringify({ docs: window.__b.docs, assets });
        return { title: d.title, w: d.w, h: d.h, nodes: n, texts: t, autolayout: al, svgs: svg, imgNodes: img,
          assets: Object.keys(window.__b.assets).length, fonts: d.fontsMatched, bytes: JSON.stringify(window.__b.docs).length,
          nan: /NaN|Infinity/.test(JSON.stringify(window.__b.docs)) };
      })()`);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (!res.error) {
        const name = "smoke-" + new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-") + ".json";
        fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
        fs.writeFileSync(path.join(__dirname, "out", name), await c.eval("window.__payload"));
      }
      // app-shell fixture: 3 x 700px sections inside an inner scroller
      if (/shell\.html$/.test(url) && !(res.h >= 2100)) res.error = "app shell not unrolled (h=" + res.h + ")";
      if (res.error || res.nan || res.texts === 0) bad++;
      console.log((res.error || res.nan || res.texts === 0 ? "FAIL " : "OK   ") + url + "  " + secs + "s  " + JSON.stringify(res));
    }
    c.close();
  } finally { chrome.kill("SIGKILL"); server.kill("SIGKILL"); proxy.kill("SIGKILL"); }
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
