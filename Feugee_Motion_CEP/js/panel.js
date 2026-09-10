/* =========================================================
   FEUGEE STUDIO - FEUGEE MOTION PANEL CONTROLLER
   Bridge to ExtendScript & UI Wiring
   ========================================================= */
(function (window) {
  "use strict";

  var statusEl = document.getElementById("status");
  var ledEl = document.getElementById("led");
  var contentEl = document.getElementById("content");
  var searchInput = document.getElementById("toolSearch");
  var clearSearchBtn = document.getElementById("clearSearch");
  var tabButtons = document.querySelectorAll(".tab-btn");

  // ---------------------------------------------------------
  // CEP BRIDGE
  // ---------------------------------------------------------
  function hasHost() {
    return typeof window.__adobe_cep__ !== "undefined" &&
           typeof window.__adobe_cep__.evalScript === "function";
  }

  function evalES(script, cb) {
    if (!hasHost()) {
      if (cb) cb("ERR|Panel is in browser preview (not connected to After Effects)");
      return;
    }
    try {
      window.__adobe_cep__.evalScript(script, function (res) {
        if (cb) cb(typeof res === "string" ? res : "ERR|Could not read host response");
      });
    } catch (e) {
      if (cb) cb("ERR|" + e.message);
    }
  }

  // ---------------------------------------------------------
  // STATUS FEEDBACK
  // ---------------------------------------------------------
  function setStatus(rawReply) {
    if (!statusEl || !ledEl) return;
    var parts = rawReply.split("|");
    var tag = parts[0] || "INFO";
    var msg = parts.slice(1).join("|") || rawReply;

    statusEl.textContent = msg;
    if (tag === "OK") {
      ledEl.className = "led ok";
      statusEl.classList.remove("is-err");
    } else if (tag === "ERR") {
      ledEl.className = "led err";
      statusEl.classList.add("is-err");
    } else {
      ledEl.className = "led";
      statusEl.classList.remove("is-err");
    }

    statusEl.classList.remove("flash");
    void statusEl.offsetWidth; // Force reflow
    statusEl.classList.add("flash");
  }

  // Helper to read inputs with fallbacks
  function getVal(id, fallback) {
    var el = document.getElementById(id);
    return el ? el.value : fallback;
  }

  function getBool(id) {
    var el = document.getElementById(id);
    return el ? el.checked : false;
  }

  // ---------------------------------------------------------
  // ACTION DISPATCHER
  // ---------------------------------------------------------
  function handleAction(act) {
    var script = "";

    // 1. Easing
    if (act === "ease:apply") {
      var curve = window.FG_CURVE ? window.FG_CURVE.getCurve() : { inInfluence: 33, outInfluence: 33, inSpeed: 0, outSpeed: 0 };
      script = "FG_MOTION.applyCubicEase(" + curve.inInfluence + ", " + curve.outInfluence + ", " + curve.inSpeed + ", " + curve.outSpeed + ");";
    } else if (act === "ease:copy") {
      script = "FG_MOTION.copyEase();";
    } else if (act === "ease:paste") {
      script = "FG_MOTION.pasteEase();";
    } else if (act === "ease:keynext") {
      script = "FG_MOTION.keyNav('next');";
    } else if (act === "ease:keyprev") {
      script = "FG_MOTION.keyNav('prev');";
    } else if (act === "ease:clean") {
      script = "FG_MOTION.keyClean();";
    } else if (act === "ease:blend") {
      script = "FG_MOTION.blendKeyframes();";
    }

    // 2. Anchor
    else if (act.indexOf("anchor:grid:") === 0) {
      var coords = act.replace("anchor:grid:", "").split(",");
      var lockRot = getBool("anchorLockRot");
      var incMask = getBool("anchorIncMasks");
      script = "FG_MOTION.setAnchorPoint(" + coords[0] + ", " + coords[1] + ", " + lockRot + ", " + incMask + ");";
    } else if (act === "anchor:center") {
      script = "FG_MOTION.centerAnchor();";
    } else if (act === "anchor:comp") {
      script = "FG_MOTION.centerToComp();";
    }

    // 3. Align & Distribute
    else if (act.indexOf("align:") === 0) {
      var aParts = act.split(":"); // align:x:min, align:y:mid, etc.
      var target = getVal("alignTarget", "comp");
      script = "FG_MOTION.alignLayers('" + aParts[1] + "', '" + aParts[2] + "', '" + target + "');";
    } else if (act.indexOf("dist:") === 0) {
      var dParts = act.split(":"); // dist:x, dist:y
      var dMode = getVal("distMode", "equal");
      var dGap = getVal("distGapVal", "40");
      script = "FG_MOTION.distributeLayers('" + dParts[1] + "', '" + dMode + "', " + dGap + ");";
    } else if (act.indexOf("flip:") === 0) {
      var fAxis = act.split(":")[1]; // flip:h, flip:v
      script = "FG_MOTION.flipLayers('" + fAxis + "');";
    } else if (act.indexOf("arrange:") === 0) {
      var arrDir = act.split(":")[1]; // front, back, reverse
      script = "FG_MOTION.arrangeLayers('" + arrDir + "');";
    }

    // 4. Rigs & Physics
    else if (act === "rig:excite") {
      var over = getVal("exciteOver", "20");
      var bnc = getVal("exciteBounce", "40");
      var fric = getVal("exciteFric", "40");
      script = "FG_MOTION.applyExcite(" + over + ", " + bnc + ", " + fric + ");";
    } else if (act === "rig:jump") {
      var str = getVal("jumpStretch", "60");
      var grav = getVal("jumpGrav", "8");
      script = "FG_MOTION.applyJump(" + str + ", " + grav + ");";
    } else if (act === "rig:burst") {
      var rays = getVal("burstRays", "8");
      var rad = getVal("burstRadius", "120");
      script = "FG_MOTION.createBurst(" + rays + ", " + rad + ");";
    } else if (act === "rig:spin") {
      var deg = getVal("spinSpeed", "180");
      script = "FG_MOTION.applySpin(" + deg + ");";
    } else if (act === "rig:dynamics") {
      var freq = getVal("dynFreq", "2");
      var amp = getVal("dynAmp", "30");
      script = "FG_MOTION.applyDynamics(" + freq + ", " + amp + ");";
    } else if (act === "rig:delay") {
      var df = getVal("delayFrames", "5");
      script = "FG_MOTION.applyDelay(" + df + ");";
    }

    // 5. Keyframes
    else if (act.indexOf("key:clone:") === 0) {
      var cMode = act.split(":")[2]; // regular, inverse
      script = "FG_MOTION.cloneKeyframes('" + cMode + "');";
    } else if (act.indexOf("key:stagger:") === 0) {
      var sDir = act.split(":")[2]; // down, up
      var sStep = getVal("staggerStep", "2");
      script = "FG_MOTION.staggerLayers(" + sStep + ", '" + sDir + "');";
    } else if (act === "key:separate") {
      script = "FG_MOTION.separatePosition();";
    } else if (act.indexOf("key:trim:") === 0) {
      var tMode = act.split(":")[2]; // in, out, both
      script = "FG_MOTION.trimToKeys('" + tMode + "');";
    } else if (act === "key:trimpaths") {
      script = "FG_MOTION.addTrimPaths();";
    }

    // 6. Utilities
    else if (act === "util:null") {
      var pBool = getBool("nullParent");
      script = "FG_MOTION.createNullRig(" + pBool + ");";
    } else if (act.indexOf("util:textbreak:") === 0) {
      var tbMode = act.split(":")[2]; // char, word, line
      script = "FG_MOTION.breakText('" + tbMode + "');";
    } else if (act === "util:rename") {
      var rPre = getVal("renPrefix", "");
      var rSuf = getVal("renSuffix", "");
      var rFind = getVal("renFind", "");
      var rRep = getVal("renReplace", "");
      var rNum = getBool("renNumber");
      script = "FG_MOTION.batchRename('" + rPre + "', '" + rSuf + "', '" + rFind + "', '" + rRep + "', " + rNum + ");";
    } else if (act === "util:crop") {
      script = "FG_MOTION.cropCompToLayer();";
    } else if (act === "util:snapshot") {
      script = "FG_MOTION.snapshotFrame();";
    } else if (act === "util:trash") {
      script = "FG_MOTION.trashClean();";
    }

    // 7. Color
    else if (act === "color:apply") {
      var colHex = getVal("colorHex", "#f2631c");
      var colMode = getVal("colorMode", "fill");
      var colOp = getVal("colorOpacity", "100");
      script = "FG_MOTION.applyColor('" + colHex + "', '" + colMode + "', " + colOp + ");";
    } else if (act === "color:swap") {
      script = "FG_MOTION.swapColors();";
    }

    if (script) {
      evalES(script, setStatus);
    }
  }

  // ---------------------------------------------------------
  // EVENT LISTENERS
  // ---------------------------------------------------------
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (btn) {
      handleAction(btn.getAttribute("data-act"));
      return;
    }

    var presetBtn = e.target.closest("button[data-preset]");
    if (presetBtn && window.FG_CURVE) {
      window.FG_CURVE.setPreset(presetBtn.getAttribute("data-preset"));
      return;
    }

    var anchorBtn = e.target.closest("button.anchor-pt");
    if (anchorBtn) {
      document.querySelectorAll(".anchor-pt").forEach(function(b) { b.classList.remove("is-active"); });
      anchorBtn.classList.add("is-active");
      handleAction("anchor:grid:" + anchorBtn.getAttribute("data-anchor"));
      return;
    }

    var swatch = e.target.closest(".swatch-chip");
    if (swatch) {
      var hex = swatch.getAttribute("data-hex");
      var hexInput = document.getElementById("colorHex");
      var previewBox = document.getElementById("colorPreview");
      if (hexInput) hexInput.value = hex;
      if (previewBox) previewBox.style.background = hex;
      handleAction("color:apply");
      return;
    }
  });

  // Category Tabs filtering
  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      tabButtons.forEach(function(b) { b.classList.remove("is-active"); });
      btn.classList.add("is-active");
      var cat = btn.getAttribute("data-cat");

      var cards = document.querySelectorAll("#content .card");
      cards.forEach(function (card) {
        if (cat === "all" || card.getAttribute("data-category") === cat) {
          card.style.display = "";
        } else {
          card.style.display = "none";
        }
      });
    });
  });

  // Quick Search
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      var query = searchInput.value.toLowerCase().trim();
      if (clearSearchBtn) clearSearchBtn.style.display = query ? "block" : "none";

      var cards = document.querySelectorAll("#content .card");
      cards.forEach(function (card) {
        if (!query) {
          card.style.display = "";
          return;
        }
        var text = card.textContent.toLowerCase();
        if (text.indexOf(query) !== -1) {
          card.style.display = "";
        } else {
          card.style.display = "none";
        }
      });
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener("click", function () {
      if (searchInput) {
        searchInput.value = "";
        searchInput.dispatchEvent(new Event("input"));
      }
    });
  }

  // Initial check
  if (hasHost()) {
    setStatus("OK|Feugee Motion ready");
  } else {
    setStatus("INFO|Browser preview mode");
  }

})(window);
