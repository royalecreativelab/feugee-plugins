#!/usr/bin/env node
/* =========================================================
   HERMES BRIDGE FIGMA - STDIO MCP PROXY
   Registered in the Hermes profile as mcp_servers.figma_bridge so every
   Hermes surface (Desktop chat, CLI, Telegram, cron) can drive the Figma
   file that is open in Figma DESKTOP right now, through the
   "Feugee Hermes Bridge" plugin.

   Why: the remote Figma MCP (mcp.figma.com, tool use_figma) runs scripts
   in Figma's cloud runtime, which only knows Google + Figma-hosted fonts.
   Scripts sent here run inside the desktop app, so every locally
   installed font (Geist Serif, Feugee, Gilroy, ...) loads and text stays
   live and editable.

   Same contract as the AE/PR proxy (hb-mcp-proxy.js): tool schemas are
   static, endpoint.json is re-read on every call, a closed plugin turns
   into a clear "open the plugin" message instead of a hang.

   usage: node hb-figma-mcp.js
   ========================================================= */
"use strict";
var fs = require("fs");
var os = require("os");
var path = require("path");
var http = require("http");
var spawn = require("child_process").spawn;

var DATA = process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "HermesBridgeFigma")
  : path.join(os.homedir(), "Library", "Application Support", "HermesBridgeFigma");
var ENDPOINT = path.join(DATA, "endpoint.json");
var RELAY = path.join(__dirname, "hb-figma-relay.js");
var VERSION = (function () { try { return require(path.join(__dirname, "..", "package.json")).version; } catch (e) { return "0.0.0"; } })();

var FILEKEY = { type: "string", description: "Optional. Figma file key (from the URL /design/<fileKey>/...). Required only when the plugin is open in more than one file." };

var TOOLS = [
  {
    name: "use_figma",
    description: "Run JavaScript (Figma Plugin API) inside Figma DESKTOP on the file where the Feugee Hermes Bridge plugin is running. " +
      "Same contract as the remote use_figma: top-level await and `return` work, return value comes back as JSON (nodes are serialized to {id,name,type}). " +
      "Difference that matters: LOCAL fonts load here (figma.loadFontAsync with Geist Serif, Feugee, Gilroy, ...) so text stays live and editable; figma.createImage works; figma.notify works. " +
      "Do NOT call figma.closePlugin() (it kills the bridge). Each call is committed as one undo step. Return payload is capped at ~200 KB.",
    inputSchema: { type: "object", properties: {
      code: { type: "string", description: "JavaScript to run. Has access to `figma`. Use `return` to send data back." },
      description: { type: "string", description: "Short description of what the code does (shown in the plugin log)." },
      fileKey: FILEKEY
    }, required: ["code"] }
  },
  {
    name: "get_screenshot",
    description: "Export a node from Figma Desktop (exportAsync, rendered with the real local fonts) to a file on this Mac. Returns {path, width, height}. " +
      "Use this instead of the remote get_screenshot when the design uses local fonts. Inspect the file with vision_analyze (keep it under ~1600 px: pass maxDimension).",
    inputSchema: { type: "object", properties: {
      nodeId: { type: "string", description: "Node id, '12:34' (URL form '12-34' is accepted)." },
      maxDimension: { type: "number", description: "Longest edge in px (default 1600). Ignored for SVG/PDF." },
      format: { type: "string", enum: ["PNG", "JPG", "SVG", "PDF"], description: "Default PNG." },
      fileKey: FILEKEY
    }, required: ["nodeId"] }
  },
  {
    name: "place_image",
    description: "Put a local image file (PNG/JPG/GIF/WebP, absolute path on this Mac) into Figma Desktop as an IMAGE fill on an existing node (rectangle/frame), via figma.createImage. No upload URL needed.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Absolute path of the image file." },
      nodeId: { type: "string", description: "Target node id that receives the fill." },
      scaleMode: { type: "string", enum: ["FILL", "FIT", "CROP", "TILE"], description: "Default FILL." },
      fileKey: FILEKEY
    }, required: ["path", "nodeId"] }
  },
  {
    name: "import_svg",
    description: "Create editable vector layers from an SVG (file path or inline string) via figma.createNodeFromSvg, optionally inside a parent at x/y.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Absolute path of an .svg file (or pass `svg`)." },
      svg: { type: "string", description: "Inline SVG markup (alternative to path)." },
      parentId: { type: "string", description: "Optional parent node id (frame/group/section). Default: current page." },
      x: { type: "number" }, y: { type: "number" },
      name: { type: "string", description: "Layer name for the created node." },
      fileKey: FILEKEY
    } }
  },
  {
    name: "list_fonts",
    description: "List fonts Figma Desktop can load right now (includes locally installed fonts). Filter by family substring.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, fileKey: FILEKEY } }
  },
  {
    name: "get_status",
    description: "Which Figma files currently have the Hermes Bridge plugin open (file name, file key, page, user). Call first when unsure the bridge is up.",
    inputSchema: { type: "object", properties: {} }
  }
];

var INSTRUCTIONS = "Tools that act on the Figma file open in Figma DESKTOP on this Mac, through the Feugee Hermes Bridge plugin. " +
  "Prefer these over the remote figma MCP (mcp__figma__*) whenever text uses local fonts or the result must stay editable. " +
  "Batch a whole change into ONE use_figma script (one undo step). Verify with get_screenshot (local render) + vision. " +
  "If a call says the plugin is closed: ask the user to open the file in Figma Desktop and run Plugins > Development > Feugee Hermes Bridge, then retry. Do not fall back to outlining text.";

