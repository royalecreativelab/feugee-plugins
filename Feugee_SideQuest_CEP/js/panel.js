/* =========================================================
   FEUGEE SIDEQUEST  -  PANEL LOGIC
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
  // Writing a corrected value back has to look like the user typed it,
  // otherwise the compact view's twin field keeps the old number.
  function setVal(el, v) {
    var s = String(v);
    if (el.value === s) return;
    el.value = s;
    var ev;
    try {
      ev = new Event("input", { bubbles: true });
    } catch (e) {
      ev = document.createEvent("Event");
      ev.initEvent("input", true, true);
    }
    el.dispatchEvent(ev);
  }

  function num(id, fallback, asInt, min) {
    var el = document.getElementById(id);
    var v = asInt ? parseInt(el.value, 10) : parseFloat(el.value);
    if (isNaN(v)) v = fallback;
    if (typeof min === "number" && v < min) v = min;
    if (asInt) v = Math.round(v);
    setVal(el, v);
    return v;
  }

  // Three keyframes need at least three distinct frames.
  function scaleDur()  { return num("scaleDur", 12, true, 2); }
  function scaleOver() { return num("scaleOver", 107, false, 1); }
  function posDur()    { return num("posDur", 12, true, 2); }
  function posOver()   { return num("posOver", 12, false, 0); }

  // A negative step is a legitimate reverse stagger; only 0 is meaningless.
  function stepOff() {
    var el = document.getElementById("stepOff");
    var v = parseInt(el.value, 10);
    if (isNaN(v) || v === 0) { v = 1; setVal(el, v); }
    return v;
  }

  function autoParent() { return document.getElementById("autoParent").checked; }

  // ---------------------------------------------------------
  // ACTION MAP  ->  ExtendScript calls
  // ---------------------------------------------------------
  var ACTIONS = {
    "scale:in":     function () { return 'FG_SQ.scale(true,'  + scaleDur() + ',' + scaleOver() + ')'; },
    "scale:out":    function () { return 'FG_SQ.scale(false,' + scaleDur() + ',' + scaleOver() + ')'; },
    "overlap:down": function () { return 'FG_SQ.overlap(true,'  + stepOff() + ')'; },
    "overlap:up":   function () { return 'FG_SQ.overlap(false,' + stepOff() + ')'; },
    "null:create":  function () { return 'FG_SQ.nullRig(' + (autoParent() ? 'true' : 'false') + ')'; },
    "null:anchor":  function () { return 'FG_SQ.centerAnchor()'; }
  };

  /* pos:both:top ... pos:both:right - one tile per side, both halves.
     The host still exposes FG_SQ.pos(isIn, ...) for a single half; the
     File > Scripts launchers use it, the panel no longer does. */
  (function () {
    var sides = ["top", "bottom", "left", "right"];
    for (var s = 0; s < sides.length; s++) {
      (function (side) {
        ACTIONS["pos:both:" + side] = function () {
          return 'FG_SQ.posBoth("' + side + '",' + posDur() + ',' + posOver() + ')';
        };
      })(sides[s]);
    }
  })();

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
  // SETTINGS  -  mirrored to a file the shortcut launchers can read
  //
  // The launchers under File > Scripts run outside the browser, so they cannot
  // see these fields. Writing them out means a shortcut applies the numbers
  // you last set here. It also means the panel remembers them between
  // sessions, which it did not before.
  // ---------------------------------------------------------
  var PREF_IDS = ["scaleDur", "scaleOver", "posDur", "posOver", "stepOff"];

  function saveSettings() {
    var call = "FG_SQ.prefsSave(" +
      scaleDur() + "," + scaleOver() + "," +
      posDur() + "," + posOver() + "," +
      stepOff() + "," + (autoParent() ? "true" : "false") + ")";
    evalES(call, function () {});          // silent: never talk over an action's status
  }

  var saveTimer = null;
  function queueSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; saveSettings(); }, 400);
  }

  function loadSettings(done) {
    evalES("FG_SQ.prefsLoad()", function (res) {
      if (res.indexOf("OK|") !== 0) { done(); return; }
      var body = res.substring(3);
      if (body) {
        var parts = body.split(";");
        for (var i = 0; i < parts.length; i++) {
          var kv = parts[i].split("=");
          if (kv.length !== 2) continue;
          var key = kv[0].replace(/^\s+|\s+$/g, "");
          var val = kv[1].replace(/^\s+|\s+$/g, "");
          var el = document.getElementById(key);
          if (!el) continue;
          if (el.type === "checkbox") {
            el.checked = (val === "1" || val === "true");
            fire(el, "change");
          } else if (val !== "" && !isNaN(parseFloat(val))) {
            setVal(el, val);
          }
        }
      }
      done();
    });
  }

  function fire(el, type) {
    var ev;
    try {
      ev = new Event(type, { bubbles: true });
    } catch (e) {
      ev = document.createEvent("Event");
      ev.initEvent(type, true, true);
    }
    el.dispatchEvent(ev);
  }

  for (var pi = 0; pi < PREF_IDS.length; pi++) {
    var pel = document.getElementById(PREF_IDS[pi]);
    if (pel) { pel.addEventListener("input", queueSave); pel.addEventListener("change", queueSave); }
  }
  var apEl = document.getElementById("autoParent");
  if (apEl) apEl.addEventListener("change", queueSave);

  // ---------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------
  evalES("FG_SQ.ping()", function (res) {
    if (res.indexOf("OK|") === 0) {
      loadSettings(function () {
        setStatus("Ready - select layers in the timeline", "ok", "var(--blue)");
      });
    } else {
      setStatus("Host script failed to load: " + res.replace(/^ERR\|/, ""), "err");
    }
  });
})();
