/* =========================================================
   FEUGELIGN v1.0  -  PANEL LOGIC
   Bridge to ExtendScript: window.__adobe_cep__.evalScript
   (CSInterface.js is only a thin wrapper over that API, so we
   do not ship it.)
   ========================================================= */
(function () {
  "use strict";

  var statusEl  = document.getElementById("status");
  var ledEl     = document.getElementById("led");
  var contentEl = document.getElementById("content");

  /* Mode switches. The panel knows nothing about the After Effects API -
     it only assembles call strings from this state. */
  var STATE = { to: "comp", safe: "edge", by: "view", dm: "gap" };

  /* Mirror of the timeline selection. `order` holds CLICK ORDER, not the
     layer - the only way to know which one is the key object, exactly why
     AlignAll relies on polling. */
  var SEL = { order: [], names: {}, three: {}, comp: "", hasCam: false };

  var busy = false;
  var timer = null;

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
  function num(id, fallback, min) {
    var el = document.getElementById(id);
    var v = parseFloat(el.value);
    if (isNaN(v) || (min !== undefined && v < min)) {
      v = fallback;
      el.value = String(fallback);
    }
    return v;
  }

  function gapVal()   { return num("gapVal", 40, 0); }
  function pollMs()   { return num("pollMs", 600, 100); }
  function scaleComp(){ return document.getElementById("scaleComp").checked; }
  function pollOn()   { return document.getElementById("pollOn").checked; }
  function keyIdx()   { return SEL.order.length ? SEL.order[SEL.order.length - 1] : 0; }
  function keyName()  { var k = keyIdx(); return k ? (SEL.names[k] || ("layer " + k)) : "-"; }

  // ---------------------------------------------------------
  // LABEL
  // ---------------------------------------------------------
  var LBL_TO   = { comp: "comp", sel: "selection", key: "key object" };
  var LBL_SAFE = { edge: "comp edge", action: "action safe", title: "title safe" };
  var LBL_BY   = { view: "View", world: "World", viewworld: "View via World", parent: "via Parent" };
  var LBL_DM   = { gap: "equal edge gaps", center: "equal centre spacing" };

  function toLabel() {
    return (STATE.to === "comp") ? LBL_SAFE[STATE.safe] : LBL_TO[STATE.to];
  }

  function count3D() {
    var n = 0;
    for (var i = 0; i < SEL.order.length; i++) if (SEL.three[SEL.order[i]]) n++;
    return n;
  }

  function sep() { return "  |  "; }

  function paintMeta() {
    var n = SEL.order.length;
    var n3 = count3D();

    document.getElementById("metaSel").textContent =
      n === 0 ? "Nothing selected"
              : n + " layer" + (STATE.to === "key" || n > 1 ? sep() + "key: " + keyName() : "");

    document.getElementById("metaSpace").textContent =
      LBL_BY[STATE.by] + sep() +
      (STATE.by === "parent" ? "needs a shared parent"
        : SEL.hasCam ? "active camera found"
        : "no camera - using AE default view") +
      (scaleComp() ? sep() + "scale comp on" : "");

    document.getElementById("metaAlign").textContent =
      "to " + toLabel() + sep() + "via " + LBL_BY[STATE.by];

    document.getElementById("metaDepth").textContent =
      n3 === 0 ? "needs 3D layers - the 3D switch is off"
               : n3 + " of " + n + " selected layers are 3D";

    document.getElementById("metaDist").textContent =
      LBL_DM[STATE.dm] + sep() + (n >= 3 ? n + " layers ready" : "needs at least 3 layers");

    document.getElementById("metaGap").textContent =
      "gap " + gapVal() + "px" + sep() + "anchor " + keyName();

    document.getElementById("metaPoll").textContent =
      pollOn() ? ("polling " + pollMs() + "ms" + sep() + "click order defines the key object")
               : ("polling off" + sep() + "updates when the cursor enters the panel");
  }

  // ---------------------------------------------------------
  // SELECTION POLLING
  // Host reply: OK|<comp>|<hasCam>|idx:name:is3d;...
  // ---------------------------------------------------------
  function applySelection(raw) {
    var f = raw.split("|");
    SEL.comp   = f[1] || "";
    SEL.hasCam = f[2] === "1";

    var ids = [], names = {}, three = {};
    var body = f[3] || "";
    if (body.length) {
      var rows = body.split(";");
      for (var i = 0; i < rows.length; i++) {
        var c = rows[i].split(":");
        var idx = parseInt(c[0], 10);
        if (isNaN(idx)) continue;
        ids.push(idx);
        names[idx] = c[1];
        three[idx] = c[2] === "1";
      }
    }

    /* Preserve click order: layers still selected keep their position,
       new ones are appended -> the last one becomes the key object. */
    var kept = [];
    for (var a = 0; a < SEL.order.length; a++) {
      if (has(ids, SEL.order[a])) kept.push(SEL.order[a]);
    }
    for (var b = 0; b < ids.length; b++) {
      if (!has(kept, ids[b])) kept.push(ids[b]);
    }

    SEL.order = kept;
    SEL.names = names;
    SEL.three = three;
    paintMeta();
  }

  function has(arr, v) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true;
    return false;
  }

  function poll(force) {
    if (busy) return;
    if (!force && !pollOn()) return;
    evalES("FG_ALIGN.selection()", function (res) {
      if (res.indexOf("OK|") === 0) applySelection(res);
      else { SEL.order = []; SEL.names = {}; SEL.three = {}; paintMeta(); }
    });
  }

  function restartTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (pollOn()) timer = setInterval(poll, pollMs());
    paintMeta();
  }

  // Tanpa polling, panel tetap segar begitu kursor masuk.
  document.body.addEventListener("mouseenter", function () {
    if (!pollOn()) poll(true);
  }, true);

  // ---------------------------------------------------------
  // ACTION MAP  ->  panggilan ExtendScript
  // ---------------------------------------------------------
  function buildCall(key) {
    var p = key.split(":");
    var by = '"' + STATE.by + '"';

    if (p[0] === "align") {
      return 'FG_ALIGN.align("' + p[1] + '","' + p[2] + '","' + STATE.to + '",' + by +
             ',"' + STATE.safe + '",' + (scaleComp() ? "true" : "false") + ',' + keyIdx() + ')';
    }
    if (p[0] === "dist") {
      return 'FG_ALIGN.distribute("' + p[1] + '","' + STATE.dm + '",' + by + ',' + keyIdx() + ')';
    }
    if (p[0] === "distd") {
      return 'FG_ALIGN.distributeBy("' + p[1] + '",' + gapVal() + ',' + by + ',' + keyIdx() + ')';
    }
    return null;
  }

  function accentOf(btn) {
    if (btn.classList.contains("danger")) return "var(--danger)";
    var card = btn.closest(".card");
    return card && card.getAttribute("data-accent") === "blue"
      ? "var(--blue)" : "var(--orange)";
  }

  function pulse(btn) {
    btn.classList.remove("pulse");
    void btn.offsetWidth;
    btn.classList.add("pulse");
  }

  // ---------------------------------------------------------
  // KLIK
  // ---------------------------------------------------------
  function runAction(btn) {
    var key = btn.getAttribute("data-act");

    if (key === "ui:refresh") {
      pulse(btn);
      poll(true);
      setStatus("Selection re-read", "ok", accentOf(btn));
      return;
    }

    if (STATE.to === "key" && !keyIdx() && key.indexOf("align") === 0) {
      setStatus("No key object yet - click the reference layer last", "err");
      return;
    }

    var call = buildCall(key);
    if (!call) return;

    pulse(btn);
    btn.classList.add("busy");
    busy = true;
    var accent = accentOf(btn);

    evalES(call, function (res) {
      btn.classList.remove("busy");
      busy = false;

      var s = res.indexOf("|");
      var tag = s > 0 ? res.substring(0, s) : "ERR";
      var msg = s > 0 ? res.substring(s + 1) : (res || "No reply from host");
      setStatus(msg, tag === "OK" ? "ok" : "err", accent);

      poll(true);
    });
  }

  function setMode(btn) {
    var group = btn.getAttribute("data-mode");
    var val   = btn.getAttribute("data-val");
    if (STATE[group] === val) { pulse(btn); return; }

    STATE[group] = val;
    var peers = document.querySelectorAll('.mode[data-mode="' + group + '"]');
    for (var i = 0; i < peers.length; i++) {
      peers[i].classList.toggle("is-on", peers[i].getAttribute("data-val") === val);
    }
    pulse(btn);
    paintMeta();

    // Trigger sync callback if registered by compact view
    if (window.FG_PANEL && typeof window.FG_PANEL.onModeChange === "function") {
      window.FG_PANEL.onModeChange(group, val);
    }

    if (group === "to" && val === "key" && !keyIdx()) {
      setStatus("Select the reference layer last - that becomes the key object", "err");
    } else {
      setStatus("Mode: to " + toLabel() + " via " + LBL_BY[STATE.by], "ok", accentOf(btn));
    }
  }

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".tile");
    if (!btn) return;
    if (btn.classList.contains("mode")) setMode(btn);
    else runAction(btn);
  });

  document.addEventListener("change", function (ev) {
    var id = ev.target.id;
    if (id === "pollOn") restartTimer();
    else paintMeta();
  });

  document.addEventListener("input", function (ev) {
    if (ev.target.tagName === "INPUT") paintMeta();
  });

  // Enter in a number field just blurs it, nothing is submitted
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target.tagName === "INPUT") {
      ev.target.blur();
      if (ev.target.id === "pollMs") restartTimer();
    }
  });

  // Export panel API for companion views (e.g. compact mode)
  window.FG_PANEL = {
    STATE: STATE,
    SEL: SEL,
    setStatus: setStatus,
    setMode: setMode,
    runAction: runAction,
    paintMeta: paintMeta,
    poll: poll,
    evalES: evalES,
    buildCall: buildCall,
    scaleComp: scaleComp,
    gapVal: gapVal,
    pulse: pulse,
    accentOf: accentOf
  };

  // ---------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------
  paintMeta();
  evalES("FG_ALIGN.ping()", function (res) {
    if (res.indexOf("OK|") === 0) {
      setStatus("Ready - select layers in the timeline", "ok", "var(--blue)");
      restartTimer();
      poll(true);
    } else {
      setStatus("Host script failed to load: " + res.replace(/^ERR\|/, ""), "err");
    }
  });
})();
