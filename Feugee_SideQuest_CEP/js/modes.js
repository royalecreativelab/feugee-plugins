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
  // AUTO-UPDATE SYSTEM
  // Checks remote manifest, shows orange dot, syncs files in-place
  // Multi-mirror: jsDelivr CDN (primary) -> raw GitHub -> GitHub API
  // ---------------------------------------------------------
  var MANIFEST_MIRRORS = [
    "https://api.github.com/repos/royalecreativelab/feugee-plugins/contents/updates.json",
    "https://cdn.jsdelivr.net/gh/royalecreativelab/feugee-plugins@main/updates.json",
    "https://raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/updates.json"
  ];

  var pendingUpdate = null;

  function getManifestUrls(cb) {
    var custom = "";
    try { custom = localStorage.getItem("feugee.manifest_url"); } catch (e) {}
    if (custom) return cb([custom]);

    var extPath = getExtPath();
    if (extPath) {
      try {
        if (typeof window.cep !== "undefined" && window.cep.fs) {
          var res = window.cep.fs.readFile(extPath + "/feugee-update-config.json");
          if (res.err === 0 && res.data) {
            var cfg = JSON.parse(res.data);
            if (cfg && cfg.manifestUrl) return cb([cfg.manifestUrl]);
          }
        }
      } catch (e) {}
    }

    cb(MANIFEST_MIRRORS);
  }

  function fetchJson(url, cb) {
    var mirrors = [url];
    if (url.indexOf("raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/") !== -1) {
      mirrors.unshift(url.replace("raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/", "cdn.jsdelivr.net/gh/royalecreativelab/feugee-plugins@main/"));
    } else if (url.indexOf("cdn.jsdelivr.net/gh/royalecreativelab/feugee-plugins@main/") !== -1) {
      mirrors.push(url.replace("cdn.jsdelivr.net/gh/royalecreativelab/feugee-plugins@main/", "raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/"));
    }

    tryMirrors(mirrors, 0, cb);
  }

  function tryMirrors(urls, idx, cb) {
    if (idx >= urls.length) {
      return cb(new Error("All mirrors failed"));
    }
    fetchSingleJson(urls[idx], function (err, data) {
      if (!err && data) {
        return cb(null, data);
      }
      tryMirrors(urls, idx + 1, cb);
    });
  }

  function fetchSingleJson(url, cb) {
    var isGhApi = url.indexOf("api.github.com") !== -1;
    var finalUrl = isGhApi ? url : (url + (url.indexOf("?") === -1 ? "?" : "&") + "_t=" + Date.now());
    var fetchHeaders = isGhApi ? { "Accept": "application/vnd.github.raw" } : {};

    var called = false;
    function safeCb(err, data) {
      if (called) return;
      called = true;
      cb(err, data);
    }

    if (typeof fetch === "function") {
      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timeoutId = setTimeout(function () {
        if (controller) {
          try { controller.abort(); } catch (e) {}
        }
        safeCb(new Error("Timeout (fetch)"));
      }, 4500);

      var opts = { cache: "no-store", headers: fetchHeaders };
      if (controller) opts.signal = controller.signal;

      fetch(finalUrl, opts)
        .then(function (res) {
          clearTimeout(timeoutId);
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (data) {
          clearTimeout(timeoutId);
          safeCb(null, data);
        })
        .catch(function () {
          clearTimeout(timeoutId);
          tryXhr(finalUrl, safeCb);
        });
      return;
    }

    tryXhr(finalUrl, safeCb);
  }

  function tryXhr(url, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.timeout = 4500;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { cb(null, JSON.parse(xhr.responseText)); } catch (e) { cb(e); }
        } else {
          cb(new Error("HTTP " + xhr.status));
        }
      };
      xhr.onerror = function () { cb(new Error("Network failed")); };
      xhr.ontimeout = function () { cb(new Error("Timeout (XHR)")); };
      xhr.send();
    } catch (e) {
      cb(e);
    }
  }

  function writeExtensionFile(fullPath, content, cb) {
    var normPath = fullPath.replace(/\\/g, "/");
    var dir = normPath.substring(0, normPath.lastIndexOf("/"));

    // 1. window.cep.fs
    if (typeof window.cep !== "undefined" && window.cep.fs) {
      try {
        if (dir) {
          var parts = dir.split("/");
          var cur = "";
          for (var i = 0; i < parts.length; i++) {
            cur += (i === 0 && parts[i] === "" ? "" : "/") + parts[i];
            if (cur && cur !== "/") window.cep.fs.makedir(cur);
          }
        }
        var res = window.cep.fs.writeFile(normPath, content);
        if (res.err === 0) return cb(null);
      } catch (e) {}
    }

    // 2. ExtendScript File write
    if (typeof window.__adobe_cep__ !== "undefined" && typeof window.__adobe_cep__.evalScript === "function") {
      var encoded = encodeURIComponent(content);
      var script = '(function() {' +
        'try {' +
          'var f = new File("' + normPath + '");' +
          'var d = f.parent;' +
          'if (!d.exists) d.create();' +
          'f.encoding = "UTF-8";' +
          'if (!f.open("w")) return "ERR|Open failed";' +
          'f.write(decodeURIComponent("' + encoded + '"));' +
          'f.close();' +
          'return "OK";' +
        '} catch(e) { return "ERR|" + e.toString(); }' +
      '})()';
      window.__adobe_cep__.evalScript(script, function (jsxRes) {
        if (jsxRes && jsxRes.indexOf("OK") === 0) cb(null);
        else cb(new Error(jsxRes || "ExtendScript write failed"));
      });
      return;
    }

    cb(new Error("No filesystem API available"));
  }

  function checkForUpdates(silent, cb) {
    try {
      var pInfo = getPluginInfo();
      var bUp = document.getElementById("btnUpdate");

      getManifestUrls(function (mirrors) {
        tryMirrors(mirrors, 0, function (err, data) {
          if (err || !data || !data.plugins) {
            if (!silent) setPluginStatus("Update check failed (" + (err ? err.message : "server offline") + ")", "var(--red)");
            if (cb) cb(err);
            return;
          }

          var pRemote = data.plugins[pInfo.slug];
          if (!pRemote || !pRemote.version) {
            if (!silent) setPluginStatus("No update info for " + pInfo.slug, "var(--blue)");
            if (cb) cb(null, false);
            return;
          }

          if (isNewerVersion(pRemote.version, pInfo.version)) {
            pendingUpdate = pRemote;
            if (bUp) {
              bUp.classList.add("has-update");
              bUp.title = "Update available: v" + pRemote.version + " (Current: v" + pInfo.version + ") - Click to install";
            }
            setPluginStatus("Update v" + pRemote.version + " available! Click the update icon.", "var(--orange)");
            if (cb) cb(null, true, pRemote);
          } else {
            pendingUpdate = null;
            if (bUp) {
              bUp.classList.remove("has-update");
              bUp.title = "Plugin is up to date (v" + pInfo.version + ") - Click to check";
            }
            if (!silent) {
              setPluginStatus("You have the latest version (v" + pInfo.version + ")", "var(--blue)");
            }
            if (cb) cb(null, false);
          }
        });
      });
    } catch (err) {
      if (!silent) setPluginStatus("Update check error: " + err.message, "var(--red)");
      if (cb) cb(err);
    }
  }

  function applyUpdate(updateInfo) {
    var bUp = document.getElementById("btnUpdate");
    if (bUp) bUp.classList.add("is-updating");

    var pInfo = getPluginInfo();
    setPluginStatus("Downloading " + (updateInfo.name || pInfo.slug) + " v" + updateInfo.version + "...", "var(--orange)");

    var extPath = getExtPath();
    if (!extPath || !updateInfo.bundleUrl) {
      fallbackZxp(updateInfo, "Missing bundle or extension path");
      return;
    }

    fetchJson(updateInfo.bundleUrl, function (err, bundle) {
      if (err || !bundle || !bundle.files) {
        fallbackZxp(updateInfo, "Could not fetch bundle: " + (err ? err.message : "Corrupt"));
        return;
      }

      setPluginStatus("Installing v" + updateInfo.version + "...", "var(--orange)");

      var fileKeys = Object.keys(bundle.files);
      function writeNext(idx) {
        if (idx >= fileKeys.length) {
          // Completed
          if (bUp) {
            bUp.classList.remove("is-updating");
            bUp.classList.remove("has-update");
          }
          setPluginStatus("Updated to v" + updateInfo.version + "! Reloading...", "var(--blue)");

          if (typeof window.__adobe_cep__ !== "undefined" && typeof window.__adobe_cep__.evalScript === "function") {
            var hostFile = extPath + "/jsx/host.jsx";
            window.__adobe_cep__.evalScript('$.evalFile(new File("' + hostFile + '"))', function () {
              setTimeout(function () { window.location.reload(); }, 250);
            });
          } else {
            setTimeout(function () { window.location.reload(); }, 250);
          }
          return;
        }

        var rel = fileKeys[idx];
        var content = bundle.files[rel];
        var targetFile = extPath + "/" + rel;

        writeExtensionFile(targetFile, content, function (wErr) {
          if (wErr) {
            fallbackZxp(updateInfo, "Write error: " + wErr.message);
            return;
          }
          writeNext(idx + 1);
        });
      }

      writeNext(0);
    });
  }

  function fallbackZxp(updateInfo, reason) {
    var bUp = document.getElementById("btnUpdate");
    if (bUp) bUp.classList.remove("is-updating");

    setPluginStatus("Auto-update failed (" + reason + "). Opening package...", "var(--red)");
    var targetUrl = updateInfo.zxpUrl || updateInfo.releaseUrl || MANIFEST_MIRRORS[0];
    try {
      if (typeof window.cep !== "undefined" && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
        window.cep.util.openURLInDefaultBrowser(targetUrl);
      } else {
        window.open(targetUrl, "_blank");
      }
    } catch (e) {
      window.open(targetUrl, "_blank");
    }
  }

  // Inject Reload Button
  var bReload = document.createElement("button");
  bReload.id = "btnReload";
  bReload.className = "topbar-btn";
  bReload.title = "Reload plugin & host script (without restarting AE)";
  bReload.innerHTML = SVG_RELOAD;
  bReload.addEventListener("click", reloadPlugin);
  topbar.appendChild(bReload);

  // Inject Update Button
  var bUpdate = document.createElement("button");
  bUpdate.id = "btnUpdate";
  bUpdate.className = "topbar-btn";
  bUpdate.title = "Check for updates";
  bUpdate.innerHTML = SVG_UPDATE;
  bUpdate.addEventListener("click", function () {
    if (bUpdate.classList.contains("is-updating")) return;
    if (bUpdate.classList.contains("has-update") && pendingUpdate) {
      applyUpdate(pendingUpdate);
    } else {
      bUpdate.classList.add("is-spinning");
      setPluginStatus("Checking for updates...", "var(--orange)");

      var done = false;
      var safetyTimer = setTimeout(function () {
        if (!done) {
          done = true;
          bUpdate.classList.remove("is-spinning");
          setPluginStatus("Update check timed out", "var(--red)");
        }
      }, 10000);

      checkForUpdates(false, function () {
        if (!done) {
          done = true;
          clearTimeout(safetyTimer);
          bUpdate.classList.remove("is-spinning");
        }
      });
    }
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

  // Background check for updates (silent)
  setTimeout(function () {
    checkForUpdates(true);
  }, 900);
})();
