/* =========================================================
   HERMES BRIDGE PR - PREMIERE PRO MCP SERVER
   Streamable-HTTP MCP server living inside the CEP panel.
   Hermes (ACP) connects to it per session; every tool call is
   one evalScript into jsx/host.jsx. Loopback only + bearer token.
   Same transport as the After Effects panel (js/mcp.js there).
   ========================================================= */
(function (global) {
  "use strict";

  var http = require("http");
  var crypto = require("crypto");
  var fs = require("fs");
  var path = require("path");
  var Buf = require("buffer").Buffer;   // CEP window context may not expose the Buffer global

  var PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
  var MAX_CALLS = 10;

  var INSTRUCTIONS = [
    "Tools that act directly on the Premiere Pro project the user has open.",
    "Read first (get_sequence / get_clip / get_markers / get_project), then change with run_script.",
    "Premiere has NO undo groups: every DOM change is its own Cmd/Ctrl+Z step. Batch a whole change into ONE run_script anyway (speed),",
    "and prefer non-destructive edits (clone the sequence, add markers) for big changes. The panel copies the saved .prproj before the first run_script of each message.",
    "A run_script summary proves the edit ran, not that it looks right: for any visual change, export_frame at the key times and compare against the user reference before calling it done.",
    "Stock assets: envato_search (Envato Elements catalog, own budget of 8 searches per message) -> import_media {item_url, download: true} for the item the user picked (downloads it in the user's logged-in browser, unzips, imports into an Envato bin)."
  ].join(" ");

  var SEQ = { type: "string", description: "Sequence name or sequenceID. Omit for the active sequence." };

  var TOOLS = [
    {
      name: "get_sequence",
      description: "Active sequence (or a named one): size, fps, duration, playhead, in/out, marker count, every track (V1.., A1..; muted/locked/clip count) and a clip table: track, i (0-based index = track.clips[i]), name, start/end on the timeline, in/out in the source (seconds), media path, speed, off/sel/mogrt/nest/offline flags. Call this when the [Konteks Premiere] block is not enough.",
      inputSchema: { type: "object", properties: {
        sequence: SEQ,
        track: { type: "string", description: "Only list clips of this track, e.g. V1 or A2." },
        max_clips: { type: "integer", description: "Cap on clips listed (default 80)." }
      } }
    },
    {
      name: "get_clip",
      description: "Deep look at one clip (track item): components/effects with their parameter values and keyframe counts, MOGRT (Essential Graphics) params, linked items. Motion and effects are listed in full; Opacity/Time Remapping/audio built-ins only when keyframed unless all_props.",
      inputSchema: { type: "object", required: ["track"], properties: {
        track: { type: "string", description: "Track like V1 or A2 (V1 = videoTracks[0])." },
        index: { type: "integer", description: "0-based clip index on that track (the i from get_sequence)." },
        name: { type: "string", description: "Exact clip name, used when index is omitted." },
        sequence: SEQ,
        all_props: { type: "boolean", description: "Also list static built-in params (bigger output)." }
      } }
    },
    {
      name: "get_markers",
      description: "Sequence markers in time order: n, start, end (if it has a duration), name, comments, type, colour index. Paged.",
      inputSchema: { type: "object", properties: {
        sequence: SEQ,
        max: { type: "integer", description: "Max markers returned (default 150)." },
        offset: { type: "integer", description: "Skip the first N markers (paging)." }
      } }
    },
    {
      name: "find_gaps",
      description: "Empty stretches on each track (before the first clip and between clips; tail=true also after the last clip to the sequence end): track, start, end, sec, frames, the clip before it. Read-only. Use this instead of writing a gap script.",
      inputSchema: { type: "object", properties: {
        sequence: SEQ,
        track: { type: "string", description: "Only this track, e.g. V1." },
        min_frames: { type: "integer", description: "Ignore gaps shorter than this (default 1 frame)." },
        tail: { type: "boolean", description: "Also report the empty stretch after the last clip." }
      } }
    },
    {
      name: "get_project",
      description: "Project file path, all sequences (size/fps/duration), and the bin tree (name, type, bin path, media path, offline flag) plus the offline count.",
      inputSchema: { type: "object", properties: { max_items: { type: "integer", description: "Cap on bin items (default 200)." } } }
    },
    {
      name: "run_script",
      description: "Run ExtendScript inside Premiere Pro and return the value of the last expression (a top-level return also works). ES3: var only, no let/const/arrow functions/template strings, no JSON object, no Array.indexOf/forEach, no chained ternaries. " +
        "API (do not guess others): var seq = app.project.activeSequence; seq.videoTracks[0] = V1, seq.audioTracks[0] = A1 (0-based, count .numTracks), track.clips[i] (count track.clips.numItems - there is no track.numItems), clip.name/start/end/inPoint/outPoint/duration (Time objects: use .seconds; there is no startTime/endPoint), clip.disabled, clip.components[i].displayName/.matchName, clip.components[i].properties[j].displayName/getValue()/setValue(v, true). " +
        "Helpers already loaded: hbTrack(seq, 'V1') returns the track, hbSec(time) returns rounded seconds, HB_TICKS = 254016000000. " +
        "Markers live on seq.markers, NOT seq: var m = seq.markers.createMarker(90); m.name = 'CTA'; m.end = 93; (plain seconds, timecode 01:30 = 90). Iterate seq.markers.getFirstMarker()/getNextMarker(m), count seq.markers.numMarkers. " +
        "Time: var t = new Time(); t.seconds = 12.5; playhead seq.getPlayerPosition() / seq.setPlayerPosition(t.ticks); fps = 254016000000 / Number(seq.timebase). There is no timecodeToTime. " +
        "Put a whole change in one script and end with a short summary string. Every DOM change is a separate undo step (no undo group). Never save/close the project or delete sequences/media unless explicitly asked.",
      inputSchema: { type: "object", required: ["code"], properties: {
        code: { type: "string", description: "ExtendScript source." }
      } }
    },
    {
      name: "export_frame",
      description: "Export one frame of a sequence (downscaled to a 1280px wide JPEG) and return its path for vision_analyze. ONLY when the user asks to see/check the look, or the task is purely visual (framing, text placement, colour) and the script result can't confirm it. Opens the sequence if it is not the active one; the playhead is restored.",
      inputSchema: { type: "object", properties: {
        sequence: SEQ,
        time: { type: "number", description: "Seconds on the sequence timeline. Omit for the playhead." }
      } }
    }
  ];
  // Envato tools (js/envato.js, loaded before this file in the panel and by the proxy)
  if (global.HBEnvato) TOOLS = TOOLS.concat(global.HBEnvato.toolsFor("ppro"));
  var MAX_SEARCH = 8;

  function PproMcpServer(opts) {
    this.evalHost = opts.evalHost;          // (expr, cb(string))
    this.frameDir = opts.frameDir;
    this.previewDir = opts.previewDir || (opts.frameDir ? path.join(path.dirname(opts.frameDir), "envato", "previews") : null);
    this.assetDir = opts.assetDir || (opts.frameDir ? path.join(path.dirname(opts.frameDir), "envato", "assets") : null);
    this.downloadsDir = opts.downloadsDir || null;   // default ~/Downloads
    this.turnSearch = 0;
    this.backupDir = opts.backupDir || null;
    this.keepBackups = opts.keepBackups || 15;
    this.onCall = opts.onCall || function () {};
    this.onDone = opts.onDone || function () {};
    this.token = crypto.randomBytes(24).toString("hex");
    this.server = null;
    this.port = 0;
    this.queue = Promise.resolve();         // Premiere's ExtendScript is single-threaded: serialize host calls
    this.calls = 0;
    this.turnCalls = 0;
    this.backedUp = false;
    this.maxTurnCalls = opts.maxTurnCalls || MAX_CALLS;
    this.endpointFile = opts.endpointFile || null;
    this.ownPid = opts.ownPid || function () { return 0; };
    this.ext = { calls: 0, last: 0, backedUp: false };
    this.maxExtCalls = opts.maxExtCalls || 30;
  }

  // endpoint.json lets bin/hb-mcp-proxy.js (registered in the user's normal
  // Hermes profile) reach this server from any Hermes surface. 0600, deleted on close.
  PproMcpServer.prototype.writeEndpoint = function () {
    if (!this.endpointFile) return;
    try {
      fs.mkdirSync(path.dirname(this.endpointFile), { recursive: true });
      fs.writeFileSync(this.endpointFile, JSON.stringify({
        app: "ppro", url: "http://127.0.0.1:" + this.port + "/mcp", token: this.token,
        pid: process.pid, startedAt: new Date().toISOString()
      }), { mode: 384 });
      try { fs.chmodSync(this.endpointFile, 384); } catch (e) {}
    } catch (e) {}
  };
  PproMcpServer.prototype.clearEndpoint = function () {
    if (!this.endpointFile) return;
    try {
      var cur = JSON.parse(fs.readFileSync(this.endpointFile, "utf8"));
      if (cur && cur.token === this.token) fs.unlinkSync(this.endpointFile);
    } catch (e) {}
  };

  // Per-caller bookkeeping. Only Envato searches have a budget; AE/Premiere calls are uncapped.
  PproMcpServer.prototype._budget = function (ctx, name, n) {
    var self = this;
    // Envato searches never touch Premiere: own budget.
    if (name === "envato_account") return null;
    if (name === "envato_search") {
      if (ctx && !ctx.own) return null;
      if (++self.turnSearch <= MAX_SEARCH) return null;
      return "LIMIT: sudah " + MAX_SEARCH + " pencarian Envato untuk perintah ini. Tunjukkan kandidat terbaik yang sudah ketemu ke user dan tanya mau yang mana.";
    }
    // No call cap (Rijal, 2026-11-10): AE/Premiere calls are never refused.
    // Counters stay for the panel UI; the 2-min idle reset still re-arms the
    // per-burst .prproj backup for external sessions.
    if (!ctx || ctx.own) { ++self.turnCalls; return null; }
    var now = Date.now();
    if (now - self.ext.last > 120000) { self.ext.calls = 0; self.ext.backedUp = false; }
    self.ext.last = now;
    ++self.ext.calls;
    return null;
  };


  // Called by the panel whenever the user sends a new message.
  PproMcpServer.prototype.newTurn = function () { this.turnCalls = 0; this.turnSearch = 0; this.backedUp = false; };

  function lit(s) {
    return JSON.stringify(String(s)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }
  function argLit(v) {
    if (v === undefined || v === null || v === "") return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return lit(v);
  }

  PproMcpServer.prototype.host = function (expr, timeoutMs) {
    var self = this;
    var run = function () {
      return new Promise(function (resolve) {
        var done = false;
        var t = setTimeout(function () {
          if (done) return;
          done = true;
          resolve(JSON.stringify({ ok: false, infra: true, error: "Premiere Pro did not answer in " + ((timeoutMs || 120000) / 1000) + "s (busy exporting or a modal dialog is open)" }));
        }, timeoutMs || 120000);
        self.evalHost(expr, function (r) {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(r);
        });
      });
    };
    var p = self.queue.then(run, run);
    self.queue = p.then(function () {}, function () {});
    return p;
  };

  function parseHost(raw) {
    if (!raw) return { ok: false, infra: true, error: "no reply from Premiere Pro (host script not loaded - reopen the panel)" };
    if (raw === "EvalScript error.") return { ok: false, infra: true, error: "Premiere rejected the call (EvalScript error) - host script not loaded; ask the user to reopen the panel" };
    try { return JSON.parse(raw); } catch (e) { return { ok: false, infra: true, error: "bad host reply: " + String(raw).slice(0, 300) }; }
  }

  // Wait until one of the candidate files exists with a stable size.
  function waitAny(paths, maxMs) {
    var t0 = Date.now(), last = {};
    return new Promise(function (resolve) {
      (function tick() {
        for (var i = 0; i < paths.length; i++) {
          var size = -1;
          try { size = fs.statSync(paths[i]).size; } catch (e) {}
          if (size > 0 && size === last[paths[i]]) return resolve(paths[i]);
          last[paths[i]] = size;
        }
        if (Date.now() - t0 > maxMs) return resolve(null);
        setTimeout(tick, 150);
      })();
    });
  }

  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // Copy the saved .prproj once per user message, before the first script.
  // Premiere has no undo group, so this is the safety net for big scripts.
  PproMcpServer.prototype.backup = function (st) {
    var self = this;
    st = st || self;   // own agent: per user message; external Hermes: per burst (self.ext)
    if (st.backedUp || !self.backupDir) return Promise.resolve(null);
    return self.host("hbProjectPath()").then(parseHost).then(function (r) {
      st.backedUp = true;
      var src = r && r.ok && r.data && r.data.path;
      if (!src || !fs.existsSync(src)) return null;
      fs.mkdirSync(self.backupDir, { recursive: true });
      var base = path.basename(src).replace(/\.prproj$/i, "");
      var dst = path.join(self.backupDir, base + "_" + stamp() + ".prproj");
      fs.copyFileSync(src, dst);
      try {
        var mine = fs.readdirSync(self.backupDir).filter(function (f) { return f.indexOf(base + "_") === 0; }).sort();
        mine.slice(0, Math.max(0, mine.length - self.keepBackups)).forEach(function (f) { fs.unlinkSync(path.join(self.backupDir, f)); });
      } catch (e) {}
      return dst;
    }).catch(function () { st.backedUp = true; return null; });
  };

  PproMcpServer.prototype.callTool = function (name, a, st) {
    var self = this;
    a = a || {};
    switch (name) {
      case "get_sequence":
        return self.host("hbGetSequence(" + argLit(a.sequence) + "," + argLit(a.max_clips) + "," + argLit(a.track) + ")").then(parseHost);
      case "get_clip":
        return self.host("hbGetClip(" + argLit(a.sequence) + "," + argLit(a.track) + "," + argLit(a.index) + "," + argLit(a.name) + "," + (a.all_props ? "true" : "false") + ")").then(parseHost);
      case "get_markers":
        return self.host("hbMarkers(" + argLit(a.sequence) + "," + argLit(a.max) + "," + argLit(a.offset) + ")").then(parseHost);
      case "find_gaps":
        return self.host("hbGaps(" + argLit(a.sequence) + "," + argLit(a.min_frames) + "," + argLit(a.track) + "," + (a.tail ? "true" : "false") + ")").then(parseHost);
      case "get_project":
        return self.host("hbProject(" + argLit(a.max_items) + ")").then(parseHost);
      case "run_script":
        if (!a.code) return Promise.resolve({ ok: false, error: "code is required" });
        return self.backup(st).then(function (bak) {
          return self.host("hbEval(" + lit(a.code) + ")", 300000).then(parseHost).then(function (r) {
            if (bak && r && r.ok) r.backup = bak;
            return r;
          });
        });
      case "export_frame":
        try { fs.mkdirSync(self.frameDir, { recursive: true }); } catch (e) {}
        var base = path.join(self.frameDir, "frame_" + Date.now());
        return self.host("hbExportFrame(" + argLit(a.sequence) + "," + argLit(a.time) + "," + lit(base) + ")").then(parseHost)
          .then(function (r) {
            if (!r.ok) return r;
            return waitAny([base + ".png", base], 60000).then(function (hit) {
              if (!hit) return { ok: false, error: "frame file never appeared: " + base + ".png" };
              return flattenFrame(hit, 1280).then(function (fin) {
                r.data.path = fin.path;
                r.data.size = fin.w + "x" + fin.h + (fin.flattened ? " (on black)" : " (raw PNG)");
                r.data.hint = "vision_analyze this path.";
                return r;
              });
            });
          });
      case "envato_search":
        if (!global.HBEnvato) return Promise.resolve({ ok: false, infra: true, error: "js/envato.js tidak termuat - reload panel" });
        return global.HBEnvato.search(a, { previewDir: self.previewDir });
      case "import_media":
        return self.importMedia(a);
      case "envato_account":
        if (!global.HBEnvatoSession) return Promise.resolve({ ok: false, infra: true, error: "js/envato-session.js tidak termuat - reload panel" });
        if (a.action === "login") return global.HBEnvatoSession.login({ waitSeconds: 240 });
        if (a.action === "logout") return global.HBEnvatoSession.logout();
        return global.HBEnvatoSession.status();
      default:
        return Promise.resolve({ ok: false, error: "unknown tool " + name });
    }
  };

  // Downloads -> "<project>/Envato Assets" -> bin "Envato/<pack>".
  // Waiting/unzipping happens in node; only the import itself queues on Premiere.
  PproMcpServer.prototype.importMedia = function (a) {
    var self = this, EV = global.HBEnvato, proj = null, dl = null;
    if (!EV) return Promise.resolve({ ok: false, infra: true, error: "js/envato.js tidak termuat - reload panel" });
    return self.host("hbProjectDir()").then(parseHost).then(function (pd) {
      proj = pd && pd.ok ? pd.data : null;
      var dest = a.dest_dir || (proj && proj.dir ? path.join(proj.dir, "Envato Assets") : self.assetDir);
      if (!dest) return { ok: false, error: "dest_dir wajib diisi (project belum disimpan)" };
      // download:true -> Hermes downloads the item in the user's own browser first
      var lic = a.project_name || (proj && proj.path ? path.basename(proj.path).replace(/\.[a-z0-9]+$/i, "") : "Feugee");
      return EV.prepareDownload(a, { downloadsDir: self.downloadsDir, timeoutMs: 180000, destRoot: dest, projectName: lic, waitMs: 200000 }).then(function (pre) {
        if (pre.stop) return pre.stop;
        dl = pre.info || null;
        return EV.collect({
          app: "ppro", itemUrl: a.item_url, paths: pre.paths || a.paths, match: a.match, minutes: a.from_downloads_minutes,
          waitSeconds: pre.waitSeconds, downloadsDir: self.downloadsDir, destRoot: dest, removeSources: pre.removeSources, copy: a.copy,
          installFonts: a.install_fonts, title: a.title, projectPath: proj && proj.path
        });
      });
    }).then(function (c) {
      if (!c.ok || !c.plans) { if (dl && dl.note) c.error = dl.note + " " + (c.error || ""); return c; }
      var packs = [];
      return c.plans.reduce(function (p, pl) {
        return p.then(function () {
          var row = { pack: pl.pack, files: pl.files, location: pl.root };
          ["mogrt", "templates", "fonts", "luts", "presets", "docs", "models", "skipped", "notes"].forEach(function (k) { if (pl[k] && pl[k].length) row[k] = pl[k]; });
          packs.push(row);
          if (!pl.import.length) { row.imported = []; return; }
          var bin = a.bin || ("Envato/" + pl.pack);
          var list = "[" + pl.import.map(function (x) { return "[" + lit(x.path) + "," + (x.kind === "sequence" ? "true" : "false") + "]"; }).join(",") + "]";
          return self.host("hbImportFiles(" + list + "," + lit(bin) + ")", 280000).then(parseHost).then(function (r) {
            if (!r.ok) { row.error = r.error; return; }
            row.bin = r.data.bin;
            row.imported = r.data.imported;
            if (r.data.reused.length) row.reused = r.data.reused;
            if (r.data.failed.length) row.failed = r.data.failed;
          });
        });
      }, Promise.resolve()).then(function () {
        var out = { dest: c.destRoot, sources: c.sources, packs: packs };
        if (dl) out.download = dl;
        if (c.errors.length) out.errors = c.errors;
        if (c.fonts) out.fonts_installed = c.fonts;
        if (!proj || !proj.dir) out.warning = "Project belum disimpan: aset disalin ke " + c.destRoot + ". Setelah Save As, pakai File > Project Manager kalau mau dikumpulkan ke folder project.";
        out.hint = "Taruh ke timeline lewat run_script: cari projectItem by nodeId/path, lalu track.insertClip(item, detik) / overwriteClip. LUT: Lumetri > Input LUT.";
        return { ok: true, data: out };
      });
    });
  };

  // Sequence frames are full size (4K for ALUX): shrink to maxW JPEG for vision.
  function flattenFrame(pngPath, maxW) {
    var raw = { path: pngPath, w: 0, h: 0, flattened: false };
    if (typeof document === "undefined") return Promise.resolve(raw);
    var c0 = document.createElement("canvas");
    if (!c0.getContext || !c0.getContext("2d")) return Promise.resolve(raw);
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var k = Math.min(1, maxW / img.naturalWidth);
          var w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
          c0.width = w; c0.height = h;
          var g = c0.getContext("2d");
          g.fillStyle = "#000000";
          g.fillRect(0, 0, w, h);
          g.imageSmoothingQuality = "high";
          g.drawImage(img, 0, 0, w, h);
          var out = pngPath.replace(/(\.png)?$/i, ".jpg");
          fs.writeFileSync(out, Buf.from(c0.toDataURL("image/jpeg", 0.9).split(",")[1], "base64"));
          try { fs.unlinkSync(pngPath); } catch (e) {}
          resolve({ path: out, w: w, h: h, flattened: true });
        } catch (e) { resolve(raw); }
      };
      img.onerror = function () { resolve(raw); };
      img.src = "data:image/png;base64," + fs.readFileSync(pngPath).toString("base64");
    });
  }

  // Only infrastructure failures (Premiere silent/busy, host not loaded) are
  // reported as isError. A script/lookup error is normal feedback the model
  // should fix and retry: Hermes opens a per-server circuit breaker after 3
  // consecutive isError results (60 s), which locked the agent out of
  // Premiere after three typos in a row.
  function textResult(obj) {
    var failed = obj && obj.ok === false;
    var isErr = failed && !!obj.infra;
    var body;
    if (failed) body = (obj.infra ? "ERROR: " : "SCRIPT ERROR (Premiere is fine - fix the code and retry): ") + obj.error + (obj.line ? " (line " + obj.line + ")" : "");
    else if (obj && Object.prototype.hasOwnProperty.call(obj, "result")) {
      body = obj.result === null ? "OK (script returned nothing)" : (typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result));
      if (obj.backup) body += "\n[backup .prproj sebelum script: " + obj.backup + "]";
    } else body = JSON.stringify(obj && obj.data !== undefined ? obj.data : obj);
    return { content: [{ type: "text", text: body }], isError: !!isErr };
  }

  PproMcpServer.prototype._rpc = function (msg, ctx) {
    var self = this;
    var id = msg.id, method = msg.method, params = msg.params || {};
    function ok(result) { return { jsonrpc: "2.0", id: id, result: result }; }
    function fail(code, message) { return { jsonrpc: "2.0", id: id, error: { code: code, message: message } }; }

    if (method === "initialize") {
      var want = params.protocolVersion;
      return Promise.resolve(ok({
        protocolVersion: PROTOCOLS.indexOf(want) >= 0 ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "premiere-pro", version: "1.0.0" },
        instructions: INSTRUCTIONS
      }));
    }
    if (method === "ping") return Promise.resolve(ok({}));
    if (method === "tools/list") { if (!ctx || ctx.own) self.listedAt = Date.now(); return Promise.resolve(ok({ tools: TOOLS })); }
    if (method === "resources/list") return Promise.resolve(ok({ resources: [] }));
    if (method === "prompts/list") return Promise.resolve(ok({ prompts: [] }));
    if (method === "tools/call") {
      var name = params.name, t0 = Date.now(), n = ++self.calls;
      var ext = !!(ctx && !ctx.own);
      var msg2 = self._budget(ctx, name, n);
      if (msg2) {
        self.onDone({ n: n, name: name, ok: false, ms: 0, text: msg2, capped: true, external: ext });
        return Promise.resolve(ok({ content: [{ type: "text", text: msg2 }], isError: true }));
      }
      self.onCall({ n: n, name: name, args: params.arguments || {}, external: ext });
      return self.callTool(name, params.arguments, ext ? self.ext : self).then(function (r) {
        var res = textResult(r);
        self.onDone({ n: n, name: name, ok: !(r && r.ok === false), ms: Date.now() - t0, text: res.content[0].text, external: ext });
        return ok(res);
      }, function (e) {
        self.onDone({ n: n, name: name, ok: false, ms: Date.now() - t0, text: String(e), external: ext });
        return ok(textResult({ ok: false, infra: true, error: String(e && e.message || e) }));
      });
    }
    return Promise.resolve(fail(-32601, "method not found: " + method));
  };

  PproMcpServer.prototype._handle = function (req, res) {
    var self = this;
    if (req.url.split("?")[0] !== "/mcp") { res.writeHead(404); return res.end(); }
    if ((req.headers.authorization || "") !== "Bearer " + self.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end('{"error":"unauthorized"}');
    }
    if (req.method === "DELETE") { res.writeHead(200); return res.end(); }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }

    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      var body;
      try { body = JSON.parse(Buf.concat(chunks).toString("utf8")); }
      catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      }
      var batch = Array.isArray(body) ? body : [body];
      var requests = batch.filter(function (m) { return m && m.method && m.id !== undefined && m.id !== null; });
      if (!requests.length) { res.writeHead(202); return res.end(); }  // notifications / responses only

      // Who is calling: the panel's own agent (ACP session server, or the stdio
      // proxy started by that agent) or another Hermes (Desktop, CLI, Telegram)
      // through bin/hb-mcp-proxy.js. The proxy sends its parent (hermes) pid.
      var hdr = req.headers["x-hb-parent-pid"];
      var mine = String(self.ownPid() || "");
      var ctx = { own: !hdr || (!!mine && String(hdr).split(",").indexOf(mine) >= 0) };
      Promise.all(requests.map(function (m) { return self._rpc(m, ctx); })).then(function (out) {
        var headers = { "Content-Type": "application/json" };
        if (requests.some(function (m) { return m.method === "initialize"; })) headers["Mcp-Session-Id"] = self.token.slice(0, 16);
        res.writeHead(200, headers);
        res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
      });
    });
  };

  PproMcpServer.prototype.start = function () {
    var self = this;
    if (self.server) return Promise.resolve(self.port);
    return new Promise(function (resolve, reject) {
      var s = http.createServer(function (req, res) { self._handle(req, res); });
      s.keepAliveTimeout = 60000;
      s.on("error", reject);
      s.listen(0, "127.0.0.1", function () {
        self.server = s;
        self.port = s.address().port;
        self.writeEndpoint();
        resolve(self.port);
      });
    });
  };

  PproMcpServer.prototype.stop = function () {
    this.clearEndpoint();
    if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
  };

  // What ACP session/new expects in mcpServers. Tools show up as mcp__ppro__*.
  PproMcpServer.prototype.acpEntry = function () {
    return {
      type: "http",
      name: "ppro",
      url: "http://127.0.0.1:" + this.port + "/mcp",
      headers: [{ name: "Authorization", value: "Bearer " + this.token }]
    };
  };

  global.PproMcpServer = PproMcpServer;
  global.PproMcpServer.TOOLS = TOOLS;
  global.PproMcpServer.INSTRUCTIONS = INSTRUCTIONS;
})(typeof window !== "undefined" ? window : global);
