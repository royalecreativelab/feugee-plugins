/* =========================================================
   HERMES BRIDGE - PLATFORM + FIRST-RUN SETUP (macOS / Windows)
   Finds the Hermes CLI, makes sure the dedicated `aebridge`
   profile exists with the AE-only toolset, and checks that a
   model is configured. Interactive steps (installing Hermes,
   logging in to a model provider) open in Terminal (macOS) or
   PowerShell (Windows) so the user types their own credentials
   there - the panel never sees them.

   Also the single place that knows OS differences: data dirs,
   Hermes home, PATH delimiter, how to spawn/kill the CLI.
   acp.js and panel.js read everything from window.HBSetup.
   ========================================================= */
(function (global) {
  "use strict";

  var fs = require("fs");
  var os = require("os");
  var cp = require("child_process");

  var PLAT = process.platform;
  var WIN = PLAT === "win32";
  var path = WIN ? require("path").win32 : require("path").posix;
  var ENV = process.env;

  function env(name) {
    // Windows env names are case-insensitive; Node's copy keeps one spelling.
    if (!WIN) return ENV[name] || "";
    var want = name.toUpperCase();
    for (var k in ENV) if (k.toUpperCase() === want) return ENV[k] || "";
    return "";
  }

  var HOME = os.homedir();
  var PROFILE = "aebridge";

  // Hermes data root: ~/.hermes on POSIX, %LOCALAPPDATA%\hermes on Windows
  // (hermes_constants._get_platform_default_hermes_home).
  var HERMES_ROOT = WIN
    ? path.join(env("LOCALAPPDATA") || path.join(HOME, "AppData", "Local"), "hermes")
    : path.join(HOME, ".hermes");

  // Panel's own data (workspace with .hermes.md, frames, attachments, helper scripts).
  var BASE = WIN
    ? path.join(env("APPDATA") || path.join(HOME, "AppData", "Roaming"), "HermesBridge")
    : path.join(HOME, "Library", "Application Support", "HermesBridge");

  var INSTALL_URL_SH = "https://hermes-agent.nousresearch.com/install.sh";
  var INSTALL_URL_PS1 = "https://hermes-agent.nousresearch.com/install.ps1";
  var INSTALL_CMD = WIN
    ? "& ([scriptblock]::Create((Invoke-RestMethod '" + INSTALL_URL_PS1 + "'))) -NonInteractive"
    : "curl -fsSL " + INSTALL_URL_SH + " | bash -s -- --skip-setup";

  // Where the official installers / Hermes Desktop put the CLI.
  function candidates() {
    if (WIN) {
      var la = env("LOCALAPPDATA") || path.join(HOME, "AppData", "Local");
      var list = [
        path.join(HERMES_ROOT, "bin", "hermes.exe"),
        path.join(HERMES_ROOT, "bin", "hermes.cmd"),
        path.join(HERMES_ROOT, "hermes-agent", "venv", "Scripts", "hermes.exe"),
        path.join(la, "Microsoft", "WindowsApps", "hermes.exe")   // Desktop (MSIX) execution alias
      ];
      // then anything on PATH
      var exts = (env("PATHEXT") || ".EXE;.CMD;.BAT").split(";").map(function (e) { return e.toLowerCase(); })
        .filter(function (e) { return e === ".exe" || e === ".cmd" || e === ".bat"; });
      (env("PATH") || "").split(";").forEach(function (d) {
        d = d.replace(/^"|"$/g, "").trim();
        if (!d) return;
        exts.forEach(function (e) { list.push(path.join(d, "hermes" + e)); });
      });
      return list;
    }
    return [
      path.join(HOME, ".local", "bin", "hermes"),
      path.join(HOME, ".hermes", "hermes-agent", ".hermes", "bin", "hermes"),
      path.join(HOME, ".hermes", "hermes-agent", "venv", "bin", "hermes"),
      "/opt/homebrew/bin/hermes",
      "/usr/local/bin/hermes"
    ];
  }

  function isRunnable(p) {
    if (WIN) {
      // App execution aliases are 0-byte reparse points: stat can fail, lstat works.
      try { return fs.statSync(p).isFile(); } catch (e) {}
      try { return fs.lstatSync(p).isSymbolicLink() || fs.lstatSync(p).isFile(); } catch (e) { return false; }
    }
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch (e) { return false; }
  }

  function findHermes() {
    var list = candidates();
    for (var i = 0; i < list.length; i++) if (isRunnable(list[i])) return list[i];
    return null;
  }

  // ---------------------------------------------------------
  // WHICH PROFILE THE PANEL AGENT RUNS IN
  //  FULL (default): the user's own Hermes profile - every MCP server,
  //    connector, skill, memory and provider key they already have. The
  //    After Effects tools reach it through bin/hb-mcp-proxy.js, registered in
  //    that profile as mcp_servers.after_effects (so Hermes Desktop, CLI and
  //    Telegram on the same profile can drive After Effects too).
  //  CEPAT: the lean `aebridge` profile (vision + panel MCP only): ~5x
  //    smaller context, nothing else reachable.
  // Choice is kept in <BASE>/bridge.json; default = Hermes' sticky
  // active profile (`hermes profile use`), else `default`.
  // ---------------------------------------------------------
  var LEAN = PROFILE;
  var BRIDGE_MCP = "after_effects";
  var APP_ARG = "ae";
  var current = null;

  function prefsFile() { return path.join(BASE, "bridge.json"); }
  function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")) || {}; } catch (e) { return {}; } }
  function writePrefs(p) {
    try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2) + "\n"); } catch (e) {}
  }
  function dirOf(name) { return name === "default" ? HERMES_ROOT : path.join(HERMES_ROOT, "profiles", name); }
  function profileExists(name) { return fs.existsSync(path.join(dirOf(name), "config.yaml")); }
  function stickyProfile() {
    try { return fs.readFileSync(path.join(HERMES_ROOT, "active_profile"), "utf8").replace(/^\ufeff/, "").trim() || "default"; }
    catch (e) { return "default"; }
  }
  function isLeanName(n) { return n === "aebridge" || n === "pprbridge"; }
  function listProfiles() {
    var out = profileExists("default") ? ["default"] : [];
    try {
      fs.readdirSync(path.join(HERMES_ROOT, "profiles")).sort().forEach(function (d) {
        if (d !== "default" && profileExists(d) && (!isLeanName(d) || d === LEAN)) out.push(d);
      });
    } catch (e) {}
    if (out.indexOf(LEAN) < 0) out.push(LEAN);   // created on first use
    return out;
  }
  function getProfile() {
    if (current) return current;
    var p = readPrefs().profile;
    if (!p || (!isLeanName(p) && !profileExists(p))) p = stickyProfile();
    if (!isLeanName(p) && !profileExists(p)) p = profileExists("default") ? "default" : LEAN;
    current = p;
    return p;
  }
  function setProfile(name) {
    current = name;
    var p = readPrefs(); p.profile = name; writePrefs(p);
  }
  function isLean() { return isLeanName(getProfile()); }

  function profileDir() { return dirOf(getProfile()); }

  // ---------------------------------------------------------
  // spawning the CLI
  // ---------------------------------------------------------
  // cmd.exe quoting for one argument (only used for .cmd/.bat launchers).
  function cmdQuote(a) {
    a = String(a);
    if (a !== "" && !/[\s"&|<>^%(),;=!]/.test(a)) return a;
    return '"' + a.replace(/"/g, '""') + '"';
  }

  // Returns [file, args, extraSpawnOptions]. Node refuses to spawn .cmd/.bat
  // directly (EINVAL since the 2024 BatBadBut fix), so route them via cmd.exe.
  function commandFor(bin, args) {
    if (WIN && /\.(cmd|bat)$/i.test(bin)) {
      var line = [bin].concat(args).map(cmdQuote).join(" ");
      return [env("ComSpec") || "cmd.exe", ["/d", "/s", "/c", '"' + line + '"'], { windowsVerbatimArguments: true }];
    }
    return [bin, args, {}];
  }

  function spawnHermes(bin, args, opts) {
    var c = commandFor(bin, args);
    var o = Object.assign({ windowsHide: true }, opts || {}, c[2]);
    return cp.spawn(c[0], c[1], o);
  }

  // Kill the whole process tree: on Windows the launcher (cmd.exe or a
  // distlib .exe) is only the parent of the real python process.
  function killTree(child) {
    if (!child) return;
    if (WIN && child.pid) {
      try { cp.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); return; }
      catch (e) {}
    }
    try { child.kill("SIGTERM"); } catch (e) {}
  }

  // Environment for `hermes acp`. POSIX: minimal and explicit. Windows:
  // inherit (Python needs SystemRoot, TEMP, USERPROFILE, APPDATA, ...).
  function agentEnv(extraDirs) {
    var sep = WIN ? ";" : ":";
    var e;
    if (WIN) {
      e = {};
      for (var k in ENV) {
        var up = k.toUpperCase();
        if (up === "HERMES_HOME" || up === "PATH" || up === "PYTHONPATH" || up === "PYTHONHOME" || up === "VIRTUAL_ENV") continue;
        e[k] = ENV[k];
      }
      e.Path = extraDirs.concat([env("PATH")]).filter(Boolean).join(sep);
      e.PYTHONUTF8 = "1";
      e.PYTHONIOENCODING = "utf-8";
    } else {
      e = {
        PATH: extraDirs.concat(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]).join(sep),
        HOME: HOME,
        USER: env("USER") || os.userInfo().username,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8"
      };
    }
    e.TERM = "dumb";
    e.HERMES_HOME = profileDir();
    return e;
  }

  // Dirs to put in front of PATH for the agent (bundled node/ffmpeg/rg + the CLI's own dir).
  function toolDirs(bin) {
    var parts = [];
    if (bin) parts.push(path.dirname(bin));
    if (!WIN) parts.push(path.join(HOME, ".local", "bin"), path.join(HERMES_ROOT, "hermes-agent", ".hermes", "bin"));
    try {
      var tdir = path.join(HERMES_ROOT, "tools");
      fs.readdirSync(tdir).forEach(function (d) {
        if (d.indexOf("node-") === 0) parts.unshift(WIN ? path.join(tdir, d) : path.join(tdir, d, "bin"));
        else if (d.indexOf("ffmpeg-") === 0 || d.indexOf("ripgrep-") === 0) parts.unshift(path.join(tdir, d));
      });
    } catch (e) { /* optional */ }
    return parts;
  }

  // Run a hermes CLI command; resolves {code, out}. Never throws.
  function run(bin, args, timeoutMs) {
    return new Promise(function (resolve) {
      var out = "", done = false;
      var e = Object.assign({}, ENV, { TERM: "dumb", NO_COLOR: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
      Object.keys(e).forEach(function (k) { if (k.toUpperCase() === "HERMES_HOME") delete e[k]; });
      if (!WIN) e.HOME = HOME;
      var c;
      try { c = spawnHermes(bin, args, { env: e, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (err) { return resolve({ code: -1, out: String(err.message || err) }); }
      var t = setTimeout(function () { if (!done) { done = true; killTree(c); resolve({ code: -2, out: out + "\n(timeout)" }); } }, timeoutMs || 60000);
      c.stdout.on("data", function (d) { out += d; });
      c.stderr.on("data", function (d) { out += d; });
      c.on("error", function (err) { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out: String(err.message || err) }); } });
      c.on("exit", function (code) { if (!done) { done = true; clearTimeout(t); resolve({ code: code, out: out }); } });
    });
  }

  function lastLine(s) { return String(s || "").trim().split(/\r?\n/).filter(Boolean).pop() || ""; }
  function readCfg() { try { return fs.readFileSync(path.join(profileDir(), "config.yaml"), "utf8").replace(/\r\n/g, "\n"); } catch (e) { return ""; } }

  // Creates the profile if missing (never clones another profile's keys),
  // then pins the settings the panel depends on. Skips CLI calls when the
  // config already has them, so a normal boot costs no extra time.
  // Windows + Hermes Desktop (MSIX): the packaged CLI's writes to %LOCALAPPDATA%
  // can be virtualised, so the panel may not see config.yaml on disk. Then
  // every check goes through the CLI instead of the file.
  var cliOnly = false;

  function ensureProfile(bin) {
    var PROFILE = LEAN;   // only the lean profile is created/pinned by the panel
    var chain = Promise.resolve();
    if (!fs.existsSync(path.join(profileDir(), "config.yaml"))) {
      chain = run(bin, ["profile", "create", PROFILE, "--no-alias", "--no-skills",
        "--description", "Hermes Bridge panel inside After Effects (ACP)"], 180000).then(function (r) {
        if (fs.existsSync(path.join(profileDir(), "config.yaml"))) return;
        if (r.code === 0 || /already exists/i.test(r.out)) { cliOnly = true; return; }
        throw new Error("gagal membuat profil " + PROFILE + ": " + lastLine(r.out));
      });
    }
    return chain.then(function () {
      if (cliOnly) {
        // can't read the file: just (re)apply the settings, both are idempotent
        return run(bin, ["-p", PROFILE, "config", "set", "platform_toolsets.acp", "[vision,no_mcp]"], 60000).then(function () {
          return run(bin, ["-p", PROFILE, "config", "set", "tools.tool_search.enabled", "off"], 60000);
        });
      }
      var cfg = readCfg();
      var steps = [];
      // YAML flow list without quotes/spaces: survives cmd.exe quoting unchanged.
      if (!/no_mcp/.test(cfg)) steps.push(["config", "set", "platform_toolsets.acp", "[vision,no_mcp]"]);
      if (!/tool_search:\s*\n\s*enabled:\s*"?off"?/.test(cfg)) steps.push(["config", "set", "tools.tool_search.enabled", "off"]);
      return steps.reduce(function (p, a) {
        return p.then(function () { return run(bin, ["-p", PROFILE].concat(a), 60000); });
      }, Promise.resolve());
    });
  }

  function modelConfigured(bin) {
    var PROFILE = getProfile();
    if (cliOnly) {
      return run(bin, ["-p", PROFILE, "config", "get", "model.default"], 60000).then(function (r) {
        var v = lastLine(r.out);
        return r.code === 0 && v && !/not set|error|unknown/i.test(v) ? v : null;
      });
    }
    var m = readCfg().match(/^model:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+default:[ \t]*(\S.*)$/m);
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

  // ---------------------------------------------------------
  // interactive steps in a visible terminal window
  // ---------------------------------------------------------
  function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

  // macOS: .command opened by Finder into Terminal. Windows: .ps1 in a new
  // PowerShell console via `start`. No osascript, no AE scripting.
  // `step` = { title, info: [lines], sh: "<bash line>", ps: "<powershell line>" }
  function openInTerminal(name, step) {
    fs.mkdirSync(BASE, { recursive: true });
    var done = "Selesai. Balik ke After Effects dan klik CEK LAGI di panel Hermes Bridge.";
    if (WIN) {
      var p = path.join(BASE, name + ".ps1");
      var body = [
        "$ErrorActionPreference = 'Continue'",
        "$Host.UI.RawUI.WindowTitle = " + psQuote("Hermes Bridge - " + step.title),
        "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072",
        "Write-Host ''",
        "Write-Host " + psQuote("  HERMES BRIDGE - " + step.title)
      ].concat(step.info.map(function (l) { return "Write-Host " + psQuote("  " + l); }))
       .concat(["Write-Host ''", step.ps, "Write-Host ''", "Write-Host " + psQuote("  " + done),
         "Read-Host '  Tekan Enter untuk menutup' | Out-Null"]).join("\r\n") + "\r\n";
      // BOM so Windows PowerShell 5.1 reads the file as UTF-8.
      fs.writeFileSync(p, "\ufeff" + body, "utf8");
      cp.spawn(env("ComSpec") || "cmd.exe", ["/d", "/c", "start", '"Hermes Bridge"', "powershell.exe",
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", '"' + p + '"'],
        { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
      return p;
    }
    var q = function (s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; };
    var f = path.join(BASE, name + ".command");
    fs.writeFileSync(f, ["#!/bin/bash", "set -u", "clear", "echo ''", "echo " + q("  HERMES BRIDGE - " + step.title)]
      .concat(step.info.map(function (l) { return "echo " + q("  " + l); }))
      .concat(["echo ''", step.sh, "echo ''", "echo " + q("  " + done), "read -r -p '  Tekan Return untuk menutup...' _"])
      .join("\n") + "\n");
    fs.chmodSync(f, 493); // 0755
    cp.spawn("open", [f], { detached: true, stdio: "ignore" }).unref();
    return f;
  }

  function openInstall() {
    return openInTerminal("install-hermes", {
      title: "install Hermes Agent",
      info: ["Sumber resmi: https://hermes-agent.nousresearch.com"],
      sh: INSTALL_CMD,
      ps: INSTALL_CMD
    });
  }

  function openLogin(bin) {
    var PROFILE = getProfile();
    return openInTerminal("login-model", {
      title: "pilih provider & model",
      info: ["Pilih provider (Nous Portal login, Anthropic, OpenAI, OpenRouter, dll)",
             "lalu masukkan akun/API key kamu sendiri. Disimpan di profil " + PROFILE + "."],
      sh: "'" + String(bin).replace(/'/g, "'\\''") + "' -p " + PROFILE + " model",
      ps: "& " + psQuote(bin) + " -p " + PROFILE + " model"
    });
  }

  // Node for the stdio proxy: Hermes' bundled node first, then system installs.
  function findNode() {
    var c = [];
    try {
      fs.readdirSync(path.join(HERMES_ROOT, "tools")).sort().reverse().forEach(function (d) {
        if (d.indexOf("node-") === 0) c.push(WIN ? path.join(HERMES_ROOT, "tools", d, "node.exe") : path.join(HERMES_ROOT, "tools", d, "bin", "node"));
      });
    } catch (e) {}
    if (!WIN) c.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
    (env("PATH") || "").split(WIN ? ";" : ":").forEach(function (d) {
      d = d.replace(/^"|"$/g, "").trim();
      if (d) c.push(path.join(d, WIN ? "node.exe" : "node"));
    });
    for (var i = 0; i < c.length; i++) if (isRunnable(c[i])) return c[i];
    return null;
  }

  // Register (or repair) mcp_servers.<BRIDGE_MCP> in the FULL-mode profile so
  // every Hermes session on it gets the After Effects tools. Idempotent: no CLI
  // call when the entry already points at this extension's proxy.
  // Resolves {ok, changed, why}.
  function ensureBridgeMcp(bin, extDir) {
    var node = findNode();
    var proxy = path.join(extDir, "bin", "hb-mcp-proxy.js");
    if (!node) return Promise.resolve({ ok: false, why: "node tidak ditemukan" });
    if (!fs.existsSync(proxy)) return Promise.resolve({ ok: false, why: "bin/hb-mcp-proxy.js tidak ada di extension" });
    var cfg = readCfg();
    var m = cfg.match(new RegExp("^[ \\t]+" + BRIDGE_MCP + ":[ \\t]*\\n((?:[ \\t]{4,}.*(?:\\n|$))*)", "m"));
    var block = m ? m[1] : "";
    if (!cliOnly && block && block.indexOf(proxy) >= 0 && block.indexOf(node) >= 0 && !/enabled:\s*false/.test(block)) {
      return Promise.resolve({ ok: true, changed: false });
    }
    var key = "mcp_servers." + BRIDGE_MCP, P = getProfile();
    // YAML flow list without quotes: survives cmd.exe quoting (spaces in the path are fine).
    var steps = [[key + ".command", node], [key + ".args", "[" + proxy + ", " + APP_ARG + "]"], [key + ".enabled", "true"]];
    return steps.reduce(function (p, s) {
      return p.then(function () { return run(bin, ["-p", P, "config", "set", s[0], s[1]], 60000); });
    }, Promise.resolve()).then(function () {
      var again = readCfg();
      var good = cliOnly || again.indexOf(proxy) >= 0;
      return { ok: good, changed: true, why: good ? "" : "config set tidak tersimpan" };
    });
  }

  // Full check. Resolves {ok, step, bin, model, message}.
  // step: "platform" | "install" | "profile" | "login" | "ready"
  function check(extDir) {
    if (PLAT !== "darwin" && !WIN) {
      return Promise.resolve({ ok: false, step: "platform", message: "Hermes Bridge cuma untuk macOS dan Windows." });
    }
    var bin = findHermes();
    if (!bin) return Promise.resolve({ ok: false, step: "install", message: "Hermes Agent belum terpasang di " + (WIN ? "PC" : "Mac") + " ini." });
    syncRules(extDir);
    var P = getProfile(), bridge = null;
    var prep = isLean() ? ensureProfile(bin) : (profileExists(P)
      ? ensureBridgeMcp(bin, extDir).then(function (r) { bridge = r; })
      : Promise.reject(new Error("profil Hermes '" + P + "' tidak ada - pilih profil lain di SESSION")));
    return prep.then(function () {
      return modelConfigured(bin);
    }).then(function (model) {
      if (!model) return { ok: false, step: "login", bin: bin, message: "Belum ada model di profil " + P + ". Login ke provider pakai akun atau API key kamu sendiri." };
      return { ok: true, step: "ready", bin: bin, model: model, profile: P, lean: isLean(), bridge: bridge };
    }, function (e) {
      return { ok: false, step: "profile", bin: bin, message: String(e.message || e) };
    });
  }

  // file:// URL for <img src> (C:\a b\x.png -> file:///C:/a%20b/x.png)
  function fileUrl(p) {
    var s = String(p);
    if (WIN) s = "/" + s.replace(/\\/g, "/");
    return "file://" + encodeURI(s).replace(/#/g, "%23").replace(/\?/g, "%3F");
  }

  // file:// URL (or plain path) -> local path
  function urlToPath(u) {
    var s = String(u);
    if (!/^file:/i.test(s)) return s;
    s = decodeURIComponent(s.replace(/^file:\/\/(localhost)?/i, ""));
    if (WIN) s = s.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\");
    return s;
  }

  global.HBSetup = {
    PLATFORM: PLAT,
    IS_WIN: WIN,
    MOD: WIN ? "Ctrl" : "Cmd",
    PROFILE: PROFILE,          // lean profile name (kept for older callers)
    LEAN_PROFILE: LEAN,
    BRIDGE_MCP: BRIDGE_MCP,
    getProfile: getProfile,
    setProfile: setProfile,
    listProfiles: listProfiles,
    isLean: isLean,
    findNode: findNode,
    ensureBridgeMcp: ensureBridgeMcp,
    HOME: HOME,
    HERMES_ROOT: HERMES_ROOT,
    BASE: BASE,
    WORK_CWD: path.join(BASE, "workspace"),
    INSTALL_CMD: INSTALL_CMD,
    candidates: candidates,
    findHermes: findHermes,
    profileDir: profileDir,
    commandFor: commandFor,
    spawnHermes: spawnHermes,
    killTree: killTree,
    agentEnv: agentEnv,
    toolDirs: toolDirs,
    check: check,
    syncRules: syncRules,
    openInstall: openInstall,
    openLogin: openLogin,
    fileUrl: fileUrl,
    urlToPath: urlToPath
  };
})(typeof window !== "undefined" ? window : global);
