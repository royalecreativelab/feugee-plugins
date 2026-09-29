/* =========================================================
   HERMES BRIDGE - FIRST-RUN SETUP
   Finds the Hermes CLI, makes sure the dedicated `aebridge`
   profile exists with the AE-only toolset, and checks that a
   model is configured. Interactive steps (installing Hermes,
   logging in to a model provider) open in Terminal so the user
   types their own credentials there - the panel never sees them.
   ========================================================= */
(function (global) {
  "use strict";

  var fs = require("fs");
  var os = require("os");
  var path = require("path");
  var cp = require("child_process");

  var HOME = os.homedir();
  var PROFILE = "aebridge";
  var BASE = path.join(HOME, "Library", "Application Support", "HermesBridge");
  var INSTALL_CMD = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup";

  // Where the official installer and Hermes Desktop put the CLI.
  var CANDIDATES = [
    path.join(HOME, ".local", "bin", "hermes"),
    path.join(HOME, ".hermes", "hermes-agent", ".hermes", "bin", "hermes"),
    path.join(HOME, ".hermes", "hermes-agent", "venv", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes"
  ];

  function isExec(p) {
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch (e) { return false; }
  }

  function findHermes() {
    for (var i = 0; i < CANDIDATES.length; i++) if (isExec(CANDIDATES[i])) return CANDIDATES[i];
    return null;
  }

  function profileDir() { return path.join(HOME, ".hermes", "profiles", PROFILE); }

  // Run a hermes CLI command; resolves {code, out}. Never throws.
  function run(bin, args, timeoutMs) {
    return new Promise(function (resolve) {
      var out = "", done = false;
      var env = Object.assign({}, process.env, { HOME: HOME, TERM: "dumb", NO_COLOR: "1" });
      delete env.HERMES_HOME;
      var c;
      try { c = cp.spawn(bin, args, { env: env, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { return resolve({ code: -1, out: String(e.message || e) }); }
      var t = setTimeout(function () { if (!done) { done = true; try { c.kill(); } catch (e) {} resolve({ code: -2, out: out + "\n(timeout)" }); } }, timeoutMs || 60000);
      c.stdout.on("data", function (d) { out += d; });
      c.stderr.on("data", function (d) { out += d; });
      c.on("error", function (e) { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out: String(e.message || e) }); } });
      c.on("exit", function (code) { if (!done) { done = true; clearTimeout(t); resolve({ code: code, out: out }); } });
    });
  }

  function lastLine(s) { return String(s || "").trim().split(/\r?\n/).filter(Boolean).pop() || ""; }

  // Creates the profile if missing (never clones another profile's keys),
  // then pins the settings the panel depends on. Skips CLI calls when the
  // config already has them, so a normal boot costs no extra time.
  function ensureProfile(bin) {
    var chain = Promise.resolve();
    if (!fs.existsSync(path.join(profileDir(), "config.yaml"))) {
      chain = run(bin, ["profile", "create", PROFILE, "--no-alias", "--no-skills",
        "--description", "Hermes Bridge panel inside After Effects (ACP)"], 180000).then(function (r) {
        if (/already exists/i.test(r.out)) return;
        if (!fs.existsSync(path.join(profileDir(), "config.yaml"))) throw new Error("gagal membuat profil " + PROFILE + ": " + lastLine(r.out));
      });
    }
    return chain.then(function () {
      var cfg = "";
      try { cfg = fs.readFileSync(path.join(profileDir(), "config.yaml"), "utf8"); } catch (e) {}
      var steps = [];
      if (!/no_mcp/.test(cfg)) steps.push(["config", "set", "platform_toolsets.acp", '["vision", "no_mcp"]']);
      if (!/tool_search:\s*\n\s*enabled:\s*"?off"?/.test(cfg)) steps.push(["config", "set", "tools.tool_search.enabled", "off"]);
      return steps.reduce(function (p, a) {
        return p.then(function () { return run(bin, ["-p", PROFILE].concat(a), 30000); });
      }, Promise.resolve());
    });
  }

  function modelConfigured() {
    var cfg = "";
    try { cfg = fs.readFileSync(path.join(profileDir(), "config.yaml"), "utf8"); } catch (e) {}
    var m = cfg.match(/^model:\s*\n(?:[ \t]+.*\n)*?[ \t]+default:\s*(\S.*)$/m);
    return Promise.resolve(m ? m[1].replace(/^["']|["']$/g, "").trim() : null);
  }

  // Keep the agent rules shipped with the plugin in the workspace Hermes reads.
  function syncRules(extDir) {
    var src = path.join(extDir, "agent", "AGENT_RULES.md");
    var dst = path.join(BASE, "workspace", ".hermes.md");
    try {
      var want = fs.readFileSync(src, "utf8");
      var have = "";
      try { have = fs.readFileSync(dst, "utf8"); } catch (e) {}
      if (have !== want) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, want);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Opens a .command file in Terminal (no osascript, no AE scripting).
  function openInTerminal(name, lines) {
    fs.mkdirSync(BASE, { recursive: true });
    var p = path.join(BASE, name + ".command");
    fs.writeFileSync(p, ["#!/bin/bash", "set -u", "clear"].concat(lines).concat([
      "echo ''", "echo '  Selesai. Balik ke After Effects dan klik CEK LAGI di panel Hermes Bridge.'",
      "read -r -p '  Tekan Return untuk menutup...' _"
    ]).join("\n") + "\n");
    fs.chmodSync(p, 493); // 0755
    cp.spawn("open", [p], { detached: true, stdio: "ignore" }).unref();
    return p;
  }

  function openInstall() {
    return openInTerminal("install-hermes", [
      "echo '  HERMES BRIDGE - install Hermes Agent'",
      "echo '  Sumber resmi: https://hermes-agent.nousresearch.com'",
      "echo ''",
      INSTALL_CMD
    ]);
  }

  function openLogin(bin) {
    return openInTerminal("login-model", [
      "echo '  HERMES BRIDGE - pilih provider & model'",
      "echo '  Pilih provider (Nous Portal login, Anthropic, OpenAI, OpenRouter, dll)'",
      "echo '  lalu masukkan akun/API key kamu sendiri. Disimpan di profil aebridge.'",
      "echo ''",
      JSON.stringify(bin) + " -p " + PROFILE + " model"
    ]);
  }

  // Full check. Resolves {ok, step, bin, model, message}.
  // step: "platform" | "install" | "profile" | "login" | "ready"
  function check(extDir) {
    if (process.platform !== "darwin") {
      return Promise.resolve({ ok: false, step: "platform", message: "Hermes Bridge saat ini cuma untuk macOS." });
    }
    var bin = findHermes();
    if (!bin) return Promise.resolve({ ok: false, step: "install", message: "Hermes Agent belum terpasang di Mac ini." });
    syncRules(extDir);
    return ensureProfile(bin).then(function () {
      return modelConfigured();
    }).then(function (model) {
      if (!model) return { ok: false, step: "login", bin: bin, message: "Belum ada model. Login ke provider pakai akun atau API key kamu sendiri." };
      return { ok: true, step: "ready", bin: bin, model: model };
    }, function (e) {
      return { ok: false, step: "profile", bin: bin, message: String(e.message || e) };
    });
  }

  global.HBSetup = {
    PROFILE: PROFILE,
    INSTALL_CMD: INSTALL_CMD,
    CANDIDATES: CANDIDATES,
    findHermes: findHermes,
    check: check,
    syncRules: syncRules,
    openInstall: openInstall,
    openLogin: openLogin
  };
})(typeof window !== "undefined" ? window : global);
