/* =========================================================
   HERMES BRIDGE - ENVATO ACCOUNT SESSION (native download)
   Shared by both panels and the stdio proxy (byte-identical).

   Envato Elements has no public download API, so the bridge does what
   the website's DOWNLOAD button does, from inside a logged-in browser:
     POST /elements-api/items/<id>/download_and_license.json
          {licenseType: "project", projectName}  (+ CSRF headers)
   -> signed downloadUrl -> node streams the file to disk.
   The licence is registered on the user's account per project, exactly
   like a manual click.

   The browser is a dedicated Chrome for Testing (or any installed
   Chromium) with its own profile in FeugeeEnvato/profile, shared by the
   After Effects and Premiere panels: the user logs in ONCE in a visible
   window (2FA / captcha handled by them), later calls run headless.
   Envato cookies are also kept in FeugeeEnvato/session.json (0600) so a
   restart does not drop the session. When the app session drops, the
   bridge re-logs in headless: silent SSO first, else the password from
   the macOS Keychain (service "FeugeeEnvato"). The password is never
   written to disk by the bridge; only the Keychain holds it.
   ========================================================= */
(function (global) {
  "use strict";

  var fs = require("fs");
  var os = require("os");
  var cp = require("child_process");
  var http = require("http");
  var https = require("https");
  var WIN = process.platform === "win32";
  var path = WIN ? require("path").win32 : require("path").posix;
  var WS = (typeof WebSocket !== "undefined") ? WebSocket : (global.WebSocket || null);

  var ROOT = WIN
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "FeugeeEnvato")
    : path.join(os.homedir(), "Library", "Application Support", "FeugeeEnvato");
  var PROFILE = path.join(ROOT, "profile");
  var COOKIES = path.join(ROOT, "session.json");
  var ORIGIN = "https://elements.envato.com";
  var APP = "https://app.envato.com";
  var SIGN_IN = ORIGIN + "/sign-in";
  var IDLE_CLOSE_MS = 120000;

  // Fair use: one licence call per 8 s, 40 per hour. Downloads are always
  // single items triggered by the user's own request.
  var RATE = { gapMs: 8000, perHour: 40 };
  var licenceLog = [];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function mkdirp(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }
  function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }

  // ---------------------------------------------------------
  // BROWSER DISCOVERY
  // ---------------------------------------------------------
  function findChrome() {
    var c = [];
    try {
      var base = path.join(ROOT, "chrome", "chrome");
      fs.readdirSync(base).sort().reverse().forEach(function (v) {
        if (WIN) c.push(path.join(base, v, "chrome-win64", "chrome.exe"));
        else ["chrome-mac-arm64", "chrome-mac-x64"].forEach(function (d) {
          c.push(path.join(base, v, d, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
        });
      });
    } catch (e) {}
    if (WIN) {
      var pf = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA];
      pf.forEach(function (b) {
        if (!b) return;
        c.push(path.join(b, "Google", "Chrome", "Application", "chrome.exe"));
        c.push(path.join(b, "Microsoft", "Edge", "Application", "msedge.exe"));
        c.push(path.join(b, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
      });
    } else {
      c.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
    }
    for (var i = 0; i < c.length; i++) if (exists(c[i])) return c[i];
    return null;
  }

  function installHint() {
    return "Browser untuk Envato belum ada. Jalankan sekali di Terminal: npx -y @puppeteer/browsers install chrome@stable --path \"" + path.join(ROOT, "chrome") + "\"";
  }

  // ---------------------------------------------------------
  // MINIMAL CDP CLIENT (flat sessions over one browser socket)
  // ---------------------------------------------------------
  function getJson(port, p) {
    return new Promise(function (resolve, reject) {
      var req = http.get({ host: "127.0.0.1", port: port, path: p, timeout: 3000 }, function (res) {
        var b = ""; res.on("data", function (d) { b += d; });
        res.on("end", function () { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
      });
      req.on("timeout", function () { req.destroy(new Error("timeout")); });
      req.on("error", reject);
    });
  }

  function Cdp(wsUrl) {
    var self = this;
    self.id = 0; self.pending = {}; self.events = [];
    return new Promise(function (resolve, reject) {
      if (!WS) return reject(new Error("WebSocket tidak tersedia di runtime ini"));
      var ws = new WS(wsUrl);
      self.ws = ws;
      ws.onopen = function () { resolve(self); };
      ws.onerror = function (e) { reject(new Error("CDP websocket error")); };
      ws.onclose = function () {
        self.closed = true;
        Object.keys(self.pending).forEach(function (k) { self.pending[k].reject(new Error("browser tertutup")); });
        self.pending = {};
      };
      ws.onmessage = function (m) {
        var d; try { d = JSON.parse(typeof m.data === "string" ? m.data : String(m.data)); } catch (e) { return; }
        if (d.id && self.pending[d.id]) {
          var p = self.pending[d.id]; delete self.pending[d.id];
          if (d.error) p.reject(new Error(d.error.message || JSON.stringify(d.error))); else p.resolve(d.result || {});
        }
      };
    });
  }
  Cdp.prototype.send = function (method, params, sessionId, timeoutMs) {
    var self = this, id = ++self.id;
    return new Promise(function (resolve, reject) {
      if (self.closed) return reject(new Error("browser tertutup"));
      self.pending[id] = { resolve: resolve, reject: reject };
      var msg = { id: id, method: method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      self.ws.send(JSON.stringify(msg));
      setTimeout(function () {
        if (self.pending[id]) { delete self.pending[id]; reject(new Error(method + " timeout")); }
      }, timeoutMs || 30000);
    });
  };
  Cdp.prototype.close = function () { try { this.ws.close(); } catch (e) {} };

  // Evaluate an async function body in a page and return its JSON value.
  function evalIn(cdp, sid, fnSrc, arg, timeoutMs) {
    var expr = "(" + fnSrc + ")(" + JSON.stringify(arg === undefined ? null : arg) + ")";
    return cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sid, timeoutMs || 45000)
      .then(function (r) {
        if (r.exceptionDetails) throw new Error("page error: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
        return r.result ? r.result.value : null;
      });
  }

  // ---------------------------------------------------------
  // BROWSER LIFECYCLE
  // ---------------------------------------------------------
  var live = null;      // { cdp, port, visible, child, idle }

  function activePort() {
    try {
      var t = fs.readFileSync(path.join(PROFILE, "DevToolsActivePort"), "utf8").split(/\r?\n/);
      var port = parseInt(t[0], 10);
      return port > 0 ? port : 0;
    } catch (e) { return 0; }
  }

  function attach(port) {
    return getJson(port, "/json/version").then(function (v) {
      return new Cdp(v.webSocketDebuggerUrl).then(function (cdp) {
        return { cdp: cdp, port: port, ua: String(v["User-Agent"] || ""), visible: !/Headless/i.test(String(v["User-Agent"] || "") + String(v.Browser || "")) };
      });
    });
  }

  function chromeVersion(bin) {
    var m = String(bin).match(/(\d+)\.\d+\.\d+\.\d+/);
    return m ? m[1] : "157";
  }

  function launch(visible, url) {
    var bin = findChrome();
    if (!bin) return Promise.reject(new Error(installHint()));
    mkdirp(PROFILE);
    try { fs.unlinkSync(path.join(PROFILE, "DevToolsActivePort")); } catch (e) {}
    var args = [
      "--user-data-dir=" + PROFILE, "--remote-debugging-port=0", "--remote-allow-origins=*",
      "--no-first-run", "--no-default-browser-check", "--disable-sync", "--password-store=basic", "--use-mock-keychain",
      "--disable-features=Translate,MediaRouter,OptimizationHints", "--disable-background-networking"
    ];
    if (visible) args.push("--window-size=1180,860", "--app-name=Envato x Hermes Bridge");
    else {
      // Cloudflare treats a "HeadlessChrome" UA as a bot: present a normal one.
      var plat = WIN ? "Windows NT 10.0; Win64; x64" : "Macintosh; Intel Mac OS X 10_15_7";
      args.push("--headless=new", "--window-size=1280,900",
        "--user-agent=Mozilla/5.0 (" + plat + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeVersion(bin) + ".0.0.0 Safari/537.36");
    }
    args.push(url || "about:blank");
    var child = cp.spawn(bin, args, { detached: !WIN, stdio: "ignore", windowsHide: !visible });
    try { child.unref(); } catch (e) {}
    var t0 = Date.now();
    function wait() {
      var port = activePort();
      if (port) return attach(port).catch(function () { return sleep(250).then(wait); });
      if (Date.now() - t0 > 20000) return Promise.reject(new Error("browser Envato tidak menyala dalam 20 dtk"));
      return sleep(200).then(wait);
    }
    return wait().then(function (b) { b.child = child; b.visible = !!visible; return b; });
  }

  function touch() {
    if (!live) return;
    if (live.idle) clearTimeout(live.idle);
    if (live.visible) return;     // the user's login window is closed by them / by login()
    live.idle = setTimeout(function () { shutdown(); }, IDLE_CLOSE_MS);
  }

  function shutdown() {
    var b = live; live = null;
    if (!b) return Promise.resolve();
    if (b.idle) clearTimeout(b.idle);
    return b.cdp.send("Browser.close", {}, null, 5000).catch(function () {}).then(function () { b.cdp.close(); });
  }

  // Reuse whatever browser owns the profile (a visible login window or a
  // headless worker), else start a headless one.
  function browser(opts) {
    opts = opts || {};
    var p = (live && !live.cdp.closed) ? Promise.resolve(live) : Promise.resolve(null);
    return p.then(function (b) {
      if (b) return b;
      if (!activePort() && profileInUse()) throw new Error("Jendela login Envato masih terbuka: user selesaikan login lalu tutup jendelanya (Cmd+Q), baru ulangi.");
      var port = activePort();
      return (port ? attach(port).catch(function () { return null; }) : Promise.resolve(null)).then(function (x) {
        return x || launch(false).then(function (nb) { return restoreCookies(nb).then(function () { return nb; }); });
      });
    }).then(function (b) {
      live = b;
      touch();
      return b;
    });
  }

  // A page target on the Elements origin (cookies + CSRF live there).
  function page(b, url) {
    return b.cdp.send("Target.createTarget", { url: url || ORIGIN + "/account", background: true }).then(function (t) {
      return b.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }).then(function (a) {
        var pg = { b: b, targetId: t.targetId, sid: a.sessionId };
        return b.cdp.send("Runtime.enable", {}, a.sessionId).then(function () { return waitReady(pg); }).then(function () { return pg; });
      });
    });
  }
  function closePage(pg) { return pg.b.cdp.send("Target.closeTarget", { targetId: pg.targetId }).catch(function () {}); }

  function waitReady(pg, ms) {
    var t0 = Date.now();
    function poll() {
      return evalIn(pg.b.cdp, pg.sid, "function(){return {s: document.readyState, u: location.href}}", null, 5000).catch(function () { return null; })
        .then(function (r) {
          if (r && r.s === "complete" && /^https:\/\/[a-z]+\.envato\.com/.test(r.u)) return r;
          if (Date.now() - t0 > (ms || 30000)) return r || { s: "timeout", u: "" };
          return sleep(400).then(poll);
        });
    }
    return poll();
  }

  // ---------------------------------------------------------
  // COOKIE PERSISTENCE
  // ---------------------------------------------------------
  function saveCookies(b) {
    return b.cdp.send("Storage.getCookies", {}).then(function (r) {
      var keep = (r.cookies || []).filter(function (c) { return /envato\.com$/i.test(String(c.domain).replace(/^\./, "")); });
      if (!keep.length) return 0;
      mkdirp(ROOT);
      fs.writeFileSync(COOKIES, JSON.stringify({ savedAt: new Date().toISOString(), cookies: keep }), { mode: 384 });
      try { fs.chmodSync(COOKIES, 384); } catch (e) {}
      return keep.length;
    }).catch(function () { return 0; });
  }

  function restoreCookies(b) {
    var data = null;
    try { data = JSON.parse(fs.readFileSync(COOKIES, "utf8")); } catch (e) { return Promise.resolve(0); }
    var now = Date.now() / 1000;
    var list = (data.cookies || []).filter(function (c) { return !(c.expires > 0 && c.expires < now); }).map(function (c) {
      var o = { name: c.name, value: c.value, domain: c.domain, path: c.path || "/", secure: !!c.secure, httpOnly: !!c.httpOnly };
      if (c.sameSite) o.sameSite = c.sameSite;
      if (c.expires > 0) o.expires = c.expires;
      return o;
    });
    if (!list.length) return Promise.resolve(0);
    return b.cdp.send("Storage.setCookies", { cookies: list }).then(function () { return list.length; }).catch(function () { return 0; });
  }

  // ---------------------------------------------------------
  // IN-PAGE HELPERS (serialized into the Elements page)
  // ---------------------------------------------------------
  // The app's root loader says who is signed in: user.displayName,
  // isGuest, subscription.status (same data the app renders from).
  var PAGE_STATUS = function () {
    // "/.data" = the home route loader in turbo-stream form; values are
    // often index references, so read the strings that only a member gets.
    return fetch("/.data", { credentials: "include" }).then(function (r) { return r.text(); }).then(function (t) {
      var name = (t.match(/"displayName","((?:[^"\\]|\\.)*)"/) || [])[1] || null;
      var plan = (t.match(/"customerPlanName","([^"]+)"/) || [])[1] || null;
      if (plan && /^[a-z]+[A-Z][A-Za-z]*$/.test(plan)) plan = null;   // turbo-stream: next key, not a value
      var subscribed = /"analyticsUserClass","subscribed"/.test(t) || /"subscribed"/.test(t);
      var guest = /"analyticsUserClass","guest"/.test(t);
      var signed = !guest && (!!name || /"observabilityUserClass","signed_in"/.test(t));
      return { signedIn: signed, user: name, plan: plan, subscription: signed ? (subscribed ? "active" : "none") : null, url: location.href };
    }).catch(function (e) { return { signedIn: false, error: String(e), url: location.href }; });
  };


  function findDownloadUrl(o, depth) {
    if (!o || depth > 6) return null;
    if (typeof o === "string") return /^https:\/\//.test(o) && /download|amazonaws|envatousercontent|cloudfront/i.test(o) ? o : null;
    if (typeof o !== "object") return null;
    if (typeof o.downloadUrl === "string") return o.downloadUrl;
    if (typeof o.download_url === "string") return o.download_url;
    for (var k in o) { var r = findDownloadUrl(o[k], (depth || 0) + 1); if (r) return r; }
    return null;
  }

  function errorText(body, fallback) {
    if (!body) return fallback;
    var e = body.errors || body.error || body.message;
    if (typeof e === "string") return e;
    if (e && e.base) return String(e.base[0] || fallback);
    if (Array.isArray(e)) return String(e[0] && (e[0].detail || e[0].title || e[0]) || fallback);
    try { return JSON.stringify(e || body).slice(0, 300); } catch (x) { return fallback; }
  }

  // ---------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------
  function appStatus(b) {
    return page(b, APP + "/").then(function (pg) {
      return evalIn(b.cdp, pg.sid, PAGE_STATUS.toString(), null, 30000).then(function (s) {
        return closePage(pg).then(function () { return s || { signedIn: false }; });
      }, function (e) { closePage(pg); throw e; });
    });
  }

  // ---------------------------------------------------------
  // AUTO RE-LOGIN (no user window)
  //   1. silent SSO: account.envato.com still has a session -> it bounces
  //      straight back to the app.
  //   2. password from the macOS Keychain (service FeugeeEnvato), typed
  //      into the account sign-in form in the headless browser. The
  //      password lives only in the Keychain and in memory for that call:
  //      never written to disk, logs, results or session.json.
  //   Captcha / 2FA / wrong password -> needLogin (manual window).
  // ---------------------------------------------------------
  var KEYCHAIN_SERVICE = "FeugeeEnvato";
  var SSO_URL = "https://account.envato.com/sign_in?to=envatoapp";
  var PW_GAP_MS = 10 * 60000;          // never hammer the login form
  var lastPwAttempt = 0;

  function keychainCred(service) {
    if (process.platform !== "darwin") return null;
    var svc = service || KEYCHAIN_SERVICE;
    try {
      var meta = cp.execFileSync("/usr/bin/security", ["find-generic-password", "-s", svc], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
      var acct = (meta.match(/"acct"<blob>="([^"]*)"/) || [])[1];
      if (!acct) return null;
      var pw = cp.execFileSync("/usr/bin/security", ["find-generic-password", "-s", svc, "-a", acct, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).replace(/\r?\n$/, "");
      return pw ? { u: acct, p: pw } : null;
    } catch (e) { return null; }
  }

  // Runs inside account.envato.com/sign_in. React/Formik form: set values
  // through the native setter so the app sees them. Every username change
  // fires a debounced (500 ms) SAML check that puts the submit button in a
  // loading state; a click during it is swallowed, so blur, let the check
  // settle, then press the button.
  var PAGE_FILL = function (c) {
    var u = document.getElementById("username") || document.querySelector('input[name="username"]');
    var p = document.getElementById("password") || document.querySelector('input[type="password"]');
    if (!u || !p) return { state: "noform", url: location.href };
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    [[u, c.u], [p, c.p]].forEach(function (x) {
      x[0].focus(); setter.call(x[0], x[1]);
      x[0].dispatchEvent(new Event("input", { bubbles: true }));
      x[0].dispatchEvent(new Event("change", { bubbles: true }));
      x[0].dispatchEvent(new Event("blur", { bubbles: true }));
      x[0].dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    c = null;
    var btn = function () { return document.getElementById("sso-forms__submit") || (u.form && u.form.querySelector('[type="submit"]')); };
    var busy = function (b) { return !b || b.disabled || b.getAttribute("aria-busy") === "true" || b.getAttribute("aria-disabled") === "true" || !!b.querySelector('[role="progressbar"],[class*="pinner"],[class*="oading"]'); };
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function wait() {
        var b = btn(), el = Date.now() - t0;
        if (el > 12000) return resolve({ state: "busy" });
        if (el < 2000 || busy(b)) return setTimeout(wait, 250);
        b.click();
        resolve({ state: "submitted", waitedMs: el });
      })();
    });
  };

  // What the sign-in page shows after a failed submit.
  var PAGE_AFTER = function () {
    var txt = (document.body && document.body.innerText || "").slice(0, 3000);
    var cap = !!document.querySelector('iframe[src*="captcha"],iframe[src*="turnstile"],iframe[src*="challenges"],[class*="captcha"],[id*="captcha"],[name="recaptchaResponse"],[name="g-recaptcha-response"]');
    var otp = !!document.querySelector('input[name="authenticationCode"],input[autocomplete="one-time-code"],input[name*="otp"]') || /verification code|two-factor|2-step|authenticator/i.test(txt);
    var err = [].map.call(document.querySelectorAll('[data-testid="errorMessage"]'), function (e) { return e.innerText; }).join(" ") ||
      (document.querySelector('[role="alert"],.error,[class*="error"]') || {}).innerText || "";
    return { url: location.href, captcha: cap, otp: otp, error: String(err).trim().slice(0, 200), form: !!document.getElementById("password") };
  };

  function hrefOf(b, pg) {
    return evalIn(b.cdp, pg.sid, "function(){return location.href}", null, 5000).catch(function () { return ""; });
  }
  function waitHost(b, pg, re, ms) {
    var t0 = Date.now();
    function poll() {
      return hrefOf(b, pg).then(function (h) {
        if (re.test(h) || Date.now() - t0 > ms) return h;
        return sleep(700).then(poll);
      });
    }
    return poll();
  }

  // -> {ok:true, via:"sso"|"password"} | {ok:false, reason, error}
  function reauth(b, opts) {
    opts = opts || {};
    var APP_RE = /^https:\/\/app\.envato\.com\//;
    return page(b, SSO_URL).then(function (pg) {
      var fin = function (r) { return closePage(pg).then(function () { return r; }); };
      return waitHost(b, pg, APP_RE, 6000).then(function (h) {
        if (APP_RE.test(h)) return fin({ ok: true, via: "sso" });
        if (opts.password === false) return fin({ ok: false, reason: "sso-expired" });
        var cred = (opts.cred !== undefined) ? opts.cred : keychainCred();
        if (!cred) return fin({ ok: false, reason: "no-credentials", error: "Sesi Envato habis dan belum ada kredensial di Keychain (service \"" + KEYCHAIN_SERVICE + "\")." });
        if (Date.now() - lastPwAttempt < PW_GAP_MS) return fin({ ok: false, reason: "throttled", error: "Login otomatis Envato baru saja dicoba dan gagal; ditahan 10 menit supaya akun tidak terkunci." });
        lastPwAttempt = Date.now();
        return evalIn(b.cdp, pg.sid, PAGE_FILL.toString(), cred, 20000).then(function (f) {
          cred = null;
          if (f && f.state === "busy") { lastPwAttempt = 0; return fin({ ok: false, reason: "busy", error: "Tombol login Envato tidak siap dalam 12 dtk (cek SAML macet). Coba lagi." }); }
          if (!f || f.state !== "submitted") return fin({ ok: false, reason: "form-changed", error: "Form login Envato berubah (" + (f && f.state) + "); perlu update bridge." });
          return waitHost(b, pg, APP_RE, 25000).then(function (h2) {
            if (APP_RE.test(h2)) { lastPwAttempt = 0; return fin({ ok: true, via: "password" }); }
            return evalIn(b.cdp, pg.sid, PAGE_AFTER.toString(), null, 8000).catch(function () { return {}; }).then(function (a) {
              a = a || {};
              var reason = a.captcha ? "captcha" : a.otp ? "2fa" : (a.error ? "rejected" : "unknown");
              return fin({ ok: false, reason: reason, error: "Login otomatis Envato gagal (" + reason + (a.error ? ": " + a.error : "") + "). Login manual sekali lewat envato_account {action: \"login\"}." });
            });
          });
        });
      });
    }).catch(function (e) { return { ok: false, reason: "infra", error: String(e.message || e) }; });
  }

  // Signed in, re-logging in automatically when the app session dropped.
  function ensureSession(b, opts) {
    return appStatus(b).then(function (s) {
      if (s.signedIn) return { s: s };
      return reauth(b, opts).then(function (r) {
        if (!r.ok) return { s: s, reauth: r };
        return appStatus(b).then(function (s2) { return { s: s2, reauth: r }; });
      });
    });
  }

  function status() {
    return browser().then(function (b) {
      return ensureSession(b).then(function (x) {
        var s = x.s;
        if (s.signedIn) saveCookies(b);
        var d = { signedIn: !!s.signedIn, user: s.user, plan: s.plan, subscription: s.subscription, browser: b.visible ? "window" : "headless", profile: PROFILE, autoLogin: !!keychainCred() };
        if (x.reauth) { d.relogin = x.reauth.ok ? x.reauth.via : x.reauth.reason; if (!x.reauth.ok && x.reauth.error) d.reloginError = x.reauth.error; }
        return { ok: true, data: d };
      });
    }).catch(function (e) { return { ok: false, infra: true, error: String(e.message || e) }; });
  }

  // One-time login. Google (and some SSO providers) refuse to sign in a
  // browser that is being remote-controlled, so the login window is a PLAIN
  // Chrome on the same profile (no debugging port). When the user closes it,
  // a headless check confirms the session and saves the cookies.
  function plainWindow(url) {
    var bin = findChrome();
    if (!bin) return null;
    mkdirp(PROFILE);
    keepSessionCookies();
    try { fs.unlinkSync(path.join(PROFILE, "DevToolsActivePort")); } catch (e) {}
    var child = cp.spawn(bin, ["--user-data-dir=" + PROFILE, "--no-first-run", "--no-default-browser-check", "--disable-sync",
      "--password-store=basic", "--use-mock-keychain", "--window-size=1180,860", url], { detached: !WIN, stdio: "ignore" });
    try { child.unref(); } catch (e) {}
    return child;
  }

  // Session cookies (no expiry) survive restarts only with "continue where
  // you left off" on the profile.
  function keepSessionCookies() {
    var f = path.join(PROFILE, "Default", "Preferences"), d = {};
    try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
    d.session = d.session || {};
    if (d.session.restore_on_startup === 1) return;
    d.session.restore_on_startup = 1;
    mkdirp(path.dirname(f));
    try { fs.writeFileSync(f, JSON.stringify(d)); } catch (e) {}
  }

  function profileInUse() {
    // Chrome holds SingletonLock (a symlink "host-pid") while the profile is open.
    try {
      var t = fs.readlinkSync(path.join(PROFILE, "SingletonLock"));
      var pid = parseInt(String(t).split("-").pop(), 10);
      if (pid > 0) { process.kill(pid, 0); return pid; }
    } catch (e) {}
    return 0;
  }

  function login(opts) {
    opts = opts || {};
    var waitMs = Math.min(280, Math.max(10, opts.waitSeconds || 240)) * 1000, t0 = Date.now();
    // Headless first (SSO / Keychain password): no window when it works.
    var tryAuto = profileInUse() ? Promise.resolve(null) : status().then(function (s) {
      return (s.ok && s.data.signedIn) ? { ok: true, data: { signedIn: true, user: s.data.user, via: s.data.relogin || "session", seconds: Math.round((Date.now() - t0) / 1000) } } : null;
    }).catch(function () { return null; });
    return tryAuto.then(function (done) {
      if (done) return done;
      return manualLogin();
    });
    function manualLogin() {
    return shutdown().then(function () {
      var pre = activePort();
      if (pre) return attach(pre).then(function (x) { return x.cdp.send("Browser.close", {}, null, 5000).catch(function () {}).then(function () { x.cdp.close(); return sleep(1000); }); }).catch(function () {});
    }).then(function () {
      if (!profileInUse()) {
        if (!plainWindow(SIGN_IN)) return { ok: false, infra: true, error: installHint() };
      }
      function poll() {
        if (profileInUse()) {
          if (Date.now() - t0 > waitMs) return { ok: false, pending: true, error: "Jendela login Envato masih terbuka. User: login (Continue with Google boleh), lalu TUTUP jendelanya (Cmd+Q), baru panggil envato_login lagi." };
          return sleep(2000).then(poll);
        }
        return sleep(800).then(status).then(function (s) {
          if (s.ok && s.data.signedIn) return { ok: true, data: { signedIn: true, user: s.data.user, seconds: Math.round((Date.now() - t0) / 1000) } };
          if (s.ok) return { ok: false, error: "Jendela ditutup tapi Envato belum login. Panggil envato_login lagi dan selesaikan login sebelum menutup jendela." };
          return s;
        });
      }
      return sleep(1500).then(poll);
    }).catch(function (e) { return { ok: false, infra: true, error: String(e.message || e) }; });
    }
  }

  function logout() {
    return shutdown().then(function () {
      try { fs.unlinkSync(COOKIES); } catch (e) {}
      try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
      return { ok: true, data: { signedOut: true } };
    });
  }

  function rateCheck() {
    var now = Date.now();
    licenceLog = licenceLog.filter(function (t) { return now - t < 3600000; });
    if (licenceLog.length >= RATE.perHour) return "batas " + RATE.perHour + " download Envato per jam tercapai (fair use) - coba lagi nanti";
    var last = licenceLog[licenceLog.length - 1];
    if (last && now - last < RATE.gapMs) return { waitMs: RATE.gapMs - (now - last) };
    return null;
  }


  // Public item page -> uuid, type, title, download formats (4K / 1080p ...).
  // The storefront ships them base64-encoded in INITIAL_HYDRATION_DATA.
  function parseItemPage(html) {
    var m = String(html).match(/window\.INITIAL_HYDRATION_DATA=\s*"?([A-Za-z0-9+\/=]+)/);
    if (!m) return null;
    var t = Buffer.from(m[1], "base64").toString("utf8");
    var it = t.match(/"item":\{"id":"([A-Z0-9]+)","itemUuid":"([0-9a-f-]{36})"/);
    if (!it) return null;
    var out = { id: it[1], itemUuid: it[2] };
    var ty = t.match(/"itemType":"([a-z0-9-]+)"/); if (ty) out.itemType = ty[1];
    var ti = t.match(/"item":\{"id":"[A-Z0-9]+","itemUuid":"[0-9a-f-]{36}","title":"((?:[^"\\]|\\.)*)"/); if (ti) { try { out.title = JSON.parse('"' + ti[1] + '"'); } catch (e) { out.title = ti[1]; } }
    var df = t.indexOf('"downloadFormats":[');
    if (df >= 0) {
      var end = t.indexOf("]", df), arr = null;
      try { arr = JSON.parse(t.slice(df + 18, end + 1)); } catch (e) {}
      if (arr && arr.length) out.formats = arr.map(function (f) { return { assetUuid: f.assetUuid, format: f.format, label: f.label, size: f.fileSize }; });
    }
    var fs1 = t.match(/"fileSizeBytes":(\d+)/); if (fs1) out.bytes = parseInt(fs1[1], 10);
    return out;
  }

  function getText(url) {
    return new Promise(function (resolve) {
      var req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36", "Accept": "text/html", "Accept-Language": "en" } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return getText(new URL(res.headers.location, url).toString()).then(resolve); }
        var b = []; res.on("data", function (c) { b.push(c); }); res.on("end", function () { resolve(res.statusCode === 200 ? Buffer.concat(b).toString("utf8") : null); });
      });
      req.setTimeout(20000, function () { req.destroy(); resolve(null); });
      req.on("error", function () { resolve(null); });
    });
  }

  function resolveItem(itemUrl, b) {
    var u = String(itemUrl || "").replace(/[?#].*$/, "");
    if (!/^https:\/\/elements\.envato\.com\//.test(u)) {
      var id = (u.match(/([A-Z0-9]{5,10})\/?$/) || [])[1];
      if (!id) return Promise.resolve(null);
      u = "https://elements.envato.com/item-" + id;
    }
    return getText(u).then(function (html) {
      var r = html && parseItemPage(html);
      if (r || !b) return r;
      // Cloudflare challenges the CEP node (v17 TLS fingerprint) with 403:
      // read the page through the browser. Open the ITEM page itself -
      // elements.envato.com/account now redirects to app.envato.com, and a
      // fetch from there to elements is cross-origin (CORS "Failed to fetch").
      return page(b, u).then(function (pg) {
        return evalIn(b.cdp, pg.sid, "function(u){var dom=function(){return document.documentElement.outerHTML};" +
          "if(location.hostname!=='elements.envato.com')return dom();" +
          "return fetch(u,{credentials:'include'}).then(function(r){return r.text()}).catch(dom)}", u, 30000)
          .then(function (h) { closePage(pg); return parseItemPage(h); }, function () { closePage(pg); return null; });
      });
    });
  }

  function pickFormat(formats, want) {
    if (!formats || !formats.length) return null;
    var w = String(want || "1080").toLowerCase();
    var is4k = /4k|2160|uhd|max|best|original|source/.test(w);
    var hit = formats.filter(function (f) { var x = (f.format + " " + f.label).toLowerCase(); return is4k ? /4k|2160|uhd/.test(x) : x.indexOf(w.replace(/p$/, "")) >= 0; })[0];
    return hit || (is4k ? formats[0] : formats[formats.length - 1]);
  }

  // Same request the app's Download button makes: route loader
  // /download.data?itemUuid&itemType&projectName[&assetUuid] (turbo-stream).
  var PAGE_APP_DL = function (a) {
    var q = new URLSearchParams({ itemUuid: a.itemUuid, itemType: a.itemType, projectName: a.projectName });
    if (a.assetUuid) q.set("assetUuid", a.assetUuid);
    return fetch("/download.data?" + q.toString(), { credentials: "include" }).then(function (r) {
      return r.text().then(function (t) {
        var url = (t.match(/"(https:\/\/[^"]*envatousercontent\.com[^"]*)"/) || t.match(/"downloadUrl","(https:\/\/[^"]+)"/) || [])[1] || null;
        var guest = /"isGuest",true|"isGuest":true/.test(t);
        var err = null, i = t.indexOf('"error",');
        if (!url && i >= 0) err = (t.slice(i + 8).match(/^"((?:[^"\\]|\\.)*)"/) || [])[1] || null;
        if (!url && !err) { var e2 = t.match(/"(?:message|reason)","((?:[^"\\]|\\.){4,200})"/); if (e2) err = e2[1]; }
        return { status: r.status, url: url, guest: guest, error: err, head: url ? null : t.slice(0, 300) };
      });
    });
  };

  // License item to projectName and get the signed file URL.
  function license(itemUrl, projectName, resolution) {
    var rc = rateCheck();
    if (typeof rc === "string") return Promise.resolve({ ok: false, error: rc });
    var pre = rc && rc.waitMs ? sleep(rc.waitMs) : Promise.resolve();
    var b0 = null, info = null;
    return pre.then(function () { return browser(); }).then(function (b) {
      b0 = b;
      return resolveItem(itemUrl, b);
    }).then(function (it) {
      if (!it) return { ok: false, error: "Item Envato tidak bisa dibaca dari " + itemUrl + " (link salah / item dihapus)." };
      info = it;
      var fmt = pickFormat(it.formats, resolution);
      var dlArg = { itemUuid: it.itemUuid, itemType: it.itemType || "stock-video", projectName: projectName, assetUuid: fmt && fmt.assetUuid };
      function attempt() {
        return page(b0, APP + "/").then(function (pg) {
          return evalIn(b0.cdp, pg.sid, PAGE_APP_DL.toString(), dlArg, 60000).then(function (r) { closePage(pg); return r; }, function (e) { closePage(pg); throw e; });
        });
      }
      licenceLog.push(Date.now());
      return attempt().then(function (r) {
        if (!(r && r.guest)) return { r: r };
        // App session dropped: re-login headless (SSO / Keychain), retry once.
        return reauth(b0).then(function (ra) { return ra.ok ? attempt().then(function (r2) { return { r: r2 }; }) : { r: r, reauth: ra }; });
      }).then(function (x) {
        var r = x.r;
        touch();
        if (r && r.url) { saveCookies(b0); return { ok: true, data: { downloadUrl: r.url, item: it, format: fmt ? fmt.label : null } }; }
        if (r && r.guest) return { ok: false, needLogin: true, error: (x.reauth && x.reauth.error ? x.reauth.error + " " : "") + "Belum login ke Envato di bridge. Panggil envato_account {action: \"login\"}, lalu ulangi." };
        if (r && /captcha/i.test(String(r.error || r.head))) return { ok: false, captcha: true, error: "Envato minta captcha untuk download ini: buka item di browser dan klik DOWNLOAD sekali." };
        return { ok: false, error: "Envato tidak memberi link download (HTTP " + (r && r.status) + "): " + (r && (r.error || r.head) || "?") };
      });
    }).catch(function (e) { return { ok: false, infra: true, error: String(e.message || e) }; });
  }

  // Background jobs survive a tool timeout: a second call for the same item
  // re-attaches instead of licensing/downloading again.
  var jobs = {};
  function fetchItem(o) {
    var key = (String(o.itemUrl).match(/([A-Z0-9]{5,10})\/?(?:[?#].*)?$/) || [])[1] || o.itemUrl;
    var job = jobs[key];
    if (job && (job.state === "downloading" || job.state === "licensing")) return waitJob(job, o.waitMs);
    if (job && job.state === "done" && job.file && exists(job.file)) return Promise.resolve(job);
    job = jobs[key] = { itemId: key, state: "licensing", received: 0, total: 0, startedAt: Date.now() };
    job.promise = license(o.itemUrl, o.projectName, o.resolution).then(function (l) {
      if (!l.ok) { job.state = "error"; job.error = l.error; job.needLogin = l.needLogin; job.infra = l.infra; return job; }
      job.title = l.data.item.title; job.format = l.data.format; job.itemType = l.data.item.itemType;
      return download(l.data.downloadUrl, o.dir, job);
    });
    return waitJob(job, o.waitMs);
  }
  function waitJob(job, ms) {
    return Promise.race([job.promise.then(function () { return job; }), sleep(ms || 200000).then(function () { return job; })]);
  }

  // ---------------------------------------------------------
  // FILE DOWNLOAD (node, resumable progress, redirects)
  // ---------------------------------------------------------
  function fileNameFrom(res, url) {
    var cd = String(res.headers["content-disposition"] || "");
    var m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    var n = m ? decodeURIComponent(m[1]) : decodeURIComponent(String(url).split("?")[0].split("/").pop() || "envato-download");
    return n.replace(/[\\\/:*?"<>|]+/g, "_").slice(0, 160) || "envato-download";
  }

  // job: {state, received, total, file, error, startedAt}
  function download(url, dir, job) {
    mkdirp(dir);
    job.state = "downloading"; job.received = 0; job.total = 0; job.startedAt = Date.now();
    return new Promise(function (resolve) {
      var hops = 0;
      function get(u) {
        var req = https.get(u, { headers: { "User-Agent": "Mozilla/5.0 HermesBridge" } }, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops++ < 6) {
            res.resume(); return get(new URL(res.headers.location, u).toString());
          }
          if (res.statusCode !== 200) {
            res.resume(); job.state = "error"; job.error = "download HTTP " + res.statusCode; return resolve(job);
          }
          var name = fileNameFrom(res, u), dst = path.join(dir, name), tmp = dst + ".hbpart";
          job.total = parseInt(res.headers["content-length"], 10) || 0;
          job.name = name;
          var out = fs.createWriteStream(tmp);
          res.on("data", function (c) { job.received += c.length; });
          res.pipe(out);
          out.on("finish", function () {
            out.close(function () {
              try { fs.renameSync(tmp, dst); job.file = dst; job.state = "done"; job.ms = Date.now() - job.startedAt; }
              catch (e) { job.state = "error"; job.error = e.message; }
              resolve(job);
            });
          });
          out.on("error", function (e) { job.state = "error"; job.error = e.message; resolve(job); });
          res.on("aborted", function () { job.state = "error"; job.error = "koneksi terputus"; resolve(job); });
        });
        req.setTimeout(120000, function () { req.destroy(new Error("download stalled 120 s")); });
        req.on("error", function (e) { job.state = "error"; job.error = e.message; resolve(job); });
      }
      get(url);
    });
  }

  function progress(job) {
    var o = { state: job.state, item: job.itemId, received_mb: Math.round(job.received / 1048576 * 10) / 10 };
    if (job.total) { o.total_mb = Math.round(job.total / 1048576 * 10) / 10; o.percent = Math.round(job.received / job.total * 100); }
    var sec = (Date.now() - job.startedAt) / 1000;
    if (sec > 1 && job.received) {
      o.mb_per_s = Math.round(job.received / 1048576 / sec * 10) / 10;
      if (job.total) o.eta_s = Math.round((job.total - job.received) / (job.received / sec));
    }
    return o;
  }

  global.HBEnvatoSession = {
    ROOT: ROOT, PROFILE: PROFILE, COOKIES: COOKIES,
    findChrome: findChrome,
    status: status,
    profileInUse: profileInUse,
    login: login,
    logout: logout,
    license: license,
    fetchItem: fetchItem,
    resolveItem: resolveItem,
    _parseItemPage: parseItemPage,
    _pickFormat: pickFormat,
    download: download,
    progress: progress,
    shutdown: shutdown,
    _findDownloadUrl: findDownloadUrl,
    _errorText: errorText,
    _rate: RATE,
    _keychainCred: keychainCred,
    _PAGE_FILL: PAGE_FILL,
    _PAGE_AFTER: PAGE_AFTER,
    KEYCHAIN_SERVICE: KEYCHAIN_SERVICE
  };
})(typeof window !== "undefined" ? window : global);
