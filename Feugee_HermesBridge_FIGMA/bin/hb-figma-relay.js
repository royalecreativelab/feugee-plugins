#!/usr/bin/env node
/* =========================================================
   HERMES BRIDGE FIGMA - LOCAL RELAY
   A Figma plugin cannot listen on a port (the AE/PR panels can), so the
   direction is flipped: this tiny daemon listens on 127.0.0.1 and the
   plugin UI long-polls it for jobs.

     plugin UI  --POST /poll  (hello + wait for jobs, 25 s)-->  relay
     plugin UI  --POST /result {id, ...}------------------------>  relay
     hb-figma-mcp.js --POST /call (Bearer token)---------------->  relay

   Started on demand by bin/hb-figma-mcp.js (detached, one per Mac). Writes
   endpoint.json {url, token, pid} to the data dir; the stdio proxy reads it
   on every call, exactly like the AE/PR proxy does with the panel.

   Data dir: ~/Library/Application Support/HermesBridgeFigma
   usage: node hb-figma-relay.js [--port 3846]
   ========================================================= */
"use strict";
var fs = require("fs");
var os = require("os");
var path = require("path");
var http = require("http");
var crypto = require("crypto");

var PORT = Number((process.argv.indexOf("--port") > 0 && process.argv[process.argv.indexOf("--port") + 1]) || process.env.HB_FIGMA_PORT || 3846);
var DATA = process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "HermesBridgeFigma")
  : path.join(os.homedir(), "Library", "Application Support", "HermesBridgeFigma");
var ENDPOINT = path.join(DATA, "endpoint.json");
var SHOTS = path.join(DATA, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

var TOKEN = crypto.randomBytes(24).toString("hex");
var POLL_MS = 25000;          // plugin long-poll window
var ALIVE_MS = POLL_MS + 15000; // a client that has not polled for this long is gone
var CALL_MS = 330000;         // one tool call (same cap as the AE proxy)

var clients = {};  // clientId -> {info, lastSeen, waiter:res|null, queue:[]}
var pending = {};  // jobId -> {resolve, timer, client}
var seq = 0;

function log() {
  var line = new Date().toISOString() + " " + Array.prototype.join.call(arguments, " ") + "\n";
  try { fs.appendFileSync(path.join(DATA, "relay.log"), line); } catch (e) {}
}

function cors(res) {
  // The plugin UI iframe has origin "null"; it is the only browser caller.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function json(res, code, obj) {
  cors(res);
  var b = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length });
  res.end(b);
}
function body(req, cb) {
  var chunks = [], size = 0;
  req.on("data", function (c) { size += c.length; if (size > 64 * 1024 * 1024) req.destroy(); else chunks.push(c); });
  req.on("end", function () {
    var t = Buffer.concat(chunks).toString("utf8");
    try { cb(t ? JSON.parse(t) : {}); } catch (e) { cb(null); }
  });
}

function alive() {
  var now = Date.now(), out = [];
  Object.keys(clients).forEach(function (id) {
    var c = clients[id];
    if (now - c.lastSeen > ALIVE_MS && !c.waiter) { delete clients[id]; return; }
    out.push(c);
  });
  return out.sort(function (a, b) { return b.lastSeen - a.lastSeen; });
}

function describe(c) {
  var i = c.info || {};
  return { client: c.id, fileKey: i.fileKey || null, fileName: i.fileName || null, page: i.page || null,
    user: i.user || null, editorType: i.editorType || null, pluginVersion: i.version || null,
    idleSeconds: Math.round((Date.now() - c.lastSeen) / 1000) };
}

function flush(c) {
  if (!c.waiter || !c.queue.length) return;
  var res = c.waiter; c.waiter = null; clearTimeout(c.waitTimer);
  json(res, 200, { jobs: c.queue.splice(0) });
}

function pickClient(fileKey) {
  var list = alive();
  if (!list.length) return { err: "closed" };
  if (fileKey) {
    var m = list.filter(function (c) { return c.info && c.info.fileKey === fileKey; });
    if (!m.length) return { err: "file", list: list };
    return { client: m[0] };
  }
  return { client: list[0], ambiguous: list.length > 1 ? list : null };
}

function call(tool, args) {
  return new Promise(function (resolve) {
    var p = pickClient(args && args.fileKey);
    if (p.err === "closed") return resolve({ closed: true });
    if (p.err === "file") return resolve({ error: "File " + args.fileKey + " tidak sedang membuka plugin Hermes Bridge. Yang terhubung: " +
      p.list.map(function (c) { return (c.info.fileName || "?") + " (" + c.info.fileKey + ")"; }).join(", ") });
    var c = p.client, id = "j" + (++seq) + "-" + Date.now().toString(36);
    var job = { id: id, tool: tool, args: args || {} };
    if (tool === "place_image" && args && args.path) {
      try { job.args = Object.assign({}, args, { data: fs.readFileSync(args.path).toString("base64") }); }
      catch (e) { return resolve({ error: "Tidak bisa membaca file gambar: " + e.message }); }
    }
    if (tool === "import_svg" && args && args.path && !args.svg) {
      try { job.args = Object.assign({}, args, { svg: fs.readFileSync(args.path, "utf8") }); }
      catch (e) { return resolve({ error: "Tidak bisa membaca file SVG: " + e.message }); }
    }
    pending[id] = {
      client: c.id,
      resolve: resolve,
      timer: setTimeout(function () {
        delete pending[id];
        resolve({ error: "Figma tidak menjawab dalam " + (CALL_MS / 1000) + " detik (script terlalu berat, ada dialog terbuka, atau plugin ditutup di tengah jalan)." });
      }, CALL_MS)
    };
    c.queue.push(job);
    log("call", tool, id, "->", c.info && c.info.fileName);
    flush(c);
  });
}

