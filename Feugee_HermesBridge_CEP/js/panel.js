/* =========================================================
   HERMES BRIDGE  -  PANEL LOGIC (frontend)
   Chat with Hermes (profile aebridge) over ACP, switchable model.
   AE access = MCP server hosted by this panel (js/mcp.js): Hermes
   calls mcp__ae__* tools -> HTTP on 127.0.0.1 -> evalScript.
   ========================================================= */
(function () {
  "use strict";

  var fs = require("fs");
  var path = require("path");
  var M = window.HBModels;

  // The shared Feugee updater (modes.js) identifies a plugin by reading its
  // manifest through window.cep.fs. Without cep.fs it falls back to the brand
  // text, which maps unknown plugins to "feugelign" and would overwrite this
  // panel with Feugelign's files. Guarantee cep.fs with a Node shim so the
  // manifest (com.feugee.hermesbridge) is always what identifies us.
  if (!(window.cep && window.cep.fs && typeof window.cep.fs.readFile === "function")) {
    window.cep = window.cep || {};
    window.cep.fs = {
      readFile: function (p) { try { return { err: 0, data: fs.readFileSync(p, "utf8") }; } catch (e) { return { err: 3, data: "" }; } },
      writeFile: function (p, c) { try { fs.writeFileSync(p, c); return { err: 0 }; } catch (e) { return { err: 3 }; } },
      deleteFile: function (p) { try { fs.unlinkSync(p); return { err: 0 }; } catch (e) { return { err: 3 }; } },
      makedir: function (p) { try { fs.mkdirSync(p, { recursive: true }); return { err: 0 }; } catch (e) { return { err: 3 }; } }
    };
  }

  var $ = function (id) { return document.getElementById(id); };
  var logEl = $("log"), input = $("input"), sendBtn = $("send");
  var statusEl = $("status"), ledEl = $("led"), usageEl = $("usage");
  var metaChat = $("metaChat"), metaComp = $("metaComp"), metaSession = $("metaSession");
  var drawer = $("drawer"), favsEl = $("favs");
  var modeCtx = $("modeCtx"), modeAuto = $("modeAuto"), modeLog = $("modeLog");
  var chip = $("modelChip"), chipName = $("modelName"), chipProv = $("modelProv");

  var S = window.HBSetup;
  var MOD = S.MOD;   // "Cmd" on macOS, "Ctrl" on Windows
  var BASE = S.BASE;
  var EXT_DIR = (function () {
    try { if (window.__adobe_cep__) return S.urlToPath(window.__adobe_cep__.getSystemPath("extension")); } catch (e) {}
    return S.urlToPath(location.href.split(/[?#]/)[0]).replace(/[\\\/]index\.html$/i, "");
  })();
  var FRAMES = path.join(BASE, "frames");
  var ATTACH = path.join(BASE, "attachments");

  var st = {
    ready: false, booting: false, busy: false, switching: false,
    turn: null
  };

  // ---------------------------------------------------------
  // PREFS
  // ---------------------------------------------------------
  function pref(k, d) { try { var v = localStorage.getItem("hb." + k); return v === null ? d : v; } catch (e) { return d; } }
  function setPref(k, v) { try { localStorage.setItem("hb." + k, v); } catch (e) {} }

  function bindMode(tile, key, dflt, onChange) {
    tile.classList.toggle("is-on", pref(key, dflt) === "1");
    tile.addEventListener("click", function () {
      var on = !tile.classList.contains("is-on");
      tile.classList.toggle("is-on", on);
      setPref(key, on ? "1" : "0");
      if (onChange) onChange(on);
    });
  }
  function isOn(tile) { return tile.classList.contains("is-on"); }

  bindMode(modeCtx, "ctx", "1");
  bindMode(modeAuto, "auto", "0");
  bindMode(modeLog, "log", "0", function (on) {
    drawer.hidden = !on;
    if (on) drawer.textContent = acp.logTail(150);
  });

  // ---------------------------------------------------------
  // MODEL STATE
  // ---------------------------------------------------------
  var store = new M.Store();
  var wanted = pref("model", window.Acp.DEFAULT_MODEL);   // last model the user chose

  function modelInfo(id) {
    var e = picker.get(id) || M.entry({ modelId: id });
    return e || { id: id, label: String(id).replace(/^.*[\/:]/, ""), providerLabel: "?" };
  }
  function modelLabel(id) { return modelInfo(id || acp.currentModel).label; }

  function paintChip() {
    var id = acp.currentModel || wanted, e = modelInfo(id);
    chipName.textContent = e.label;
    chipProv.textContent = e.providerLabel;
    chip.title = id + " - klik untuk ganti (" + MOD + "+K)";
    chip.classList.toggle("switching", st.switching || st.booting);
    chip.classList.toggle("bad", !!store.health(id));
    metaSession.textContent = e.label + " - " + (e.providerLabel || "") + (acp.sessionId ? " - " + String(acp.sessionId).slice(0, 8) : "");
    renderFavs();
  }

  function renderFavs() {
    var cur = acp.currentModel;
    var avail = store.favs().filter(function (id) { return !picker.list.length || picker.get(id); });
    favsEl.innerHTML = avail.slice(0, 4).map(function (id) {
      var e = modelInfo(id);
      return '<button class="tile chip' + (id === cur ? " is-on" : "") + '" data-model="' + esc(id) +
        '" title="' + esc(id) + '"><span>' + esc(e.label) + "</span></button>";
    }).join("");
  }

  // ---------------------------------------------------------
  // STATUS (same behaviour as the other Feugee panels)
  // ---------------------------------------------------------
  function setStatus(text, kind, accent) {
    statusEl.textContent = text;
    statusEl.classList.toggle("is-err", kind === "err");
    ledEl.className = "led " + (kind === "err" ? "err" : kind === "ok" ? "ok" : kind === "busy" ? "busy" : "");
    statusEl.style.setProperty("--flash", accent || "var(--orange)");
    statusEl.classList.remove("flash");
    void statusEl.offsetWidth;
    statusEl.classList.add("flash");
  }

  // ---------------------------------------------------------
  // MARKDOWN (small, safe subset)
  // ---------------------------------------------------------
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  }

  var RUNNABLE = { jsx: 1, extendscript: 1, aescript: 1 };
  var codeStore = [];

  function renderText(block) {
    var lines = block.split("\n"), html = "", list = false, para = [];
    function flush() {
      if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; }
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var m = ln.match(/^\s*[-*]\s+(.*)$/);
      var h = ln.match(/^#{1,4}\s+(.*)$/);
      if (m) {
        flush();
        if (!list) { html += "<ul>"; list = true; }
        html += "<li>" + inline(m[1]) + "</li>";
        continue;
      }
      if (list) { html += "</ul>"; list = false; }
      if (h) { flush(); html += "<h4>" + inline(h[1]) + "</h4>"; continue; }
      if (!ln.trim()) { flush(); continue; }
      para.push(ln);
    }
    flush();
    if (list) html += "</ul>";
    return html;
  }

  function renderMd(raw, live) {
    var parts = String(raw).split("```"), html = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 0) { html += renderText(parts[i]); continue; }
      var body = parts[i], nl = body.indexOf("\n"), lang = "";
      if (nl >= 0) { lang = body.slice(0, nl).trim().toLowerCase(); body = body.slice(nl + 1); }
      body = body.replace(/\n$/, "");
      html += "<pre>" + esc(body) + "</pre>";
      var closed = i < parts.length - 1;
      if (!live && closed && RUNNABLE[lang]) {
        var idx = codeStore.push(body) - 1;
        html += '<div class="hb-run"><button class="tile chip" data-run="' + idx + '" title="Jalankan di After Effects (satu undo group)">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5v14l11-7z"/></svg><span>RUN IN AE</span></button></div>';
      }
    }
    return html;
  }

  // ---------------------------------------------------------
  // CHAT LOG
  // ---------------------------------------------------------
  function nearBottom() { return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 70; }
  function down(force) { if (force || nearBottom()) logEl.scrollTop = logEl.scrollHeight; }
  function hhmm() { var d = new Date(); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }

  function bubble(role) {
    var d = document.createElement("div");
    d.className = "hb-msg " + role;
    d.innerHTML = '<div class="hb-who">' + (role === "user" ? "KAMU" : "HERMES") + ' <span class="t">' + hhmm() + "</span>" +
      (role === "user" ? "" : '<span class="mdl">' + esc(modelLabel()) + "</span>") + "</div>" +
      '<div class="hb-body"></div><div class="hb-tools"></div>';
    logEl.appendChild(d);
    down(true);
    return { root: d, body: d.querySelector(".hb-body"), tools: d.querySelector(".hb-tools") };
  }

  function note(text, err) {
    var d = document.createElement("div");
    d.className = "hb-note" + (err ? " err" : "");
    d.textContent = text;
    logEl.appendChild(d);
    down(true);
  }

  function switchLine(text) {
    var d = document.createElement("div");
    d.className = "hb-switch";
    d.textContent = text;
    logEl.appendChild(d);
    down(true);
  }

  function toolRow(host, id, title, ae) {
    var d = document.createElement("div");
    d.className = "hb-tool" + (ae ? " ae" : "");
    if (id) d.setAttribute("data-tc", id);
    d.innerHTML = "<i></i>" + (ae ? "<b>AE</b> " : "") + esc(title);
    d.title = title;
    host.appendChild(d);
    down();
    return d;
  }

  function ensureTurn() {
    if (!st.turn) {
      var b = bubble("agent");
      st.turn = { b: b, text: "", queued: false, tools: {} };
    }
    return st.turn;
  }

  function paint() {
    var t = st.turn;
    if (!t || t.queued) return;
    t.queued = true;
    requestAnimationFrame(function () {
      t.queued = false;
      if (st.turn !== t) return;
      t.b.body.innerHTML = renderMd(t.text, true) + '<span class="hb-caret"></span>';
      down();
    });
  }

  function endTurn() {
    var t = st.turn;
    st.turn = null;
    if (!t) return "";
    t.b.body.innerHTML = t.text ? renderMd(t.text, false) : '<span class="hb-think">(tanpa teks)</span>';
    down();
    return t.text;
  }

  // ---------------------------------------------------------
  // ACP (backend)
  // ---------------------------------------------------------
  var acp = new window.Acp({
    onLog: function (l) { if (isOn(modeLog)) drawer.textContent = (drawer.textContent + "\n" + l).slice(-30000); },
    onError: function (m) { note(m, true); },
    onExit: function (i) {
      var wasReady = st.ready;
      st.ready = false; st.booting = false; st.switching = false;
      if (st.busy) { endTurn(); setBusy(false); }
      metaChat.textContent = "Agent mati - klik RESTART";
      paintChip();
      if (wasReady) setStatus("Hermes berhenti (code " + i.code + ")", "err");
    },
    onUsage: function (u) {
      if (u && u.size) usageEl.textContent = Math.round(u.used / 1000) + "k / " + Math.round(u.size / 1000) + "k ctx";
    },
    onStream: function (s) { var t = ensureTurn(); t.text += s.text; paint(); },
    onThought: function () { if (st.busy) setStatus(modelLabel() + " berpikir...", "busy", "var(--blue)"); },
    onTool: function (x) {
      var t = ensureTurn();
      if (t.tools[x.toolCallId]) return;
      var ae = /mcp__ae__|^ae[_:]/.test(x.title);
      var label = x.title.replace(/^mcp__ae__/, "").replace(/_/g, " ");
      t.tools[x.toolCallId] = toolRow(t.b.tools, x.toolCallId, ae ? label : x.title, ae);
      setStatus((ae ? "AE: " + label : x.title).slice(0, 80), "busy", "var(--blue)");
    },
    onToolUpdate: function (x) {
      var t = st.turn;
      var row = t && t.tools[x.toolCallId];
      if (!row) return;
      if (x.status === "completed") row.classList.add("done");
      else if (x.status === "failed") row.classList.add("fail");
    },
    onPermission: function (p) { permission(p); }
  });

  // ---------------------------------------------------------
  // MODEL PICKER
  // ---------------------------------------------------------
  var picker = new M.Picker({
    root: $("picker"),
    store: store,
    getCurrent: function () { return acp.currentModel; },
    onPick: function (id) { switchModel(id); }
  });
  picker.onClose = function () { chip.classList.remove("open"); };
  picker.onFavsChange = renderFavs;

  function openPicker() {
    if (!picker.list.length) { note(st.booting ? "daftar model belum ada - tunggu Hermes menyala" : "daftar model kosong - klik RESTART", true); return; }
    chip.classList.add("open");
    picker.open();
  }

  chip.addEventListener("click", function (e) { e.stopPropagation(); if (picker.isOpen()) picker.close(); else openPicker(); });
  document.addEventListener("mousedown", function (e) {
    if (picker.isOpen() && !e.target.closest("#picker") && !e.target.closest("#modelChip")) picker.close();
  });

  // Switch keeps the conversation: Hermes rebuilds the agent with the same history.
  function switchModel(id) {
    if (!id || id === acp.currentModel) return Promise.resolve(true);
    if (st.switching) { note("masih ganti model"); return Promise.resolve(false); }
    if (st.busy) { note("tunggu jawaban selesai (atau STOP) sebelum ganti model", true); return Promise.resolve(false); }
    if (!st.ready || !acp.alive()) {
      wanted = id; setPref("model", id); paintChip();
      if (!st.booting) boot();
      return Promise.resolve(true);
    }
    var from = acp.currentModel;
    st.switching = true; paintChip();
    setStatus("Ganti model ke " + modelLabel(id) + "...", "busy", "var(--blue)");
    return acp.setModel(id).then(function () {
      st.switching = false;
      wanted = id; setPref("model", id);
      store.pushRecent(id);
      paintChip();
      var bad = store.health(id);
      switchLine(modelLabel(from) + "  ->  " + modelLabel(id));
      setStatus("Model: " + modelLabel(id) + (bad ? " - terakhir gagal (" + bad.why + ")" : ""), bad ? "err" : "ok");
      return true;
    }).catch(function (e) {
      st.switching = false; paintChip();
      var msg = (e && (e.message || (e.data && e.data.message))) || JSON.stringify(e);
      store.markBad(id, "ditolak");
      setStatus("Gagal ganti model: " + msg, "err");
      note("gagal ganti ke " + id + ": " + msg, true);
      return false;
    });
  }

  // cycle through favourites (Cmd+Shift+M)
  function cycleFav(dir) {
    var f = store.favs().filter(function (id) { return picker.get(id); });
    if (!f.length) return;
    var i = f.indexOf(acp.currentModel);
    switchModel(f[(i + dir + f.length) % f.length]);
  }

  // ---------------------------------------------------------
  // PERMISSION
  // ---------------------------------------------------------
  function permission(p) {
    var opts = (p.params && p.params.options) || [];
    var allow = null, i;
    for (i = 0; i < opts.length && !allow; i++) if (opts[i].kind === "allow_once") allow = opts[i];
    for (i = 0; i < opts.length && !allow; i++) if (/^allow/.test(opts[i].kind)) allow = opts[i];

    var tc = p.params && p.params.toolCall;
    var what = (tc && (tc.title || tc.kind)) || "aksi";

    if (isOn(modeAuto) && allow) {
      acp.respondPermission(p.id, allow.optionId);
      note("auto-ok: " + what);
      return;
    }

    var card = document.createElement("div");
    card.className = "hb-perm";
    var detail = "";
    try { detail = JSON.stringify((tc && (tc.rawInput || tc.content)) || p.params, null, 1).slice(0, 700); } catch (e) {}
    card.innerHTML = '<div class="hb-who">IZIN DIPERLUKAN <span class="t">' + esc(what) + "</span></div>" +
      (detail ? "<pre>" + esc(detail) + "</pre>" : "") + '<div class="row"></div>';
    var row = card.querySelector(".row");

    function answer(fn, label) {
      card.classList.add("done");
      fn();
      note(label);
      setStatus("Izin: " + label, "busy");
    }
    opts.forEach(function (o) {
      var b = document.createElement("button");
      b.className = "tile chip";
      b.innerHTML = "<span>" + esc((o.name || o.optionId).toUpperCase()) + "</span>";
      b.onclick = function () { answer(function () { acp.respondPermission(p.id, o.optionId); }, o.name || o.optionId); };
      row.appendChild(b);
    });
    var no = document.createElement("button");
    no.className = "tile chip danger";
    no.innerHTML = "<span>TOLAK</span>";
    no.onclick = function () { answer(function () { acp.cancelPermission(p.id); }, "ditolak"); };
    row.appendChild(no);

    logEl.appendChild(card);
    down(true);
    setStatus("Hermes minta izin: " + what, "busy", "var(--orange)");
  }

  // ---------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------
  function afterSession() {
    picker.setModels(acp.models);
    // a saved model that disappeared from the catalog falls back to the default
    if (!picker.get(wanted)) wanted = picker.get(window.Acp.DEFAULT_MODEL) ? window.Acp.DEFAULT_MODEL : acp.currentModel;
    if (!wanted || acp.currentModel === wanted) return Promise.resolve();
    return acp.setModel(wanted).catch(function () {
      note("model tersimpan " + wanted + " ditolak - pakai " + window.Acp.DEFAULT_MODEL, true);
      wanted = window.Acp.DEFAULT_MODEL; setPref("model", wanted);
      return acp.setModel(wanted);
    });
  }

  function boot() {
    if (st.booting) return;
    st.booting = true; st.ready = false;
    setStatus("Cek setup Hermes...", "busy");
    window.HBSetup.check(EXT_DIR).then(function (s) {
      if (!s.ok) { st.booting = false; showSetup(s); return; }
      hideSetup();
      startAgent();
    });
  }

  // ---------------------------------------------------------
  // FIRST-RUN SETUP (js/setup.js)
  // ---------------------------------------------------------
  var setupEl = $("setup"), setupAct = $("setupAction");
  var setupState = null;
  var STEP_ORDER = { install: 0, profile: 1, login: 2, ready: 3, platform: -1 };

  function showSetup(s) {
    setupState = s;
    setupEl.hidden = false;
    logEl.style.display = "none";
    $("setupMsg").textContent = s.message || "";
    var at = STEP_ORDER[s.step];
    [["stepInstall", 0], ["stepProfile", 1], ["stepLogin", 2]].forEach(function (x) {
      var li = $(x[0]);
      li.classList.toggle("done", at > x[1]);
      li.classList.toggle("now", at === x[1]);
    });
    var label = { install: "INSTALL HERMES", login: "LOGIN MODEL", profile: "COBA LAGI", platform: "" }[s.step];
    setupAct.hidden = !label;
    setupAct.querySelector("span").textContent = label || "";
    metaChat.textContent = "Setup belum selesai";
    setStatus(s.message || "Setup Hermes belum selesai", "err");
  }

  function hideSetup() { setupEl.hidden = true; logEl.style.display = ""; }

  setupAct.addEventListener("click", function () {
    if (!setupState) return;
    if (setupState.step === "install") { window.HBSetup.openInstall(); setStatus("Install jalan di Terminal - klik CEK LAGI kalau sudah", "busy"); }
    else if (setupState.step === "login") { window.HBSetup.openLogin(setupState.bin); setStatus("Pilih provider & model di Terminal - klik CEK LAGI kalau sudah", "busy"); }
    else boot();
  });
  $("setupRecheck").addEventListener("click", function () { boot(); });

  function startAgent() {
    paintChip();
    metaChat.textContent = "Menyalakan Hermes...";
    setStatus("Menyalakan Hermes (" + modelLabel(wanted) + ")...", "busy");
    var t0 = Date.now();
    aeMcp.start().then(function () {
      acp.mcpServers = [aeMcp.acpEntry()];
      if (!acp.alive()) acp.spawn();
      return acp.initialize();
    }).then(function () { return acp.newSession(); })
    .then(afterSession)
    .then(function () {
      st.booting = false; st.ready = true;
      store.pushRecent(acp.currentModel);
      paintChip();
      metaChat.textContent = "Siap (" + ((Date.now() - t0) / 1000).toFixed(1) + "s) - " + picker.list.length + " model tersedia";
      if (!aeMcp.listedAt) {
        setStatus("Hermes siap, tapi tool AE belum terpasang - klik RESTART", "err");
        note("Hermes tidak mengambil daftar tool AE (MCP). Tanpa itu dia tidak bisa menyentuh AE. Klik RESTART; kalau tetap, buka LOG.", true);
      } else {
        setStatus("Hermes siap - " + modelLabel() + " - " + window.AeMcpServer.TOOLS.length + " tool AE", "ok");
      }
      input.focus();
    }).catch(function (e) {
      st.booting = false; paintChip();
      metaChat.textContent = "Gagal start - klik RESTART";
      setStatus("Gagal start: " + ((e && e.message) || JSON.stringify(e)), "err");
      note("gagal start: " + ((e && e.message) || JSON.stringify(e)), true);
    });
  }

  function restart() {
    acp.kill();
    st.busy = false; st.turn = null; st.switching = false;
    aeMcp.queue = Promise.resolve();
    setBusy(false);
    note("agent dinyalakan ulang");
    setTimeout(boot, 150);
  }

  // ---------------------------------------------------------
  // PROMPT
  // ---------------------------------------------------------
  // Operating rules live in HermesBridge/workspace/.hermes.md (loaded once as
  // project context, cached by the provider) - nothing is re-sent per turn.

  function evalHost(expr, cb) {
    if (!window.__adobe_cep__ || !window.__adobe_cep__.evalScript) return cb("");
    try { window.__adobe_cep__.evalScript(expr, function (r) { cb(typeof r === "string" ? r : ""); }); }
    catch (e) { cb(""); }
  }

  function compContext(cb) {
    evalHost("hbGetComp(null, 40)", function (raw) {
      var r = null, o = null;
      try { r = JSON.parse(raw); } catch (e) {}
      if (!r) return cb("[Konteks AE: tidak terbaca]");
      if (!r.ok) return cb("[Konteks AE: " + (r.error || "tidak ada comp aktif") + "]");
      o = r.data;
      o.layerCount = o.comp.numLayers;
      var c = o.comp, L = ["[Konteks AE]",
        "Project: " + o.project,
        'Comp aktif: "' + c.name + '" ' + c.width + "x" + c.height + " @" + c.fps + "fps, durasi " + c.duration +
          "s, CTI " + c.time + "s, work area " + c.workStart + "-" + c.workEnd + "s",
        "Layer terpilih: " + (o.selected.length ? "#" + o.selected.join(", #") : "(tidak ada)"),
        "Layer (" + o.layerCount + (o.layerCount > o.layers.length ? ", " + o.layers.length + " pertama" : "") + ", * = terpilih):"];
      o.layers.forEach(function (l) {
        L.push("  #" + l.i + (l.sel ? "*" : " ") + ' "' + l.name + '" ' + l.type + (l.on ? "" : " OFF") +
          (l.threeD ? " 3D" : "") + (l.parent ? " parent#" + l.parent : "") + " " + l["in"] + "-" + l.out + "s");
      });
      L.push("[/Konteks]");
      cb(L.join("\n"));
    });
  }

  function setBusy(on) {
    st.busy = on;
    sendBtn.classList.toggle("is-stop", on);
    sendBtn.querySelector("span").textContent = on ? "STOP" : "SEND";
    sendBtn.title = on ? "Hentikan (Esc)" : "Kirim (Enter)";
    chip.disabled = on;
  }

  var lastSent = null;   // {text,label} for the "retry on another model" button

  function send(text, label) {
    text = String(text || "").replace(/\s+$/, "");
    if (!text) return;
    if (st.busy) { note("masih mengerjakan perintah sebelumnya"); return; }
    if (st.switching) { note("tunggu ganti model selesai"); return; }
    if (!st.ready) { note(st.booting ? "Hermes masih menyala, tunggu sebentar" : "Hermes mati - klik RESTART", !st.booting); return; }

    var imgs = attachments.splice(0);
    paintAttachments();
    lastSent = { text: text, label: label };
    var ub = bubble("user");
    ub.body.innerHTML = renderMd(label || text, false);
    imgs.forEach(function (a) {
      var im = document.createElement("img");
      im.className = "hb-uimg"; im.src = fileUrl(a.path); im.title = a.path;
      ub.body.appendChild(im);
    });
    if (imgs.length) {
      text += "\n\n[Gambar referensi dari user - lihat dengan vision_analyze sebelum mengerjakan:\n" +
        imgs.map(function (a) { return "- " + a.path; }).join("\n") + "]";
    }
    aeMcp.newTurn();
    setBusy(true);
    var usedModel = acp.currentModel;
    setStatus(modelLabel(usedModel) + " mengerjakan...", "busy", "var(--blue)");

    function go(ctx) {
      var parts = [];
      if (ctx) parts.push(ctx);
      parts.push(text);
      var t0 = Date.now();
      ensureTurn();
      paint();
      acp.prompt(parts.join("\n\n")).then(function (r) {
        var reply = endTurn();
        var sec = ((Date.now() - t0) / 1000).toFixed(1);
        var sr = r && r.stopReason;
        var fail = M.detectFailure(reply);
        if (fail) {
          store.markBad(usedModel, fail);
          paintChip();
          setStatus(modelLabel(usedModel) + " gagal (" + fail + ") - pilih model lain", "err");
          offerRetry(usedModel, fail);
        } else if (sr === "cancelled") setStatus("Dihentikan (" + sec + "s)", "err");
        else if (sr && sr !== "end_turn") setStatus("Selesai: " + sr + " (" + sec + "s)", "err");
        else {
          store.markGood(usedModel);
          setStatus("Selesai (" + sec + "s) - " + modelLabel(usedModel), "ok");
        }
      }).catch(function (e) {
        endTurn();
        setStatus("Gagal: " + ((e && e.message) || "error"), "err");
        note("prompt gagal: " + ((e && e.message) || JSON.stringify(e)), true);
      }).then(function () { setBusy(false); refreshMeta(); paintChip(); });
    }

    if (isOn(modeCtx)) compContext(go); else go(null);
  }

  // A provider refused (403/404/credit): one click to rerun on a healthy favourite.
  function offerRetry(badId, why) {
    var alt = store.favs().filter(function (id) { return id !== badId && picker.get(id) && !store.health(id); })[0];
    var d = document.createElement("div");
    d.className = "hb-note err";
    d.innerHTML = esc(modelLabel(badId) + " ditolak provider (" + why + "). ") +
      (alt ? '<button class="tile chip" data-retry="' + esc(alt) + '"><span>ULANGI DI ' + esc(modelLabel(alt).toUpperCase()) + "</span></button> " : "") +
      '<button class="tile chip" data-pick="1"><span>PILIH MODEL</span></button>';
    logEl.appendChild(d);
    down(true);
  }

  function stop() {
    if (!st.busy) return;
    acp.cancel();
    setStatus("Menghentikan...", "busy", "var(--danger)");
  }

  // ---------------------------------------------------------
  // QUICK ACTIONS
  // ---------------------------------------------------------
  var QUICK = {
    inspect: ["Inspect comp aktif", "Inspect comp aktif: struktur layer, precomp, expression yang error, layer OFF/shy, layer yang in/out-nya di luar durasi comp, dan parenting yang aneh. Laporkan ringkas yang janggal saja. JANGAN mengubah apa pun."],
    organize: ["Rapikan layer", "Rapikan comp aktif dalam SATU run_script: rename layer yang masih bernama default (Shape Layer 1, Null 3, Layer 1, Solid, dsb) jadi nama deskriptif berdasarkan isinya, dan set label color per tipe layer (text, shape, null/controller, precomp, footage, adjustment). Jangan ubah timing, posisi, atau urutan. Laporkan tabel singkat nama lama -> baru."],
    expr: ["Perbaiki expression error", "Panggil expression_errors untuk comp aktif. Perbaiki semua penyebabnya dalam satu run_script dengan perubahan sekecil mungkin, lalu panggil expression_errors sekali lagi untuk verifikasi. Laporkan per property: error -> perbaikan."],
    ease: ["Easy ease keyframe terpilih", "Terapkan easy ease ke keyframe yang terpilih di comp aktif (kalau tidak ada keyframe terpilih: semua keyframe di layer terpilih). Pakai KeyframeEase influence 75 speed 0 in/out, jaga dimensi property spatial vs non-spatial dengan benar. Laporkan jumlah keyframe yang diubah per property."],
    vertical: ["Buat versi 9:16", "Buat versi vertikal 9:16 (1080x1920) dari comp aktif sebagai COMP BARU bernama '<nama> 9x16' - comp asli jangan diubah. Nest atau duplikasi, fit subjek utama, jaga safe area teks. Laporkan skala/posisi yang dipakai dan elemen yang perlu dicek manual."],
    frame: ["Cek frame di CTI", "Panggil render_frame untuk comp aktif di posisi CTI, lalu lihat gambarnya dengan vision_analyze dan kasih kritik visual singkat: komposisi, hierarki, keterbacaan teks, warna."]
  };

  // ---------------------------------------------------------
  // AE MCP SERVER (Hermes' only way into After Effects)
  // ---------------------------------------------------------
  var aeMcp = new window.AeMcpServer({
    evalHost: evalHost,
    frameDir: FRAMES,
    onCall: function (c) {
      if (c.name === "run_script") setStatus("AE: menjalankan script...", "busy", "var(--blue)");
    },
    onDone: function (c) {
      var t = st.turn;
      if (!t) return;
      // attach timing to the matching (last unfinished) AE row
      var rows = t.b.tools.querySelectorAll(".hb-tool.ae:not(.timed)");
      var row = rows[rows.length - 1];
      if (c.capped) {
        setStatus("Batas " + aeMcp.maxTurnCalls + " panggilan AE tercapai - Hermes diminta lapor dulu", "err");
      }
      if (row) {
        row.classList.add("timed");
        if (c.capped) row.classList.add("fail");
        var s = document.createElement("span");
        s.className = "ms";
        s.textContent = " " + (c.ms < 1000 ? c.ms + "ms" : (c.ms / 1000).toFixed(1) + "s");
        row.appendChild(s);
        if (!c.ok) row.title = c.text;
      }
    }
  });

  function runInAE(code, cb) {
    evalHost("hbEval(" + JSON.stringify(String(code)) + ", \"Hermes Bridge\")", function (raw) {
      var r = null;
      try { r = JSON.parse(raw); } catch (e) {}
      if (!r) return cb("ERR: no reply from After Effects (host script not loaded?)");
      if (!r.ok) return cb("ERR: " + r.error + (r.line ? " (line " + r.line + ")" : ""));
      cb(r.result === null ? "OK" : (typeof r.result === "string" ? r.result : JSON.stringify(r.result)));
    });
  }

  function cleanFrames() {
    [[FRAMES, 6], [ATTACH, 72]].forEach(function (d) {
      try {
        var now = Date.now();
        fs.readdirSync(d[0]).forEach(function (f) {
          var p = path.join(d[0], f);
          if (now - fs.statSync(p).mtimeMs > d[1] * 3600 * 1000) fs.unlinkSync(p);
        });
      } catch (e) {}
    });
  }

  // ---------------------------------------------------------
  // IMAGE ATTACHMENTS (paste / drag-drop)
  // Saved into HermesBridge/attachments so Hermes' vision_analyze can read
  // them (clipboard-history paths under ~/Library/Metadata are TCC-blocked).
  // ---------------------------------------------------------
  var attachments = [];
  var IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;
  var attachBar = document.createElement("div");
  attachBar.className = "hb-attach";
  input.parentNode.parentNode.insertBefore(attachBar, input.parentNode);

  function fileUrl(p) { return S.fileUrl(p); }
  function attachName(ext) { return path.join(ATTACH, "img_" + Date.now() + "_" + Math.floor(Math.random() * 1e4) + "." + ext); }

  function paintAttachments() {
    attachBar.innerHTML = "";
    attachBar.style.display = attachments.length ? "flex" : "none";
    attachments.forEach(function (a, i) {
      var el = document.createElement("div");
      el.className = "hb-athumb";
      el.innerHTML = '<img><button title="Hapus">x</button>';
      el.querySelector("img").src = fileUrl(a.path);
      el.querySelector("button").addEventListener("click", function () { attachments.splice(i, 1); paintAttachments(); });
      attachBar.appendChild(el);
    });
  }

  // Big screenshots cost ~20s in vision_analyze; shrink to 1280px on the long side.
  // PNG output keeps alpha. Falls back to the original file on any failure.
  var MAX_ATTACH = 1280;
  function shrinkImage(p, cb) {
    var img = new Image();
    img.onload = function () {
      try {
        var w = img.naturalWidth, h = img.naturalHeight, k = MAX_ATTACH / Math.max(w, h);
        if (k >= 1) return cb(p);
        var c = document.createElement("canvas");
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        var g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, c.width, c.height);
        var out = p.replace(/\.[a-z0-9]+$/i, "") + "_" + c.width + ".png";
        fs.writeFileSync(out, require("buffer").Buffer.from(c.toDataURL("image/png").split(",")[1], "base64"));
        try { fs.unlinkSync(p); } catch (e) {}
        cb(out);
      } catch (e) { cb(p); }
    };
    img.onerror = function () { cb(p); };
    var mime = /\.jpe?g$/i.test(p) ? "image/jpeg" : /\.webp$/i.test(p) ? "image/webp" : /\.gif$/i.test(p) ? "image/gif" : "image/png";
    try { img.src = "data:" + mime + ";base64," + fs.readFileSync(p).toString("base64"); } catch (e) { cb(p); }
  }

  function addAttachment(p) {
    if (attachments.length >= 4) { note("maksimal 4 gambar per pesan", true); return; }
    shrinkImage(p, function (fin) {
      attachments.push({ path: fin });
      paintAttachments();
      setStatus("Gambar terlampir (" + attachments.length + ") - tulis perintah lalu Enter", "ok");
    });
  }

  function saveBlob(blob) {
    var ext = ((blob.type || "image/png").split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
    var fr = new FileReader();
    fr.onload = function () {
      try {
        fs.mkdirSync(ATTACH, { recursive: true });
        var p = attachName(ext);
        fs.writeFileSync(p, new Uint8Array(fr.result));
        addAttachment(p);
      } catch (e) { note("gagal menyimpan gambar: " + e.message, true); }
    };
    fr.readAsArrayBuffer(blob);
  }

  function copyImageFile(src) {
    src = S.urlToPath(src);
    try {
      fs.mkdirSync(ATTACH, { recursive: true });
      var ext = (src.match(/\.([a-z0-9]+)$/i) || [, "png"])[1].toLowerCase();
      var p = attachName(ext);
      fs.copyFileSync(src, p);
      addAttachment(p);
      return true;
    } catch (e) {
      note("gambar tidak bisa dibaca (" + (e.code || e.message) + "). Coba screenshot (" + (S.IS_WIN ? "Win+Shift+S" : "Cmd+Shift+Ctrl+4") + ") lalu paste, atau drag file-nya ke sini.", true);
      return false;
    }
  }

  input.addEventListener("paste", function (e) {
    var cd = e.clipboardData;
    if (!cd) return;
    var items = cd.items || [], hit = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === "file" && /^image\//.test(items[i].type)) {
        var b = items[i].getAsFile();
        if (b) { saveBlob(b); hit = true; }
      }
    }
    if (!hit) {
      // Clipboard history / Finder copy gives a file:// URL as text instead of pixels.
      var t = (cd.getData("text/plain") || "").trim();
      if (/^file:\/\//.test(t) && IMG_EXT.test(t.split("?")[0])) hit = copyImageFile(t) || true;
    }
    if (hit) e.preventDefault();
  });

  ["dragenter", "dragover"].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.add("hb-dropping"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    document.addEventListener(ev, function (e) { if (ev === "drop" || !e.relatedTarget) document.body.classList.remove("hb-dropping"); });
  });
  document.addEventListener("drop", function (e) {
    e.preventDefault();
    var files = (e.dataTransfer && e.dataTransfer.files) || [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.path && IMG_EXT.test(f.path)) copyImageFile(f.path);
      else if (/^image\//.test(f.type)) saveBlob(f);
    }
  });

  // ---------------------------------------------------------
  // COMP META (cheap read-only poll)
  // ---------------------------------------------------------
  function refreshMeta() {
    if (document.hidden) return;
    evalHost("hbCompMeta()", function (r) { if (r) metaComp.textContent = r; });
  }

  // ---------------------------------------------------------
  // EVENTS
  // ---------------------------------------------------------
  document.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest("[data-run], [data-model], [data-retry], [data-pick], .tile[data-act]") : null;
    if (!t) return;

    if (t.hasAttribute("data-model")) { switchModel(t.getAttribute("data-model")); return; }
    if (t.hasAttribute("data-pick")) { openPicker(); return; }
    if (t.hasAttribute("data-retry")) {
      var target = t.getAttribute("data-retry"), again = lastSent;
      t.parentNode.querySelectorAll(".tile").forEach(function (b) { b.disabled = true; });
      switchModel(target).then(function (ok) { if (ok && again) send(again.text, again.label); });
      return;
    }

    var ri = t.getAttribute("data-run");
    if (ri !== null) {
      var code = codeStore[+ri];
      if (code === undefined || t.classList.contains("busy")) return;
      t.classList.add("busy");
      setStatus("Menjalankan script di AE...", "busy");
      runInAE(code, function (res) {
        t.classList.remove("busy");
        var pre = document.createElement("pre");
        pre.className = "res" + (/^ERR:/.test(res) ? " err" : "");
        pre.textContent = res;
        t.parentNode.parentNode.insertBefore(pre, t.parentNode.nextSibling);
        setStatus(/^ERR:/.test(res) ? "Script error - lihat hasil" : "Script selesai (" + MOD + "+Z untuk batal)", /^ERR:/.test(res) ? "err" : "ok");
        refreshMeta();
      });
      return;
    }

    var act = t.getAttribute("data-act") || "";
    t.classList.remove("pulse"); void t.offsetWidth; t.classList.add("pulse");
    var kv = act.split(":");
    if (kv[0] === "quick" && QUICK[kv[1]]) send(QUICK[kv[1]][1], QUICK[kv[1]][0]);
    else if (act === "session:new") newSession();
    else if (act === "session:stop") stop();
    else if (act === "session:restart") restart();
  });

  function newSession() {
    if (st.busy) { note("hentikan dulu perintah yang berjalan"); return; }
    if (!acp.alive()) { boot(); return; }
    setStatus("Sesi baru...", "busy");
    acp.newSession().then(afterSession).then(function () {
      logEl.innerHTML = "";
      codeStore = [];
      usageEl.textContent = "";
      paintChip();
      setStatus("Sesi baru - " + modelLabel(), "ok");
    }).catch(function (e) { setStatus("Gagal membuat sesi: " + ((e && e.message) || ""), "err"); });
  }

  sendBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    if (st.busy) { stop(); return; }
    var v = input.value; input.value = ""; autosize();
    if (!v.trim() && attachments.length) v = "Lihat gambar ini.";
    send(v);
  });

  function autosize() { input.style.height = "auto"; input.style.height = Math.min(160, Math.max(46, input.scrollHeight)) + "px"; }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (st.busy) return;
      var v = input.value.trim();
      // "/model opus" -> switch without leaving the keyboard
      var m = v.match(/^\/model\s*(.*)$/i);
      if (m) {
        input.value = ""; autosize();
        if (!m[1]) { openPicker(); return; }
        var hit = M.search(picker.list, m[1])[0];
        if (hit) switchModel(hit.id); else note("model '" + m[1] + "' tidak ketemu", true);
        return;
      }
      if (!v && attachments.length) v = "Lihat gambar ini.";
      input.value = ""; autosize();
      send(v);
    }
  });
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); if (picker.isOpen()) picker.close(); else openPicker(); return; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "m" || e.key === "M")) { e.preventDefault(); cycleFav(1); return; }
    if (e.key === "Escape") { if (picker.isOpen()) picker.close(); else stop(); }
  });

  // kill the agent with the panel, never leave an orphan python behind
  window.addEventListener("beforeunload", function () { acp.kill(); aeMcp.stop(); });

  // ---------------------------------------------------------
  // START
  // ---------------------------------------------------------
  try { fs.mkdirSync(FRAMES, { recursive: true }); fs.mkdirSync(ATTACH, { recursive: true }); } catch (e) {}
  paintAttachments();
  cleanFrames();
  setInterval(refreshMeta, 1500);
  refreshMeta();
  paintChip();
  try { $("hintKeys").textContent = "Enter kirim - Esc stop - " + MOD + "+K model"; } catch (e) {}
  note("Hermes Bridge 2.2 - Hermes pegang AE lewat tool MCP (get comp/layer, run script, render frame). Tiap script = 1 undo group. Ganti model: chip, " + MOD + "+K, atau /model.");
  boot();
})();
