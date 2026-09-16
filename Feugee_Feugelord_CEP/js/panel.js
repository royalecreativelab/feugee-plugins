/* =========================================================
   FEUGEE FEUGELORD  -  PANEL LOGIC  (Illustrator + After Effects)
   Bridge to ExtendScript: window.__adobe_cep__.evalScript
   ========================================================= */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $("status");
  var ledEl = $("led");
  var cep = window.__adobe_cep__;

  // ---------------------------------------------------------
  // HOST  -  keep only this app's cards, before modes.js builds
  //          the compact view out of whatever tiles are left
  // ---------------------------------------------------------
  function hostName() {
    try { return JSON.parse(cep.getHostEnvironment()).appName; } catch (e) {}
    var m = /[?&]host=(\w+)/.exec(location.search);          // browser preview: ?host=AEFT
    return m ? m[1] : "ILST";
  }
  var HOST = hostName();
  var cards = document.querySelectorAll("[data-host]");
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].getAttribute("data-host") !== HOST) cards[i].parentNode.removeChild(cards[i]);
  }

  // ---------------------------------------------------------
  // BRIDGE
  // ---------------------------------------------------------
  function hasHost() { return !!cep && typeof cep.evalScript === "function"; }

  function evalES(script, cb) {
    if (!hasHost()) { cb("ERR|Panel is not connected to Adobe"); return; }
    try {
      cep.evalScript(script, function (res) { cb(typeof res === "string" ? res : "ERR|Could not read the host reply"); });
    } catch (e) {
      cb("ERR|" + e.message);
    }
  }

  function split(res) {
    var parts = String(res || "").split("|");
    return { ok: parts[0] === "OK", parts: parts, msg: parts.slice(1).join("|") || "No reply from host" };
  }

  function lit(s) { return JSON.stringify(String(s)); }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function fs() { return window.cep && window.cep.fs; }

  function userData() {
    // getSystemPath returns a URL (Application%20Support); cep.fs does not decode it
    try { return decodeURIComponent(cep.getSystemPath("userData").replace(/^file:\/\//, "")); } catch (e) { return ""; }
  }
  var BASE = userData() + "/Feugee/Feugelord";

  // ---------------------------------------------------------
  // STATUS
  // ---------------------------------------------------------
  function setStatus(text, kind, accent) {
    statusEl.textContent = text;
    statusEl.classList.toggle("is-err", kind === "err");
    ledEl.className = "led " + (kind === "err" ? "err" : (kind === "ok" ? "ok" : ""));
    statusEl.style.setProperty("--flash", accent || "var(--orange)");
    statusEl.classList.remove("flash");
    void statusEl.offsetWidth;
    statusEl.classList.add("flash");
  }

  // =========================================================
  // ILLUSTRATOR
  // =========================================================
  var pending = null;     // { id, sentAt, timer }

  function renderSteps(steps) {
    $("steps").innerHTML = steps.map(function (s) {
      return '<li class="' + s.kind + '"><i></i><span>' + esc(s.text) + "</span><b>" + esc(s.side || "") + "</b></li>";
    }).join("");
  }

  function renderWarnings(list) {
    $("warnings").innerHTML = (list || []).map(function (w) {
      return "<li><span>" + esc(w[0]) + "</span><b>" + (w[1] > 1 ? "×" + w[1] : "") + "</b></li>";
    }).join("");
  }

  function checkSelection() {
    if (HOST !== "ILST" || document.hidden) return;
    evalES("FG_LORD.selectionInfo()", function (res) {
      var r = split(res);
      if (!r.ok) return;
      var n = Number(r.parts[1]) || 0;
      $("metaSel").textContent = (n ? n + " selected" : "Nothing selected") + " · " + (r.parts[2] || "");
    });
  }

  function push(mode, btn) {
    var opts = ($("optSeparate").checked ? "S" : "") + ($("optText").checked ? "T" : "");
    btn.classList.add("busy");
    setStatus("Collecting artwork...", "", "var(--blue)");
    evalES("FG_LORD.push(" + lit(mode) + "," + lit(opts) + ")", function (res) {
      btn.classList.remove("busy");
      var r = split(res);
      if (!r.ok) {
        setStatus(r.msg, "err");
        renderSteps([{ kind: "err", text: r.msg }]);
        return;
      }
      var id = r.parts[1];
      var summary = r.parts[2];
      var warnings = [];
      try { warnings = JSON.parse(r.parts.slice(3).join("|")); } catch (e) {}
      renderWarnings(warnings);
      $("metaLast").textContent = (mode === "artboard" ? "Artboard" : "Selection") + " · " + summary;
      waitForAE(id, summary);
    });
  }

  function waitForAE(id, summary) {
    if (pending && pending.timer) clearInterval(pending.timer);
    var sentAt = Date.now();
    var sentStep = { kind: "ok", text: "Sent · " + summary };
    renderSteps([sentStep, { kind: "wait", text: "Waiting for After Effects..." }]);
    setStatus("Sent - switch to After Effects", "ok", "var(--blue)");

    var path = BASE + "/results/" + id + ".txt";
    pending = { id: id, timer: setInterval(function () {
      var waited = Date.now() - sentAt;
      var read = fs() ? fs().readFile(path) : { err: 1 };
      if (read.err === 0 && read.data) {
        clearInterval(pending.timer);
        var r = split(read.data);
        if (r.ok) {
          renderSteps([sentStep, { kind: "ok", text: "Built in AE · " + r.parts[1], side: (r.parts[2] || "?") + " ms" }]);
          setStatus("✓ " + r.parts[1], "ok");
        } else {
          renderSteps([sentStep, { kind: "err", text: "AE: " + r.msg }]);
          setStatus("After Effects: " + r.msg, "err");
        }
        return;
      }
      if (waited > 6000) {
        renderSteps([sentStep, { kind: "wait", text: "Not picked up yet - it builds as soon as After Effects is running with Feugelord installed" }]);
      }
      if (waited > 600000) clearInterval(pending.timer);    // the payload still waits in the outbox
    }, 200) };
  }

  // =========================================================
  // AFTER EFFECTS
  // =========================================================
  function loadLog() {
    if (HOST !== "AEFT" || !fs()) return;
    var dir = BASE + "/results";
    var list = fs().readdir(dir);
    var names = (list.err === 0 && list.data ? list.data : []).filter(function (n) { return /\.txt$/.test(n); }).sort().reverse();
    var rows = names.slice(0, 12).map(function (n) {
      var r = split((fs().readFile(dir + "/" + n) || {}).data);
      var when = new Date(Number(n.split("-")[0]));
      var time = isNaN(when.getTime()) ? "" : when.toTimeString().slice(0, 5);
      return '<li class="' + (r.ok ? "" : "err") + '"><i></i><span>' + esc(r.ok ? r.parts[1] : r.msg) + "</span><b>" + time + "</b></li>";
    });
    $("log").innerHTML = rows.join("") || '<li class="fl-none">No pushes received yet - select artwork in Illustrator and press Selection</li>';

    var queue = fs().readdir(BASE + "/outbox");
    var waiting = (queue.err === 0 && queue.data ? queue.data : []).filter(function (n) { return /\.json$/.test(n); }).length;
    $("metaRecent").textContent = names.length + " received" + (waiting ? " · " + waiting + " waiting" : "");
    $("metaRecv").textContent = waiting ? waiting + " push(es) waiting - open a composition or check the log" : "Listening for Illustrator pushes";

    // keep the results folder small
    names.slice(50).forEach(function (n) { fs().deleteFile(dir + "/" + n); });
  }

  function clearQueue() {
    var queue = fs().readdir(BASE + "/outbox");
    var n = 0;
    (queue.err === 0 && queue.data ? queue.data : []).forEach(function (f) {
      if (/\.(json|tmp)$/.test(f)) { fs().deleteFile(BASE + "/outbox/" + f); n++; }
    });
    setStatus(n ? "Dropped " + n + " waiting push(es)" : "Queue is empty", "ok", "var(--blue)");
    loadLog();
  }

  // ---------------------------------------------------------
  // TILES
  // ---------------------------------------------------------
  var ACTIONS = {
    "push:selection": function (btn) { push("selection", btn); },
    "push:artboard": function (btn) { push("artboard", btn); },
    refresh: function () { loadLog(); setStatus("Log refreshed", "ok", "var(--blue)"); },
    clear: clearQueue
  };

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".tile[data-act], .ctile[data-act]");
    if (!btn) return;
    var fn = ACTIONS[btn.getAttribute("data-act")];
    if (!fn) return;
    btn.classList.remove("pulse");
    void btn.offsetWidth;
    btn.classList.add("pulse");
    fn(btn);
  });

  // options survive panel reloads
  ["optSeparate", "optText"].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    try {
      var saved = localStorage.getItem("feugee.feugelord." + id);
      if (saved !== null) el.checked = saved === "1";
    } catch (e) {}
    el.addEventListener("change", function () {
      try { localStorage.setItem("feugee.feugelord." + id, el.checked ? "1" : "0"); } catch (e) {}
    });
  });

  // ---------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------
  evalES("FG_LORD.ping()", function (res) {
    var r = split(res);
    if (!r.ok) {
      setStatus("Host script failed to load: " + r.msg, "err");
      return;
    }
    if (HOST === "ILST") {
      setStatus("Beta - select artwork, then Selection", "ok", "var(--blue)");
      checkSelection();
      setInterval(checkSelection, 1200);
    } else {
      setStatus("Receiving - pushes from Illustrator build here", "ok", "var(--blue)");
      loadLog();
      setInterval(loadLog, 2000);
    }
  });
})();
