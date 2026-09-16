/* =========================================================
   FEUGEE FX SEARCH  -  LIBRARY PANEL LOGIC
   Bridge to ExtendScript: window.__adobe_cep__.evalScript
   ========================================================= */
(function () {
  "use strict";

  var EVENT_DATA = "com.feugee.fxsearch.data";
  var LS_INDEX = "feugee.fxsearch.index.panel";

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $("status");
  var ledEl = $("led");

  var S = {
    items: [], map: {}, stamp: "",
    data: FXCore.emptyData(),
    scope: "all", results: [], pick: null
  };

  // ---------------------------------------------------------
  // BRIDGE
  // ---------------------------------------------------------
  function hasHost() {
    return typeof window.__adobe_cep__ !== "undefined" &&
           typeof window.__adobe_cep__.evalScript === "function";
  }

  function evalES(script, cb) {
    if (!hasHost()) { cb("ERR|Panel is not connected to After Effects"); return; }
    try {
      window.__adobe_cep__.evalScript(script, function (res) {
        cb(typeof res === "string" ? res : "ERR|Could not read the host reply");
      });
    } catch (e) {
      cb("ERR|" + e.message);
    }
  }

  function extPath() {
    try { return window.__adobe_cep__.getSystemPath("extension").replace(/^file:\/\//, ""); }
    catch (e) { return ""; }
  }

  // ---------------------------------------------------------
  // STATUS
  // ---------------------------------------------------------
  function setStatus(text, kind, accent) {
    statusEl.textContent = text;
    statusEl.classList.toggle("is-err", kind === "err");
    ledEl.className = "led " + (kind === "err" ? "err" : kind === "ok" ? "ok" : "");
    statusEl.style.setProperty("--flash", accent || "var(--orange)");
    statusEl.classList.remove("flash");
    void statusEl.offsetWidth;
    statusEl.classList.add("flash");
  }

  function report(res, accent) {
    var rep = FXCore.parseReply(res);
    if (rep.msg) setStatus(rep.msg, rep.ok ? "ok" : "err", accent);
    return rep;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---------------------------------------------------------
  // DATA
  // ---------------------------------------------------------
  function saveData(msg) {
    evalES(FXCore.saveCall(S.data), function (res) {
      var rep = FXCore.parseReply(res);
      if (!rep.ok) setStatus(rep.msg, "err");
      else if (msg) setStatus(msg, "ok", "var(--blue)");
    });
    renderAll();
  }

  function loadData(done) {
    evalES("FG_FXS.loadData()", function (res) {
      if (res.indexOf("OK|") === 0) S.data = FXCore.parseData(res.substring(3));
      renderAll();
      if (done) done();
    });
  }

  // ---------------------------------------------------------
  // INDEX
  // ---------------------------------------------------------
  function loadIndex(rows, stamp) {
    S.items = FXCore.buildItems(rows).filter(function (it) { return it.kind !== "cmd"; });
    S.map = FXCore.byId(S.items);
    S.stamp = stamp;
  }

  function boot(stamp, done) {
    evalES("FG_FXS.boot(" + FXCore.lit(stamp) + ")", function (res) {
      if (res.indexOf("OK|") !== 0) { if (done) done(res); return; }
      var d;
      try { d = JSON.parse(res.substring(3)); } catch (e) { if (done) done("ERR|" + e.message); return; }
      S.data = FXCore.parseData(d.data);
      if (d.rows) {
        loadIndex(d.rows, d.stamp);
        try { localStorage.setItem(LS_INDEX, JSON.stringify({ stamp: d.stamp, rows: d.rows })); } catch (e2) {}
      }
      $("metaIndex").textContent = d.nfx + " effects · " + d.nps + " presets indexed";
      renderAll();
      if (done) done("OK|");
    });
  }

  // ---------------------------------------------------------
  // LIBRARY LIST
  // ---------------------------------------------------------
  function highlight(name, pos) {
    return FXCore.segments(name, pos).map(function (seg) {
      return seg.hit ? "<mark>" + esc(seg.t) + "</mark>" : esc(seg.t);
    }).join("");
  }

  function runLib() {
    var q = $("libQuery").value;
    if (!q && S.scope === "all") {
      // idle: favorites + recents, then the effect list A-Z
      var idle = FXCore.search(S.items, "", { scope: "all", data: S.data, map: S.map, limit: 200 });
      var fx = FXCore.search(S.items, "", { scope: "fx", data: S.data, map: S.map, limit: 200 });
      var seen = {};
      S.results = idle.concat(fx).filter(function (r) {
        if (seen[r.item.id]) return false;
        seen[r.item.id] = true;
        return true;
      }).slice(0, 200);
    } else {
      S.results = FXCore.search(S.items, q, { scope: S.scope, data: S.data, map: S.map, limit: 200 });
    }
    renderList();
  }

  function renderList() {
    var html = [];
    for (var i = 0; i < S.results.length; i++) {
      var r = S.results[i];
      var it = r.item;
      var fav = S.data.favorites.indexOf(it.id) >= 0;
      html.push('<li class="fxl-row k-' + it.kind + (S.pick === it.id ? " on" : "") + '" data-id="' + esc(it.id) + '" title="' + esc(it.cat) + '">' +
        '<span class="k">' + (it.kind === "fx" ? "FX" : "PRE") + "</span>" +
        '<span class="n">' + highlight(it.name, r.pos) + "</span>" +
        '<span class="c">' + esc(it.cat) + "</span>" +
        (fav ? '<span class="s">★</span>' : "") + "</li>");
    }
    if (!html.length) {
      html.push('<li class="fxl-empty">' + (S.items.length ? "No match" : "Index not loaded yet") + "</li>");
    }
    $("libList").innerHTML = html.join("");
  }

  function renderPick() {
    var it = S.pick ? S.map[S.pick] : null;
    var box = $("libPick");
    box.classList.toggle("is-empty", !it);
    $("pickName").textContent = it ? it.name + "  ·  " + it.cat : "Nothing highlighted - click a row";
    if (!it) return;
    var fav = S.data.favorites.indexOf(it.id) >= 0;
    $("btnStar").classList.toggle("is-on", fav);
    $("btnStar").textContent = fav ? "★ STARRED" : "☆ STAR";
    $("aliasField").value = FXCore.aliasesOf(S.data, it.id).join(" ");
    $("overRow").hidden = it.kind !== "fx";
    var ob = document.querySelector('[data-lib="override"]');
    var over = S.data.overrides[it.id];
    ob.textContent = over ? "CLEAR OVERRIDE (" + presetName(over) + ")" : "OVERRIDE WITH PRESET...";
    ob.classList.toggle("danger", !!over);
  }

  function presetName(id) {
    if (S.map[id]) return S.map[id].name;
    return String(id).replace(/^ps:/, "").split(/[\\\/]/).pop().replace(/\.ffx$/i, "");
  }

  function renderAll() {
    runLib();
    renderPick();
    renderKV();
    renderSettings();
  }

  // ---------------------------------------------------------
  // ALIASES / OVERRIDES / FOLDERS
  // ---------------------------------------------------------
  function nameOf(id) {
    if (S.map[id]) return S.map[id].name;
    return String(id).replace(/^(fx|ps):/, "").split(/[\\\/]/).pop();
  }

  function kvRow(key, val, rm) {
    return '<li><span class="key">' + esc(key) + '</span><span class="val">' + esc(val) +
           '</span><button class="x" data-rm="' + esc(rm) + '" title="Remove">×</button></li>';
  }

  function renderKV() {
    var a = [];
    Object.keys(S.data.aliases).sort().forEach(function (k) {
      a.push(kvRow(k, nameOf(S.data.aliases[k]), "alias:" + k));
    });
    $("aliasList").innerHTML = a.join("") || '<li class="fxl-none">No aliases - highlight an item in Library and set one, or press ⌘K in the popup</li>';

    var o = [];
    Object.keys(S.data.overrides).forEach(function (k) {
      o.push(kvRow(nameOf(k), "→ " + presetName(S.data.overrides[k]), "over:" + k));
    });
    $("overList").innerHTML = o.join("") || '<li class="fxl-none">No overrides</li>';

    var f = S.data.presetFolders.map(function (p, i) { return kvRow("DIR", p, "folder:" + i); });
    $("folderList").innerHTML = f.join("") || '<li class="fxl-none">Only the After Effects and User Presets folders</li>';
    $("metaAlias").textContent = Object.keys(S.data.aliases).length + " aliases · " +
      Object.keys(S.data.overrides).length + " overrides · " + S.data.favorites.length + " favorites";
  }

  function renderSettings() {
    var boxes = document.querySelectorAll("[data-setting]");
    for (var i = 0; i < boxes.length; i++) {
      var k = boxes[i].getAttribute("data-setting");
      var v = S.data.settings[k];
      boxes[i].checked = k === "noSelection" ? v === "adjustment" : !!v;
    }
  }

  document.addEventListener("change", function (ev) {
    var k = ev.target.getAttribute && ev.target.getAttribute("data-setting");
    if (!k) return;
    S.data.settings[k] = k === "noSelection" ? (ev.target.checked ? "adjustment" : "error") : ev.target.checked;
    saveData("Setting saved");
  });

  document.addEventListener("click", function (ev) {
    var rm = ev.target.closest("[data-rm]");
    if (!rm) return;
    var v = rm.getAttribute("data-rm");
    var sep = v.indexOf(":");
    var kind = v.substring(0, sep), key = v.substring(sep + 1);
    if (kind === "alias") delete S.data.aliases[key];
    else if (kind === "over") delete S.data.overrides[key];
    else if (kind === "folder") {
      S.data.presetFolders.splice(Number(key), 1);
      saveData();
      reindex();
      return;
    }
    saveData("Removed");
  });

  // ---------------------------------------------------------
  // LIBRARY INTERACTION
  // ---------------------------------------------------------
  $("libQuery").addEventListener("input", runLib);

  $("libScopes").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-scope]");
    if (!b) return;
    S.scope = b.getAttribute("data-scope");
    var all = $("libScopes").querySelectorAll("button");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("on", all[i] === b);
    runLib();
  });

  $("libList").addEventListener("click", function (ev) {
    var row = ev.target.closest(".fxl-row");
    if (!row) return;
    S.pick = row.getAttribute("data-id");
    var rows = $("libList").querySelectorAll(".fxl-row");
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle("on", rows[i] === row);
    renderPick();
  });

  $("libList").addEventListener("dblclick", function (ev) {
    var row = ev.target.closest(".fxl-row");
    if (!row) return;
    S.pick = row.getAttribute("data-id");
    applyPick(ev.altKey ? "adj" : "sel");
  });

  $("libQuery").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && S.results.length) {
      S.pick = S.results[0].item.id;
      applyPick(ev.altKey ? "adj" : "sel");
    }
  });

  $("aliasField").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); libAction("alias"); }
  });

  function applyPick(mode) {
    var it = S.map[S.pick];
    if (!it) return;
    var target = FXCore.resolveTarget(it, S.data, S.map);
    evalES(FXCore.applyCall(target, mode, S.data, it.name), function (res) {
      var rep = report(res, it.kind === "preset" ? "var(--blue)" : "var(--orange)");
      if (rep.ok) {
        FXCore.recordUse(S.data, it.id);
        evalES(FXCore.saveCall(S.data), function () {});
      }
      renderPick();
    });
  }

  function libAction(act) {
    var it = S.map[S.pick];
    if (!it) return;
    if (act === "apply" || act === "adj") { applyPick(act === "adj" ? "adj" : "sel"); return; }
    if (act === "star") {
      var on = FXCore.toggleFavorite(S.data, it.id);
      saveData((on ? "Starred " : "Unstarred ") + it.name);
      return;
    }
    if (act === "alias") {
      FXCore.aliasesOf(S.data, it.id).forEach(function (a) { delete S.data.aliases[a]; });
      var parts = $("aliasField").value.split(/[\s,]+/).filter(Boolean);
      parts.forEach(function (p) { FXCore.setAlias(S.data, p, it.id); });
      saveData(parts.length ? "Alias " + parts.join(", ") + " → " + it.name : "Aliases cleared for " + it.name);
      return;
    }
    if (act === "override") {
      if (S.data.overrides[it.id]) {
        delete S.data.overrides[it.id];
        saveData("Override cleared - " + it.name + " applies normally");
        return;
      }
      evalES("FG_FXS.pickPreset()", function (res) {
        var rep = FXCore.parseReply(res);
        if (!rep.ok || !rep.msg) return;             // cancelled
        S.data.overrides[it.id] = "ps:" + rep.msg;
        saveData(it.name + " now runs " + presetName("ps:" + rep.msg));
      });
    }
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-lib]");
    if (b) libAction(b.getAttribute("data-lib"));
  });

  // ---------------------------------------------------------
  // GALLERY
  // ---------------------------------------------------------
  function fileUrl(p) {
    return "file://" + encodeURI(String(p).replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F");
  }

  function loadGallery() {
    evalES("FG_FXS.listSnapshots()", function (res) {
      if (res.indexOf("OK|") !== 0) return;
      var d;
      try { d = JSON.parse(res.substring(3)); } catch (e) { return; }
      $("metaSnap").textContent = d.items.length + " snapshot" + (d.items.length === 1 ? "" : "s") + " · " + d.folder;
      $("gallery").innerHTML = d.items.slice(0, 24).map(function (s) {
        return '<button class="fxl-shot" data-reveal="' + esc(s.p) + '" title="' + esc(s.n) + ' - click to reveal">' +
               '<img loading="lazy" src="' + esc(fileUrl(s.p)) + '"><span>' + esc(s.n) + "</span></button>";
      }).join("") || '<div class="fxl-empty">No snapshots yet</div>';
    });
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-reveal]");
    if (b) evalES("FG_FXS.reveal(" + FXCore.lit(b.getAttribute("data-reveal")) + ")", function (res) { report(res, "var(--blue)"); });
  });

  // ---------------------------------------------------------
  // TILES  (data-act, so they also appear in compact view)
  // ---------------------------------------------------------
  function reindex() {
    setStatus("Scanning effects and presets...", "", "var(--blue)");
    evalES("FG_FXS.reindex()", function (res) {
      var rep = report(res, "var(--blue)");
      if (rep.ok) boot("", function () {});
    });
  }

  function checkLauncher() {
    evalES("FG_FXS.launcherStatus()", function (res) {
      if (res.indexOf("OK|") !== 0) return;
      try {
        var d = JSON.parse(res.substring(3));
        $("metaShortcut").textContent = d.installed
          ? "Launcher installed for AE " + d.version + " · bind it to Ctrl+Space"
          : "Launcher missing for AE " + d.version + " · press Install below";
      } catch (e) {}
    });
  }

  var ACTIONS = {
    open: function () {
      evalES(FXCore.popupScript(FXCore.lit(extPath()), "show", FXCore.POPUP_VERSION), function (res) {
        var rep = FXCore.parseReply(res);
        if (!rep.ok) setStatus(rep.msg, "err");
      });
    },
    reindex: reindex,
    snap: function () {
      setStatus("Rendering frame...", "");
      FXCore.snapshot(evalES, false, function (rep) { setStatus(rep.msg, rep.ok ? "ok" : "err"); loadGallery(); });
    },
    snapcopy: function () {
      setStatus("Rendering frame...", "");
      FXCore.snapshot(evalES, true, function (rep) { setStatus(rep.msg, rep.ok ? "ok" : "err"); });
    },
    snapfolder: function () { evalES("FG_FXS.openSnapshots()", function (res) { report(res, "var(--blue)"); }); },
    snaprefresh: loadGallery,
    launcher: function () {
      evalES("FG_FXS.installLauncher(" + FXCore.lit(extPath()) + ")", function (res) { report(res); checkLauncher(); });
    },
    addfolder: function () {
      evalES("FG_FXS.pickFolder()", function (res) {
        var rep = FXCore.parseReply(res);
        if (!rep.ok || !rep.msg) return;
        if (S.data.presetFolders.indexOf(rep.msg) < 0) S.data.presetFolders.push(rep.msg);
        evalES(FXCore.saveCall(S.data), function () { reindex(); renderKV(); });
      });
    }
  };

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".tile[data-act], .ctile[data-act]");
    if (!btn) return;
    var fn = ACTIONS[btn.getAttribute("data-act")];
    if (!fn) return;
    btn.classList.remove("pulse");
    void btn.offsetWidth;
    btn.classList.add("pulse");
    fn();
  });

  // the popup saved something (usage, a star, an alias)
  if (hasHost()) {
    try { window.__adobe_cep__.addEventListener(EVENT_DATA, function () { loadData(); }); } catch (e) {}
  }

  // ---------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------
  try {
    var cached = JSON.parse(localStorage.getItem(LS_INDEX) || "null");
    if (cached && cached.rows) loadIndex(cached.rows, cached.stamp);
  } catch (e) {}
  renderAll();

  evalES("FG_FXS.ping()", function (res) {
    if (res.indexOf("OK|") !== 0) {
      setStatus("Host script failed to load: " + res.replace(/^ERR\|/, ""), "err");
      return;
    }
    boot(S.stamp, function (r) {
      if (r.indexOf("OK|") === 0) setStatus("Ready - press your shortcut in the timeline", "ok", "var(--blue)");
      else setStatus("Index failed: " + r.replace(/^ERR\|/, ""), "err");
    });
    loadGallery();
    checkLauncher();
  });
})();