function onResult(r) {
  var p = pending[r.id];
  if (!p) return;
  clearTimeout(p.timer); delete pending[r.id];
  if (r.ok === false && !r.error) r.error = "script gagal tanpa pesan";
  if (r.resultJson !== undefined) { r.result = r.resultJson; delete r.resultJson; }
  if (r.shot && r.shot.data) {
    var ext = r.shot.format === "JPG" ? "jpg" : r.shot.format === "SVG" ? "svg" : r.shot.format === "PDF" ? "pdf" : "png";
    var file = path.join(SHOTS, (r.shot.name || "shot").replace(/[^\w.-]+/g, "_").slice(0, 60) + "_" + Date.now() + "." + ext);
    fs.writeFileSync(file, Buffer.from(r.shot.data, "base64"));
    r.result = Object.assign({}, r.result || {}, { path: file, bytes: fs.statSync(file).size });
    delete r.shot;
  }
  p.resolve(r);
}

var server = http.createServer(function (req, res) {
  var url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  if (url.pathname === "/health") return json(res, 200, { ok: true, app: "hermes-bridge-figma", pid: process.pid, clients: alive().map(describe) });

  if (url.pathname === "/poll" && req.method === "POST") {
    return body(req, function (b) {
      if (!b || !b.client) return json(res, 400, { error: "bad poll" });
      var c = clients[b.client] || (clients[b.client] = { id: b.client, queue: [], waiter: null });
      if (!c.info) log("hello", b.client, b.info && b.info.fileName);
      c.info = b.info || c.info || {};
      c.lastSeen = Date.now();
      if (c.waiter) { clearTimeout(c.waitTimer); json(c.waiter, 200, { jobs: [] }); }
      c.waiter = res;
      c.waitTimer = setTimeout(function () { if (c.waiter === res) { c.waiter = null; c.lastSeen = Date.now(); json(res, 200, { jobs: [] }); } }, POLL_MS);
      // res 'close' = response sent or socket dropped (req 'close' fires as soon as the body is read)
      res.on("close", function () { if (c.waiter === res) { c.waiter = null; clearTimeout(c.waitTimer); } });
      flush(c);
    });
  }

  if (url.pathname === "/result" && req.method === "POST") {
    return body(req, function (b) { if (b && b.id) onResult(b); json(res, 200, { ok: true }); });
  }

  if (url.pathname === "/bye" && req.method === "POST") {
    return body(req, function (b) { if (b && b.client) { log("bye", b.client); delete clients[b.client]; } json(res, 200, { ok: true }); });
  }

  if (url.pathname === "/call" && req.method === "POST") {
    if (req.headers.authorization !== "Bearer " + TOKEN) return json(res, 401, { error: "bad token" });
    return body(req, function (b) {
      if (!b || !b.tool) return json(res, 400, { error: "bad call" });
      if (b.tool === "get_status") return json(res, 200, { result: { connected: alive().map(describe) } });
      call(b.tool, b.args).then(function (r) { json(res, 200, r); });
    });
  }
  json(res, 404, { error: "not found" });
});

server.requestTimeout = 0;   // /call can legitimately take minutes (heavy scripts)
server.headersTimeout = 60000;
server.on("error", function (e) {
  if (e.code === "EADDRINUSE") { log("port in use, another relay is running - exit"); process.exit(0); }
  log("server error", e.message); process.exit(1);
});
server.listen(PORT, "127.0.0.1", function () {
  fs.writeFileSync(ENDPOINT, JSON.stringify({ url: "http://127.0.0.1:" + PORT, token: TOKEN, pid: process.pid, started: new Date().toISOString() }), { mode: 0o600 });
  log("relay up on", PORT, "pid", process.pid);
  // The plugin manifest can only allow "localhost", which Figma's Chromium may
  // resolve to ::1. Listen on IPv6 loopback too (still loopback only, never LAN).
  var v6 = http.createServer(function (req, res) { server.emit("request", req, res); });
  v6.requestTimeout = 0;
  v6.on("error", function (e) { log("ipv6 loopback listener skipped:", e.code || e.message); });
  v6.listen(PORT, "::1", function () { log("relay also on [::1]:" + PORT); });
});
function cleanup() {
  try { var e = JSON.parse(fs.readFileSync(ENDPOINT, "utf8")); if (e.pid === process.pid) fs.unlinkSync(ENDPOINT); } catch (x) {}
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
