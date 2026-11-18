/* =========================================================
   HERMES BRIDGE - AFTER EFFECTS MCP SERVER
   Streamable-HTTP MCP server living inside the CEP panel.
   Hermes (ACP) connects to it per session; every tool call is
   one evalScript into jsx/host.jsx. Loopback only + bearer token.
   ========================================================= */
(function (global) {
  "use strict";

  var http = require("http");
  var crypto = require("crypto");
  var fs = require("fs");
  var path = require("path");
  var Buf = require("buffer").Buffer;   // CEP window context may not expose the Buffer global

  var PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

  var INSTRUCTIONS = [
    "Tools that act directly on the After Effects project the user has open.",
    "Read first (get_comp / get_layer / get_project / expression_errors), then change with run_script.",
    "run_script = one undo group; batch a whole change into ONE script instead of many small calls.",
    "A run_script summary / empty expression_errors proves the script ran, not that it looks right: for any visual change, render frames at the key times (render_frame, or one run_script saveFrameToPng loop + contact sheet for many frames) and compare them against the user reference or the agreed layout before calling it done.",
    "Stock assets: envato_search (Envato Elements catalog, own budget of 8 searches per message) -> import_media {item_url, download: true} for the item the user picked (downloads it in the user's logged-in browser, unzips, imports into an Envato folder)."
  ].join(" ");

  var TOOLS = [
    {
      name: "get_comp",
      description: "Active comp (or a named one): size, fps, duration, CTI, work area, selection, and a layer table (index, name, type, enabled, parent, in/out, 3D, source). Call this first.",
      inputSchema: { type: "object", properties: {
        comp: { type: "string", description: "Comp name or id. Omit for the active comp." },
        max_layers: { type: "integer", description: "Cap on layers listed (default 60)." }
      } }
    },
    {
      name: "get_layer",
      description: "Deep look at one layer: transform values, effects, and every animated or expression-driven property with its value, keyframe count, expression text and expression error.",
      inputSchema: { type: "object", required: ["layer"], properties: {
        layer: { type: "string", description: "Layer index (1-based) or exact name." },
        comp: { type: "string", description: "Comp name or id. Omit for the active comp." },
        all_props: { type: "boolean", description: "Also list static properties (bigger output)." }
      } }
    },
    {
      name: "get_project",
      description: "Project items: comps (size/fps/duration/layer count), footage (path, missing), solids, folders; plus which item is active and whether the project has unsaved changes.",
      inputSchema: { type: "object", properties: { max_items: { type: "integer", description: "Cap (default 200)." } } }
    },
    {
      name: "expression_errors",
      description: "Expression errors in a comp, grouped by identical error: count, property path, affected layer names, and one example expression. Empty groups = every expression evaluates.",
      inputSchema: { type: "object", properties: { comp: { type: "string", description: "Comp name or id. Omit for the active comp." } } }
    },
    {
      name: "run_script",
      description: "Run ExtendScript inside After Effects as ONE undo group (the user can undo it with Cmd/Ctrl+Z). The value of the last expression is returned. ExtendScript is ES3: var only, no let/const/arrow functions/template strings, no JSON object. Put a whole change in one script and end it with a short summary string. Never save/close the project, purge, or delete comps/footage unless explicitly asked.",
      inputSchema: { type: "object", required: ["code"], properties: {
        code: { type: "string", description: "ExtendScript source." },
        undo_name: { type: "string", description: "Label shown in Edit > Undo (default 'Hermes')." }
      } }
    },
    {
      name: "render_frame",
      description: "Render one frame (flattened on the comp background colour, downscaled to 1280px wide JPEG) and return its path for vision_analyze. ONLY when the user asks to see/check the look, or the task is purely visual (layout, colour) and the script result can't confirm it. Never for rigs/expressions - use expression_errors.",
      inputSchema: { type: "object", properties: {
        comp: { type: "string", description: "Comp name or id. Omit for the active comp." },
        time: { type: "number", description: "Seconds. Omit for the current time indicator." }
      } }
    }
  ];
  // Envato tools (js/envato.js, loaded before this file in the panel and by the proxy)
  if (global.HBEnvato) TOOLS = TOOLS.concat(global.HBEnvato.toolsFor("ae"));
  var MAX_SEARCH = 8;

  function AeMcpServer(opts) {
    this.evalHost = opts.evalHost;          // (expr, cb(string))
    this.frameDir = opts.frameDir;
    this.previewDir = opts.previewDir || (opts.frameDir ? path.join(path.dirname(opts.frameDir), "envato", "previews") : null);
    this.assetDir = opts.assetDir || (opts.frameDir ? path.join(path.dirname(opts.frameDir), "envato", "assets") : null);
    this.downloadsDir = opts.downloadsDir || null;   // default ~/Downloads
    this.turnSearch = 0;
    this.onCall = opts.onCall || function () {};
    this.onDone = opts.onDone || function () {};
    this.token = crypto.randomBytes(24).toString("hex");
    this.server = null;
    this.port = 0;
    this.queue = Promise.resolve();         // AE is single-threaded: serialize host calls
    this.calls = 0;
    this.turnCalls = 0;
    this.maxTurnCalls = opts.maxTurnCalls || 10;
    this.endpointFile = opts.endpointFile || null;
    this.ownPid = opts.ownPid || function () { return 0; };
    this.ext = { calls: 0, last: 0, backedUp: false };
    this.maxExtCalls = opts.maxExtCalls || 30;
  }

  // endpoint.json lets bin/hb-mcp-proxy.js (registered in the user's normal
  // Hermes profile) reach this server from any Hermes surface. 0600, deleted on close.
  AeMcpServer.prototype.writeEndpoint = function () {
    if (!this.endpointFile) return;
    try {
      fs.mkdirSync(path.dirname(this.endpointFile), { recursive: true });
      fs.writeFileSync(this.endpointFile, JSON.stringify({
        app: "ae", url: "http://127.0.0.1:" + this.port + "/mcp", token: this.token,
        pid: process.pid, startedAt: new Date().toISOString()
      }), { mode: 384 });
      try { fs.chmodSync(this.endpointFile, 384); } catch (e) {}
    } catch (e) {}
  };
  AeMcpServer.prototype.clearEndpoint = function () {
    if (!this.endpointFile) return;
    try {
      var cur = JSON.parse(fs.readFileSync(this.endpointFile, "utf8"));
      if (cur && cur.token === this.token) fs.unlinkSync(this.endpointFile);
    } catch (e) {}
  };

  // Per-caller bookkeeping. Only Envato searches have a budget; AE/Premiere calls are uncapped.
  AeMcpServer.prototype._budget = function (ctx, name, n) {
    var self = this;
    // Envato searches never touch AE: own budget so a few searches do not
    // eat the 10 AE calls a task needs.
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
  AeMcpServer.prototype.newTurn = function () { this.turnCalls = 0; this.turnSearch = 0; };

  function lit(s) {
    return JSON.stringify(String(s)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }
  function argLit(v) {
    if (v === undefined || v === null || v === "") return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return lit(v);
  }

  AeMcpServer.prototype.host = function (expr, timeoutMs) {
    var self = this;
    var run = function () {
      return new Promise(function (resolve) {
        var done = false;
        var t = setTimeout(function () {
          if (done) return;
          done = true;
          resolve(JSON.stringify({ ok: false, infra: true, error: "After Effects did not answer in " + ((timeoutMs || 120000) / 1000) + "s (busy rendering or a modal dialog is open)" }));
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
    if (!raw) return { ok: false, infra: true, error: "no reply from After Effects (host script not loaded - reopen the panel)" };
    if (raw === "EvalScript error.") return { ok: false, infra: true, error: "After Effects rejected the call (EvalScript error) - host script not loaded; ask the user to reopen the panel" };
    try { return JSON.parse(raw); } catch (e) { return { ok: false, infra: true, error: "bad host reply: " + String(raw).slice(0, 300) }; }
  }

  function waitFile(p, maxMs) {
    var t0 = Date.now(), last = -1;
    return new Promise(function (resolve) {
      (function tick() {
        var size = -1;
        try { size = fs.statSync(p).size; } catch (e) {}
        if (size > 0 && size === last) return resolve(true);
        last = size;
        if (Date.now() - t0 > maxMs) return resolve(size > 0);
        setTimeout(tick, 120);
      })();
    });
  }

  AeMcpServer.prototype.callTool = function (name, a) {
    var self = this;
    a = a || {};
    switch (name) {
      case "get_comp":
        return self.host("hbGetComp(" + argLit(a.comp) + "," + argLit(a.max_layers) + ")").then(parseHost);
      case "get_layer":
        return self.host("hbGetLayer(" + argLit(a.comp) + "," + argLit(a.layer) + "," + (a.all_props ? "true" : "false") + ")").then(parseHost);
      case "get_project":
        return self.host("hbProject(" + argLit(a.max_items) + ")").then(parseHost);
      case "expression_errors":
        return self.host("hbExprErrors(" + argLit(a.comp) + ")").then(parseHost).then(groupExprErrors);
      case "run_script":
        if (!a.code) return Promise.resolve({ ok: false, error: "code is required" });
        return self.host("hbEval(" + lit(a.code) + "," + argLit(a.undo_name || "Hermes") + ")", 300000).then(parseHost);
      case "render_frame":
        try { fs.mkdirSync(self.frameDir, { recursive: true }); } catch (e) {}
        var out = path.join(self.frameDir, "frame_" + Date.now() + ".png");
        return self.host("hbSaveFrame(" + argLit(a.comp) + "," + argLit(a.time) + "," + lit(out) + ",true)").then(parseHost)
          .then(function (r) {
            if (!r.ok) return r;
            return waitFile(out, 60000).then(function (ok) {
              if (!ok) return { ok: false, error: "frame file never appeared: " + out };
              return flattenFrame(out, r.data.bg, 1280).then(function (fin) {
                r.data.path = fin.path;
                r.data.size = fin.w + "x" + fin.h + (fin.flattened ? " (on comp bg " + fin.bgHex + ")" : " (raw PNG, alpha = transparent, NOT white)");
                delete r.data.bg;
                r.data.hint = "vision_analyze this path. Background is the comp colour, not white.";
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

  // Downloads -> "<project>/Envato Assets" -> AE folder "Envato/<pack>".
  // Waiting/unzipping happens in node; only the import itself queues on AE.
  AeMcpServer.prototype.importMedia = function (a) {
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
          app: "ae", itemUrl: a.item_url, paths: pre.paths || a.paths, match: a.match, minutes: a.from_downloads_minutes,
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
          ["templates", "fonts", "luts", "presets", "docs", "models", "skipped", "notes"].forEach(function (k) { if (pl[k] && pl[k].length) row[k] = pl[k]; });
          packs.push(row);
          if (!pl.import.length) { row.imported = []; return; }
          var bin = a.bin || ("Envato/" + pl.pack);
          var list = "[" + pl.import.map(function (x) { return "[" + lit(x.path) + "," + (x.kind === "sequence" ? "true" : "false") + "]"; }).join(",") + "]";
          return self.host("hbImportFiles(" + list + "," + lit(bin) + ")", 280000).then(parseHost).then(function (r) {
            if (!r.ok) { row.error = r.error; return; }
            row.folder = r.data.folder;
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
        if (!proj || !proj.dir) out.warning = "Project belum disimpan: aset disalin ke " + c.destRoot + ". Setelah Save As, pakai File > Dependencies > Collect Files kalau mau dipindah ke folder project.";
        out.hint = "Pakai id dari imported untuk menaruh aset (comp.layers.add(app.project.itemByID(id))). Template: comps berisi comp yang biasanya diedit/dirender.";
        return { ok: true, data: out };
      });
    });
  };

  // hbExprErrors returns one row per broken property; 50 layers x 3 props with the
  // same bug = 150 near-identical rows (110 KB). Collapse by error signature.
  function groupExprErrors(r) {
    if (!r || !r.ok || !r.data || !r.data.errors) return r;
    var groups = {}, order = [];
    r.data.errors.forEach(function (e) {
      var msg = String(e.error || "");
      var sig = (msg.match(/[A-Za-z]*Error:[^\n\r]*/) || [msg.split(/[\r\n]/).filter(Boolean).pop() || msg])[0].trim();
      var key = e.path + "|" + sig;
      if (!groups[key]) {
        groups[key] = { error: sig, path: e.path, count: 0, layers: [],
          example: { layer: e.name, detail: msg.slice(0, 400), expr: String(e.expr || "").slice(0, 700) } };
        order.push(key);
      }
      var g = groups[key];
      g.count++;
      if (g.layers.length < 8) g.layers.push(e.name);
    });
    return { ok: true, data: {
      comp: r.data.comp,
      total: r.data.errors.length,
      groups: order.map(function (k) {
        var g = groups[k];
        if (g.count > g.layers.length) g.layers.push("+" + (g.count - g.layers.length) + " more");
        return g;
      })
    } };
  }

  // saveFrameToPng keeps alpha; vision models read transparent pixels as white.
  // Composite on the comp bg colour and shrink to maxW (4K PNGs cost ~10s in vision).
  function flattenFrame(pngPath, bg, maxW) {
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
          var rgb = (bg && bg.length >= 3 ? bg : [0, 0, 0]).slice(0, 3).map(function (v) { return Math.round(Math.max(0, Math.min(1, v)) * 255); });
          var hex = "#" + rgb.map(function (v) { return (v < 16 ? "0" : "") + v.toString(16); }).join("");
          g.fillStyle = hex;
          g.fillRect(0, 0, w, h);
          g.imageSmoothingQuality = "high";
          g.drawImage(img, 0, 0, w, h);
          var out = pngPath.replace(/\.png$/i, ".jpg");
          fs.writeFileSync(out, Buf.from(c0.toDataURL("image/jpeg", 0.9).split(",")[1], "base64"));
          try { fs.unlinkSync(pngPath); } catch (e) {}
          resolve({ path: out, w: w, h: h, flattened: true, bgHex: hex });
        } catch (e) { resolve(raw); }
      };
      img.onerror = function () { resolve(raw); };
      img.src = "data:image/png;base64," + fs.readFileSync(pngPath).toString("base64");
    });
  }

  // Only infrastructure failures are isError: Hermes opens a per-server circuit
  // breaker after 3 consecutive isError results (60 s lockout), so a script typo
  // is returned as normal text the model fixes and retries.
  function textResult(obj) {
    var failed = obj && obj.ok === false;
    var isErr = failed && !!obj.infra;
    var body;
    if (failed) body = (obj.infra ? "ERROR: " : "SCRIPT ERROR (After Effects is fine - fix the code and retry): ") + obj.error + (obj.line ? " (line " + obj.line + ")" : "");
    else if (obj && Object.prototype.hasOwnProperty.call(obj, "result")) {
      body = obj.result === null ? "OK (script returned nothing)" : (typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result));
    } else body = JSON.stringify(obj && obj.data !== undefined ? obj.data : obj);
    return { content: [{ type: "text", text: body }], isError: !!isErr };
  }

  AeMcpServer.prototype._rpc = function (msg, ctx) {
    var self = this;
    var id = msg.id, method = msg.method, params = msg.params || {};
    function ok(result) { return { jsonrpc: "2.0", id: id, result: result }; }
    function fail(code, message) { return { jsonrpc: "2.0", id: id, error: { code: code, message: message } }; }

    if (method === "initialize") {
      var want = params.protocolVersion;
      return Promise.resolve(ok({
        protocolVersion: PROTOCOLS.indexOf(want) >= 0 ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "after-effects", version: "2.1.0" },
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
      var msg = self._budget(ctx, name, n);
      if (msg) {
        self.onDone({ n: n, name: name, ok: false, ms: 0, text: msg, capped: true, external: ext });
        return Promise.resolve(ok({ content: [{ type: "text", text: msg }], isError: true }));
      }
      self.onCall({ n: n, name: name, args: params.arguments || {}, external: ext });
      return self.callTool(name, params.arguments).then(function (r) {
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

  AeMcpServer.prototype._handle = function (req, res) {
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

  AeMcpServer.prototype.start = function () {
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

  AeMcpServer.prototype.stop = function () {
    this.clearEndpoint();
    if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
  };

  // What ACP session/new expects in mcpServers.
  AeMcpServer.prototype.acpEntry = function () {
    return {
      type: "http",
      name: "ae",
      url: "http://127.0.0.1:" + this.port + "/mcp",
      headers: [{ name: "Authorization", value: "Bearer " + this.token }]
    };
  };

  global.AeMcpServer = AeMcpServer;
  global.AeMcpServer.TOOLS = TOOLS;
  global.AeMcpServer.INSTRUCTIONS = INSTRUCTIONS;
})(typeof window !== "undefined" ? window : global);
