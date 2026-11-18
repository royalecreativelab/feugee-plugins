/* =========================================================
   FEUGEE HTML IMPORT - ui.js (wiring)
   Shell behaviour mirrors js/modes.js of the CEP suite (theme toggle,
   splash, ticker, status bar) - re-implemented because modes.js talks to
   CEP / ExtendScript, which does not exist inside Figma.
   ========================================================= */
(function () {
  "use strict";

  var VERSION = "/*@VERSION*/";
  var VIEWPORTS = {
    desktop: { w: 1440, h: 900, label: "Desktop 1440" },
    tablet: { w: 768, h: 1024, label: "Tablet 768" },
    mobile: { w: 375, h: 812, label: "Mobile 375" }
  };
  var HTML_KEEP_LIMIT = 60000; // pluginData budget for re-import of pasted HTML

  var SVG_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  var SVG_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return [].slice.call(document.querySelectorAll(s)); };

  function post(msg) { parent.postMessage({ pluginMessage: msg }, "*"); }

  // ---------------------------------------------------------
  // status bar
  // ---------------------------------------------------------
  var led = $("#led"), statusEl = $("#status");
  function status(text, kind) {
    statusEl.textContent = text;
    led.className = "led" + (kind === "ok" ? " ok" : kind === "err" ? " err" : "");
    statusEl.classList.toggle("is-err", kind === "err");
    statusEl.classList.remove("flash");
    void statusEl.offsetWidth;
    if (kind === "ok" || kind === "err") {
      statusEl.style.setProperty("--flash", kind === "err" ? "var(--danger)" : "var(--orange)");
      statusEl.classList.add("flash");
    }
  }

  var progress = $("#progress"), bar = $("#progressBar");
  function prog(frac, indet) {
    progress.hidden = frac == null && !indet;
    progress.classList.toggle("is-indet", !!indet);
    if (frac != null) bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%";
  }

  function pulse(el) { el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); }

  // ---------------------------------------------------------
  // theme (shared key with the CEP suite: feugee.theme)
  // ---------------------------------------------------------
  var bTheme = document.createElement("button");
  bTheme.id = "btnTheme";
  bTheme.className = "topbar-btn";
  $(".topbar").appendChild(bTheme);
  function applyTheme(theme, save) {
    var light = theme === "light";
    document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
    document.body.setAttribute("data-theme", light ? "light" : "dark");
    bTheme.innerHTML = light ? SVG_MOON : SVG_SUN;
    bTheme.title = light ? "Switch to Dark theme" : "Switch to Light theme";
    if (save) post({ type: "theme", theme: light ? "light" : "dark" });
  }
  bTheme.addEventListener("click", function () {
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light", true);
  });
  applyTheme("dark", false);

  var logo = $(".brand-logo");
  if (logo) {
    logo.setAttribute("title", "Feugee Studio (@feug.feugee)");
    logo.addEventListener("click", function () {
      logo.classList.remove("logo-pop"); void logo.offsetWidth; logo.classList.add("logo-pop");
      post({ type: "open", url: "https://www.instagram.com/feug.feugee/" });
    });
  }

  // ticker + splash: same markup as modes.js so panel.css styles them
  (function ticker() {
    var t = document.createElement("div");
    t.id = "feugeeTicker"; t.className = "feugee-ticker"; t.setAttribute("aria-hidden", "true");
    var group =
      '<span class="ticker-item"><span class="pixel-icon icon-spark">\u2726</span> <span class="pixel-icon icon-ghost">\uD83D\uDC7E</span> <span class="pixel-dot">\u25A0</span></span>' +
      '<span class="ticker-item"><span class="pixel-icon icon-star">\u2605</span> <span class="pixel-icon icon-bolt">\u26A1</span> <span class="pixel-dot">\u25A0</span></span>' +
      '<span class="ticker-item"><span class="pixel-icon icon-spark">\u2726</span> <span class="pixel-icon icon-heart">\u2665</span> <span class="pixel-dot">\u25A0</span></span>';
    var txt = new Array(9).join(group);
    t.innerHTML = '<div class="feugee-ticker-track"><div class="feugee-ticker-segment">' + txt +
      '</div><div class="feugee-ticker-segment" aria-hidden="true">' + txt + "</div></div>";
    t.addEventListener("click", function () { t.classList.remove("pixel-pop"); void t.offsetWidth; t.classList.add("pixel-pop"); });
    var top = $(".topbar");
    top.parentNode.insertBefore(t, top.nextSibling);
  })();

  (function splash() {
    if (!logo) return;
    var s = document.createElement("div");
    s.className = "feugee-splash";
    var wrap = document.createElement("div");
    wrap.className = "splash-content";
    var lc = logo.cloneNode(true);
    lc.setAttribute("class", "splash-logo"); lc.removeAttribute("width"); lc.removeAttribute("height");
    var title = document.createElement("div");
    title.className = "splash-title";
    title.innerHTML = "<h2>FEUGEE STUDIO</h2><p>HTML Import <span>v" + VERSION + "</span></p>";
    wrap.appendChild(lc); wrap.appendChild(title); s.appendChild(wrap);
    document.body.appendChild(s);
    function dismiss() {
      if (s.classList.contains("is-leaving")) return;
      s.classList.add("is-leaving");
      setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 360);
    }
    s.addEventListener("click", dismiss);
    setTimeout(dismiss, 1350);
  })();

  // ---------------------------------------------------------
  // state & settings
  // ---------------------------------------------------------
  var state = {
    src: "url", vps: { desktop: true }, scheme: "light",
    fileText: null, fileName: "", captureData: null, captureName: "",
    busy: false, cancel: false, selection: null, pendingRelaunch: false
  };

  function settings() {
    return {
      src: state.src,
      url: $("#inUrl").value.trim(),
      base: $("#inBase").value.trim(),
      fileBase: $("#inFileBase").value.trim(),
      vps: Object.keys(state.vps).filter(function (k) { return state.vps[k]; }),
      customW: $("#vpCustomW").value.trim(), customH: $("#vpCustomH").value.trim(),
      scheme: state.scheme,
      autoLayout: $("#optAuto").checked, flatten: $("#optFlatten").checked,
      vectorSvg: $("#optVector").checked, scripts: $("#optScripts").checked, matchFonts: $("#optFonts").checked,
      proxy: $("#optProxy").value, proxyUrl: $("#optProxyUrl").value.trim()
    };
  }

  var saveT = null;
  function saveSettings() {
    clearTimeout(saveT);
    saveT = setTimeout(function () { post({ type: "settings", settings: settings() }); }, 250);
  }

  function setSrc(src) {
    state.src = src;
    $$("[data-src]").forEach(function (b) { b.classList.toggle("is-on", b.getAttribute("data-src") === src); });
    $$("[data-pane]").forEach(function (p) { p.hidden = p.getAttribute("data-pane") !== src; });
    var meta = {
      url: "public URL, rendered here then rebuilt as native layers",
      html: "paste markup, inline <style> works, scripts optional",
      file: ".html page, or a .json made by CAPTURE",
      capture: "exact state of any open tab, incl. logged-in pages"
    };
    $("#srcMeta").textContent = meta[src];
    $("#cardViewports").classList.toggle("hi-dim", src === "capture");
    $("#vpMeta").textContent = src === "capture" ? "capture keeps the viewport it was taken at" : "one frame per viewport, side by side";
  }

  function setScheme(s) {
    state.scheme = s;
    $$("[data-scheme]").forEach(function (b) { b.classList.toggle("is-on", b.getAttribute("data-scheme") === s); });
  }

  function syncVps() {
    $$("[data-vp]").forEach(function (b) { b.classList.toggle("is-on", !!state.vps[b.getAttribute("data-vp")]); });
  }

  function syncProxy() {
    var v = $("#optProxy").value;
    $("#optProxyUrl").hidden = v !== "custom";
    $("#proxyNote").textContent = v === "auto"
      ? "Tries the local proxy first (nothing leaves your machine), then public ones. Install once: bash tools/install-proxy.sh"
      : v === "local"
      ? "Run: python3 tools/cors-proxy.py, or install it to start at login: bash tools/install-proxy.sh"
      : v === "off"
        ? "Direct only: URL import works just for sites that allow CORS. Images from other hosts may be blocked."
        : "Public proxies see the URLs you import. For private pages use CAPTURE, or the local proxy.";
  }

  function restore(s) {
    if (!s) return;
    if (s.url) $("#inUrl").value = s.url;
    if (s.base) $("#inBase").value = s.base;
    if (s.fileBase) $("#inFileBase").value = s.fileBase;
    if (s.vps && s.vps.length) { state.vps = {}; s.vps.forEach(function (k) { state.vps[k] = true; }); }
    if (s.customW != null) $("#vpCustomW").value = s.customW;
    if (s.customH) $("#vpCustomH").value = s.customH;
    if (s.scheme) setScheme(s.scheme);
    ["autoLayout:optAuto", "flatten:optFlatten", "vectorSvg:optVector", "scripts:optScripts", "matchFonts:optFonts"].forEach(function (p) {
      var kv = p.split(":"); if (typeof s[kv[0]] === "boolean") $("#" + kv[1]).checked = s[kv[0]];
    });
    // proxies that no longer exist (corsproxy.io went API-key only) -> auto
    if (s.proxy) $("#optProxy").value = $("#optProxy option[value='" + s.proxy + "']") ? s.proxy : "auto";
    if (s.proxyUrl) $("#optProxyUrl").value = s.proxyUrl;
    if (s.src) setSrc(s.src);
    syncVps(); syncProxy();
  }

  // ---------------------------------------------------------
  // input wiring
  // ---------------------------------------------------------
  $$("[data-src]").forEach(function (b) {
    b.addEventListener("click", function () { pulse(b); setSrc(b.getAttribute("data-src")); saveSettings(); });
  });
  $$("[data-vp]").forEach(function (b) {
    b.addEventListener("click", function () {
      var k = b.getAttribute("data-vp");
      state.vps[k] = !state.vps[k];
      var any = Object.keys(state.vps).some(function (x) { return state.vps[x]; }) || $("#vpCustomW").value.trim();
      if (!any) state.vps[k] = true; // never zero viewports
      pulse(b); syncVps(); saveSettings();
    });
  });
  $$("[data-scheme]").forEach(function (b) {
    b.addEventListener("click", function () { pulse(b); setScheme(b.getAttribute("data-scheme")); saveSettings(); });
  });
  $$("input, textarea, select").forEach(function (el) {
    if (el.type === "file") return;
    el.addEventListener("change", saveSettings);
    if (el.tagName !== "SELECT" && el.id !== "inHtml") el.addEventListener("input", saveSettings);
  });
  $("#optProxy").addEventListener("change", syncProxy);
  $("#inUrl").addEventListener("keydown", function (e) { if (e.key === "Enter") runImport(); });
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runImport(); }
  });

  // files
  function readFile(file, target) {
    var r = new FileReader();
    r.onload = function () {
      var text = String(r.result || "");
      var isCapture = /\.json$/i.test(file.name) || /^\s*\{/.test(text.slice(0, 64));
      if (isCapture) {
        try {
          var data = JSON.parse(text);
          if (data.kind !== "feugee-capture") throw new Error("not a Feugee capture file");
          state.captureData = data; state.captureName = file.name;
          $("#dropCaptureName").textContent = file.name.toUpperCase();
          $("#dropCapture").classList.add("has-file");
          if (target === "file") { $("#dropFileName").textContent = file.name.toUpperCase(); $("#dropFile").classList.add("has-file"); state.fileText = null; }
          status("Capture loaded: " + data.doc.title + " (" + data.doc.w + "px)", "ok");
        } catch (e) { status("Could not read " + file.name + ": " + e.message, "err"); }
      } else {
        state.fileText = text; state.fileName = file.name; state.captureData = null;
        $("#dropFileName").textContent = file.name.toUpperCase();
        $("#dropFile").classList.add("has-file");
        status("Loaded " + file.name + " (" + Math.round(text.length / 1024) + " KB)", "ok");
      }
    };
    r.readAsText(file);
  }

  function bindDrop(zone, input, target) {
    zone.addEventListener("click", function () { input.click(); });
    zone.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") input.click(); });
    ["dragenter", "dragover"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      zone.addEventListener(ev, function () { zone.classList.remove("is-over"); });
    });
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(f, target);
    });
  }
  var inFile = $("#inFile");
  inFile.addEventListener("change", function () {
    if (inFile.files[0]) readFile(inFile.files[0], state.src === "capture" ? "capture" : "file");
    inFile.value = "";
  });
  bindDrop($("#dropFile"), inFile, "file");
  bindDrop($("#dropCapture"), inFile, "capture");
  // dropping anywhere on the panel works too
  document.addEventListener("dragover", function (e) { e.preventDefault(); });
  document.addEventListener("drop", function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    var cap = /\.json$/i.test(f.name);
    setSrc(cap ? "capture" : "file");
    readFile(f, cap ? "capture" : "file");
  });

  // clipboard: navigator.clipboard is blocked in plugin iframes, execCommand is not
  function copy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove();
    return ok;
  }

  // ---------------------------------------------------------
  // actions
  // ---------------------------------------------------------
  var ACTIONS = {
    import: function () { runImport(); },
    reimport: function () { runReimport(); },
    cancel: function () { if (state.busy) { state.cancel = true; status("Stopping after this step..."); } },
    clear: function () {
      $("#inUrl").value = ""; $("#inHtml").value = ""; $("#inBase").value = ""; $("#inFileBase").value = "";
      state.fileText = null; state.captureData = null;
      $("#dropFileName").textContent = "DROP .HTML OR CAPTURE .JSON";
      $("#dropCaptureName").textContent = "DROP CAPTURE .JSON";
      $$(".hi-drop").forEach(function (z) { z.classList.remove("has-file"); });
      $("#cardReport").hidden = true;
      status("Cleared"); saveSettings();
    },
    copySnippet: function () {
      status(copy(FEUGEE_SNIPPET) ? "Snippet copied - paste it in the page's DevTools Console" : "Copy failed - your clipboard is blocked", "ok");
    },
    copyBookmarklet: function () {
      var bm = "javascript:" + encodeURIComponent(FEUGEE_SNIPPET);
      status(copy(bm) ? "Bookmarklet copied - add a bookmark and paste it as the URL" : "Copy failed", "ok");
    },
    pickCapture: function () { inFile.click(); }
  };
  $$("[data-act]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (b.disabled) return;
      pulse(b);
      var fn = ACTIONS[b.getAttribute("data-act")];
      if (fn) fn();
    });
  });

  // ---------------------------------------------------------
  // import pipeline
  // ---------------------------------------------------------
  function checkCancel() { if (state.cancel) throw new Error("Stopped"); }

  function viewportList(s) {
    var out = [];
    ["desktop", "tablet", "mobile"].forEach(function (k) { if (s.vps.indexOf(k) >= 0) out.push(VIEWPORTS[k]); });
    var cw = parseInt(s.customW, 10), ch = parseInt(s.customH, 10) || 900;
    if (cw >= 240 && cw <= 4000) out.push({ w: cw, h: Math.max(320, Math.min(4000, ch)), label: "Custom " + cw });
    if (!out.length) out.push(VIEWPORTS.desktop);
    return out;
  }

  // every viewport capture numbers its images from i0; merge them on URL
  function mergeImages(docs) {
    var byUrl = {}, list = [], n = 0;
    docs.forEach(function (d) {
      var remap = {};
      (d.images || []).forEach(function (e) {
        var g = byUrl[e.url];
        if (!g) { g = byUrl[e.url] = { key: "g" + (n++), url: e.url, asSvg: false, asFill: false }; list.push(g); }
        g.asSvg = g.asSvg || e.asSvg; g.asFill = g.asFill || e.asFill;
        remap[e.key] = g.key;
      });
      (function walk(node) {
        if (node.fills) node.fills.forEach(function (p) { if (p.k === "img" && remap[p.key]) p.key = remap[p.key]; });
        if (node.img && remap[node.img]) node.img = remap[node.img];
        if (node.kids) node.kids.forEach(walk);
      })(d.root);
      delete d.images;
    });
    return list;
  }

  function setBusy(on) {
    state.busy = on;
    if (on) state.cancel = false;
    $$("[data-act='import']").forEach(function (b) { b.classList.toggle("busy", on); });
    $("#btnCancel").disabled = !on;
    $("#btnReimport").disabled = on || !(state.selection && state.selection.source && state.selection.source.kind);
  }

  var buildWaiter = null;

  async function runImport(override) {
    if (state.busy) return;
    var s = settings();
    var src = override ? override.kind : s.src;
    setBusy(true);
    prog(null, true);
    $("#cardReport").hidden = true;
    var t0 = Date.now();
    try {
      var cfg = { proxy: s.proxy, proxyUrl: s.proxyUrl, scripts: s.scripts, scheme: s.scheme,
        autoLayout: s.autoLayout, flatten: s.flatten, vectorSvg: s.vectorSvg, matchFonts: s.matchFonts,
        figmaFamilies: state.figmaFamilies || null };
      var docs = [], assets = {}, failed = [], source = null, html = null, base = "";

      if (src === "capture" || (src === "file" && !override && state.captureData && !state.fileText)) {
        var cap = state.captureData;
        if (!cap) throw new Error("Drop a capture .json first (CAPTURE > SNIPPET)");
        status("Decoding capture images");
        var d = cap.doc;
        var list = d.images || [];
        var res = await FeugeeLoader.assetsFromCapture(cap.images, list, function (a, b) { prog(a / Math.max(1, b)); });
        d.label = d.w + "";
        var keyed = {};
        list.forEach(function (e) { keyed[e.key] = 1; });
        delete d.images;
        docs.push(d);
        assets = res.assets; failed = res.failed;
        source = { kind: "capture", label: d.title, url: d.url };
      } else {
        if (src === "url") {
          var url = override ? override.url : s.url;
          if (!url) throw new Error("Enter a URL");
          if (!/^[a-z]+:/i.test(url)) url = "https://" + url;
          status("Fetching " + url);
          html = await FeugeeLoader.fetchAny(url, cfg, "text").catch(function (e) {
            if (/^site answered/.test(e.message)) throw new Error("The " + e.message.replace("site", "site") + ". Check the URL.");
            var localDown = /local: not running/.test(e.message);
            throw new Error("Could not fetch the page. " + e.message + ". " +
              (s.proxy === "off" ? "Set CORS proxy to Auto in OPTIONS, or use CAPTURE."
                : localDown ? "Start the local proxy (bash tools/install-proxy.sh, once), or use CAPTURE."
                : "Use CAPTURE for this page."));
          });
          base = url;
          source = { kind: "url", url: url, label: url.replace(/^https?:\/\//, "").slice(0, 60) };
        } else if (src === "html") {
          html = override ? override.html : $("#inHtml").value;
          base = override ? (override.base || "") : s.base;
          if (!html || !html.trim()) throw new Error("Paste some HTML first");
          source = { kind: "html", label: "pasted HTML", base: base };
          if (html.length <= HTML_KEEP_LIMIT) source.html = html;
        } else {
          html = override ? override.html : state.fileText;
          base = override ? (override.base || "") : s.fileBase;
          if (!html) throw new Error("Drop an .html file first");
          source = { kind: "file", label: override ? override.label : state.fileName, base: base };
          if (html.length <= HTML_KEEP_LIMIT) source.html = html;
        }
        checkCancel();
        if (!/<html|<body|<head|<!doctype/i.test(html)) html = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" + html + "</body></html>";
        var prepared = await FeugeeLoader.prepare(html, base, cfg, function (t) { status(t); });
        var vps = override && override.viewport ? viewportList(s).filter(function (v) { return v.label === override.viewport; }) : viewportList(s);
        if (!vps.length) vps = viewportList(s);
        var host = document.body;
        for (var i = 0; i < vps.length; i++) {
          checkCancel();
          status("Rendering " + vps[i].label + (vps.length > 1 ? " (" + (i + 1) + "/" + vps.length + ")" : ""));
          var doc = await FeugeeLoader.renderAndCapture(prepared, vps[i], cfg, host, function (t) { status(t); });
          doc.label = vps[i].label;
          docs.push(doc);
        }
        var list2 = mergeImages(docs);
        checkCancel();
        if (list2.length) {
          status("Fetching " + list2.length + " image" + (list2.length > 1 ? "s" : ""));
          prog(0);
          var r2 = await FeugeeLoader.resolveImages(list2, cfg, function (a, b) {
            prog(a / b); status("Images " + a + "/" + b);
          });
          assets = r2.assets; failed = r2.failed;
        }
      }
      checkCancel();
      source.settings = { autoLayout: s.autoLayout, flatten: s.flatten, vectorSvg: s.vectorSvg, scripts: s.scripts, scheme: s.scheme, matchFonts: s.matchFonts };
      status("Building layers in Figma");
      prog(0);
      var nodes = docs.reduce(function (n, d) { return n + countNodes(d.root); }, 0);
      var result = await new Promise(function (resolve, reject) {
        buildWaiter = { resolve: resolve, reject: reject };
        post({ type: "build", docs: docs, assets: assets, source: source, replaceId: override && override.replaceId || null });
      });
      var secs = ((Date.now() - t0) / 1000).toFixed(1);
      var matched = {};
      docs.forEach(function (d) { (d.fontsMatched || []).forEach(function (f) { matched[f] = 1; }); delete d.fontsMatched; });
      report(result, failed, nodes, secs, Object.keys(matched));
      status("Imported " + result.length + " frame" + (result.length > 1 ? "s" : "") + " in " + secs + "s", "ok");
    } catch (e) {
      status(e && e.message ? e.message : String(e), "err");
    } finally {
      buildWaiter = null;
      prog(null, false);
      setBusy(false);
    }
  }

  function countNodes(n) { var c = 1; (n.kids || []).forEach(function (k) { c += countNodes(k); }); return c; }

  function runReimport() {
    var sel = state.selection;
    if (!sel || !sel.source || !sel.source.kind) return status("Select a frame made by this plugin", "err");
    var src = sel.source;
    if (src.kind === "capture") return status("Captures are snapshots - capture the page again to refresh", "err");
    if ((src.kind === "html" || src.kind === "file") && !src.html) return status("Source was too large to keep - import it again from the file", "err");
    if (src.settings) restore(Object.assign({}, settings(), src.settings));
    runImport({ kind: src.kind, url: src.url, html: src.html, base: src.base, label: src.label, viewport: src.viewport, replaceId: sel.id });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function report(stats, failedImgs, irNodes, secs, matchedFonts) {
    var tot = { nodes: 0, texts: 0, images: 0, vectors: 0, frames: 0, autolayout: 0, svgFailed: 0, missingImages: 0 };
    var subs = {}, warns = [];
    stats.forEach(function (s) {
      Object.keys(tot).forEach(function (k) { tot[k] += s[k] || 0; });
      Object.keys(s.substitutions || {}).forEach(function (k) { subs[k] = s.substitutions[k]; });
      (s.warnings || []).forEach(function (w) { warns.push(w); });
    });
    var h = "";
    function kv(k, v) { h += '<div class="hi-kv"><span>' + k + "</span><b>" + v + "</b></div>"; }
    kv("Frames", stats.map(function (s) { return s.label; }).join(", "));
    kv("Layers", tot.nodes);
    kv("Text layers (editable)", tot.texts);
    kv("Images", tot.images);
    kv("Vectors (SVG)", tot.vectors);
    kv("Auto layout frames", tot.autolayout + " / " + tot.frames);
    kv("Time", secs + "s");
    if (matchedFonts && matchedFonts.length) kv("Fonts matched from Google", matchedFonts.join(", "));
    var subKeys = Object.keys(subs);
    if (subKeys.length) {
      h += '<div class="hi-head">Fonts substituted</div>';
      subKeys.forEach(function (k) { h += '<div class="hi-warn">' + esc(k) + " &rarr; " + esc(subs[k]) + "</div>"; });
    }
    if (failedImgs.length || tot.missingImages) {
      h += '<div class="hi-head">Images blocked (' + failedImgs.length + ")</div>";
      failedImgs.slice(0, 8).forEach(function (u) { h += '<div class="hi-warn">' + esc(String(u).slice(0, 110)) + "</div>"; });
      if (failedImgs.length > 8) h += '<div class="hi-warn">+ ' + (failedImgs.length - 8) + " more</div>";
      h += '<div class="hi-warn">Grey placeholders mark them. A CORS proxy or CAPTURE usually fixes this.</div>';
    }
    if (tot.svgFailed) h += '<div class="hi-warn"><b>' + tot.svgFailed + "</b> SVG could not be parsed by Figma and became placeholders.</div>";
    if (warns.length) {
      h += '<div class="hi-head">Warnings</div>';
      warns.slice(0, 6).forEach(function (w) { h += '<div class="hi-warn">' + esc(w.slice(0, 140)) + "</div>"; });
    }
    $("#report").innerHTML = h;
    $("#reportMeta").textContent = irNodes + " elements read";
    $("#cardReport").hidden = false;
  }

  // ---------------------------------------------------------
  // messages from the sandbox
  // ---------------------------------------------------------
  window.onmessage = function (ev) {
    var msg = ev.data && ev.data.pluginMessage;
    if (!msg) return;
    if (msg.type === "init") {
      applyTheme(msg.theme || "dark", false);
      restore(msg.settings);
      if (msg.command === "reimport") state.pendingRelaunch = true;
    } else if (msg.type === "fonts") {
      state.figmaFamilies = msg.families;
    } else if (msg.type === "selection") {
      state.selection = msg;
      var ok = !!(msg.source && msg.source.kind);
      $("#btnReimport").disabled = state.busy || !ok;
      $("#selMeta").textContent = ok
        ? "selected: " + (msg.name || "") + " (" + msg.source.kind + ")"
        : "nothing imported selected";
      if (ok && state.pendingRelaunch) { state.pendingRelaunch = false; runReimport(); }
    } else if (msg.type === "progress") {
      var frac = (msg.index + (msg.total ? msg.done / msg.total : 0)) / Math.max(1, msg.count);
      prog(frac);
      if (msg.label) statusEl.textContent = "Building " + (msg.count > 1 ? (msg.index + 1) + "/" + msg.count + " " : "") + "- " + String(msg.label).slice(0, 60);
    } else if (msg.type === "done") {
      if (buildWaiter) buildWaiter.resolve(msg.stats);
    } else if (msg.type === "error") {
      if (buildWaiter) buildWaiter.reject(new Error(msg.message));
      else status(msg.message, "err");
    }
  };

  // ---------------------------------------------------------
  // resize grip
  // ---------------------------------------------------------
  (function grip() {
    var g = $("#grip"), start = null;
    g.addEventListener("pointerdown", function (e) {
      start = { x: e.clientX, y: e.clientY, w: window.innerWidth, h: window.innerHeight };
      g.setPointerCapture(e.pointerId);
    });
    g.addEventListener("pointermove", function (e) {
      if (!start) return;
      post({ type: "resize", w: start.w + e.clientX - start.x, h: start.h + e.clientY - start.y });
    });
    g.addEventListener("pointerup", function (e) {
      if (!start) return;
      post({ type: "resize", w: start.w + e.clientX - start.x, h: start.h + e.clientY - start.y, save: true });
      start = null;
    });
  })();

  setSrc("url"); syncVps(); syncProxy();
  post({ type: "init" });
})();
