/* =========================================================
   FEUGEE KNOWLEDGE NUKE  -  PANEL LOGIC
   Bridge to ExtendScript: window.__adobe_cep__.evalScript
   (CSInterface.js is only a thin wrapper over that API, so we
   do not ship it.)
   ========================================================= */
(function () {
  "use strict";

  var statusEl = document.getElementById("status");
  var ledEl = document.getElementById("led");

  // ---------------------------------------------------------
  // BRIDGE
  // ---------------------------------------------------------
  function hasHost() {
    return typeof window.__adobe_cep__ !== "undefined" &&
           typeof window.__adobe_cep__.evalScript === "function";
  }

  function evalES(script, cb) {
    if (!hasHost()) {
      cb("ERR|Panel is not connected to After Effects");
      return;
    }
    try {
      window.__adobe_cep__.evalScript(script, function (res) {
        cb(typeof res === "string" ? res : "ERR|Could not read the host reply");
      });
    } catch (e) {
      cb("ERR|" + e.message);
    }
  }

  // ---------------------------------------------------------
  // STATUS
  // ---------------------------------------------------------
  function setStatus(text, kind, accent) {
    statusEl.textContent = text;
    statusEl.classList.toggle("is-err", kind === "err");
    ledEl.className = "led " + (kind === "err" ? "err" : kind === "ok" ? "ok" : "");

    statusEl.style.setProperty("--flash", accent || "var(--orange)");
    statusEl.classList.remove("flash");
    // force reflow so the same animation can replay back to back
    void statusEl.offsetWidth;
    statusEl.classList.add("flash");
  }

  // ---------------------------------------------------------
  // PARAM READERS
  // ---------------------------------------------------------
  function num(id, fallback, asInt) {
    var el = document.getElementById(id);
    var v = asInt ? parseInt(el.value, 10) : parseFloat(el.value);
    if (isNaN(v) || v === 0 || (!asInt && v <= 0)) {
      v = fallback;
      el.value = String(fallback);
    }
    return v;
  }

  function popDist() { return num("popDist", 50, false); }
  function popDur() { return num("popDur", 12, true); }
  function curveDur() { return num("curveDur", 2.0, false); }
  function stepOff() {
    var el = document.getElementById("stepOff");
    var v = parseInt(el.value, 10);
    if (isNaN(v) || v === 0) { v = 1; el.value = "1"; }
    return v;
  }
  function autoParent() { return document.getElementById("autoParent").checked; }

  // ---------------------------------------------------------
  // ACTION MAP  ->  ExtendScript calls
  // ---------------------------------------------------------
  var ACTIONS = {
    "pop:top":      function () { return 'FG_KN.pop("top",' + popDist() + ',' + popDur() + ')'; },
    "pop:bottom":     function () { return 'FG_KN.pop("bottom",' + popDist() + ',' + popDur() + ')'; },
    "pop:left":      function () { return 'FG_KN.pop("left",' + popDist() + ',' + popDur() + ')'; },
    "pop:right":     function () { return 'FG_KN.pop("right",' + popDist() + ',' + popDur() + ')'; },
    "curve:in":      function () { return 'FG_KN.curve(true,' + curveDur() + ')'; },
    "curve:out":     function () { return 'FG_KN.curve(false,' + curveDur() + ')'; },
    "overlap:down":  function () { return 'FG_KN.overlap(true,' + stepOff() + ')'; },
    "overlap:up":    function () { return 'FG_KN.overlap(false,' + stepOff() + ')'; },
    "wiggle:both":   function () { return 'FG_KN.wiggle(true,true)'; },
    "wiggle:pos":    function () { return 'FG_KN.wiggle(true,false)'; },
    "wiggle:rot":    function () { return 'FG_KN.wiggle(false,true)'; },
    "wiggle:clear":  function () { return 'FG_KN.wiggleClear()'; },
    "turb:apply":    function () { return 'FG_KN.turbulent()'; },
    "turb:remove":   function () { return 'FG_KN.turbulentRemove()'; },
    "null:create":   function () { return 'FG_KN.nullRig(' + (autoParent() ? 'true' : 'false') + ')'; },
    "null:anchor":   function () { return 'FG_KN.centerAnchor()'; }
  };

  function accentOf(btn) {
    if (btn.classList.contains("danger")) return "var(--danger)";
    var host = btn.closest("[data-accent]") || btn;
    return host.getAttribute("data-accent") === "blue"
      ? "var(--blue)" : "var(--orange)";
  }

  // ---------------------------------------------------------
  // CLICK
  // ---------------------------------------------------------
  function run(btn) {
    var key = btn.getAttribute("data-act");
    var build = ACTIONS[key];
    if (!build) return;

    btn.classList.remove("pulse");
    void btn.offsetWidth;
    btn.classList.add("pulse");
    btn.classList.add("busy");

    var accent = accentOf(btn);

    evalES(build(), function (res) {
      btn.classList.remove("busy");
      var sep = res.indexOf("|");
      var tag = sep > 0 ? res.substring(0, sep) : "ERR";
      var msg = sep > 0 ? res.substring(sep + 1) : (res || "No reply from host");
      setStatus(msg, tag === "OK" ? "ok" : "err", accent);
    });
  }

  // Delegated on document: catches tiles in BOTH the full and compact views.
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".tile[data-act]");
    if (btn) run(btn);
  });

  // Enter in a number field just blurs it, nothing is submitted
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target.tagName === "INPUT") ev.target.blur();
  });

  // ---------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------
  evalES("FG_KN.ping()", function (res) {
    if (res.indexOf("OK|") === 0) {
      setStatus("Ready - select layers in the timeline", "ok", "var(--blue)");
    } else {
      setStatus("Host script failed to load: " + res.replace(/^ERR\|/, ""), "err");
    }
  });
})();
