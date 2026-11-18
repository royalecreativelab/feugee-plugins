#!/usr/bin/env node
/* End-to-end check of the REAL ui.html in a real Chromium (headless shell via CDP).
   - serves the plugin folder over http
   - opens dist/ui.html, imports tests/fixtures/page.html through the URL path
   - intercepts the "build" message the UI would send to the Figma sandbox
   - asserts on the IR and writes tests/out/payload.json (+ screenshots)
   The Figma half is verified separately by running builder.js in Figma (use_figma). */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "out");
const PORT = 8790, CDP = 9333;
const CHROME = process.env.CHROME || path.join(os.homedir(),
  "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const SCHEME = process.env.SCHEME || "light";

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? "  PASS " : "  FAIL ") + name + (extra ? "  " + extra : ""));
  if (!ok) failures++;
}

async function cdpConnect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(150);
  }
  throw new Error("chrome did not come up");
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  const ready = new Promise((r) => (ws.onopen = r));
  return {
    ready,
    send(method, params) {
      return new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    },
    async eval(expr) {
      const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    },
    close() { ws.close(); }
  };
}

async function main() {
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "fg-chrome-"));
  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${prof}`, "--no-first-run",
    "--hide-scrollbars", "--force-color-profile=srgb", "about:blank"], { stdio: "ignore" });
  try {
    await sleep(600);
    const c = client(await cdpConnect());
    await c.ready;
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 680, deviceScaleFactor: 2, mobile: false });

    // ---------- 1. the panel itself ----------
    await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/dist/ui.html` });
    await sleep(1800); // past the splash
    const ui = await c.eval(`(() => {
      const cs = (s) => getComputedStyle(document.querySelector(s));
      return {
        title: document.querySelector('.brand-text h1').textContent,
        sub: document.querySelector('.brand-text p').textContent,
        tileFont: cs('.tile').fontSize,
        cards: document.querySelectorAll('.card').length,
        theme: document.documentElement.getAttribute('data-theme'),
        themeBtn: !!document.querySelector('#btnTheme'),
        ticker: !!document.querySelector('#feugeeTicker'),
        overflowX: document.querySelector('.content').scrollWidth > document.querySelector('.content').clientWidth,
        clipped: [...document.querySelectorAll('.tile span')].filter(s => s.scrollWidth > s.clientWidth + 1).map(s => s.textContent)
      };
    })()`);
    check("brand header", ui.title === "FEUGEE STUDIO" && /HTML Import v\d/.test(ui.sub), ui.sub);
    check("tile label is 9px (panel.css applied, jebakan #10)", ui.tileFont === "9px", ui.tileFont);
    check("cards rendered", ui.cards >= 4, String(ui.cards));
    check("theme toggle + ticker present", ui.themeBtn && ui.ticker);
    check("no horizontal overflow at 380px", !ui.overflowX);
    check("no clipped tile labels", ui.clipped.length === 0, ui.clipped.join(","));
    let shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "panel-dark.png"), Buffer.from(shot.data, "base64"));
    await c.eval(`document.querySelector('#btnTheme').click()`);
    await sleep(200);
    shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "panel-light.png"), Buffer.from(shot.data, "base64"));
    await c.eval(`document.querySelector('#btnTheme').click()`);

    // ---------- 2. import through the URL path ----------
    const payloadJson = await c.eval(`(async () => {
      window.__build = null;
      window.addEventListener('message', (e) => {
        const m = e.data && e.data.pluginMessage;
        if (m && m.type === 'build' && !window.__build) {
          window.__build = m;
          setTimeout(() => window.postMessage({ pluginMessage: { type: 'done', stats: m.docs.map(d => ({ label: d.label, nodes: 1 })) } }, '*'), 30);
        }
      });
      document.querySelector('[data-src=url]').click();
      document.querySelector('#inUrl').value = 'http://127.0.0.1:${PORT}/tests/fixtures/page.html';
      document.querySelector('[data-scheme=${SCHEME}]').click();
      if (!document.querySelector('[data-vp=mobile]').classList.contains('is-on')) document.querySelector('[data-vp=mobile]').click();
      document.querySelector('#optProxy').value = 'off';
      document.querySelector('[data-act=import]').click();
      for (let i = 0; i < 400 && !window.__build; i++) await new Promise(r => setTimeout(r, 100));
      if (!window.__build) return JSON.stringify({ error: document.querySelector('#status').textContent });
      await new Promise(r => setTimeout(r, 300));
      const m = window.__build;
      const assets = {};
      for (const k in m.assets) {
        const a = m.assets[k], o = {};
        if (a.svg) o.svg = a.svg;
        if (a.bytes) { let s = ''; for (let i = 0; i < a.bytes.length; i++) s += String.fromCharCode(a.bytes[i]); o.b64 = btoa(s); }
        assets[k] = o;
      }
      return JSON.stringify({ docs: m.docs, assets, source: m.source, status: document.querySelector('#status').textContent });
    })()`);
    const payload = JSON.parse(payloadJson);
    if (payload.error) throw new Error("UI reported: " + payload.error);
    fs.writeFileSync(path.join(OUT, "payload" + (SCHEME === "dark" ? "-dark" : "") + ".json"), JSON.stringify(payload));

    const d = payload.docs[0];
    const flat = [];
    (function walk(n, depth) { flat.push(Object.assign({ depth }, n)); (n.kids || []).forEach((k) => walk(k, depth + 1)); })(d.root, 0);
    const texts = flat.filter((n) => n.type === "text");
    const find = (re) => texts.find((t) => re.test(t.segs.map((s) => s.t).join("")));
    console.log("\n  doc", d.label, d.w + "x" + d.h, "nodes", flat.length, "texts", texts.length);

    check("two viewports captured", payload.docs.length === 2 && payload.docs[1].w === 375, payload.docs.map((x) => x.label).join(","));
    const h1 = find(/^Motion that moves people$/);
    check("h1 merged into ONE text with 3 styled ranges", !!h1 && h1.segs.length === 3, h1 && h1.segs.map((s) => s.t + "/" + s.wt + (s.it ? "i" : "")).join(" | "));
    check("h1 size/lh/letter-spacing", h1 && h1.segs[0].sz === 64 && Math.abs(h1.lh - 67.2) < 0.1 && h1.segs[0].ls === -1.5, h1 && [h1.segs[0].sz, h1.lh, h1.segs[0].ls].join("/"));
    const lead = find(/^We craft kinetic/);
    check("lead keeps bold + link ranges", lead && lead.segs.some((s) => s.wt === 700 && s.t === "kinetic") && lead.segs.some((s) => s.href === "https://example.com/reel" && s.deco === "UNDERLINE"));
    const para = find(/^Two lines of description/);
    check("card copy wraps (multi-line, fixed width)", para && para.lines >= 2 && para.auto === false, para && para.lines + " lines");
    const badge = flat.find((n) => /New reel/i.test(JSON.stringify(n.kids || [])) && n.tf);
    check("rotated badge keeps transform", !!badge && Math.abs(badge.tf[1] + Math.sin(8 * Math.PI / 180)) < 0.01, badge && badge.tf.join(","));
    check("badge text-transform -> UPPER", texts.some((t) => /New reel/.test(t.segs[0].t) && t.segs[0].cs === "UPPER"));
    const hero = flat.find((n) => n.fills && n.fills.some((f) => f.k === "lin"));
    check("hero gradient parsed (oklch stop converted)", hero && hero.fills.find((f) => f.k === "lin").stops.length === 2 && hero.fills.find((f) => f.k === "lin").angle === 135,
      hero && JSON.stringify(hero.fills.find((f) => f.k === "lin").stops.map((s) => [s.c.r.toFixed(2), s.c.g.toFixed(2), s.c.b.toFixed(2)])));
    check("hero radius 24", hero && hero.rad && hero.rad[0] === 24);
    const primary = flat.find((n) => n.fx && n.fills && n.fills.some((f) => f.k === "solid" && f.c.r > 0.9 && f.c.g < 0.45));
    check("primary button drop shadow", primary && primary.fx[0].k === "drop" && primary.fx[0].y === 8 && primary.fx[0].s === -6);
    const imgs = flat.filter((n) => n.img);
    check("images found + fetched", imgs.length >= 2 && imgs.every((n) => payload.assets[n.img] && payload.assets[n.img].b64), imgs.length + " img nodes");
    check("same image deduped across cards/viewports", Object.keys(payload.assets).filter((k) => payload.assets[k].b64).length === 1);
    check("blurred image keeps filter", imgs.some((n) => n.blur === 2));
    const svgs = flat.filter((n) => n.type === "svg");
    check("inline svgs serialized with resolved colours", svgs.length >= 2 && svgs.every((s) => /xmlns=/.test(s.svg) && !/currentColor/.test(s.svg)), svgs.length + " svg");
    const dashed = flat.find((n) => n.border && n.border.style === "dashed");
    check("dashed border", !!dashed && dashed.border.w[0] === 2);
    const input = flat.find((n) => /^Input/.test(n.name));
    check("input placeholder as text", input && input.kids && input.kids[0] && /you@studio/.test(input.kids[0].segs[0].t));
    const check1 = flat.find((n) => /^Input$/.test(n.name) && n.fills && n.fills[0] && n.fills[0].c && n.fills[0].c.b > 0.9 && n.fills[0].c.r < 0.2);
    check("checked checkbox drawn filled", !!check1);
    const nav = flat.find((n) => /^Nav/.test(n.name));
    check("nav: horizontal auto layout, space-between kept", nav && nav.al && nav.al.dir === "H" && nav.al.primary === "SPACE_BETWEEN" && nav.al.counter === "CENTER", nav && JSON.stringify(nav.al));
    const cards = flat.find((n) => /^Section \.cards/.test(n.name));
    check("cards row: auto layout H, gap 24", cards && cards.al && cards.al.dir === "H" && Math.abs(cards.al.gap - 24) < 0.6, cards && JSON.stringify(cards.al));
    const cardsKids = cards ? cards.kids.filter((k) => !k.abs) : [];
    check("cards grow -> FILL", cardsKids.length === 3 && cardsKids.every((k) => k.fillH), cardsKids.map((k) => k.fillH).join(","));
    const card = cardsKids[0];
    check("card with unequal margins (14 vs 6) is NOT forced into auto layout", card && !card.al);
    const cta = flat.find((n) => /^div \.cta/.test(n.name));
    check("cta row: auto layout H gap 12, full-width block (no width hug)", cta && cta.al && cta.al.dir === "H" && cta.al.gap === 12 && !cta.al.hugP, cta && JSON.stringify(cta.al));
    const btn = flat.find((n) => /^Button/.test(n.name) && n.kids && n.kids[0] && /Book a call/.test(n.kids[0].name));
    check("inline-block button hugs its label (text auto-width, no FILL)", btn && btn.al && btn.al.hugC && btn.kids[0].auto && !btn.kids[0].fillH, btn && JSON.stringify(btn.al));
    const foot = flat.find((n) => /^Footer/.test(n.name));
    check("footer: real padding 48/48 (not leftover 1207), text FILLs", foot && foot.al && foot.al.pl === 48 && foot.al.pr === 48 && foot.kids[0].fillH, foot && JSON.stringify(foot.al));
    const icon = flat.find((n) => /^div \.icon/.test(n.name));
    check("centred icon box -> CENTER/CENTER, no fake padding", icon && icon.al && icon.al.primary === "CENTER" && icon.al.counter === "CENTER" && icon.al.pl === 0, icon && JSON.stringify(icon.al));
    check("body wrapper melted into root", !flat.some((n) => n.name === "body"));
    check("missing web font matched from Google Fonts (Inter)", (d.fontsMatched || []).indexOf("Inter") >= 0, JSON.stringify(d.fontsMatched));
    const cb = flat.find((n) => n.kids && n.kids.some((k) => k.type === "svg" && k.name === "Check"));
    check("checked checkbox draws a check glyph", !!cb && cb.fills[0].c.b > 0.9);
    check("card with shadow spread clips (Figma only honours spread when clipping)", card && card.clip === 1);
    const h3 = find(/^Brand film$/), p3 = para;
    check("text stacking exact (h3 bottom + 6px margin = p top)", h3 && p3 && Math.abs(h3.y + h3.h + 6 - p3.y) < 0.05, h3 && p3 && (p3.y - h3.y - h3.h).toFixed(3));
    const note = find(/changes with the color scheme/);
    const noteBox = flat.find((n) => n.kids && n.kids.includes && n.kids.some((k) => k === note));
    const noteFrame = flat.find((n) => n.kids && n.kids.some((k) => k.type === "text" && /color scheme/.test(k.segs[0].t)));
    const noteBg = noteFrame && noteFrame.fills && noteFrame.fills[0] && noteFrame.fills[0].c;
    check("prefers-color-scheme forced to " + SCHEME, noteBg && (SCHEME === "dark" ? noteBg.r < 0.2 : noteBg.r > 0.95),
      noteBg && [noteBg.r, noteBg.g, noteBg.b].map((v) => v.toFixed(2)).join(","));
    check("foot text color", texts.some((t) => /Feugee Studio/.test(t.segs[0].t) && t.segs[0].c.r > 0.7));
    check("no NaN anywhere", !/NaN|Infinity/.test(JSON.stringify(payload.docs)));

    // ---------- 3. reference render of the page ----------
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: SCHEME }] });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/tests/fixtures/page.html` });
    await sleep(900);
    shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: d.w, height: d.h, scale: 1 } });
    fs.writeFileSync(path.join(OUT, "reference-" + SCHEME + ".png"), Buffer.from(shot.data, "base64"));
    // same page with the font Figma will use, for a fair pixel comparison
    await c.eval(`(async () => { const l = document.createElement('link'); l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=block';
      document.head.appendChild(l); await new Promise(r => l.onload = r); await document.fonts.ready;
      await Promise.all(['400','500','600','700','800','italic 400'].map(w => document.fonts.load(w + ' 16px Inter'))); })()`);
    await sleep(300);
    const hFm = await c.eval("document.documentElement.scrollHeight");
    shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: hFm, scale: 1 } });
    fs.writeFileSync(path.join(OUT, "reference-" + SCHEME + "-fm.png"), Buffer.from(shot.data, "base64"));
    c.close();
  } finally {
    chrome.kill("SIGKILL");
    server.kill("SIGKILL");
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