function closedText(why) {
  return "Figma Desktop belum bisa dijangkau (" + why + "). Minta user membuka file-nya di Figma Desktop lalu jalankan Plugins > Development > Feugee Hermes Bridge (panel plugin harus tetap terbuka; menjalankan plugin lain menutupnya), kemudian coba lagi. Jangan outline teks sebagai gantinya.";
}

function readEndpoint() {
  try { var e = JSON.parse(fs.readFileSync(ENDPOINT, "utf8")); if (e && e.url && e.token) return e; } catch (err) {}
  return null;
}

function health(ep) {
  return new Promise(function (resolve) {
    if (!ep) return resolve(false);
    var u = new URL(ep.url);
    var req = http.request({ host: u.hostname, port: u.port, path: "/health", method: "GET", timeout: 1500 }, function (res) {
      var c = []; res.on("data", function (d) { c.push(d); });
      res.on("end", function () { try { resolve(JSON.parse(Buffer.concat(c).toString()).ok === true); } catch (e) { resolve(false); } });
    });
    req.on("error", function () { resolve(false); });
    req.on("timeout", function () { req.destroy(); resolve(false); });
    req.end();
  });
}

// One relay per Mac. Started detached so it outlives this proxy (other
// Hermes sessions and the open plugin keep using it).
var starting = null;
function ensureRelay() {
  if (starting) return starting;
  starting = health(readEndpoint()).then(function (up) {
    if (up) return true;
    fs.mkdirSync(DATA, { recursive: true });
    var out = fs.openSync(path.join(DATA, "relay.out"), "a");
    var child = spawn(process.execPath, [RELAY], { detached: true, stdio: ["ignore", out, out] });
    child.unref();
    return new Promise(function (resolve) {
      var tries = 0;
      (function wait() {
        health(readEndpoint()).then(function (ok) {
          if (ok || ++tries > 30) return resolve(ok);
          setTimeout(wait, 100);
        });
      })();
    });
  }).then(function (ok) { starting = null; return ok; });
  return starting;
}

function post(ep, payload, timeoutMs) {
  return new Promise(function (resolve) {
    var u = new URL(ep.url), b = Buffer.from(JSON.stringify(payload), "utf8"), done = false;
    var req = http.request({ host: u.hostname, port: u.port, path: "/call", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": b.length, "Authorization": "Bearer " + ep.token } }, function (res) {
      var c = []; res.on("data", function (d) { c.push(d); });
      res.on("end", function () {
        if (done) return; done = true;
        if (res.statusCode === 401) return resolve({ closed: "token relay berubah, relay baru di-restart" });
        try { resolve(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch (e) { resolve({ error: "balasan relay tidak terbaca" }); }
      });
    });
    req.setTimeout(timeoutMs, function () { if (done) return; done = true; req.destroy(); resolve({ error: "relay tidak menjawab" }); });
    req.on("error", function (e) { if (done) return; done = true; resolve({ closed: e.code === "ECONNREFUSED" ? "relay mati" : (e.code || e.message) }); });
    req.end(b);
  });
}

function text(t, isError) { return { content: [{ type: "text", text: t }], isError: !!isError }; }

function callTool(name, args) {
  if (!TOOLS.some(function (t) { return t.name === name; })) return Promise.resolve(text("ERROR: unknown tool " + name, true));
  args = args || {};
  if (args.nodeId) args.nodeId = String(args.nodeId).replace("-", ":");
  if (args.parentId) args.parentId = String(args.parentId).replace("-", ":");
  if (args.path && !path.isAbsolute(args.path)) return Promise.resolve(text("ERROR: path harus absolut", true));
  return ensureRelay().then(function (ok) {
    var ep = readEndpoint();
    if (!ok || !ep) return text("ERROR: relay Hermes Bridge Figma gagal start (cek " + path.join(DATA, "relay.out") + ")", true);
    return post(ep, { tool: name, args: args }, 340000).then(function (r) {
      if (r.closed === true) return text("ERROR: " + closedText("plugin tidak terbuka di file mana pun"), true);
      if (r.closed) return text("ERROR: " + closedText(r.closed), true);
      if (r.error) return text("ERROR: " + r.error, true);
      var out = r.result === undefined ? null : r.result;
      var s = typeof out === "string" ? out : JSON.stringify(out, null, 0);
      if (r.ms !== undefined) s = s + (r.file ? "\n[" + r.file + " · " + r.ms + " ms]" : "");
      return text(s === undefined ? "null" : s, false);
    });
  });
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
var pendingCount = 0, closing = false;
function track(p) {
  if (!p || typeof p.then !== "function") return;
  pendingCount++;
  p.then(fin, fin);
  function fin() { if (--pendingCount <= 0 && closing) process.exit(0); }
}

function handle(msg) {
  if (!msg || typeof msg !== "object" || !msg.method) return;
  var id = msg.id, isReq = id !== undefined && id !== null, params = msg.params || {};
  function ok(result) { if (isReq) send({ jsonrpc: "2.0", id: id, result: result }); }
  switch (msg.method) {
    case "initialize":
      ensureRelay(); // warm up so the plugin connects as soon as any Hermes session is open
      return ok({ protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "figma-bridge", version: VERSION }, instructions: INSTRUCTIONS });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "resources/list": return ok({ resources: [] });
    case "prompts/list": return ok({ prompts: [] });
    case "tools/call":
      return callTool(params.name, params.arguments).then(ok);
    default:
      if (isReq) send({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "method not found: " + msg.method } });
  }
}

var buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (d) {
  buf += d;
  var i;
  while ((i = buf.indexOf("\n")) >= 0) {
    var line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    var m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (Array.isArray(m)) m.forEach(function (x) { track(handle(x)); }); else track(handle(m));
  }
});
process.stdin.on("end", function () { closing = true; if (pendingCount <= 0) process.exit(0); });
