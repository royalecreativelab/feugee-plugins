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
    "A run_script summary string / empty expression_errors IS the proof - do not render frames to double-check unless the user asks to see it.",
    "Hard cap: " + 10 + " AE tool calls per message; after that every AE tool refuses until the user replies."
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
      description: "Run ExtendScript inside After Effects as ONE undo group (the user can Cmd+Z it). The value of the last expression is returned. ExtendScript is ES3: var only, no let/const/arrow functions/template strings, no JSON object. Put a whole change in one script and end it with a short summary string. Never save/close the project, purge, or delete comps/footage unless explicitly asked.",
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

  function AeMcpServer(opts) {
    this.evalHost = opts.evalHost;          // (expr, cb(string))
    this.frameDir = opts.frameDir;
    this.onCall = opts.onCall || function () {};
    this.onDone = opts.onDone || function () {};
    this.token = crypto.randomBytes(24).toString("hex");
    this.server = null;
    this.port = 0;
    this.queue = Promise.resolve();         // AE is single-threaded: serialize host calls
    this.calls = 0;
    this.turnCalls = 0;
    this.maxTurnCalls = opts.maxTurnCalls || 10;
  }

  // Called by the panel whenever the user sends a new message.
  AeMcpServer.prototype.newTurn = function () { this.turnCalls = 0; };

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
          resolve(JSON.stringify({ ok: false, error: "After Effects did not answer in " + ((timeoutMs || 120000) / 1000) + "s (busy rendering or a modal dialog is open)" }));
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
    if (!raw) return { ok: false, error: "no reply from After Effects (host script not loaded - reopen the panel)" };
    try { return JSON.parse(raw); } catch (e) { return { ok: false, error: "bad host reply: " + String(raw).slice(0, 300) }; }
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
      default:
        return Promise.resolve({ ok: false, error: "unknown tool " + name });
    }
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

  function textResult(obj) {
    var isErr = obj && obj.ok === false;
    var body;
    if (isErr) body = "ERROR: " + obj.error + (obj.line ? " (line " + obj.line + ")" : "");
    else if (obj && Object.prototype.hasOwnProperty.call(obj, "result")) {
      body = obj.result === null ? "OK (script returned nothing)" : (typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result));
    } else body = JSON.stringify(obj && obj.data !== undefined ? obj.data : obj);
    return { content: [{ type: "text", text: body }], isError: !!isErr };
  }

  AeMcpServer.prototype._rpc = function (msg) {
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
    if (method === "tools/list") { self.listedAt = Date.now(); return Promise.resolve(ok({ tools: TOOLS })); }
    if (method === "resources/list") return Promise.resolve(ok({ resources: [] }));
    if (method === "prompts/list") return Promise.resolve(ok({ prompts: [] }));
    if (method === "tools/call") {
      var name = params.name, t0 = Date.now(), n = ++self.calls;
      if (++self.turnCalls > self.maxTurnCalls) {
        var msg = "LIMIT: sudah " + self.maxTurnCalls + " panggilan tool AE untuk perintah ini. Semua tool AE diblokir sampai user membalas. " +
          "BERHENTI sekarang: laporkan apa yang sudah jadi, apa yang belum, dan apa langkah berikutnya, lalu tanya user mau lanjut atau tidak.";
        self.onDone({ n: n, name: name, ok: false, ms: 0, text: msg, capped: true });
        return Promise.resolve(ok({ content: [{ type: "text", text: msg }], isError: true }));
      }
      self.onCall({ n: n, name: name, args: params.arguments || {} });
      return self.callTool(name, params.arguments).then(function (r) {
        var res = textResult(r);
        self.onDone({ n: n, name: name, ok: !res.isError, ms: Date.now() - t0, text: res.content[0].text });
        return ok(res);
      }, function (e) {
        self.onDone({ n: n, name: name, ok: false, ms: Date.now() - t0, text: String(e) });
        return ok(textResult({ ok: false, error: String(e && e.message || e) }));
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

      Promise.all(requests.map(function (m) { return self._rpc(m); })).then(function (out) {
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
        resolve(self.port);
      });
    });
  };

  AeMcpServer.prototype.stop = function () {
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
})(typeof window !== "undefined" ? window : global);
