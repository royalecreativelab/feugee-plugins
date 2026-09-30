/* =========================================================
   HERMES BRIDGE - ACP CLIENT (backend)
   Spawns `hermes acp` (profile aebridge) and speaks ACP JSON-RPC
   over stdio. Runs in the CEP panel's mixed Node+browser context.
   ========================================================= */
(function (global) {
  "use strict";

  // OS specifics (paths, PATH delimiter, spawn/kill) live in js/setup.js.
  var S = global.HBSetup;
  var HOME = S.HOME;
  var PROFILE = S.PROFILE;   // dedicated lean profile: vision + panel MCP only, AE-specific .hermes.md
  var WORK_CWD = S.WORK_CWD;

  // Preferred model when it exists on this machine; otherwise the panel keeps
  // whatever the aebridge profile has as model.default (set via `hermes model`).
  var DEFAULT_MODEL = "custom:pecut:pecut/deepseek-v4.1-flash";

  function buildEnv(bin, opts) {
    var env = S.agentEnv(S.toolDirs(bin));
    // Figma / Google Workspace MCP are not needed inside AE: skipping them
    // saves seconds at boot and ~170 tool schemas on every turn.
    if (!opts || !opts.withMcp) env.HERMES_ACP_SKIP_CONFIGURED_MCP = "1";
    // Panel MCP tools (mcp__ae__*) must be sent eagerly, not hidden behind
    // tool_search: that bridge costs an extra model round trip per call.
    return env;
  }

  function Acp(handlers) {
    this.handlers = handlers || {};
    this.child = null;
    this.nextId = 1;
    this.pending = {};
    this.sessionId = null;
    this.models = [];
    this.currentModel = "";
    this._buf = "";
    this._log = [];
  }

  Acp.DEFAULT_MODEL = DEFAULT_MODEL;
  Acp.WORK_CWD = WORK_CWD;
  Acp.PROFILE = PROFILE;
  Acp.HOME = HOME;

  Acp.prototype._emit = function (name, arg) {
    var h = this.handlers[name];
    if (typeof h === "function") {
      try { h(arg); } catch (e) { /* a UI error must never kill the bridge */ }
    }
  };

  Acp.prototype._pushLog = function (line) {
    if (!line) return;
    this._log.push(line);
    if (this._log.length > 500) this._log.shift();
    this._emit("onLog", line);
  };

  Acp.prototype.alive = function () { return !!this.child; };

  Acp.prototype.spawn = function (opts) {
    var inst = this;
    inst._buf = "";
    var bin = S.findHermes();
    if (!bin) throw new Error("Hermes CLI tidak ditemukan");
    try { require("fs").mkdirSync(WORK_CWD, { recursive: true }); } catch (e) {}
    inst.child = S.spawnHermes(bin, ["acp"], {
      env: buildEnv(bin, opts),
      cwd: WORK_CWD,
      stdio: ["pipe", "pipe", "pipe"]
    });
    var me = inst.child;
    me.stdout.on("data", function (d) { if (inst.child === me) inst._onStdout(d); });
    me.stderr.on("data", function (d) { inst._pushLog(String(d).trim()); });
    me.on("error", function (e) { inst._emit("onError", "spawn: " + e.message); });
    me.on("exit", function (code, sig) {
      if (inst.child !== me) return; // an old child after restart
      inst.child = null;
      inst.sessionId = null;
      Object.keys(inst.pending).forEach(function (id) {
        inst.pending[id].reject(new Error("agent exited"));
        delete inst.pending[id];
      });
      inst._emit("onExit", { code: code, signal: sig });
    });
    return inst;
  };

  Acp.prototype._onStdout = function (d) {
    this._buf += d.toString();
    var i;
    while ((i = this._buf.indexOf("\n")) >= 0) {
      var line = this._buf.slice(0, i).replace(/\r$/, "").trim();
      this._buf = this._buf.slice(i + 1);
      if (!line) continue;
      var obj;
      try { obj = JSON.parse(line); } catch (e) { this._pushLog("BADLINE " + line.slice(0, 200)); continue; }
      this._dispatch(obj);
    }
  };

  Acp.prototype._write = function (obj) {
    if (!this.child) { this._emit("onError", "agent not running"); return false; }
    try { this.child.stdin.write(JSON.stringify(obj) + "\n"); return true; }
    catch (e) { this._emit("onError", "write: " + e.message); return false; }
  };

  Acp.prototype._send = function (method, params, isNotify) {
    var inst = this;
    var msg = { jsonrpc: "2.0", method: method, params: params || {} };
    if (!isNotify) msg.id = inst.nextId++;
    if (!inst._write(msg)) return isNotify ? Promise.resolve() : Promise.reject(new Error("agent not running"));
    if (isNotify) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      inst.pending[msg.id] = { method: method, resolve: resolve, reject: reject };
    });
  };

  Acp.prototype._reply = function (id, result) { this._write({ jsonrpc: "2.0", id: id, result: result }); };
  Acp.prototype._replyErr = function (id, code, message) {
    this._write({ jsonrpc: "2.0", id: id, error: { code: code, message: message } });
  };

  Acp.prototype._dispatch = function (obj) {
    var hasId = Object.prototype.hasOwnProperty.call(obj, "id");
    if (hasId && !obj.method) {
      var p = this.pending[obj.id];
      if (p) {
        delete this.pending[obj.id];
        if (obj.error) p.reject(obj.error); else p.resolve(obj.result);
      }
      return;
    }
    if (!obj.method) return;
    if (hasId) this._handleRequest(obj.id, obj.method, obj.params || {});
    else this._handleNotify(obj.method, obj.params || {});
  };

  // ---- agent -> client requests ----
  Acp.prototype._handleRequest = function (id, method, params) {
    var inst = this;
    var fs = require("fs");
    if (method === "fs/read_text_file") {
      fs.readFile(params.path, "utf8", function (e, content) {
        if (e) inst._replyErr(id, -32000, "read: " + e.message);
        else inst._reply(id, { content: content });
      });
      return;
    }
    if (method === "fs/write_text_file") {
      fs.writeFile(params.path, params.content, function (e) {
        if (e) inst._replyErr(id, -32000, "write: " + e.message);
        else inst._reply(id, {});
      });
      return;
    }
    if (method === "session/request_permission") {
      inst._emit("onPermission", { id: id, params: params });
      return;
    }
    inst._replyErr(id, -32601, "hermes-bridge: not handled: " + method);
  };

  Acp.prototype.respondPermission = function (id, optionId) {
    this._reply(id, { outcome: { outcome: "selected", optionId: optionId } });
  };
  Acp.prototype.cancelPermission = function (id) {
    this._reply(id, { outcome: { outcome: "cancelled" } });
  };

  // ---- notifications ----
  Acp.prototype._handleNotify = function (method, params) {
    if (method !== "session/update") return;
    var upd = params.update || {};
    var kind = upd.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_message") {
      this._emit("onStream", { messageId: upd.messageId, text: (upd.content && upd.content.text) || "" });
    } else if (kind === "agent_thought_chunk") {
      this._emit("onThought", { text: (upd.content && upd.content.text) || "" });
    } else if (kind === "tool_call") {
      this._emit("onTool", { toolCallId: upd.toolCallId, title: upd.title || "tool", kind: upd.kind || "", status: upd.status || "in_progress" });
    } else if (kind === "tool_call_update") {
      this._emit("onToolUpdate", { toolCallId: upd.toolCallId, status: upd.status || "", title: upd.title || "" });
    } else if (kind === "usage_update") {
      this._emit("onUsage", { used: upd.used, size: upd.size });
    }
  };

  // ---- high-level flow ----
  Acp.prototype.initialize = function () {
    return this._send("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "hermes-ae-bridge", version: "2.1.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
    });
  };

  Acp.prototype.newSession = function () {
    var inst = this;
    inst.sessionId = null;
    return inst._send("session/new", { cwd: WORK_CWD, mcpServers: inst.mcpServers || [] }).then(function (res) {
      inst.sessionId = res.sessionId;
      if (res.models) {
        inst.models = res.models.availableModels || [];
        inst.currentModel = res.models.currentModelId || "";
      }
      return res;
    });
  };

  Acp.prototype.prompt = function (text) {
    return this._send("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: text }] });
  };

  Acp.prototype.cancel = function () {
    return this._send("session/cancel", { sessionId: this.sessionId }, true);
  };

  Acp.prototype.setModel = function (modelId) {
    var inst = this;
    return inst._send("session/set_model", { sessionId: inst.sessionId, modelId: modelId }).then(function (res) {
      inst.currentModel = (res && res.currentModelId) || modelId;
      return res;
    });
  };

  Acp.prototype.setMode = function (modeId) {
    return this._send("session/set_mode", { sessionId: this.sessionId, modeId: modeId });
  };

  // Full boot: spawn -> initialize -> session -> model. Resolves with ms elapsed.
  Acp.prototype.boot = function (model, opts) {
    var inst = this;
    var t0 = Date.now();
    if (!inst.child) inst.spawn(opts);
    return inst.initialize().then(function () {
      return inst.newSession();
    }).then(function () {
      var want = model || DEFAULT_MODEL;
      if (inst.currentModel === want) return null;
      return inst.setModel(want);
    }).then(function () { return Date.now() - t0; });
  };

  Acp.prototype.kill = function () {
    var c = this.child;
    this.child = null;
    this.sessionId = null;
    if (c) S.killTree(c);
  };

  Acp.prototype.logTail = function (n) { return this._log.slice(-(n || 120)).join("\n"); };

  global.Acp = Acp;
})(window);
