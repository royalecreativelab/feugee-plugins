#!/usr/bin/env node
/* =========================================================
   HERMES BRIDGE - STDIO MCP PROXY (After Effects + Premiere Pro)
   Registered in a normal Hermes profile (mcp_servers.after_effects /
   mcp_servers.premiere_pro) so EVERY Hermes surface - the panel in
   full mode, Hermes Desktop chat, CLI, Telegram, cron - can drive the
   AE / Premiere project that is open right now.

   The real MCP server lives inside the CEP panel (js/mcp.js, random
   port + bearer token). The panel writes both to endpoint.json in its
   data dir on start and deletes it on close; this proxy re-reads that
   file on every call, so it survives panel/app restarts.

   usage: node hb-mcp-proxy.js ae|ppro
   Same file ships in both extensions (byte-identical).
   ========================================================= */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var http = require("http");

var APP = (process.argv[2] || "ae").toLowerCase() === "ppro" ? "ppro" : "ae";
var WIN = process.platform === "win32";
var HOME = os.homedir();
var DATA = WIN
  ? path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), APP === "ppro" ? "HermesBridgePR" : "HermesBridge")
  : path.join(HOME, "Library", "Application Support", APP === "ppro" ? "HermesBridgePR" : "HermesBridge");
var ENDPOINT = path.join(DATA, "endpoint.json");
var LABEL = APP === "ppro" ? "Premiere Pro" : "After Effects";
var PANEL = APP === "ppro" ? "Hermes Bridge PR" : "Hermes Bridge";

// Tool schemas come straight from the panel's own mcp.js (same folder tree),
// so the list is always in sync with the installed panel version and is
// available even while the app is closed.
var Server = null;
(function loadSchemas() {
  var candidates = [
    path.join(__dirname, "..", "js", "mcp.js"),
    path.join(HOME, "Library", "Application Support", "Adobe", "CEP", "extensions",
      APP === "ppro" ? "com.feugee.hermesbridgepr" : "com.feugee.hermesbridge", "js", "mcp.js")
  ];
  for (var i = 0; i < candidates.length && !Server; i++) {
    try {
      // mcp.js only touches window/document inside functions; under node it
      // attaches to `global`. The ExtendScript side is not loaded here.
      // envato.js first: mcp.js appends its tool schemas at load time.
      try { require(path.join(path.dirname(candidates[i]), "envato-session.js")); } catch (e3) {}
      try { require(path.join(path.dirname(candidates[i]), "envato.js")); } catch (e2) {}
      require(candidates[i]);
      Server = APP === "ppro" ? global.PproMcpServer : global.AeMcpServer;
    } catch (e) { Server = null; }
  }
})();
var TOOLS = (Server && Server.TOOLS) || [];
var INSTRUCTIONS = ((Server && Server.INSTRUCTIONS) || "") +
  " These tools reach the " + LABEL + " project open on this Mac through the " + PANEL + " panel; " +
  "if the app or panel is closed every call says so - then tell the user to open " + LABEL + " and Window > Extensions > " + PANEL + ".";

// Parent + grandparent pid: the panel compares them with the pid of the
// `hermes acp` it spawned (a launcher script may sit in between).
var ANCESTORS = (function () {
  var ids = [process.ppid];
  if (!WIN) {
    try {
      var g = String(require("child_process").execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { timeout: 2000 })).trim();
      if (g) ids.push(Number(g));
    } catch (e) {}
  }
  return ids.join(",");
})();

function readEndpoint() {
  try {
    var e = JSON.parse(fs.readFileSync(ENDPOINT, "utf8"));
    if (e && e.url && e.token) return e;
  } catch (err) {}
  return null;
}

function closedText(why) {
  return LABEL + " belum bisa dijangkau (" + why + "). Minta user membuka " + LABEL +
    " lalu Window > Extensions > " + PANEL + " (panel harus terbuka), kemudian coba lagi. Jangan pakai osascript sebagai gantinya kecuali user minta.";
}

