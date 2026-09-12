/* =========================================================
   FEUGEE MOGRAPH v1.0  -  PANEL LOGIC
   Bridge to ExtendScript: window.__adobe_cep__.evalScript
   The panel knows nothing about the After Effects API: it builds
   call strings for FG_MOGRAPH and shows the "OK|" / "ERR|" reply.
   ========================================================= */
(function () {
  "use strict";

  var statusEl = document.getElementById("status");
  var ledEl = document.getElementById("led");

  var POLL_MS = 900;
  var busy = false;
  var hostReady = false;

  // last scan: { comp, plain, props, rows: [{kind,id,name,links,selected}] }
  var SCAN = { comp: "", plain: 0, props: 0, rows: [] };

  var CLONER_KINDS = { grid: 1, array: 1, linear: 1 };

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
    void statusEl.offsetWidth; // replay the flash back to back
    statusEl.classList.add("flash");
  }

  // ---------------------------------------------------------
  // PARAMS
  // ---------------------------------------------------------
  function intField(id, fallback) {
    var el = document.getElementById(id);
    var min = parseInt(el.getAttribute("data-min"), 10) || 1;
    var max = parseInt(el.getAttribute("data-max"), 10) || 500;
    var v = parseInt(el.value, 10);
    if (isNaN(v)) v = fallback;
    v = Math.max(min, Math.min(max, v));
    if (String(v) !== el.value) {
      el.value = String(v);
      fire(el, "input"); // keeps the compact twin in sync
    }
    return v;
  }

  /* Read without writing back: the poll repaints hints every 900 ms and must
     never rewrite a field the user is still typing in. */
  function readInt(id, fallback) {
    var el = document.getElementById(id);
    var min = parseInt(el.getAttribute("data-min"), 10) || 1;
    var max = parseInt(el.getAttribute("data-max"), 10) || 500;
    var v = parseInt(el.value, 10);
    if (isNaN(v)) v = fallback;
    return Math.max(min, Math.min(max, v));
  }

  function fire(el, type) {
    var ev;
    try { ev = new Event(type, { bubbles: true }); }
    catch (e) { ev = document.createEvent("Event"); ev.initEvent(type, true, true); }
    el.dispatchEvent(ev);
  }

  function checked(id) { return document.getElementById(id).checked; }

  var MASK = [["afPos", "pos", "Position"], ["afScale", "scale", "Scale"], ["afRot", "rot", "Rotation"], ["afOpa", "opa", "Opacity"]];

  function mask() {
    var out = [];
    for (var i = 0; i < MASK.length; i++) if (checked(MASK[i][0])) out.push(MASK[i][1]);
    return out.join(",");
  }

  function maskLabel() {
    var out = [];
    for (var i = 0; i < MASK.length; i++) if (checked(MASK[i][0])) out.push(MASK[i][2]);
    return out.join(" + ");
  }

  function safeId(v) { return /^[A-Z0-9]{1,12}$/.test(v) ? v : "auto"; }

  function selValue(id) {
    var el = document.getElementById(id);
    return safeId(el ? el.value : "auto");
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function shortName(name) { return String(name).replace(/^FGM\s+/, ""); }

  // ---------------------------------------------------------
  // META HINTS - tell the user what a click will do right now
  // ---------------------------------------------------------
  function selectedRows(cat) {
    var out = [];
    for (var i = 0; i < SCAN.rows.length; i++) {
      var r = SCAN.rows[i];
      if (!r.selected) continue;
      if (cat === "cloner" && !CLONER_KINDS[r.kind]) continue;
      if (cat === "effector" && CLONER_KINDS[r.kind]) continue;
      out.push(r);
    }
    return out;
  }

  function sep() { return "  |  "; }

  function paintMeta() {
    var metaClone = document.getElementById("metaClone");
    var metaEff = document.getElementById("metaEff");
    var metaTools = document.getElementById("metaTools");
    var metaList = document.getElementById("metaList");

    if (!hostReady) return;
    if (!SCAN.comp) {
      metaClone.textContent = "Open a composition";
      metaEff.textContent = "Open a composition";
      metaTools.textContent = "Open a composition";
      metaList.textContent = "No composition open";
      return;
    }

    var gx = readInt("gridX", 3), gy = readInt("gridY", 3);
    var arr = readInt("arrN", 6), lin = readInt("linN", 5);

    if (SCAN.plain === 0) {
      metaClone.textContent = "Select layers to clone";
    } else if (SCAN.plain === 1) {
      metaClone.textContent = "1 layer -> duplicated: grid " + gx + "x" + gy + ", array " + arr + ", linear " + lin;
    } else {
      metaClone.textContent = SCAN.plain + " layers -> arranged as they are, nothing duplicated";
    }
    var selC = selectedRows("cloner");
    if (selC.length && SCAN.plain) metaClone.textContent = "Link -> " + shortName(selC[0].name) + sep() + plural(SCAN.plain, "layer", "layers");

    if (SCAN.props > 0) {
      metaEff.textContent = plural(SCAN.props, "property", "properties") + " selected -> Field / Step / Noise drive them";
    } else if (SCAN.plain > 0) {
      var ml = maskLabel();
      metaEff.textContent = ml ? "No property selected -> " + ml : "Tick a property below, or select one in the timeline";
    } else {
      metaEff.textContent = "Select layers or properties to animate";
    }
    var selE = selectedRows("effector");
    if (selE.length && (SCAN.plain || SCAN.props)) metaEff.textContent = "Link -> " + shortName(selE[0].name) + sep() + metaEff.textContent;

    var selAll = selectedRows(null);
    if (selAll.length === 1) {
      metaTools.textContent = shortName(selAll[0].name) + " -> " + plural(selAll[0].links, "linked layer", "linked layers");
    } else if (selAll.length > 1) {
      metaTools.textContent = selAll.length + " controllers selected";
    } else if (SCAN.plain > 0) {
      metaTools.textContent = plural(SCAN.plain, "layer", "layers") + " selected";
    } else {
      metaTools.textContent = "Select a controller or linked layers";
    }

    metaList.textContent = SCAN.rows.length
      ? plural(SCAN.rows.length, "controller", "controllers") + sep() + "click one to select it"
      : "No rigs yet";
  }

  // ---------------------------------------------------------
  // CONTROLLER PICKERS + LIST
  // ---------------------------------------------------------
  function fillSelect(id, rows, autoLabel) {
    var el = document.getElementById(id);
    if (!el || document.activeElement === el) return; // never rebuild while the user has it open
    var keep = el.value;
    var sig = autoLabel;
    for (var i = 0; i < rows.length; i++) sig += "|" + rows[i].id + rows[i].name + rows[i].links;
    if (el.getAttribute("data-sig") === sig) return;
    el.setAttribute("data-sig", sig);

    el.innerHTML = "";
    var auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = autoLabel;
    el.appendChild(auto);
    var found = false;
    for (var j = 0; j < rows.length; j++) {
      var o = document.createElement("option");
      o.value = rows[j].id;
      o.textContent = shortName(rows[j].name) + "  (" + rows[j].links + ")";
      if (rows[j].id === keep) found = true;
      el.appendChild(o);
    }
    el.value = found ? keep : "auto";
  }

  function paintList() {
    var list = document.getElementById("ctrlList");
    var sig = SCAN.comp;
    for (var i = 0; i < SCAN.rows.length; i++) {
      var r = SCAN.rows[i];
      sig += "|" + r.id + r.name + r.links + r.selected;
    }
    if (list.getAttribute("data-sig") === sig) return;
    list.setAttribute("data-sig", sig);
    list.innerHTML = "";

    if (!SCAN.rows.length) {
      var empty = document.createElement("p");
      empty.className = "fgm-empty";
      empty.textContent = SCAN.comp
        ? "Select a layer and press GRID, ARRAY or LINEAR - or press SAMPLE for a ready-made rig."
        : "Open a composition to see its rigs.";
      list.appendChild(empty);
      return;
    }

    for (var j = 0; j < SCAN.rows.length; j++) {
      var row = SCAN.rows[j];
      var b = document.createElement("button");
      b.className = "fgm-row " + (CLONER_KINDS[row.kind] ? "cloner" : "effector") + (row.selected ? " is-on" : "");
      b.setAttribute("data-id", row.id);
      b.title = "Select " + row.name + " in the timeline";
      var dot = document.createElement("i");
      dot.className = "dot";
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = shortName(row.name);
      var count = document.createElement("span");
      count.className = "count";
      count.textContent = plural(row.links, "layer", "layers");
      b.appendChild(dot);
      b.appendChild(name);
      b.appendChild(count);
      list.appendChild(b);
    }
  }

  function applyScan(raw) {
    // OK|<comp>|<plain>|<props>|<rows>
    var f = raw.split("|");
    var comp = "";
    try { comp = decodeURIComponent(f[1] || ""); } catch (e) { comp = f[1] || ""; }
    SCAN.comp = comp;
    SCAN.plain = parseInt(f[2], 10) || 0;
    SCAN.props = parseInt(f[3], 10) || 0;
    SCAN.rows = [];
    var body = f[4] || "";
    if (body) {
      var parts = body.split(";");
      for (var i = 0; i < parts.length; i++) {
        var c = parts[i].split("~");
        if (c.length < 5) continue;
        var name = c[2];
        try { name = decodeURIComponent(c[2]); } catch (e2) {}
        SCAN.rows.push({ kind: c[0], id: c[1], name: name, links: parseInt(c[3], 10) || 0, selected: c[4] === "1" });
      }
    }

    var cl = [], ef = [];
    for (var r = 0; r < SCAN.rows.length; r++) (CLONER_KINDS[SCAN.rows[r].kind] ? cl : ef).push(SCAN.rows[r]);
    fillSelect("clonerSel", cl, "Auto - selected cloner");
    fillSelect("effSel", ef, "Auto - selected effector");
    paintList();
    paintMeta();
  }

  // ---------------------------------------------------------
  // POLLING
  // ---------------------------------------------------------
  function poll(force) {
    if (!hostReady || busy) return;
    if (!force && document.hidden) return;
    evalES("FG_MOGRAPH.scan()", function (res) {
      if (res.indexOf("OK|") === 0) applyScan(res);
    });
  }

  // ---------------------------------------------------------
  // ACTIONS -> ExtendScript calls
  // ---------------------------------------------------------
  function q(s) { return '"' + s + '"'; }

  function buildCall(key) {
    var p = key.split(":");
    var kind = p[1];

    if (p[0] === "create") {
      if (kind === "grid") {
        var gx = intField("gridX", 3), gy = intField("gridY", 3);
        return "FG_MOGRAPH.create(" + q("grid") + "," + (gx * gy) + "," + q("") + "," + gx + "," + gy + ")";
      }
      if (kind === "array") return "FG_MOGRAPH.create(" + q("array") + "," + intField("arrN", 6) + "," + q("") + ",0,0)";
      if (kind === "linear") return "FG_MOGRAPH.create(" + q("linear") + "," + intField("linN", 5) + "," + q("") + ",0,0)";
      if (kind === "field" || kind === "step" || kind === "noise") {
        return "FG_MOGRAPH.create(" + q(kind) + ",0," + q(mask()) + ",0,0)";
      }
      if (kind === "target" || kind === "inherit") return "FG_MOGRAPH.create(" + q(kind) + ",0," + q("") + ",0,0)";
      return null;
    }
    if (p[0] === "link" || p[0] === "unlink") {
      if (kind !== "cloner" && kind !== "effector") return null;
      var target = selValue(kind === "cloner" ? "clonerSel" : "effSel");
      return p[0] === "link"
        ? "FG_MOGRAPH.link(" + q(kind) + "," + q(target) + "," + q(mask()) + ")"
        : "FG_MOGRAPH.unlink(" + q(kind) + "," + q(target) + ")";
    }
    if (key === "morph") return "FG_MOGRAPH.addMorphTarget(" + q(selValue("effSel")) + ")";
    if (key === "bake") return "FG_MOGRAPH.bake(" + (checked("bakeWA") ? "true" : "false") + ")";
    if (key === "select" || key === "copy" || key === "organize" || key === "clean" || key === "sample") {
      return "FG_MOGRAPH." + key + "()";
    }
    return null;
  }

  function accentOf(btn) {
    if (btn.classList.contains("danger")) return "var(--danger)";
    var a = btn.getAttribute("data-accent");
    if (!a) {
      var card = btn.closest(".card");
      a = card ? card.getAttribute("data-accent") : "orange";
    }
    return a === "blue" ? "var(--blue)" : "var(--orange)";
  }

  function pulse(btn) {
    btn.classList.remove("pulse");
    void btn.offsetWidth;
    btn.classList.add("pulse");
  }

  /* CLEAN deletes controllers: ask for a second click instead of a dialog. */
  var armed = { key: "", until: 0 };

  function needsConfirm(key) {
    if (key !== "clean") return false;
    var now = Date.now();
    if (armed.key === key && now < armed.until) { armed.key = ""; return false; }
    armed.key = key;
    armed.until = now + 3000;
    return true;
  }

  function send(call, btn, pending) {
    busy = true;
    var accent = btn ? accentOf(btn) : "var(--orange)";
    if (btn) { pulse(btn); btn.classList.add("busy"); }
    if (pending) setStatus(pending, "", accent);

    evalES(call, function (res) {
      if (btn) btn.classList.remove("busy");
      busy = false;
      var s = res.indexOf("|");
      var tag = s > 0 ? res.substring(0, s) : "ERR";
      var msg = s > 0 ? res.substring(s + 1) : (res || "No reply from host - press the reload button");
      setStatus(msg, tag === "OK" ? "ok" : "err", accent);
      poll(true);
    });
  }

  function runAction(btn) {
    if (busy) return;
    var key = btn.getAttribute("data-act");
    if (!key) return;
    if (!hostReady) {
      setStatus("Host script is not loaded - press the reload button", "err");
      return;
    }
    if (needsConfirm(key)) {
      pulse(btn);
      setStatus("Click CLEAN again to remove the rig (the current look is kept)", "err");
      return;
    }
    var call = buildCall(key);
    if (!call) return;
    var pending = (key === "bake") ? "Baking... this reads every frame" : (key === "sample") ? "Building sample comp..." : "";
    send(call, btn, pending);
  }

  document.addEventListener("click", function (ev) {
    var row = ev.target.closest(".fgm-row");
    if (row) {
      if (busy || !hostReady) return;
      send("FG_MOGRAPH.selectLayer(" + q(safeId(row.getAttribute("data-id"))) + ")", null, "");
      return;
    }
    var btn = ev.target.closest(".tile");
    if (!btn) return;
    runAction(btn);
  });

  document.addEventListener("change", function (ev) {
    if (ev.target && ev.target.tagName === "SELECT") {
      ev.target.blur();
      var sel = ev.target;
      var label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "";
      setStatus(sel.value === "auto" ? "Link / Unlink use the controller you select in the timeline" : "Link / Unlink use " + label, "ok",
        sel.id === "effSel" ? "var(--blue)" : "var(--orange)");
    }
    paintMeta();
  });

  document.addEventListener("input", function (ev) {
    if (ev.target && ev.target.tagName === "INPUT" && ev.target.type === "text") {
      // light live validation: digits only while typing
      var cleaned = ev.target.value.replace(/[^0-9]/g, "");
      if (cleaned !== ev.target.value) ev.target.value = cleaned;
    }
  });

  var DEFAULTS = { gridX: 3, gridY: 3, arrN: 6, linN: 5 };

  document.addEventListener("focusout", function (ev) {
    var t = ev.target;
    if (!t || t.tagName !== "INPUT" || t.type !== "text") return;
    // compact chips have no id of their own: normalise every count field
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) intField(k, DEFAULTS[k]);
    paintMeta();
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target.tagName === "INPUT") ev.target.blur();
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) poll(true);
  });

  window.FG_PANEL = { setStatus: setStatus, runAction: runAction, poll: poll, evalES: evalES };

  // ---------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------
  function boot(attempt) {
    evalES("typeof FG_MOGRAPH === 'object' ? FG_MOGRAPH.ping() : 'ERR|FG_MOGRAPH missing'", function (res) {
      if (res.indexOf("OK|") === 0) {
        hostReady = true;
        setStatus("Ready - select layers, then pick a cloner or effector", "ok", "var(--blue)");
        poll(true);
        setInterval(poll, POLL_MS);
      } else if (attempt < 3 && hasHost()) {
        setTimeout(function () { boot(attempt + 1); }, 700);
      } else {
        setStatus("Host script failed to load: " + res.replace(/^ERR\|/, ""), "err");
        document.getElementById("ctrlList").innerHTML = '<p class="fgm-empty">Not connected to After Effects.</p>';
      }
    });
  }
  boot(0);
})();
