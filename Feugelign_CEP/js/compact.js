/* =========================================================
   FEUGELIGN - ULTRA-COMPACT PALETTE CONTROLLER
   Builds high-density tool-palette UI inside #compact and
   keeps two-way sync with the Full view & panel state.
   Load AFTER js/modes.js.
   ========================================================= */
(function () {
  "use strict";

  var compact = document.getElementById("compact");
  if (!compact) return;

  // ---------------------------------------------------------
  // SVG ICONS
  // ---------------------------------------------------------
  var ICONS = {
    alignLeft:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="4" y1="3.5" x2="4" y2="20.5"/>' +
      '<rect x="6.5" y="6" width="12" height="4.5" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '<rect x="6.5" y="13.5" width="7.5" height="4.5" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '</svg>',

    alignCenterH:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="12" y1="3.5" x2="12" y2="20.5"/>' +
      '<rect x="4" y="6" width="16" height="4.5" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '<rect x="8.2" y="13.5" width="7.6" height="4.5" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '</svg>',

    alignRight:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="20" y1="3.5" x2="20" y2="20.5"/>' +
      '<rect x="5.5" y="6" width="12" height="4.5" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '<rect x="10" y="13.5" width="7.5" height="4.5" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '</svg>',

    center2D:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="12" y1="3.5" x2="12" y2="7.5"/>' +
      '<line x1="12" y1="16.5" x2="12" y2="20.5"/>' +
      '<line x1="3.5" y1="12" x2="7.5" y2="12"/>' +
      '<line x1="16.5" y1="12" x2="20.5" y2="12"/>' +
      '<rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" fill-opacity="0.2"/>' +
      '</svg>',

    alignTop:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="3.5" y1="4" x2="20.5" y2="4"/>' +
      '<rect x="6" y="6.5" width="4.5" height="12" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '<rect x="13.5" y="6.5" width="4.5" height="7.5" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '</svg>',

    alignCenterV:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="3.5" y1="12" x2="20.5" y2="12"/>' +
      '<rect x="6" y="4" width="4.5" height="16" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '<rect x="13.5" y="8.2" width="4.5" height="7.6" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '</svg>',

    alignBottom:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="3.5" y1="20" x2="20.5" y2="20"/>' +
      '<rect x="6" y="5.5" width="4.5" height="12" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '<rect x="13.5" y="10" width="4.5" height="7.5" rx="1" fill="currentColor" fill-opacity="0.15"/>' +
      '</svg>',

    depthBack:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 14l6-3 6 3-6 3z" fill="currentColor" fill-opacity="0.35"/>' +
      '<path d="M7 14l6-3 6 3-6 3z"/>' +
      '<path d="M5 10l6-3 6 3-6 3z" stroke-opacity="0.6"/>' +
      '<path d="M3 6l6-3 6 3-6 3z" stroke-opacity="0.4"/>' +
      '</svg>',

    depthMid:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 14l6-3 6 3-6 3z" stroke-opacity="0.4"/>' +
      '<path d="M5 10l6-3 6 3-6 3z" fill="currentColor" fill-opacity="0.35"/>' +
      '<path d="M5 10l6-3 6 3-6 3z"/>' +
      '<path d="M3 6l6-3 6 3-6 3z" stroke-opacity="0.4"/>' +
      '</svg>',

    depthFront:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 14l6-3 6 3-6 3z" stroke-opacity="0.4"/>' +
      '<path d="M5 10l6-3 6 3-6 3z" stroke-opacity="0.6"/>' +
      '<path d="M3 6l6-3 6 3-6 3z" fill="currentColor" fill-opacity="0.35"/>' +
      '<path d="M3 6l6-3 6 3-6 3z"/>' +
      '</svg>',

    center3D:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="12" y1="3" x2="12" y2="7.5"/>' +
      '<line x1="12" y1="16.5" x2="12" y2="21"/>' +
      '<line x1="4.2" y1="7.5" x2="8.1" y2="9.8"/>' +
      '<line x1="15.9" y1="14.2" x2="19.8" y2="16.5"/>' +
      '<line x1="19.8" y1="7.5" x2="15.9" y2="9.8"/>' +
      '<line x1="8.1" y1="14.2" x2="4.2" y2="16.5"/>' +
      '<path d="M12 8.5l3.5 2v3.8L12 16.3l-3.5-2v-3.8z" fill="currentColor" fill-opacity="0.25"/>' +
      '<path d="M12 8.5l3.5 2-3.5 2-3.5-2z"/>' +
      '<line x1="12" y1="12.5" x2="12" y2="16.3"/>' +
      '</svg>',

    targetComp:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<rect x="7.5" y="7.5" width="9" height="9" rx="1" fill="currentColor" fill-opacity="0.2"/>' +
      '</svg>',

    targetSel:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="3" width="3" height="3" fill="currentColor"/>' +
      '<rect x="18" y="3" width="3" height="3" fill="currentColor"/>' +
      '<rect x="18" y="18" width="3" height="3" fill="currentColor"/>' +
      '<rect x="3" y="18" width="3" height="3" fill="currentColor"/>' +
      '<path d="M6 4.5h12 M6 19.5h12 M4.5 6v12 M19.5 6v12" stroke-dasharray="2.5 2"/>' +
      '<circle cx="12" cy="12" r="1.6" fill="currentColor"/>' +
      '</svg>',

    targetKey:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="3" width="3" height="3" fill="currentColor"/>' +
      '<rect x="18" y="3" width="3" height="3" fill="currentColor"/>' +
      '<rect x="18" y="18" width="3" height="3" fill="currentColor"/>' +
      '<rect x="3" y="18" width="3" height="3" fill="currentColor"/>' +
      '<path d="M6 4.5h12 M6 19.5h12 M4.5 6v12 M19.5 6v12" stroke-dasharray="2.5 2"/>' +
      '<circle cx="10" cy="13" r="2.2"/>' +
      '<path d="M11.5 11.5L16 7 M14 9l1.2 1.2 M15.2 7.8l1.2 1.2"/>' +
      '</svg>',

    distX:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="4" y1="3.5" x2="4" y2="20.5"/>' +
      '<line x1="20" y1="3.5" x2="20" y2="20.5"/>' +
      '<rect x="9.5" y="6" width="5" height="12" rx="1" fill="currentColor" fill-opacity="0.2"/>' +
      '</svg>',

    distY:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="3.5" y1="4" x2="20.5" y2="4"/>' +
      '<line x1="3.5" y1="20" x2="20.5" y2="20"/>' +
      '<rect x="6" y="9.5" width="12" height="5" rx="1" fill="currentColor" fill-opacity="0.2"/>' +
      '</svg>',

    distZ:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 15l5-2.5 5 2.5-5 2.5z"/>' +
      '<path d="M6 10l5-2.5 5 2.5-5 2.5z" stroke-opacity="0.75"/>' +
      '<path d="M5 5l5-2.5 5 2.5-5 2.5z" stroke-opacity="0.5"/>' +
      '</svg>',

    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="m5 12 5 5 9-10"/>' +
      '</svg>',

    chevron:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="m6 9 6 6 6-6"/>' +
      '</svg>'
  };

  // ---------------------------------------------------------
  // BUILD COMPACT PALETTE DOM
  // ---------------------------------------------------------
  compact.innerHTML =
    '<div class="compact-palette">' +
      '<!-- ALIGN SECTION -->' +
      '<div class="cp-section">' +
        '<div class="cp-row cp-header-row">' +
          '<span class="cp-label">Align by:</span>' +
          '<div class="cp-select-wrap">' +
            '<select id="cpAlignBy" class="cp-select">' +
              '<option value="view">View</option>' +
              '<option value="world">World</option>' +
              '<option value="viewworld">View via World</option>' +
            '</select>' +
            '<span class="cp-chevron">' + ICONS.chevron + '</span>' +
          '</div>' +
        '</div>' +

        '<div class="cp-row cp-checks-row">' +
          '<label class="cp-check" title="Move in shared parent local space">' +
            '<input type="checkbox" id="cpViaParent">' +
            '<span class="cp-box">' + ICONS.check + '</span>' +
            '<span>via Parent</span>' +
          '</label>' +
          '<label class="cp-check" title="Keep on-screen size when moving in depth (VIEW mode)">' +
            '<input type="checkbox" id="cpScaleComp">' +
            '<span class="cp-box">' + ICONS.check + '</span>' +
            '<span>Scale comp</span>' +
          '</label>' +
        '</div>' +

        '<!-- ALIGN MATRIX: 7 COLUMNS -->' +
        '<div class="cp-matrix">' +
          '<div class="cp-grid-row">' +
            '<div class="cp-group cp-group-h">' +
              '<button class="tile cp-tile" data-act="align:x:min" title="Align left">' + ICONS.alignLeft + '</button>' +
              '<button class="tile cp-tile" data-act="align:x:mid" title="Align horizontal centre">' + ICONS.alignCenterH + '</button>' +
              '<button class="tile cp-tile" data-act="align:x:max" title="Align right">' + ICONS.alignRight + '</button>' +
            '</div>' +
            '<div class="cp-group cp-group-center2d">' +
              '<button class="tile cp-tile" data-act="align:xy:mid" title="Center 2D: Horizontal & Vertical">' + ICONS.center2D + '</button>' +
            '</div>' +
            '<div class="cp-group cp-group-v">' +
              '<button class="tile cp-tile" data-act="align:y:min" title="Align top">' + ICONS.alignTop + '</button>' +
              '<button class="tile cp-tile" data-act="align:y:mid" title="Align vertical centre">' + ICONS.alignCenterV + '</button>' +
              '<button class="tile cp-tile" data-act="align:y:max" title="Align bottom">' + ICONS.alignBottom + '</button>' +
            '</div>' +
          '</div>' +

          '<div class="cp-grid-row">' +
            '<div class="cp-group cp-group-z">' +
              '<button class="tile cp-tile" data-act="align:z:max" title="Align depth far (back)">' + ICONS.depthBack + '</button>' +
              '<button class="tile cp-tile" data-act="align:z:mid" title="Align depth middle">' + ICONS.depthMid + '</button>' +
              '<button class="tile cp-tile" data-act="align:z:min" title="Align depth near (front)">' + ICONS.depthFront + '</button>' +
            '</div>' +
            '<div class="cp-group cp-group-center3d">' +
              '<button class="tile cp-tile" data-act="align:xyz:mid" title="Center 3D: X, Y & Depth Z">' + ICONS.center3D + '</button>' +
            '</div>' +
            '<div class="cp-group cp-group-spacer"></div>' +
          '</div>' +
        '</div>' +

        '<!-- ALIGN TO -->' +
        '<div class="cp-row cp-to-row">' +
          '<div class="cp-to-left">' +
            '<span class="cp-label">Align to:</span>' +
            '<div class="cp-to-buttons">' +
              '<button class="tile cp-tile mode is-on" data-mode="to" data-val="comp" id="cpToComp" title="Align to composition">' + ICONS.targetComp + '</button>' +
              '<button class="tile cp-tile mode" data-mode="to" data-val="sel" id="cpToSel" title="Align to selection bounds">' + ICONS.targetSel + '</button>' +
              '<button class="tile cp-tile mode" data-mode="to" data-val="key" id="cpToKey" title="Align to key object (last clicked)">' + ICONS.targetKey + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="cp-safe-chips" id="cpSafeChips">' +
            '<button class="tile chip mode is-on" data-mode="safe" data-val="edge" title="Full composition edge">EDGE</button>' +
            '<button class="tile chip mode" data-mode="safe" data-val="action" title="Action safe (90%)">ACT</button>' +
            '<button class="tile chip mode" data-mode="safe" data-val="title" title="Title safe (80%)">TIT</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<!-- DIVIDER -->' +
      '<hr class="cp-divider">' +

      '<!-- DISTRIBUTE SECTION -->' +
      '<div class="cp-section">' +
        '<div class="cp-row cp-header-row">' +
          '<span class="cp-label">Distribute by:</span>' +
          '<div class="cp-select-wrap">' +
            '<select id="cpDistBy" class="cp-select">' +
              '<option value="view">View</option>' +
              '<option value="world">World</option>' +
              '<option value="viewworld">View via World</option>' +
            '</select>' +
            '<span class="cp-chevron">' + ICONS.chevron + '</span>' +
          '</div>' +
        '</div>' +

        '<div class="cp-row cp-checks-row">' +
          '<label class="cp-check" title="Distribute in shared parent local space">' +
            '<input type="checkbox" id="cpDistViaParent">' +
            '<span class="cp-box">' + ICONS.check + '</span>' +
            '<span>via Parent</span>' +
          '</label>' +
          '<div class="cp-dm-toggle" id="cpDmToggle" title="Equal edge gaps (Figma) vs equal centres (AE)">' +
            '<button class="tile chip mode is-on" data-mode="dm" data-val="gap">GAP</button>' +
            '<button class="tile chip mode" data-mode="dm" data-val="center">CTR</button>' +
          '</div>' +
        '</div>' +

        '<div class="cp-row cp-dist-row">' +
          '<div class="cp-dist-buttons">' +
            '<button class="tile cp-tile" id="cpDistX" data-act="dist:x" title="Distribute horizontally">' + ICONS.distX + '</button>' +
            '<button class="tile cp-tile" id="cpDistY" data-act="dist:y" title="Distribute vertically">' + ICONS.distY + '</button>' +
            '<button class="tile cp-tile" id="cpDistZ" data-act="dist:z" title="Distribute in depth (3D)">' + ICONS.distZ + '</button>' +
          '</div>' +
          '<div class="cp-fixed-group" id="cpFixedGroup">' +
            '<label class="cp-check cp-fixed-check" title="Check to enforce fixed distance spacing">' +
              '<input type="checkbox" id="cpFixedGapCheck">' +
              '<span class="cp-box">' + ICONS.check + '</span>' +
            '</label>' +
            '<div class="cp-input-wrap">' +
              '<input type="text" id="cpGapVal" class="cp-input" value="40" title="Fixed spacing gap in pixels">' +
              '<span class="cp-unit">px</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  // ---------------------------------------------------------
  // TWO-WAY SYNCHRONIZATION
  // ---------------------------------------------------------
  var alignBySelect    = document.getElementById("cpAlignBy");
  var viaParentCheck   = document.getElementById("cpViaParent");
  var scaleCompCheck   = document.getElementById("cpScaleComp");
  var safeChipsWrap    = document.getElementById("cpSafeChips");
  var distBySelect     = document.getElementById("cpDistBy");
  var distViaParent    = document.getElementById("cpDistViaParent");
  var fixedGapCheck    = document.getElementById("cpFixedGapCheck");
  var fixedGroup       = document.getElementById("cpFixedGroup");
  var cpGapVal         = document.getElementById("cpGapVal");
  var distX            = document.getElementById("cpDistX");
  var distY            = document.getElementById("cpDistY");
  var distZ            = document.getElementById("cpDistZ");
  var dmToggle         = document.getElementById("cpDmToggle");

  // Full view inputs
  var srcGapVal        = document.getElementById("gapVal");
  var srcScaleComp     = document.getElementById("scaleComp");

  function getPanelState() {
    return window.FG_PANEL ? window.FG_PANEL.STATE : null;
  }

  function syncFromState() {
    var state = getPanelState();
    if (!state) return;

    // Align by / via Parent
    if (state.by === "parent") {
      viaParentCheck.checked = true;
      distViaParent.checked = true;
    } else {
      viaParentCheck.checked = false;
      distViaParent.checked = false;
      alignBySelect.value = state.by;
      distBySelect.value = state.by;
    }

    // Scale comp
    if (srcScaleComp) {
      scaleCompCheck.checked = srcScaleComp.checked;
    }

    // Gap value
    if (srcGapVal) {
      cpGapVal.value = srcGapVal.value;
    }

    // Safe chips visibility
    if (safeChipsWrap) {
      safeChipsWrap.classList.toggle("is-hidden", state.to !== "comp");
    }

    // Mode buttons reflect state
    var modes = compact.querySelectorAll(".mode");
    for (var i = 0; i < modes.length; i++) {
      var g = modes[i].getAttribute("data-mode");
      var v = modes[i].getAttribute("data-val");
      modes[i].classList.toggle("is-on", state[g] === v);
    }
  }

  // Hook into panel.js mode changes
  if (window.FG_PANEL) {
    var prevOnModeChange = window.FG_PANEL.onModeChange;
    window.FG_PANEL.onModeChange = function (group, val) {
      if (typeof prevOnModeChange === "function") prevOnModeChange(group, val);
      syncFromState();
    };
  }

  // Align by select
  alignBySelect.addEventListener("change", function () {
    var val = alignBySelect.value;
    viaParentCheck.checked = false;
    distBySelect.value = val;
    distViaParent.checked = false;
    updateByMode(val);
  });

  // Distribute by select
  distBySelect.addEventListener("change", function () {
    var val = distBySelect.value;
    distViaParent.checked = false;
    alignBySelect.value = val;
    viaParentCheck.checked = false;
    updateByMode(val);
  });

  // via Parent checkboxes
  viaParentCheck.addEventListener("change", function () {
    var on = viaParentCheck.checked;
    distViaParent.checked = on;
    updateByMode(on ? "parent" : alignBySelect.value);
  });

  distViaParent.addEventListener("change", function () {
    var on = distViaParent.checked;
    viaParentCheck.checked = on;
    updateByMode(on ? "parent" : distBySelect.value);
  });

  function updateByMode(val) {
    var state = getPanelState();
    if (!state) return;
    state.by = val;

    // Trigger update in full mode tiles
    var fullPeers = document.getElementById("content").querySelectorAll('.mode[data-mode="by"]');
    for (var i = 0; i < fullPeers.length; i++) {
      fullPeers[i].classList.toggle("is-on", fullPeers[i].getAttribute("data-val") === val);
    }

    if (window.FG_PANEL) {
      window.FG_PANEL.paintMeta();
      window.FG_PANEL.setStatus("Space: via " + val, "ok", "var(--blue)");
    }
  }

  // Scale compensate checkbox
  scaleCompCheck.addEventListener("change", function () {
    if (srcScaleComp) {
      srcScaleComp.checked = scaleCompCheck.checked;
      if (window.FG_PANEL) window.FG_PANEL.paintMeta();
    }
  });
  if (srcScaleComp) {
    srcScaleComp.addEventListener("change", function () {
      scaleCompCheck.checked = srcScaleComp.checked;
    });
  }

  // Gap value input
  cpGapVal.addEventListener("input", function () {
    if (srcGapVal) {
      srcGapVal.value = cpGapVal.value;
      if (window.FG_PANEL) window.FG_PANEL.paintMeta();
    }
  });
  cpGapVal.addEventListener("blur", function () {
    var num = parseFloat(cpGapVal.value);
    if (isNaN(num) || num < 0) num = 40;
    cpGapVal.value = String(num);
    if (srcGapVal) srcGapVal.value = String(num);
  });
  if (srcGapVal) {
    srcGapVal.addEventListener("input", function () {
      cpGapVal.value = srcGapVal.value;
    });
  }

  // Fixed Gap Checkbox toggle: switches Distribute buttons between 'dist' and 'distd'
  fixedGapCheck.addEventListener("change", function () {
    var isFixed = fixedGapCheck.checked;
    fixedGroup.classList.toggle("is-active", isFixed);

    // Switch action strings
    distX.setAttribute("data-act", isFixed ? "distd:x" : "dist:x");
    distY.setAttribute("data-act", isFixed ? "distd:y" : "dist:y");
    distZ.setAttribute("data-act", isFixed ? "distd:z" : "dist:z");

    distX.title = isFixed ? "Fixed spacing horizontally (gap " + cpGapVal.value + "px)" : "Distribute horizontally";
    distY.title = isFixed ? "Fixed spacing vertically (gap " + cpGapVal.value + "px)" : "Distribute vertically";
    distZ.title = isFixed ? "Fixed spacing in depth (gap " + cpGapVal.value + "px)" : "Distribute in depth (3D)";

    // Toggle DM toggle chips opacity
    if (dmToggle) dmToggle.style.opacity = isFixed ? "0.3" : "1";
    if (dmToggle) dmToggle.style.pointerEvents = isFixed ? "none" : "auto";

    if (window.FG_PANEL) {
      window.FG_PANEL.setStatus(isFixed ? "Fixed Spacing active (" + cpGapVal.value + "px)" : "Equal Distribute active", "ok", "var(--orange)");
    }
  });

  // Re-sync whenever user toggles into compact mode
  var bComp = document.querySelector(".modes button:last-child");
  if (bComp) {
    bComp.addEventListener("click", function () {
      setTimeout(syncFromState, 10);
    });
  }

  // Initial synchronization
  syncFromState();
})();
