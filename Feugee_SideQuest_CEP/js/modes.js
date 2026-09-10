/* =========================================================
   FEUGEE STUDIO - SHARED VIEW MODES
   Full (cards) <-> Compact (buttons only)

   Drop-in: include this AFTER panel.js and it works. It builds the
   compact view by reading the full markup, so there is no second
   markup tree to keep in sync. Add a tile to index.html and it shows
   up in both modes automatically.

   Handles both kinds of tile:
     .tile[data-act]   one-shot actions
     .tile.mode        persistent selectors - they keep their .is-on state,
                       mirrored both ways with the original

   Per-tile opt-in:
     data-params="popDist,popDur"   which inputs ride along on the button
     data-params=""                 explicitly none
   Default when the attribute is absent: every text input in the tile's
   own card. Checkboxes are never included unless named explicitly.

   Copy this file as-is into every Feugee plugin.
   ========================================================= */
(function () {
  "use strict";

  var LS_KEY = "feugee.viewmode." + (document.title || "panel");

  var content = document.getElementById("content");
  var topbar = document.querySelector(".topbar");
  if (!content || !topbar) return;

  // ---------------------------------------------------------
  // ICONS
  // ---------------------------------------------------------
  var SVG_FULL =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="3" width="18" height="8" rx="2"/>' +
    '<rect x="3" y="13" width="18" height="8" rx="2"/></svg>';

  var SVG_COMPACT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="3" width="8" height="8" rx="1.5"/>' +
    '<rect x="13" y="3" width="8" height="8" rx="1.5"/>' +
    '<rect x="3" y="13" width="8" height="8" rx="1.5"/>' +
    '<rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>';

  var SVG_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 5 5 9-11"/></svg>';

  var SVG_RELOAD =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M20.2 12a8.2 8.2 0 1 1-2.6-6"/><path d="M20.5 3.6v4.8h-4.8"/></svg>';

  var SVG_UPDATE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/>' +
    '<line x1="12" y1="15" x2="12" y2="3"/></svg>';

  var SVG_SUN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';

  var SVG_MOON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';


  // ---------------------------------------------------------
  // COMPACT CONTAINER
  // ---------------------------------------------------------
  var compact = document.createElement("main");
  compact.className = "compact";
  compact.id = "compact";
  compact.hidden = true;
  content.parentNode.insertBefore(compact, content.nextSibling);

  // Keeps source input -> every clone that mirrors it
  var mirrors = {};

  function mirrorFrom(srcEl) {
    var id = srcEl.id;
    if (!mirrors[id]) {
      mirrors[id] = [];
      srcEl.addEventListener("input", function () { push(id); });
      srcEl.addEventListener("change", function () { push(id); });
    }
    return mirrors[id];
  }

  function push(id) {
    var src = document.getElementById(id);
    var list = mirrors[id] || [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.type === "checkbox" || el.classList.contains("cchk")) {
        el.classList.toggle("on", !!src.checked);
      } else if (el.value !== src.value) {
        el.value = src.value;
      }
    }
  }

  // ---------------------------------------------------------
  // WHICH INPUTS RIDE ALONG ON A TILE
  // ---------------------------------------------------------
  function paramsFor(tile) {
    var attr = tile.getAttribute("data-params");
    var out = [];
    var i;

    if (attr !== null) {
      var ids = attr.split(",");
      for (i = 0; i < ids.length; i++) {
        var id = ids[i].replace(/^\s+|\s+$/g, "");
        if (!id) continue;
        var el = document.getElementById(id);
        if (el) out.push(el);
      }
      return out;
    }

    // default: text inputs living in the same card
    var card = tile.closest(".card");
    if (!card) return out;
    var found = card.querySelectorAll(".params input[type='text'], .params input:not([type])");
    for (i = 0; i < found.length; i++) out.push(found[i]);
    return out;
  }

  // ---------------------------------------------------------
  // BUILD
  // ---------------------------------------------------------
  var tileSources = [];

  function build() {
    var tiles = content.querySelectorAll(".tile[data-act], .tile.mode");

    for (var i = 0; i < tiles.length; i++) {
      var src = tiles[i];
      var card = src.closest(".card");
      var isMode = src.classList.contains("mode");

      var btn = document.createElement("button");
      btn.className = "tile row ctile" +
        (src.classList.contains("danger") ? " danger" : "") +
        (isMode ? " mode" + (src.classList.contains("is-on") ? " is-on" : "") : "");
      if (src.getAttribute("data-act")) btn.setAttribute("data-act", src.getAttribute("data-act"));
      btn.setAttribute("data-accent", card ? (card.getAttribute("data-accent") || "orange") : "orange");
      if (src.title) btn.title = src.title;

      // A mode tile is a selector, not an action: forward the click to the
      // original so the plugin's own handler runs, then mirror .is-on back.
      if (isMode) bindMode(btn, src);

      // icon + label, copied from the source tile
      var icon = src.querySelector("svg");
      if (icon) btn.appendChild(icon.cloneNode(true));

      var lab = document.createElement("span");
      var srcLab = src.querySelector("span");
      lab.textContent = srcLab ? srcLab.textContent : "";
      btn.appendChild(lab);

      // inline editable properties
      var params = paramsFor(src);
      if (params.length) {
        var wrap = document.createElement("i");
        wrap.className = "cvals";

        for (var p = 0; p < params.length; p++) {
          var srcInput = params[p];
          if (!srcInput.id) continue;

          if (srcInput.type === "checkbox") {
            var box = document.createElement("i");
            box.className = "cchk" + (srcInput.checked ? " on" : "");
            box.innerHTML = SVG_CHECK;
            box.title = labelTextFor(srcInput);
            bindCheck(box, srcInput);
            mirrorFrom(srcInput).push(box);
            wrap.appendChild(box);
          } else {
            var inp = document.createElement("input");
            inp.type = "text";
            inp.className = "cval";
            inp.value = srcInput.value;
            inp.title = labelTextFor(srcInput);
            bindValue(inp, srcInput);
            mirrorFrom(srcInput).push(inp);
            wrap.appendChild(inp);
          }
        }
        if (wrap.childNodes.length) btn.appendChild(wrap);
      }

      tileSources.push(src);
      compact.appendChild(btn);
    }

    disambiguate();
  }

  /* Two cards can legitimately use the same label ("AXIS X" under both
     Distribute and Fixed spacing). Inside a card that reads fine; stripped of
     its card in compact view it does not. Prefix only the labels that actually
     collide, so nothing else gets longer than it needs to be. */
  function disambiguate() {
    var btns = compact.querySelectorAll(".ctile");
    var seen = {}, i, key;

    for (i = 0; i < btns.length; i++) {
      key = btns[i].querySelector("span").textContent;
      seen[key] = (seen[key] || 0) + 1;
    }

    for (i = 0; i < btns.length; i++) {
      var lab = btns[i].querySelector("span");
      if (seen[lab.textContent] < 2) continue;

      var src = tileSources[i];
      var card = src ? src.closest(".card") : null;
      var h2 = card ? card.querySelector("h2") : null;
      if (!h2) continue;

      var tag = document.createElement("b");
      tag.className = "cgrp";
      tag.textContent = h2.textContent;
      lab.insertBefore(tag, lab.firstChild);
      btns[i].title = h2.textContent + " - " + btns[i].title;
    }
  }

  // Mirror .is-on between a mode tile and its compact twin.
  var modePairs = [];

  function bindMode(clone, src) {
    modePairs.push([clone, src]);
    clone.addEventListener("click", function (ev) {
      ev.stopPropagation();
      src.click();
      syncModes();
    });
  }

  function syncModes() {
    for (var i = 0; i < modePairs.length; i++) {
      modePairs[i][0].classList.toggle("is-on", modePairs[i][1].classList.contains("is-on"));
    }
  }

  // Catches state changed by the plugin itself, not only by our clones.
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(syncModes).observe(content, {
      subtree: true, attributes: true, attributeFilter: ["class"]
    });
  }

  function labelTextFor(input) {
    var lab = input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
    if (lab) return lab.textContent;
    var wrapLab = input.closest("label");
    return wrapLab ? wrapLab.textContent.replace(/^\s+|\s+$/g, "") : "";
  }

  // Editing a property must never fire the button's action.
  function stop(ev) { ev.stopPropagation(); }

  function bindValue(clone, src) {
    clone.addEventListener("click", stop);
    clone.addEventListener("mousedown", stop);
    clone.addEventListener("input", function () {
      src.value = clone.value;
      fire(src, "input");
      push(src.id);
    });
    clone.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); clone.blur(); }
    });
  }

  function bindCheck(box, src) {
    box.addEventListener("mousedown", stop);
    box.addEventListener("click", function (ev) {
      ev.stopPropagation();
      src.checked = !src.checked;
      fire(src, "change");
      push(src.id);
    });
  }

  function fire(el, type) {
    var ev;
    try {
      ev = new Event(type, { bubbles: true });
    } catch (e) {
      ev = document.createEvent("Event");
      ev.initEvent(type, true, true);
    }
    el.dispatchEvent(ev);
  }

  // ---------------------------------------------------------
  // SWITCH
  // ---------------------------------------------------------
  var box = document.createElement("div");
  box.className = "modes";

  var bFull = document.createElement("button");
  bFull.innerHTML = SVG_FULL;
  bFull.title = "Full view - cards, labels and settings";

  var bComp = document.createElement("button");
  bComp.innerHTML = SVG_COMPACT;
  bComp.title = "Compact view - buttons only";

  box.appendChild(bFull);
  box.appendChild(bComp);
  topbar.appendChild(box);

  // ---------------------------------------------------------
  // THEME SWITCHER (DARK <-> LIGHT)
  // ---------------------------------------------------------
  var LS_THEME_KEY = "feugee.theme";

  function getSavedTheme() {
    try {
      return localStorage.getItem(LS_THEME_KEY) || "dark";
    } catch (e) {
      return "dark";
    }
  }

  function applyTheme(theme, save) {
    var isLight = theme === "light";
    document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");
    if (document.body) {
      document.body.setAttribute("data-theme", isLight ? "light" : "dark");
    }
    if (bTheme) {
      bTheme.innerHTML = isLight ? SVG_MOON : SVG_SUN;
      bTheme.title = isLight ? "Switch to Dark theme" : "Switch to Light theme";
    }
    if (save) {
      try { localStorage.setItem(LS_THEME_KEY, isLight ? "light" : "dark"); } catch (e) {}
    }
    if (window.FG_CURVE && typeof window.FG_CURVE.render === "function") {
      try { window.FG_CURVE.render(); } catch (e) {}
    }
  }

  var bTheme = document.createElement("button");
  bTheme.id = "btnTheme";
  bTheme.className = "topbar-btn";
  bTheme.title = "Toggle Light / Dark theme";
  bTheme.innerHTML = SVG_SUN;
  bTheme.addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "light" ? "dark" : "light", true);
  });
  topbar.appendChild(bTheme);

  window.addEventListener("storage", function (ev) {
    if (ev && ev.key === LS_THEME_KEY && ev.newValue) {
      applyTheme(ev.newValue, false);
    }
  });

  applyTheme(getSavedTheme(), false);


  // ---------------------------------------------------------
  // EXTENSION PATH & PLUGIN INFO HELPERS
  // ---------------------------------------------------------
  function getExtPath() {
    var p = "";
    try {
      if (typeof window.__adobe_cep__ !== "undefined" && typeof window.__adobe_cep__.getSystemPath === "function") {
        p = window.__adobe_cep__.getSystemPath("extension");
      }
    } catch (e) {}

    if (!p && window.location && window.location.pathname) {
      p = window.location.pathname.replace(/\/[^\/]+$/, "");
    }
    if (p) {
      p = decodeURIComponent(p.replace(/^file:\/\//i, "")).replace(/\\/g, "/");
      if (/^\/[a-zA-Z]:/.test(p)) {
        p = p.substring(1);
      }
    }
    return (p || "").replace(/\\/g, "/");
  }

  function getPluginInfo() {
    var brandP = document.querySelector(".brand-text p");
    var fullText = brandP ? brandP.textContent : (document.title || "");
    var slug = "feugelign";
    if (/knowledge\s*nuke/i.test(fullText)) slug = "knowledgenuke";
    else if (/sidequest/i.test(fullText)) slug = "sidequest";
    else if (/feugelign/i.test(fullText)) slug = "feugelign";
    else if (/motion/i.test(fullText)) slug = "feugeemotion";

    var verMatch = fullText.match(/v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
    var version = verMatch ? verMatch[1] : "1.0.0";

    return {
      slug: slug,
      version: version,
      name: brandP && brandP.firstChild ? brandP.firstChild.textContent.trim() : slug
    };
  }

  function isNewerVersion(remote, local) {
    if (!remote) return false;
    if (!local) return true;
    var r = String(remote).replace(/^v/i, "").split(".").map(function (n) { return parseInt(n, 10) || 0; });
    var l = String(local).replace(/^v/i, "").split(".").map(function (n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < Math.max(r.length, l.length); i++) {
      var rv = r[i] || 0;
      var lv = l[i] || 0;
      if (rv > lv) return true;
      if (rv < lv) return false;
    }
    return false;
  }

  function setPluginStatus(text, colorVar) {
    var statusEl = document.getElementById("status");
    if (!statusEl) return;
    statusEl.textContent = text;
    if (colorVar) statusEl.style.setProperty("--flash", colorVar);
    statusEl.classList.remove("flash");
    void statusEl.offsetWidth;
    statusEl.classList.add("flash");
  }

  // ---------------------------------------------------------
  // RELOAD PLUGIN BUTTON
  // Re-evaluates jsx/host.jsx in ExtendScript + reloads webview
  // ---------------------------------------------------------
  function reloadPlugin() {
    var btn = document.getElementById("btnReload");
    if (btn) btn.classList.add("is-spinning");

    setPluginStatus("Reloading host & panel...", "var(--orange)");

    var extPath = getExtPath();
    if (extPath && typeof window.__adobe_cep__ !== "undefined" && typeof window.__adobe_cep__.evalScript === "function") {
      var hostFile = extPath + "/jsx/host.jsx";
      var script = '$.evalFile(new File("' + hostFile + '"))';
      window.__adobe_cep__.evalScript(script, function () {
        setTimeout(function () {
          window.location.reload();
        }, 80);
      });
      return;
    }

    setTimeout(function () {
      window.location.reload();
    }, 80);
  }

  // ---------------------------------------------------------
  // FEUGEE AUTO-UPDATE v2 - live in-place installer
  //
  // What changed vs v1 (and why it failed on other machines):
  //  - GitHub API mirror dropped. 60 req/hour per IP, so a studio
  //    sharing one connection gets HTTP 403 and every fetch dies.
  //  - Write access is probed BEFORE downloading. A ZXP installed
  //    system-wide (/Library/... or Program Files) is not writable
  //    by After Effects, which is what silently killed the install.
  //  - Files are backed up in memory, written, then read back and
  //    compared. Any mismatch rolls everything back, so a failed
  //    update can no longer leave half a plugin on disk.
  //  - After patching, the ZXP signature no longer matches, so the
  //    installer drops signatures.xml, writes .debug and turns on
  //    PlayerDebugMode. Without that the panel would refuse to load
  //    on the next After Effects launch.
  //  - Every step is logged to feugee-update.log next to the plugin.
  //    Alt+click the update button to dump diagnostics and open it.
  // ---------------------------------------------------------
  var REPO = "royalecreativelab/feugee-plugins";
  var BRANCH = "main";
  var RAW_BASE = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/";
  var CDN_BASE = "https://cdn.jsdelivr.net/gh/" + REPO + "@" + BRANCH + "/";
  var REPAIR_PAGE = "https://github.com/" + REPO + "#repair--reinstall";

  var MANIFEST_MIRRORS = [RAW_BASE + "updates.json", CDN_BASE + "updates.json"];

  var SLUG_BY_BUNDLE = {
    "com.feugee.feugelign": "feugelign",
    "com.feugee.knowledgenuke": "knowledgenuke",
    "com.feugee.sidequest": "sidequest",
    "com.feugee.motion": "feugeemotion"
  };

  var TIMEOUT_MANIFEST = 12000;
  var TIMEOUT_BUNDLE = 45000;

  var pendingUpdate = null;
  var LOG = [];
  var lastFailure = "";

  function log(msg) {
    var line = "[" + new Date().toISOString() + "] " + msg;
    LOG.push(line);
    try { console.log("[feugee-update] " + msg); } catch (e) {}
  }

  // --- ExtendScript bridge -----------------------------------------------
  function es(script, cb) {
    if (typeof window.__adobe_cep__ === "undefined" ||
        typeof window.__adobe_cep__.evalScript !== "function") {
      return cb("ERR|No ExtendScript bridge");
    }
    try {
      window.__adobe_cep__.evalScript(script, function (r) {
        cb(typeof r === "string" ? r : String(r));
      });
    } catch (e) {
      cb("ERR|" + e.message);
    }
  }

  function esStr(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // --- filesystem ---------------------------------------------------------
  function cepRead(path) {
    try {
      if (typeof window.cep !== "undefined" && window.cep.fs) {
        var r = window.cep.fs.readFile(path);
        if (r && r.err === 0) return r.data;
      }
    } catch (e) {}
    return null;
  }

  function cepWrite(path, content) {
    try {
      if (typeof window.cep !== "undefined" && window.cep.fs) {
        var r = window.cep.fs.writeFile(path, content);
        return !!(r && r.err === 0);
      }
    } catch (e) {}
    return false;
  }

  function cepDelete(path) {
    try {
      if (typeof window.cep !== "undefined" && window.cep.fs) {
        window.cep.fs.deleteFile(path);
      }
    } catch (e) {}
  }

  function mkdirp(dir, cb) {
    if (!dir) return cb(null);
    if (typeof window.cep !== "undefined" && window.cep.fs) {
      try {
        var parts = dir.split("/");
        var cur = "";
        for (var i = 0; i < parts.length; i++) {
          cur += (i === 0 && parts[i] === "" ? "" : "/") + parts[i];
          if (cur && cur !== "/") window.cep.fs.makedir(cur);
        }
      } catch (e) {}
    }
    var script = '(function(){try{' +
      'var f=new Folder("' + esStr(dir) + '");' +
      'if(f.exists) return "OK";' +
      'var stack=[],cur=f;' +
      'while(cur && !cur.exists){stack.push(cur);cur=cur.parent;}' +
      'for(var i=stack.length-1;i>=0;i--){if(!stack[i].create()) return "ERR|mkdir failed: "+stack[i].fsName;}' +
      'return "OK";}catch(e){return "ERR|"+e.toString();}})()';
    es(script, function (res) {
      cb(res && res.indexOf("OK") === 0 ? null : new Error(res || "mkdir failed"));
    });
  }

  // Splits without cutting a surrogate pair in half - encodeURIComponent
  // throws URIError on a lone surrogate and that used to kill the write.
  function safeChunks(content, size) {
    var out = [];
    var i = 0;
    while (i < content.length) {
      var end = Math.min(i + size, content.length);
      var code = content.charCodeAt(end - 1);
      if (end < content.length && code >= 0xd800 && code <= 0xdbff) end--;
      out.push(content.substring(i, end));
      i = end;
    }
    if (!out.length) out.push("");
    return out;
  }

  function esWrite(path, content, cb) {
    var chunks = safeChunks(content, 6000);
    function step(idx) {
      if (idx >= chunks.length) return cb(null);
      var payload;
      try { payload = encodeURIComponent(chunks[idx]); }
      catch (e) { return cb(new Error("encode failed: " + e.message)); }
      var script = '(function(){try{' +
        'var f=new File("' + esStr(path) + '");' +
        'f.encoding="UTF-8";f.lineFeed="Unix";' +
        'if(!f.open("' + (idx === 0 ? "w" : "a") + '")) return "ERR|open failed (' + (idx === 0 ? "w" : "a") + ')";' +
        'f.write(decodeURIComponent("' + payload + '"));' +
        'f.close();return "OK";' +
        '}catch(e){return "ERR|"+e.toString();}})()';
      es(script, function (res) {
        if (res && res.indexOf("OK") === 0) return step(idx + 1);
        cb(new Error(res || "ExtendScript write failed"));
      });
    }
    step(0);
  }

  // cep.fs first (sync, fast), ExtendScript as fallback, read-back either way.
  function writeVerified(path, content, cb) {
    var dir = path.substring(0, path.lastIndexOf("/"));
    mkdirp(dir, function () {
      if (cepWrite(path, content) && cepRead(path) === content) {
        return cb(null, "cep.fs");
      }
      esWrite(path, content, function (err) {
        if (err) return cb(err);
        var back = cepRead(path);
        if (back !== null && back !== content) {
          return cb(new Error("verify mismatch (" + (back ? back.length : 0) + "/" + content.length + " chars)"));
        }
        cb(null, "extendscript");
      });
    });
  }

  function probeWritable(extPath, cb) {
    var probe = extPath + "/.feugee-write-test";
    var stamp = "feugee " + Date.now();
    if (cepWrite(probe, stamp) && cepRead(probe) === stamp) {
      cepDelete(probe);
      return cb(true, "cep.fs");
    }
    var script = '(function(){try{' +
      'var f=new File("' + esStr(probe) + '");' +
      'if(!f.open("w")) return "ERR|open denied";' +
      'f.write("' + stamp + '");f.close();f.remove();return "OK";' +
      '}catch(e){return "ERR|"+e.toString();}})()';
    es(script, function (res) {
      if (res && res.indexOf("OK") === 0) return cb(true, "extendscript");
      cb(false, res || "no filesystem api");
    });
  }

  // --- network ------------------------------------------------------------
  function fetchSingleJson(url, timeout, cb) {
    var finalUrl = url + (url.indexOf("?") === -1 ? "?" : "&") + "_t=" + Date.now();
    var called = false;
    function safeCb(err, data) {
      if (called) return;
      called = true;
      cb(err, data);
    }

    if (typeof fetch === "function") {
      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) { try { controller.abort(); } catch (e) {} }
        safeCb(new Error("timeout " + timeout + "ms"));
      }, timeout);

      var opts = { cache: "no-store" };
      if (controller) opts.signal = controller.signal;

      fetch(finalUrl, opts)
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (data) { clearTimeout(timer); safeCb(null, data); })
        .catch(function (e) {
          clearTimeout(timer);
          if (called) return;
          tryXhr(finalUrl, timeout, safeCb);
        });
      return;
    }
    tryXhr(finalUrl, timeout, safeCb);
  }

  function tryXhr(url, timeout, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.timeout = timeout;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { cb(null, JSON.parse(xhr.responseText)); }
          catch (e) { cb(new Error("bad JSON: " + e.message)); }
        } else {
          cb(new Error("HTTP " + xhr.status));
        }
      };
      xhr.onerror = function () { cb(new Error("network failed")); };
      xhr.ontimeout = function () { cb(new Error("timeout " + timeout + "ms")); };
      xhr.send();
    } catch (e) {
      cb(e);
    }
  }

  function tryMirrors(urls, timeout, validate, cb) {
    var errors = [];
    function next(i) {
      if (i >= urls.length) return cb(new Error(errors.join(" | ") || "all mirrors failed"));
      fetchSingleJson(urls[i], timeout, function (err, data) {
        if (!err && data) {
          var bad = validate ? validate(data) : null;
          if (!bad) { log("fetched " + urls[i]); return cb(null, data); }
          err = new Error(bad);
        }
        errors.push(shortHost(urls[i]) + ": " + err.message);
        log("mirror failed " + urls[i] + " -> " + err.message);
        next(i + 1);
      });
    }
    next(0);
  }

  function shortHost(url) {
    var m = String(url).match(/^https?:\/\/([^\/]+)/);
    return m ? m[1].replace("raw.githubusercontent.com", "raw").replace("cdn.jsdelivr.net", "jsdelivr") : url;
  }

  // --- commit-pinned resolution (bypasses GitHub Fastly 300s cache) ------
  var cachedCommitSha = null;
  function getLatestCommitSha(cb) {
    if (cachedCommitSha) return cb(cachedCommitSha);
    var atomUrl = "https://github.com/" + REPO + "/commits/" + BRANCH + ".atom";
    var finalUrl = atomUrl + "?_t=" + Date.now();

    function parseSha(text) {
      if (!text) return null;
      var m = String(text).match(/commit\/([0-9a-f]{40})/i);
      return m ? m[1] : null;
    }

    if (typeof fetch === "function") {
      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) { try { controller.abort(); } catch (e) {} }
        cb(null);
      }, 4000);

      fetch(finalUrl, { cache: "no-store", signal: controller ? controller.signal : undefined })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.text();
        })
        .then(function (text) {
          clearTimeout(timer);
          var sha = parseSha(text);
          if (sha) cachedCommitSha = sha;
          cb(sha);
        })
        .catch(function () {
          clearTimeout(timer);
          tryXhrText(finalUrl, 3000, function (err, text) {
            var sha = parseSha(text);
            if (sha) cachedCommitSha = sha;
            cb(sha);
          });
        });
      return;
    }
    tryXhrText(finalUrl, 3000, function (err, text) {
      var sha = parseSha(text);
      if (sha) cachedCommitSha = sha;
      cb(sha);
    });
  }

  function tryXhrText(url, timeout, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.timeout = timeout;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          cb(null, xhr.responseText);
        } else {
          cb(new Error("HTTP " + xhr.status));
        }
      };
      xhr.onerror = function () { cb(new Error("network failed")); };
      xhr.ontimeout = function () { cb(new Error("timeout")); };
      xhr.send();
    } catch (e) {
      cb(e);
    }
  }

  // --- local plugin identity ---------------------------------------------
  function readLocalInfo() {
    var info = getPluginInfo();
    var extPath = getExtPath();
    var xml = extPath ? cepRead(extPath + "/CSXS/manifest.xml") : null;
    if (xml) {
      var mB = xml.match(/ExtensionBundleId="([^"]+)"/);
      var mV = xml.match(/ExtensionBundleVersion="([^"]+)"/);
      var mE = xml.match(/<Extension\s+Id="([^"]+)"/);
      if (mB) {
        info.bundleId = mB[1];
        if (SLUG_BY_BUNDLE[mB[1]]) info.slug = SLUG_BY_BUNDLE[mB[1]];
      }
      if (mV) info.version = mV[1];
      if (mE) info.extensionId = mE[1];
    }
    if (!info.bundleId) {
      info.bundleId = "com.feugee." + (info.slug === "feugeemotion" ? "motion" : info.slug);
    }
    if (!info.extensionId) info.extensionId = info.bundleId + ".panel";
    return info;
  }

  function getManifestUrls(cb) {
    var custom = "";
    try { custom = localStorage.getItem("feugee.manifest_url"); } catch (e) {}
    if (custom) return cb([custom]);

    var extPath = getExtPath();
    if (extPath) {
      var raw = cepRead(extPath + "/feugee-update-config.json");
      if (raw) {
        try {
          var cfg = JSON.parse(raw);
          if (cfg && cfg.manifestUrl) return cb([cfg.manifestUrl]);
        } catch (e) {}
      }
    }

    getLatestCommitSha(function (sha) {
      if (sha) {
        var shaRaw = "https://raw.githubusercontent.com/" + REPO + "/" + sha + "/";
        return cb([shaRaw + "updates.json", RAW_BASE + "updates.json", CDN_BASE + "updates.json"]);
      }
      cb(MANIFEST_MIRRORS);
    });
  }

  // --- update check -------------------------------------------------------
  function checkForUpdates(silent, cb) {
    var local = readLocalInfo();
    var bUp = document.getElementById("btnUpdate");
    log("check " + local.slug + " v" + local.version);

    getManifestUrls(function (mirrors) {
      tryMirrors(mirrors, TIMEOUT_MANIFEST, function (d) {
        return d && d.plugins ? null : "manifest has no plugins";
      }, function (err, data) {
        if (err) {
          if (!silent) setPluginStatus("Update check failed (" + err.message + ")", "var(--red)");
          if (cb) cb(err);
          return;
        }

        var remote = data.plugins[local.slug];
        if (!remote || !remote.version) {
          if (!silent) setPluginStatus("No update info for " + local.slug, "var(--blue)");
          if (cb) cb(null, false);
          return;
        }
        if (!remote.slug) remote.slug = local.slug;

        if (isNewerVersion(remote.version, local.version)) {
          pendingUpdate = remote;
          if (bUp) {
            bUp.classList.add("has-update");
            bUp.title = "Update available: v" + remote.version + " (installed v" + local.version + ") - click to install";
          }
          setPluginStatus("Update v" + remote.version + " available! Click the update icon.", "var(--orange)");
          if (cb) cb(null, true, remote);
        } else {
          pendingUpdate = null;
          if (bUp) {
            bUp.classList.remove("has-update");
            bUp.title = "Up to date (v" + local.version + ") - click to check, alt+click for diagnostics";
          }
          if (!silent) setPluginStatus("You have the latest version (v" + local.version + ")", "var(--blue)");
          if (cb) cb(null, false);
        }
      });
    });
  }

  function fetchBundleJson(updateInfo, local, cb) {
    var slug = updateInfo.slug || local.slug;
    var path = "bundles/" + slug + ".json";
    getLatestCommitSha(function (sha) {
      var mirrors = [];
      if (sha) {
        mirrors.push("https://raw.githubusercontent.com/" + REPO + "/" + sha + "/" + path);
      }
      mirrors.push(RAW_BASE + path);
      mirrors.push(CDN_BASE + path);
      if (updateInfo.bundleUrl && mirrors.indexOf(updateInfo.bundleUrl) === -1) {
        mirrors.push(updateInfo.bundleUrl);
      }
      tryMirrors(mirrors, TIMEOUT_BUNDLE, function (bundle) {
        if (!bundle || !bundle.files) return "no files in bundle";
        var keys = Object.keys(bundle.files);
        if (!keys.length) return "bundle is empty";
        // jsDelivr can serve a cached older copy - refuse anything stale
        if (bundle.version && isNewerVersion(updateInfo.version, bundle.version)) {
          return "stale copy (v" + bundle.version + ")";
        }
        for (var i = 0; i < keys.length; i++) {
          if (typeof bundle.files[keys[i]] !== "string") return "corrupt entry " + keys[i];
        }
        return null;
      }, cb);
    });
  }


  // --- install ------------------------------------------------------------
  function applyUpdate(updateInfo) {
    var bUp = document.getElementById("btnUpdate");
    if (bUp) bUp.classList.add("is-updating");

    LOG = [];
    var local = readLocalInfo();
    var extPath = getExtPath();

    log("=== apply update ===");
    log("plugin=" + local.slug + " bundleId=" + local.bundleId);
    log("installed=v" + local.version + " -> remote=v" + updateInfo.version);
    log("extPath=" + extPath);
    log("cep.fs=" + (typeof window.cep !== "undefined" && !!window.cep.fs) +
        " extendscript=" + (typeof window.__adobe_cep__ !== "undefined"));

    if (!extPath) return failUpdate(updateInfo, "extension path unknown");

    setPluginStatus("Checking write access...", "var(--orange)");
    probeWritable(extPath, function (writable, detail) {
      log("writable=" + writable + " via " + detail);
      if (!writable) {
        return failUpdate(updateInfo,
          "plugin folder is read-only - reinstall to your user folder", extPath);
      }

      setPluginStatus("Downloading v" + updateInfo.version + "...", "var(--orange)");
      fetchBundleJson(updateInfo, local, function (err, bundle) {
        if (err) return failUpdate(updateInfo, "download failed - " + err.message, extPath);
        log("bundle v" + bundle.version + " files=" + Object.keys(bundle.files).length);
        installBundle(bundle, updateInfo, local, extPath);
      });
    });
  }

  function installBundle(bundle, updateInfo, local, extPath) {
    var version = bundle.version || updateInfo.version;
    var keys = Object.keys(bundle.files);
    var backup = {};
    var written = [];

    setPluginStatus("Installing v" + version + " (0/" + keys.length + ")...", "var(--orange)");

    function rollback(reason, done) {
      log("ROLLBACK: " + reason);
      var i = 0;
      function next() {
        if (i >= written.length) return done();
        var rel = written[i++];
        if (typeof backup[rel] !== "string") return next();
        writeVerified(extPath + "/" + rel, backup[rel], function (e) {
          log("restore " + rel + (e ? " FAILED " + e.message : " ok"));
          next();
        });
      }
      next();
    }

    function step(idx) {
      if (idx >= keys.length) return postInstall(bundle, updateInfo, local, extPath, version);

      var rel = keys[idx];
      var target = extPath + "/" + rel;
      var content = bundle.files[rel];
      var current = cepRead(target);
      if (typeof current === "string") backup[rel] = current;

      setPluginStatus("Installing v" + version + " (" + (idx + 1) + "/" + keys.length + ")...", "var(--orange)");

      writeVerified(target, content, function (err, how) {
        if (err) {
          log("write FAILED " + rel + " -> " + err.message);
          return rollback(err.message, function () {
            failUpdate(updateInfo, "write failed on " + rel + " (" + err.message + ")", extPath);
          });
        }
        written.push(rel);
        log("wrote " + rel + " (" + content.length + " chars, " + how + ")");
        step(idx + 1);
      });
    }

    step(0);
  }

  // Patching the folder invalidates the ZXP signature, so the extension has
  // to be switched to unsigned + debug mode or After Effects drops it on the
  // next launch.
  function postInstall(bundle, updateInfo, local, extPath, version) {
    setPluginStatus("Finalizing v" + version + "...", "var(--orange)");

    cepDelete(extPath + "/META-INF/signatures.xml");
    es('(function(){try{var f=new File("' + esStr(extPath) + '/META-INF/signatures.xml");' +
       'if(f.exists){f.remove();return "OK|removed";}return "OK|absent";}catch(e){return "ERR|"+e.toString();}})()',
      function (sigRes) {
        log("signature: " + sigRes);

        var debugXml =
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<ExtensionList>\n' +
          '  <Extension Id="' + local.extensionId + '">\n' +
          '    <HostList>\n' +
          '      <Host Name="AEFT" Port="' + debugPort(local.bundleId) + '"/>\n' +
          '    </HostList>\n' +
          '  </Extension>\n' +
          '</ExtensionList>\n';

        writeVerified(extPath + "/.debug", debugXml, function (dErr) {
          log(".debug: " + (dErr ? "FAILED " + dErr.message : "ok"));
          enableDebugMode(function (dbgRes) {
            log("PlayerDebugMode: " + dbgRes);
            writeLog(extPath, function (logPath) {
              finishUpdate(extPath, version, logPath);
            });
          });
        });
      });
  }

  function debugPort(bundleId) {
    var h = 0;
    for (var i = 0; i < bundleId.length; i++) h = (h * 31 + bundleId.charCodeAt(i)) % 900;
    return 8100 + h;
  }

  // Writes a throwaway shell/batch file and runs it - avoids quoting hell
  // inside system.callSystem.
  function enableDebugMode(cb) {
    var isWin = /win/i.test(navigator.platform || "");
    var body;
    if (isWin) {
      body = '@echo off\r\nfor /L %%i in (9,1,26) do reg add "HKCU\\SOFTWARE\\Adobe\\CSXS.%%i" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1\r\n';
    } else {
      body = '#!/bin/sh\nfor i in 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26; do\n' +
             '  defaults write com.adobe.CSXS.$i PlayerDebugMode 1 >/dev/null 2>&1\ndone\n';
    }
    var name = isWin ? "feugee-debugmode.bat" : "feugee-debugmode.sh";
    var payload = encodeURIComponent(body);
    var script = '(function(){try{' +
      'var f=new File(Folder.temp.fsName+"/' + name + '");' +
      'f.encoding="UTF-8";f.lineFeed="Unix";' +
      'if(!f.open("w")) return "ERR|temp open failed";' +
      'f.write(decodeURIComponent("' + payload + '"));f.close();' +
      'var cmd=' + (isWin
        ? '"cmd.exe /c \\""+f.fsName+"\\""'
        : '"/bin/sh \\""+f.fsName+"\\""') + ';' +
      'system.callSystem(cmd);f.remove();return "OK";' +
      '}catch(e){return "ERR|"+e.toString();}})()';
    es(script, function (res) { cb(res || "no response"); });
  }

  function finishUpdate(extPath, version, logPath) {
    var bUp = document.getElementById("btnUpdate");
    if (bUp) {
      bUp.classList.remove("is-updating");
      bUp.classList.remove("has-update");
    }
    pendingUpdate = null;
    log("=== updated to v" + version + " ===");
    setPluginStatus("Updated to v" + version + "! Reloading...", "var(--blue)");

    if (typeof window.__adobe_cep__ !== "undefined" &&
        typeof window.__adobe_cep__.evalScript === "function") {
      window.__adobe_cep__.evalScript(
        '$.evalFile(new File("' + esStr(extPath + "/jsx/host.jsx") + '"))',
        function () { setTimeout(function () { window.location.reload(true); }, 400); });
    } else {
      setTimeout(function () { window.location.reload(true); }, 400);
    }
  }

  function failUpdate(updateInfo, reason, extPath) {
    var bUp = document.getElementById("btnUpdate");
    if (bUp) bUp.classList.remove("is-updating");
    lastFailure = reason;
    log("FAILED: " + reason);
    try { localStorage.setItem("feugee.update.lastError", reason); } catch (e) {}

    writeLog(extPath || getExtPath(), function (logPath) {
      setPluginStatus("Update failed: " + reason + (logPath ? " - see " + logPath : ""), "var(--red)");
      var targetUrl = (updateInfo && (updateInfo.zxpUrl || updateInfo.releaseUrl)) || REPAIR_PAGE;
      openExternal(targetUrl);
    });
  }

  function openExternal(url) {
    try {
      if (typeof window.cep !== "undefined" && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
        window.cep.util.openURLInDefaultBrowser(url);
        return;
      }
    } catch (e) {}
    try { window.open(url, "_blank"); } catch (e) {}
  }

  function writeLog(extPath, cb) {
    var text = LOG.join("\n") + "\n";
    if (extPath && cepWrite(extPath + "/feugee-update.log", text)) {
      return cb(extPath + "/feugee-update.log");
    }
    var payload = encodeURIComponent(text);
    var script = '(function(){try{' +
      'var d=new Folder(Folder.userData.fsName+"/Feugee");if(!d.exists)d.create();' +
      'var f=new File(d.fsName+"/feugee-update.log");f.encoding="UTF-8";' +
      'if(!f.open("w")) return "ERR|open failed";' +
      'f.write(decodeURIComponent("' + payload + '"));f.close();return "OK|"+f.fsName;' +
      '}catch(e){return "ERR|"+e.toString();}})()';
    es(script, function (res) {
      cb(res && res.indexOf("OK|") === 0 ? res.substring(3) : "");
    });
  }

  // --- diagnostics (alt+click on the update button) -----------------------
  function runDiagnostics() {
    LOG = [];
    var local = readLocalInfo();
    var extPath = getExtPath();
    setPluginStatus("Running diagnostics...", "var(--orange)");

    log("=== feugee diagnostics ===");
    log("plugin=" + local.slug + " v" + local.version + " (" + local.bundleId + ")");
    log("extPath=" + extPath);
    log("platform=" + navigator.platform + " ua=" + navigator.userAgent);
    log("cep.fs=" + (typeof window.cep !== "undefined" && !!window.cep.fs));
    log("signature present=" + (cepRead(extPath + "/META-INF/signatures.xml") !== null));
    log(".debug present=" + (cepRead(extPath + "/.debug") !== null));
    log("last failure=" + (lastFailure || localStorage.getItem("feugee.update.lastError") || "none"));

    probeWritable(extPath, function (writable, detail) {
      log("writable=" + writable + " via " + detail);
      tryMirrors(MANIFEST_MIRRORS, TIMEOUT_MANIFEST, function (d) {
        return d && d.plugins ? null : "no plugins key";
      }, function (mErr, manifest) {
        log("manifest=" + (mErr ? "FAILED " + mErr.message : "ok, remote v" +
          (manifest.plugins[local.slug] ? manifest.plugins[local.slug].version : "?")));
        var remote = (!mErr && manifest.plugins[local.slug]) || { slug: local.slug, version: local.version };
        fetchBundleJson(remote, local, function (bErr, bundle) {
          log("bundle=" + (bErr ? "FAILED " + bErr.message
            : "ok v" + bundle.version + ", " + Object.keys(bundle.files).length + " files"));
          writeLog(extPath, function (logPath) {
            setPluginStatus("Diagnostics saved: " + (logPath || "console only"), "var(--blue)");
            if (logPath) es('(function(){try{new File("' + esStr(logPath) + '").execute();return "OK";}catch(e){return "ERR";}})()', function () {});
          });
        });
      });
    });
  }

  // ---------------------------------------------------------
  // TOPBAR BUTTONS
  // ---------------------------------------------------------
  var bReload = document.createElement("button");
  bReload.id = "btnReload";
  bReload.className = "topbar-btn";
  bReload.title = "Reload plugin & host script (without restarting AE)";
  bReload.innerHTML = SVG_RELOAD;
  bReload.addEventListener("click", reloadPlugin);
  topbar.appendChild(bReload);

  var bUpdate = document.createElement("button");
  bUpdate.id = "btnUpdate";
  bUpdate.className = "topbar-btn";
  bUpdate.title = "Check for updates (alt+click for diagnostics)";
  bUpdate.innerHTML = SVG_UPDATE;
  bUpdate.addEventListener("click", function (ev) {
    if (bUpdate.classList.contains("is-updating")) return;

    if (ev && (ev.altKey || ev.metaKey && ev.shiftKey)) {
      runDiagnostics();
      return;
    }

    if (bUpdate.classList.contains("has-update") && pendingUpdate) {
      applyUpdate(pendingUpdate);
      return;
    }

    bUpdate.classList.add("is-spinning");
    setPluginStatus("Checking for updates...", "var(--orange)");

    var done = false;
    var safety = setTimeout(function () {
      if (done) return;
      done = true;
      bUpdate.classList.remove("is-spinning");
      setPluginStatus("Update check timed out", "var(--red)");
    }, TIMEOUT_MANIFEST * 2 + 2000);

    checkForUpdates(false, function () {
      if (done) return;
      done = true;
      clearTimeout(safety);
      bUpdate.classList.remove("is-spinning");
    });
  });
  bUpdate.addEventListener("contextmenu", function (ev) {
    ev.preventDefault();
    if (!bUpdate.classList.contains("is-updating")) runDiagnostics();
  });
  topbar.appendChild(bUpdate);

  function apply(mode, remember) {
    var isCompact = mode === "compact";
    content.hidden = isCompact;
    compact.hidden = !isCompact;
    bFull.classList.toggle("on", !isCompact);
    bComp.classList.toggle("on", isCompact);
    if (remember) {
      try { localStorage.setItem(LS_KEY, mode); } catch (e) {}
    }
  }

  bFull.addEventListener("click", function () { apply("full", true); });
  bComp.addEventListener("click", function () { apply("compact", true); });

  build();
  syncModes();

  var saved = "full";
  try { saved = localStorage.getItem(LS_KEY) || "full"; } catch (e) {}
  apply(saved === "compact" ? "compact" : "full", false);

  // ---------------------------------------------------------
  // INTRO SPLASH ANIMATION
  // Elegant logo intro on panel launch
  // ---------------------------------------------------------
  function initSplash() {
    try {
      var brandLogo = document.querySelector(".brand-logo");
      if (!brandLogo || !document.body) return;

      var pluginInfo = getPluginInfo();
      var displayName = pluginInfo.name || "Plugin";
      if (displayName.toLowerCase() === "motion") displayName = "Feugee Motion";

      var splash = document.createElement("div");
      splash.id = "feugeeSplash";
      splash.className = "feugee-splash";

      var wrap = document.createElement("div");
      wrap.className = "splash-content";

      var logoClone = brandLogo.cloneNode(true);
      logoClone.setAttribute("class", "splash-logo");
      logoClone.removeAttribute("width");
      logoClone.removeAttribute("height");

      var title = document.createElement("div");
      title.className = "splash-title";
      title.innerHTML = '<h2>FEUGEE STUDIO</h2><p>' + displayName + ' <span>v' + pluginInfo.version + '</span></p>';

      wrap.appendChild(logoClone);
      wrap.appendChild(title);
      splash.appendChild(wrap);
      document.body.appendChild(splash);

      function dismiss() {
        if (splash.classList.contains("is-leaving")) return;
        splash.classList.add("is-leaving");
        setTimeout(function () {
          if (splash.parentNode) splash.parentNode.removeChild(splash);
        }, 360);
      }

      splash.addEventListener("click", dismiss);
      setTimeout(dismiss, 1350);
    } catch (e) {}
  }

  initSplash();

  // Background check for updates (silent)
  setTimeout(function () {
    checkForUpdates(true);
  }, 900);
})();