// One JSON-RPC request to the panel's HTTP MCP server.
function forward(msg, timeoutMs) {
  return new Promise(function (resolve) {
    var ep = readEndpoint();
    if (!ep) return resolve({ closed: closedText("panel tidak terbuka") });
    var body = Buffer.from(JSON.stringify(msg), "utf8");
    var u;
    try { u = new URL(ep.url); } catch (e) { return resolve({ closed: closedText("endpoint rusak") }); }
    var done = false;
    var req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Content-Length": body.length,
        "Authorization": "Bearer " + ep.token,
        // lets the panel tell its own agent from Hermes Desktop / CLI / Telegram
        "X-HB-Parent-Pid": ANCESTORS
      }
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        if (done) return; done = true;
        if (res.statusCode === 401) return resolve({ closed: closedText("token kedaluwarsa, panel baru di-restart") });
        try { resolve({ reply: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (e) { resolve({ closed: closedText("balasan panel tidak terbaca") }); }
      });
    });
    req.setTimeout(timeoutMs || 330000, function () {
      if (done) return; done = true;
      req.destroy();
      resolve({ closed: closedText(LABEL + " tidak menjawab - mungkin sedang render/export atau ada dialog terbuka") });
    });
    req.on("error", function (e) {
      if (done) return; done = true;
      resolve({ closed: closedText(e.code === "ECONNREFUSED" ? "panel sudah ditutup" : e.code || e.message) });
    });
    req.end(body);
  });
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

// Requests still running when stdin closes are answered before exiting.
var pending = 0, closing = false;
function track(p) {
  if (!p || typeof p.then !== "function") return p;
  pending++;
  return p.then(done, done);
  function done() { if (--pending <= 0 && closing) process.exit(0); }
}

function handle(msg) {
  if (!msg || typeof msg !== "object" || !msg.method) return;
  var id = msg.id, isReq = id !== undefined && id !== null;
  var params = msg.params || {};
  function ok(result) { if (isReq) send({ jsonrpc: "2.0", id: id, result: result }); }

  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: APP === "ppro" ? "premiere-pro" : "after-effects", version: "1.0.0" },
        instructions: INSTRUCTIONS
      });
    case "ping":
      return ok({});
    case "tools/list":
      // Tell a live panel which agent listed its tools (boot check), never wait on it.
      forward({ jsonrpc: "2.0", id: "hb-list", method: "tools/list", params: {} }, 2000);
      return ok({ tools: TOOLS });
    case "resources/list": return ok({ resources: [] });
    case "prompts/list": return ok({ prompts: [] });
    case "tools/call":
      // Envato search does not need the app: when the panel is closed, run it
      // here. With the panel open it goes through the panel (cards in chat).
      if (params.name === "envato_search" && global.HBEnvato) {
        return forward({ jsonrpc: "2.0", id: 1, method: "tools/call", params: params }).then(function (r) {
          if (!r.closed && r.reply && r.reply.result) return ok(r.reply.result);
          return global.HBEnvato.search(params.arguments || {}, { previewDir: path.join(DATA, "envato", "previews") }).then(function (res) {
            var text = res.ok ? JSON.stringify(res.data) : (res.infra ? "ERROR: " : "SEARCH ERROR (perbaiki argumen lalu ulangi): ") + res.error;
            ok({ content: [{ type: "text", text: text }], isError: !res.ok && !!res.infra });
          });
        });
      }
      return forward({ jsonrpc: "2.0", id: 1, method: "tools/call", params: params }).then(function (r) {
        if (r.closed) return ok({ content: [{ type: "text", text: "ERROR: " + r.closed }], isError: true });
        if (r.reply && r.reply.error) return ok({ content: [{ type: "text", text: "ERROR: " + (r.reply.error.message || "panel error") }], isError: true });
        return ok(r.reply && r.reply.result ? r.reply.result : { content: [{ type: "text", text: "ERROR: balasan kosong dari panel" }], isError: true });
      });
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
    var line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    var msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (Array.isArray(msg)) msg.forEach(function (m) { track(handle(m)); }); else track(handle(msg));
  }
});
process.stdin.on("end", function () { closing = true; if (pending <= 0) process.exit(0); });
