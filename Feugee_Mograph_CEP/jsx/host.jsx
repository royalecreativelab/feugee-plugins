/**
 * FEUGEE STUDIO - FEUGEE MOGRAPH  |  HOST SCRIPT (ExtendScript)
 *
 * Procedural cloners and effectors for After Effects, rebuilt on the Feugee
 * CEP standard. Everything is driven by expressions, so a rig keeps working
 * without the panel installed.
 *
 *   Cloners    Grid, Array, Linear              (Null controllers)
 *   Effectors  Field, Step, Noise, Target,      (guide shape controllers)
 *              Inheritance
 *   Helpers    Link, Unlink, Select, Copy, Organize, Clean, Bake, Sample
 *
 * How a rig is wired
 *   controller layer   comment "FGM|<kind>|<id>", effects hold the settings,
 *                      "Link Range" = [first linked layer index, link count]
 *   linked layer       one Layer Control per controller: "FGM Link <id>"
 *   linked property    generated expression, first line lists its links:
 *                      // FGM:cloner=AB12;field=CD34~Scale
 *
 * Every public call returns "OK|message" or "ERR|message" and never opens a
 * dialog. One public action = one undo group, opened in exactly one place
 * (see pitfall #16 in the Feugee CEP standard).
 *
 * Only one global is created: FG_MOGRAPH.
 */

var FG_MOGRAPH = (function () {

    var PREFIX = "FGM";
    var LINK_FX = "FGM Link ";
    var HEADER = "// FGM:";

    var CLONERS = { grid: 1, array: 1, linear: 1 };
    var EFFECTORS = { field: 1, step: 1, noise: 1, target: 1, inherit: 1 };
    var TITLE = {
        grid: "Grid", array: "Array", linear: "Linear", field: "Field",
        step: "Step", noise: "Noise", target: "Target", inherit: "Inherit"
    };
    var CLONER_TYPE = { grid: 1, array: 2, linear: 3 };
    // AE label colours: 9 green, 4 pink, 10 purple
    var LABEL = { grid: 9, array: 9, linear: 9, field: 4, step: 10, noise: 10, target: 10, inherit: 10 };
    var ORDER = { cloner: 0, inherit: 1, step: 2, field: 3, noise: 4, target: 5 };

    // ==========================================================
    // SMALL UTILITIES (ExtendScript has no Array.indexOf / JSON / trim)
    // ==========================================================
    function idxOf(arr, v) {
        for (var i = 0; i < arr.length; i++) if (arr[i] === v) return i;
        return -1;
    }

    /* ExtendScript hands out a fresh wrapper object per access, so layers are
       compared by index, never with === */
    function hasLayer(arr, l) {
        for (var i = 0; i < arr.length; i++) if (arr[i].index === l.index) return true;
        return false;
    }

    function clean(s) {
        return String(s).replace(/["\\;=~|\r\n]/g, " ").replace(/^\s+|\s+$/g, "");
    }

    function newId(comp) {
        var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        for (var tries = 0; tries < 200; tries++) {
            var s = "";
            for (var i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
            if (!findCtrlById(comp, s)) return s;
        }
        return "X" + new Date().getTime().toString(36).toUpperCase();
    }

    function activeComp() {
        var c = app.project.activeItem;
        return (c instanceof CompItem) ? c : null;
    }

    function layerIsLocked(l) {
        try { return l.locked; } catch (e) { return false; }
    }

    // ==========================================================
    // CONTROLLER IDENTITY
    // ==========================================================
    function ctrlInfo(layer) {
        var c = "";
        try { c = layer.comment || ""; } catch (e) { return null; }
        var m = c.match(/^FGM\|([a-z]+)\|([A-Z0-9]+)/);
        if (!m || !(CLONERS[m[1]] || EFFECTORS[m[1]])) return null;
        return { kind: m[1], id: m[2], layer: layer };
    }

    function isCtrl(layer) { return !!ctrlInfo(layer); }

    function controllers(comp) {
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var info = ctrlInfo(comp.layer(i));
            if (info) out.push(info);
        }
        return out;
    }

    function findCtrlById(comp, id) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var info = ctrlInfo(comp.layer(i));
            if (info && info.id === id) return info;
        }
        return null;
    }

    function category(kind) { return CLONERS[kind] ? "cloner" : "effector"; }

    function nextNumber(comp, kind) {
        var n = 0;
        var re = new RegExp("^" + PREFIX + " " + TITLE[kind] + " (\\d+)$");
        for (var i = 1; i <= comp.numLayers; i++) {
            var m = comp.layer(i).name.match(re);
            if (m) n = Math.max(n, parseInt(m[1], 10));
        }
        return n + 1;
    }

    /* A controller duplicated with Cmd+D keeps its comment, so two layers can
       carry the same id. Give the later one a fresh id and move every link
       that points at it onto the new id. */
    function ensureUniqueIds(comp) {
        var seen = {};
        var list = controllers(comp);
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            if (!seen[c.id]) { seen[c.id] = 1; continue; }
            var fresh = newId(comp);
            c.layer.comment = PREFIX + "|" + c.kind + "|" + fresh;
            for (var j = 1; j <= comp.numLayers; j++) {
                var l = comp.layer(j);
                var fx = linkEffect(l, c.id);
                if (!fx) continue;
                var pointsAt = 0;
                try { pointsAt = fx.property(1).value; } catch (e) {}
                if (pointsAt === c.layer.index) renameLinkId(l, c.id, fresh);
            }
        }
    }

    // ==========================================================
    // EFFECT BUILDERS
    // Adding an effect can invalidate references to sibling effects, so every
    // builder fetches the new effect by index and never keeps it around.
    // ==========================================================
    function parade(layer) { return layer.property("ADBE Effect Parade"); }

    function lastFx(layer) {
        var p = parade(layer);
        return p.property(p.numProperties);
    }

    function fxByName(layer, name) {
        var p = parade(layer);
        for (var i = 1; i <= p.numProperties; i++) {
            if (p.property(i).name === name) return p.property(i);
        }
        return null;
    }

    var MATCH = {
        slider: "ADBE Slider Control", angle: "ADBE Angle Control", check: "ADBE Checkbox Control",
        point: "ADBE Point Control", point3: "ADBE Point3D Control", color: "ADBE Color Control",
        layer: "ADBE Layer Control"
    };

    function addFx(layer, type, name, val, expr) {
        if (type === "drop") return addDrop(layer, name, val[0], val[1]);
        if (type === "spline") return addSpline(layer, name);
        parade(layer).addProperty(MATCH[type]);
        var fx = lastFx(layer);
        fx.name = name;
        if (val !== undefined && val !== null) {
            try { lastFx(layer).property(1).setValue(val); } catch (e) {}
        }
        if (expr) {
            try { lastFx(layer).property(1).expression = expr; } catch (e2) {}
        }
        return lastFx(layer).propertyIndex;
    }

    function addDrop(layer, name, items, val) {
        try {
            parade(layer).addProperty("ADBE Dropdown Control");
            var idx = lastFx(layer).propertyIndex;
            parade(layer).property(idx).property(1).setPropertyParameters(items);
            parade(layer).property(idx).name = name;
            parade(layer).property(idx).property(1).setValue(val);
            return idx;
        } catch (e) {
            // AE older than 17.0.1 has no scriptable dropdown: fall back to a slider
            var bad = lastFx(layer);
            try { if (bad && bad.matchName === "ADBE Dropdown Control") bad.remove(); } catch (e2) {}
            return addFx(layer, "slider", name, val);
        }
    }

    function addSpline(layer, name) {
        parade(layer).addProperty("ADBE Slider Control");
        var idx = lastFx(layer).propertyIndex;
        parade(layer).property(idx).name = name;
        var p = parade(layer).property(idx).property(1);
        p.setValueAtTime(0, 0);
        p = parade(layer).property(idx).property(1);
        p.setValueAtTime(1, 100);
        p = parade(layer).property(idx).property(1);
        for (var k = 1; k <= p.numKeys; k++) {
            p.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        }
        return idx;
    }

    // Link Range = [first linked layer index, number of linked layers]
    var RANGE_EXPR = [
        "var first = 0, n = 0;",
        "for (var j = 1; j <= thisComp.numLayers; j++) {",
        "  var fx = null;",
        "  try { fx = thisComp.layer(j)(\"ADBE Effect Parade\"); } catch (e) { fx = null; }",
        "  if (!fx) continue;",
        "  for (var k = 1; k <= fx.numProperties; k++) {",
        "    var ef = fx(k);",
        "    if (ef.name.indexOf(\"FGM Link \") !== 0) continue;",
        "    var hit = false;",
        "    try { hit = ef(1).index === index; } catch (e2) { hit = false; }",
        "    if (hit) { if (n === 0) first = j; n++; break; }",
        "  }",
        "}",
        "[first, n];"
    ].join("\n");

    var DELAY_SPEC = [
        ["check", "Delay Enable", 0],
        ["slider", "Max Delay", 0.5],
        ["check", "Reverse Delay", 0],
        ["check", "Random Delay Enable", 0],
        ["slider", "Min Random Delay", -0.1],
        ["slider", "Max Random Delay", 0.1],
        ["slider", "Random Delay Seed", 1]
    ];

    var SCATTER_SPEC = [
        ["check", "Scatter Enable", 0],
        ["point", "Scatter X", [-50, 50]],
        ["point", "Scatter Y", [-50, 50]],
        ["point", "Scatter Z", [0, 0]],
        ["slider", "Scatter Seed", 1]
    ];

    var INFLUENCE_SPEC = [
        ["slider", "Random Influence", 0],
        ["slider", "Random Influence Seed", 1]
    ];

    function specFor(kind) {
        var s = [];
        var i;
        function push(list) { for (i = 0; i < list.length; i++) s.push(list[i]); }

        if (CLONERS[kind]) {
            s.push(["slider", "Cloner Type", CLONER_TYPE[kind], String(CLONER_TYPE[kind])]);
        }
        s.push(["point", "Link Range", [0, 0], RANGE_EXPR]);

        if (kind === "grid") {
            push([
                ["slider", "Grid X", 3], ["slider", "Grid Y", 3],
                ["slider", "X Gap", 150], ["slider", "Y Gap", 150],
                ["drop", "Pin X", [["Left", "Middle", "Right"], 2]],
                ["drop", "Pin Y", [["Top", "Middle", "Bottom"], 2]],
                ["check", "Link Rotation", 1], ["angle", "Base Rotation", 0]
            ]);
            push(DELAY_SPEC);
            s.push(["drop", "Delay Based On", [["Distance from Origin", "Distance along X", "Distance along Y", "Layer Index"], 1]]);
            push(SCATTER_SPEC);
        } else if (kind === "array") {
            push([
                ["slider", "Radius", 300], ["slider", "Start", 0], ["slider", "End", 100],
                ["angle", "Offset", 0], ["check", "Face Outward", 1],
                ["check", "Link Rotation", 1], ["angle", "Base Rotation", 0]
            ]);
            push(DELAY_SPEC);
            push(SCATTER_SPEC);
        } else if (kind === "linear") {
            push([
                ["slider", "Strength", 100],
                ["drop", "Mode", [["Endpoint", "Per Step"], 1]],
                ["point", "Position", [600, 0]], ["angle", "Rotation", 0], ["slider", "Scale", 100],
                ["check", "Reverse Layer Order", 0], ["spline", "Spline"],
                ["check", "Link Rotation", 1], ["angle", "Base Rotation", 0]
            ]);
            push(DELAY_SPEC);
            push(SCATTER_SPEC);
        } else if (kind === "field") {
            push([
                ["drop", "Shape", [["Circle", "Line"], 1]],
                ["slider", "Outer Radius", 300], ["slider", "Inner Radius", 100],
                ["slider", "Strength", 100], ["check", "Invert", 0]
            ]);
            push(DELAY_SPEC);
            push(INFLUENCE_SPEC);
        } else if (kind === "step") {
            push([
                ["slider", "Strength", 100],
                ["drop", "Mode", [["Endpoint", "Per Step"], 1]],
                ["check", "Reverse Layer Order", 0], ["slider", "Layers per Step", 1],
                ["spline", "Spline"]
            ]);
            push(DELAY_SPEC);
            push(INFLUENCE_SPEC);
        } else if (kind === "noise") {
            push([
                ["slider", "Strength", 100], ["check", "Enable Noise", 1],
                ["angle", "Evolution", 0], ["slider", "Evolution Speed", 0.25],
                ["slider", "Loop Period", 1], ["slider", "Noise Seed", 1]
            ]);
            push(DELAY_SPEC);
            push(INFLUENCE_SPEC);
        } else if (kind === "target") {
            push([
                ["check", "Look At", 1], ["slider", "Look At Strength", 100], ["angle", "Rotation Correction", 0],
                ["check", "Repel", 1], ["slider", "Outer Radius", 300], ["slider", "Inner Radius", 0],
                ["slider", "Force", 200], ["check", "Invert", 0], ["spline", "Repel Spline"]
            ]);
            push(DELAY_SPEC);
            push(INFLUENCE_SPEC);
        } else if (kind === "inherit") {
            s.push(["angle", "Morph Progress", 0]);
            push(DELAY_SPEC);
        }
        return s;
    }

    function buildControls(layer, kind) {
        var spec = specFor(kind);
        for (var i = 0; i < spec.length; i++) {
            addFx(layer, spec[i][0], spec[i][1], spec[i][2], spec[i][3]);
        }
    }

    // ==========================================================
    // CONTROLLER VISUALS (guide layers, never rendered)
    // ==========================================================
    function addRectGroup(layer, name, sizeExpr, roundExpr, rgb, width, dashed) {
        var root = layer.property("ADBE Root Vectors Group");
        root.addProperty("ADBE Vector Group");
        var gi = root.numProperties;
        root.property(gi).name = name;
        var vecs = function () { return layer.property("ADBE Root Vectors Group").property(gi).property("ADBE Vectors Group"); };
        vecs().addProperty("ADBE Vector Shape - Rect");
        var rect = vecs().property(vecs().numProperties);
        rect.property("ADBE Vector Rect Size").expression = sizeExpr;
        rect = vecs().property(vecs().numProperties);
        rect.property("ADBE Vector Rect Roundness").expression = roundExpr;
        vecs().addProperty("ADBE Vector Graphic - Stroke");
        var st = vecs().property(vecs().numProperties);
        st.property("ADBE Vector Stroke Color").setValue(rgb);
        st = vecs().property(vecs().numProperties);
        st.property("ADBE Vector Stroke Width").setValue(width);
        if (dashed) {
            try {
                st = vecs().property(vecs().numProperties);
                st.property("ADBE Vector Stroke Dashes").addProperty("ADBE Vector Stroke Dash 1");
                st = vecs().property(vecs().numProperties);
                st.property("ADBE Vector Stroke Dashes").property(1).setValue(14);
            } catch (e) {}
        }
    }

    function makeController(comp, kind, pos3, is3D) {
        var layer;
        if (CLONERS[kind]) {
            layer = comp.layers.addNull();
        } else {
            layer = comp.layers.addShape();
        }
        var id = newId(comp);
        layer.name = PREFIX + " " + TITLE[kind] + " " + nextNumber(comp, kind);
        layer.comment = PREFIX + "|" + kind + "|" + id;
        try { layer.label = LABEL[kind]; } catch (e) {}

        buildControls(layer, kind);

        if (!CLONERS[kind]) {
            layer.guideLayer = true;
            var pink = [0.96, 0.42, 0.72], purple = [0.62, 0.48, 0.96];
            if (kind === "field") {
                addRectGroup(layer, "Outer",
                    "var r = effect(\"Outer Radius\")(1) * 2; Math.round(effect(\"Shape\")(1)) === 2 ? [thisComp.width * 4, r] : [r, r];",
                    "Math.round(effect(\"Shape\")(1)) === 2 ? 0 : effect(\"Outer Radius\")(1);", pink, 3, false);
                addRectGroup(layer, "Inner",
                    "var r = effect(\"Inner Radius\")(1) * 2; Math.round(effect(\"Shape\")(1)) === 2 ? [thisComp.width * 4, r] : [r, r];",
                    "Math.round(effect(\"Shape\")(1)) === 2 ? 0 : effect(\"Inner Radius\")(1);", pink, 2, true);
            } else if (kind === "target") {
                addRectGroup(layer, "Repel",
                    "var r = effect(\"Outer Radius\")(1) * 2; [r, r];", "effect(\"Outer Radius\")(1);", purple, 2, true);
                addRectGroup(layer, "Core", "[40, 40];", "20;", purple, 4, false);
            } else {
                addRectGroup(layer, "Icon", "[70, 70];", "10;", purple, 4, false);
            }
        }

        if (is3D) { try { layer.threeDLayer = true; } catch (e3) {} }
        try {
            var p = layer.property("ADBE Transform Group").property("ADBE Position");
            p.setValue(is3D ? [pos3[0], pos3[1], pos3[2]] : [pos3[0], pos3[1]]);
        } catch (e4) {}

        return { kind: kind, id: id, layer: layer };
    }

    // ==========================================================
    // EXPRESSION LIBRARY
    // Written for both expression engines (legacy ExtendScript and JavaScript):
    // no const/let, no arrow functions, no array operators - only helper maths.
    // ==========================================================
    var LIB = [
        "function fgmFx(c, n, d, t) { try { return c.effect(n)(1).valueAtTime(t); } catch (e) { return d; } }",
        "function fgmAdd(a, b) {",
        "  if (typeof a === \"number\") return a + (typeof b === \"number\" ? b : b[0]);",
        "  var o = [];",
        "  for (var j = 0; j < a.length; j++) o.push(a[j] + (typeof b === \"number\" ? b : (j < b.length ? b[j] : 0)));",
        "  return o;",
        "}",
        "function fgmMul(a, k) {",
        "  if (typeof a === \"number\") return a * k;",
        "  var o = [];",
        "  for (var j = 0; j < a.length; j++) o.push(a[j] * k);",
        "  return o;",
        "}",
        "function fgmLerp(a, b, k) { return fgmAdd(a, fgmMul(fgmAdd(b, fgmMul(a, -1)), k)); }",
        "function fgmFit(w, keep) {",
        "  if (typeof keep === \"number\") return w[0];",
        "  var o = [];",
        "  for (var j = 0; j < keep.length; j++) o.push(j < w.length ? w[j] : keep[j]);",
        "  return o;",
        "}",
        "function fgmP3(p) { return [p[0], p[1], p.length > 2 ? p[2] : 0]; }",
        "function fgmSpline(c, n, f, t) {",
        "  try {",
        "    var s = c.effect(n)(1);",
        "    if (s.numKeys < 2) return f;",
        "    var a = s.key(1), b = s.key(s.numKeys), dv = b.value - a.value;",
        "    if (dv === 0) return f;",
        "    return (s.valueAtTime(a.time + f * (b.time - a.time)) - a.value) / dv;",
        "  } catch (e) { return f; }",
        "}",
        "function fgmRange(c) {",
        "  var r = [0, 1];",
        "  try { r = c.effect(\"Link Range\")(1).value; } catch (e) {}",
        "  var n = Math.max(1, Math.round(r[1]));",
        "  var i = Math.round(r[0]) > 0 ? index - Math.round(r[0]) : 0;",
        "  return [Math.max(0, Math.min(n - 1, i)), n];",
        "}",
        "function fgmDelay(c, i, df, t) {",
        "  var d = 0;",
        "  if (fgmFx(c, \"Delay Enable\", 0, t)) d = fgmFx(c, \"Max Delay\", 0.5, t) * (fgmFx(c, \"Reverse Delay\", 0, t) ? 1 - df : df);",
        "  if (fgmFx(c, \"Random Delay Enable\", 0, t)) {",
        "    seedRandom(Math.round(fgmFx(c, \"Random Delay Seed\", 1, t)) * 7919 + index * 31 + 7, true);",
        "    d += random(fgmFx(c, \"Min Random Delay\", -0.1, t), fgmFx(c, \"Max Random Delay\", 0.1, t));",
        "  }",
        "  return d;",
        "}",
        "function fgmAngle(L, t) {",
        "  var o = L.toWorld([0, 0, 0], t), u = L.toWorld([100, 0, 0], t);",
        "  return radiansToDegrees(Math.atan2(u[1] - o[1], u[0] - o[0]));",
        "}",
        "function fgmInfluence(c, f, t) {",
        "  var rin = fgmFx(c, \"Random Influence\", 0, t);",
        "  if (rin === 0) return f;",
        "  seedRandom(Math.round(fgmFx(c, \"Random Influence Seed\", 1, t)) * 7919 + index * 17 + 3, true);",
        "  return f * Math.max(0, 1 + random(-rin, rin) / 100);",
        "}",
        // cloner pose in controller space: [x, y, z, rotation, scale%, delay factor]
        "function fgmPose(c, i, n, t) {",
        "  var type = Math.round(fgmFx(c, \"Cloner Type\", 0, t));",
        "  var x = 0, y = 0, z = 0, r = 0, s = 100, df = n > 1 ? i / (n - 1) : 0;",
        "  if (type === 1) {",
        "    var cols = Math.max(1, Math.round(fgmFx(c, \"Grid X\", 3, t))), rows = Math.max(1, Math.round(fgmFx(c, \"Grid Y\", 3, t)));",
        "    var col = i % cols, row = Math.floor(i / cols);",
        "    var px = Math.round(fgmFx(c, \"Pin X\", 2, t)), py = Math.round(fgmFx(c, \"Pin Y\", 2, t));",
        "    var ox = px === 1 ? 0 : (px === 3 ? cols - 1 : (cols - 1) / 2);",
        "    var oy = py === 1 ? 0 : (py === 3 ? rows - 1 : (rows - 1) / 2);",
        "    x = (col - ox) * fgmFx(c, \"X Gap\", 150, t);",
        "    y = (row - oy) * fgmFx(c, \"Y Gap\", 150, t);",
        "    var mx = Math.max(ox, cols - 1 - ox), my = Math.max(oy, rows - 1 - oy);",
        "    var ux = mx > 0 ? Math.abs(col - ox) / mx : 0, uy = my > 0 ? Math.abs(row - oy) / my : 0;",
        "    var based = Math.round(fgmFx(c, \"Delay Based On\", 1, t));",
        "    if (based === 1) { var nrm = (mx > 0 ? 1 : 0) + (my > 0 ? 1 : 0); df = nrm > 0 ? Math.sqrt((ux * ux + uy * uy) / nrm) : 0; }",
        "    else if (based === 2) df = ux;",
        "    else if (based === 3) df = uy;",
        "  } else if (type === 2) {",
        "    var rad = fgmFx(c, \"Radius\", 300, t);",
        "    var a0 = fgmFx(c, \"Start\", 0, t) * 3.6, span = fgmFx(c, \"End\", 100, t) * 3.6 - a0;",
        "    var stp = Math.abs(span) >= 359.999 ? span / n : (n > 1 ? span / (n - 1) : 0);",
        "    var ang = a0 + fgmFx(c, \"Offset\", 0, t) + stp * i - 90;",
        "    x = Math.cos(degreesToRadians(ang)) * rad;",
        "    y = Math.sin(degreesToRadians(ang)) * rad;",
        "    if (fgmFx(c, \"Face Outward\", 1, t)) r = ang + 90;",
        "  } else if (type === 3) {",
        "    var ii = fgmFx(c, \"Reverse Layer Order\", 0, t) ? n - 1 - i : i;",
        "    var f = n > 1 ? ii / (n - 1) : 0;",
        "    df = f;",
        "    var sp = fgmSpline(c, \"Spline\", f, t);",
        "    var mult = (Math.round(fgmFx(c, \"Mode\", 1, t)) === 2 ? sp * (n - 1) : sp) * fgmFx(c, \"Strength\", 100, t) / 100;",
        "    var P = fgmFx(c, \"Position\", [0, 0], t);",
        "    x = P[0] * mult; y = P[1] * mult;",
        "    r = fgmFx(c, \"Rotation\", 0, t) * mult;",
        "    s = 100 + (fgmFx(c, \"Scale\", 100, t) - 100) * mult;",
        "  }",
        "  if (fgmFx(c, \"Scatter Enable\", 0, t)) {",
        "    seedRandom(Math.round(fgmFx(c, \"Scatter Seed\", 1, t)) * 7919 + i * 13 + 1, true);",
        "    var bx = fgmFx(c, \"Scatter X\", [0, 0], t), by = fgmFx(c, \"Scatter Y\", [0, 0], t), bz = fgmFx(c, \"Scatter Z\", [0, 0], t);",
        "    x += random(bx[0], bx[1]); y += random(by[0], by[1]); z += random(bz[0], bz[1]);",
        "  }",
        "  return [x, y, z, r, s, df];",
        "}",
        // world placement of slot i of cloner c, in this layer's parent space
        "function fgmClone(c, i, n, keep, useDelay) {",
        "  var t = time, p = fgmPose(c, i, n, t);",
        "  if (useDelay) { var d = fgmDelay(c, i, p[5], time); if (d !== 0) { t = time - d; p = fgmPose(c, i, n, t); } }",
        "  var a = fgmP3(c.anchorPoint.valueAtTime(t));",
        "  var w = c.toWorld([a[0] + p[0], a[1] + p[1], a[2] + p[2]], t);",
        "  if (hasParent) w = parent.fromWorld(w);",
        "  return { pos: fgmFit(w, keep), pose: p, t: t };",
        "}",
        "function fgmCloneRot(c, W) {",
        "  var rot = W.pose[3] + fgmFx(c, \"Base Rotation\", 0, W.t);",
        "  if (fgmFx(c, \"Link Rotation\", 1, W.t)) rot += fgmAngle(c, W.t);",
        "  if (hasParent) rot -= fgmAngle(parent, time);",
        "  return rot;",
        "}",
        "function fgmFalloff(c, me, t, sp, useShape) {",
        "  var a = fgmP3(c.anchorPoint.valueAtTime(t));",
        "  var loc = c.fromWorld(fgmP3(me), t);",
        "  var dx = loc[0] - a[0], dy = loc[1] - a[1];",
        "  var dist = (useShape && Math.round(fgmFx(c, \"Shape\", 1, t)) === 2) ? Math.abs(dy) : Math.sqrt(dx * dx + dy * dy);",
        "  var ro = fgmFx(c, \"Outer Radius\", 300, t), ri = fgmFx(c, \"Inner Radius\", 100, t);",
        "  var f = ro > ri ? linear(dist, ri, ro, 1, 0) : (dist <= ro ? 1 : 0);",
        "  if (fgmFx(c, \"Invert\", 0, t)) f = 1 - f;",
        "  f = fgmSpline(c, sp, f, t);",
        "  return fgmInfluence(c, f, t) * fgmFx(c, \"Strength\", 100, t) / 100;",
        "}",
        "function fgmMe(v, isPos) {",
        "  var p = isPos ? v : transform.position.value;",
        "  return hasParent ? parent.toWorld(p) : p;",
        "}",
        "function fgmTargets(h) {",
        "  var out = [];",
        "  for (var k = 1; k <= 32; k++) {",
        "    var ef = null;",
        "    try { ef = h.effect(\"Morph Target \" + k); } catch (e) { ef = null; }",
        "    if (!ef) break;",
        "    var L = null;",
        "    try { L = ef(1); if (!L || Math.round(fgmFx(L, \"Cloner Type\", 0, time)) < 1) L = null; } catch (e2) { L = null; }",
        "    out.push(L);",
        "  }",
        "  return out;",
        "}"
    ].join("\n");

    function linkRef(id) { return "effect(\"" + LINK_FX + id + "\")(1)"; }

    function q(s) { return "\"" + s + "\""; }

    /* Where this layer sits in world space, as seen from a property other than
       Position. Reading transform.position would evaluate the Position
       expression nested inside this one; AE's JavaScript engine can fail that
       with "Internal error". A cloned layer's position is recomputed straight
       from its cloner instead - no nested evaluation. */
    function meCode(info, isPos) {
        if (isPos) return "fgmMe(v, true)";
        if (info.posCloner) {
            return "(function () { var K = " + linkRef(info.posCloner) + ", kr = fgmRange(K), kw = fgmClone(K, kr[0], kr[1], [0, 0, 0], true).pos; return hasParent ? parent.toWorld(kw) : kw; })()";
        }
        return "fgmMe(v, false)";
    }

    /* One block per link. Each runs inside (function (v) { ... })(v), so local
       names never collide between blocks. */
    function blockCode(kind, id, key, info) {
        var L = [];
        var isPos = info.role === "pos";
        L.push("var C = " + linkRef(id) + ";");

        if (kind === "cloner") {
            L.push("var rg = fgmRange(C), W = fgmClone(C, rg[0], rg[1], v, true);");
            if (info.role === "pos") L.push("return W.pos;");
            else if (info.role === "rot") L.push("return fgmCloneRot(C, W);");
            else if (info.role === "scale") L.push("return fgmMul(v, W.pose[4] / 100);");
            else L.push("return v;");
            return L.join("\n");
        }

        L.push("var rg = fgmRange(C), i = rg[0], n = rg[1];");
        L.push("var t = time - fgmDelay(C, i, n > 1 ? i / (n - 1) : 0, time);");

        if (kind === "inherit") {
            L.push("var prog = fgmFx(C, \"Morph Progress\", 0, t) / 360;");
            L.push("if (!(prog > 0)) return v;");
            L.push("var T = fgmTargets(C);");
            L.push("if (!T.length) return v;");
            L.push("var seg = Math.floor(prog), fr = prog - seg;");
            L.push("if (seg >= T.length) { seg = T.length; fr = 0; }");
            if (isPos) {
                L.push("function at(k) { if (k === 0 || !T[k - 1]) return v; return fgmClone(T[k - 1], i, n, v, false).pos; }");
            } else {
                L.push("function at(k) { if (k === 0 || !T[k - 1]) return v; var W = fgmClone(T[k - 1], i, n, [0, 0], false); return fgmCloneRot(T[k - 1], W); }");
            }
            L.push("var A = at(seg);");
            L.push("return fr === 0 ? A : fgmLerp(A, at(seg + 1), fr);");
            return L.join("\n");
        }

        if (kind === "target") {
            L.push("var a = fgmP3(C.anchorPoint.valueAtTime(t)), tc = C.toWorld(a, t);");
            if (isPos) {
                L.push("if (!fgmFx(C, \"Repel\", 1, t)) return v;");
                L.push("var me = fgmMe(v, true);");
                L.push("var f = fgmFalloff(C, me, t, \"Repel Spline\", false);");
                L.push("var dx = me[0] - tc[0], dy = me[1] - tc[1], len = Math.sqrt(dx * dx + dy * dy);");
                L.push("if (len < 0.001) { dx = 0; dy = -1; len = 1; }");
                L.push("var force = fgmFx(C, \"Force\", 200, t) * f;");
                L.push("var w = fgmP3(me); w = [w[0] + dx / len * force, w[1] + dy / len * force, w[2]];");
                L.push("if (hasParent) w = parent.fromWorld(w);");
                L.push("return fgmFit(w, v);");
            } else {
                L.push("if (!fgmFx(C, \"Look At\", 1, t)) return v;");
                L.push("var me = " + meCode(info, false) + ";");
                L.push("var ang = radiansToDegrees(Math.atan2(tc[1] - me[1], tc[0] - me[0])) + fgmFx(C, \"Rotation Correction\", 0, t);");
                L.push("if (hasParent) ang -= fgmAngle(parent, time);");
                L.push("var s = fgmInfluence(C, fgmFx(C, \"Look At Strength\", 100, t) / 100, t);");
                L.push("var diff = ((ang - v) % 360 + 540) % 360 - 180;");
                L.push("return v + diff * s;");
            }
            return L.join("\n");
        }

        var k = key;
        if (kind === "field") {
            L.push("var f = fgmFalloff(C, " + meCode(info, isPos) + ", t, " + q(k + " Spline") + ", true);");
            L.push("var inf = fgmFx(C, " + q(k + " Influence") + ", v, t);");
            L.push(info.isColor ? "return fgmLerp(v, inf, f);" : "return fgmAdd(v, fgmMul(inf, f));");
            return L.join("\n");
        }

        if (kind === "step") {
            L.push("var j = fgmFx(C, \"Reverse Layer Order\", 0, t) ? n - 1 - i : i;");
            L.push("var per = Math.max(1, Math.round(fgmFx(C, \"Layers per Step\", 1, t)));");
            L.push("var steps = Math.ceil(n / per), si = Math.floor(j / per);");
            L.push("var f = fgmSpline(C, \"Spline\", steps > 1 ? si / (steps - 1) : 1, t);");
            L.push("var m = Math.round(fgmFx(C, \"Mode\", 1, t)) === 2 ? f * (steps - 1) : f;");
            L.push("var str = fgmInfluence(C, fgmFx(C, \"Strength\", 100, t) / 100, t);");
            L.push("var st = fgmFx(C, " + q(k + " Step") + ", v, t), base = fgmFx(C, " + q(k + " Base Offset") + ", fgmMul(v, 0), t);");
            if (info.isColor) {
                L.push("return fgmAdd(fgmLerp(v, st, Math.min(1, m) * str), fgmMul(base, str));");
            } else {
                L.push("return fgmAdd(v, fgmMul(fgmAdd(base, fgmMul(st, m)), str));");
            }
            return L.join("\n");
        }

        if (kind === "noise") {
            L.push("var str = fgmInfluence(C, fgmFx(C, \"Strength\", 100, t) / 100, t);");
            L.push("var inf = fgmFx(C, " + q(k + " Influence") + ", v, t);");
            L.push("var nz = [1, 1, 1];");
            L.push("if (fgmFx(C, \"Enable Noise\", 1, t)) {");
            L.push("  var per = Math.max(0.01, fgmFx(C, \"Loop Period\", 1, t));");
            L.push("  var turns = fgmFx(C, \"Evolution\", 0, t) / 360 + t * fgmFx(C, \"Evolution Speed\", 0, t);");
            L.push("  var ph = ((turns % per) + per) % per / per * Math.PI * 2, rr = 0.35 * per + 0.5;");
            L.push("  var sd = Math.round(fgmFx(C, \"Noise Seed\", 1, t)) * 13.37 + index * 7.13;");
            L.push("  var cx = Math.cos(ph) * rr + sd, cy = Math.sin(ph) * rr + sd;");
            L.push("  nz = [clamp(noise([cx, cy, 0.5]) * 2, -1, 1), clamp(noise([cx, cy, 11.5]) * 2, -1, 1), clamp(noise([cx, cy, 23.5]) * 2, -1, 1)];");
            L.push("}");
            if (info.dims === 1 || info.isColor) {
                L.push("var nb = nz[Math.max(0, Math.min(2, Math.round(fgmFx(C, " + q(k + " Based On") + ", 1, t)) - 1))];");
                if (info.isColor) {
                    L.push("return fgmLerp(v, inf, (fgmFx(C, \"Enable Noise\", 1, t) ? (nb + 1) / 2 : 1) * str);");
                } else {
                    L.push("return v + inf * nb * str;");
                }
            } else {
                L.push("var split = fgmFx(C, " + q(k + " Split Dimensions") + ", 1, t), o = [];");
                L.push("for (var d = 0; d < v.length; d++) o.push(v[d] + (d < inf.length ? inf[d] : 0) * (split ? nz[Math.min(d, 2)] : nz[0]) * str);");
                L.push("return o;");
            }
            return L.join("\n");
        }
        return "return v;";
    }

    // ==========================================================
    // PROPERTY INFO, HEADER & EXPRESSION GENERATION
    // ==========================================================
    function ownerLayer(prop) { return prop.propertyGroup(prop.propertyDepth); }

    function propPath(prop) {
        var path = [];
        var p = prop;
        while (p && p.propertyDepth > 0) {
            path.unshift(p.propertyIndex);
            p = p.parentProperty;
        }
        return path;
    }

    function resolvePath(layer, path) {
        var p = layer;
        for (var i = 0; i < path.length; i++) {
            p = p.property(path[i]);
            if (!p) return null;
        }
        return p;
    }

    function isTransform(prop, match) {
        try {
            return prop.matchName === match && prop.parentProperty && prop.parentProperty.matchName === "ADBE Transform Group";
        } catch (e) { return false; }
    }

    function propInfo(prop) {
        var vt = prop.propertyValueType;
        var info = { role: "gen", isColor: vt === PropertyValueType.COLOR, dims: 1 };
        if (vt === PropertyValueType.TwoD || vt === PropertyValueType.TwoD_SPATIAL) info.dims = 2;
        if (vt === PropertyValueType.ThreeD || vt === PropertyValueType.ThreeD_SPATIAL) info.dims = 3;
        if (info.isColor) info.dims = 4;
        if (isTransform(prop, "ADBE Position")) info.role = "pos";
        else if (isTransform(prop, "ADBE Rotate Z")) info.role = "rot";
        else if (isTransform(prop, "ADBE Scale")) info.role = "scale";
        info.isRotation = info.role === "rot" || /Rotat|Angle/i.test(prop.matchName + " " + prop.name);
        info.posCloner = "";
        if (info.role !== "pos") {
            try {
                var pos = ownerLayer(prop).property("ADBE Transform Group").property("ADBE Position");
                var es = readEntries(pos);
                for (var i = 0; i < es.length; i++) if (es[i].kind === "cloner") info.posCloner = es[i].id;
                info.posHasFgm = hasFgm(pos);
            } catch (e) { info.posCloner = ""; }
        }
        return info;
    }

    function linkable(prop) {
        if (!prop || prop.propertyType !== PropertyType.PROPERTY) return false;
        if (!prop.canSetExpression) return false;
        var vt = prop.propertyValueType;
        return vt === PropertyValueType.OneD || vt === PropertyValueType.TwoD || vt === PropertyValueType.TwoD_SPATIAL ||
               vt === PropertyValueType.ThreeD || vt === PropertyValueType.ThreeD_SPATIAL || vt === PropertyValueType.COLOR;
    }

    function hasFgm(prop) {
        try { return prop.canSetExpression && prop.expression.indexOf(HEADER) === 0; } catch (e) { return false; }
    }

    function readEntries(prop) {
        var out = [];
        if (!hasFgm(prop)) return out;
        var line = prop.expression.split("\n")[0].substring(HEADER.length);
        var parts = line.split(";");
        for (var i = 0; i < parts.length; i++) {
            var m = parts[i].match(/^([a-z]+)=([A-Z0-9]+)(?:~(.*))?$/);
            if (m) out.push({ kind: m[1], id: m[2], key: m[3] || "" });
        }
        return out;
    }

    function writeEntries(prop, entries) {
        writeEntriesOnly(prop, entries);
        if (isTransform(prop, "ADBE Position")) refreshSiblings(ownerLayer(prop));
    }

    function refreshSiblings(layer) {
        var paths = [];
        walkProps(layer, function (p) {
            if (hasFgm(p) && !isTransform(p, "ADBE Position")) paths.push(propPath(p));
        });
        for (var i = 0; i < paths.length; i++) {
            var p = resolvePath(layer, paths[i]);
            if (!p) continue;
            var es = readEntries(p);
            var needs = false;
            for (var j = 0; j < es.length; j++) if (es[j].kind === "field" || es[j].kind === "target") needs = true;
            if (needs) writeEntriesOnly(p, es);
        }
    }

    function writeEntriesOnly(prop, entries) {
        if (!entries.length) {
            snapshotAndClear(prop);
            return;
        }
        entries.sort(function (a, b) { return ORDER[a.kind] - ORDER[b.kind]; });
        var info = propInfo(prop);
        var head = [];
        var body = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            head.push(e.kind + "=" + e.id + (e.key ? "~" + e.key : ""));
            body.push("v = (function (v) {\n" + blockCode(e.kind, e.id, e.key, info) + "\n})(v);");
        }
        /* Everything lives inside one function scope. AE's JavaScript engine
           can fail with "Internal error" when an expression that declares
           top-level functions reads another property whose expression declares
           the same names (Scale reading Position on one layer). No globals, no
           collision. */
        prop.expression = HEADER + head.join(";") + "\n" +
            "// Feugee Mograph - generated. Link, unlink or bake from the panel instead of editing.\n" +
            "(function () {\n" + LIB + "\nvar v = value;\n" + body.join("\n") + "\nreturn v;\n})();";
        try { prop.expressionEnabled = true; } catch (e2) {}
    }

    /* Read a post-expression value from a script. When the comp is open in the
       viewer, AE's JavaScript engine can report a transient "Internal error"
       (measured: never during plain playback, only while a script samples in
       parallel) and disables the expression. Re-enable and read again; only a
       persistent error is reported. Returns { ok, value, error }. */
    function sampleAt(prop, t) {
        var err = "";
        for (var attempt = 0; attempt < 4; attempt++) {
            var v;
            try { v = prop.valueAtTime(t, false); } catch (e) { err = String(e); recompile(prop); continue; }
            try { err = prop.expressionError || ""; } catch (e1) { err = ""; }
            if (!err && prop.expressionEnabled) return { ok: true, value: v };
            recompile(prop);
        }
        return { ok: false, error: String(err).split("\n")[0] };
    }

    /* Re-assigning the text makes AE compile the expression again, which is
       what clears a stale "Internal error"; enabling alone does not. */
    function recompile(prop) {
        try {
            var text = prop.expression;
            prop.expression = text;
            prop.expressionEnabled = true;
        } catch (e) {}
    }

    /* Freeze the current look before an expression is removed: a property with
       no keyframes keeps the value it shows right now. */
    function snapshotAndClear(prop) {
        if (!prop.canSetExpression || prop.expression === "") return;
        var keep = null;
        if (prop.numKeys === 0) {
            var sm = sampleAt(prop, ownerLayer(prop).containingComp.time);
            if (sm.ok) keep = sm.value;
        }
        prop.expression = "";
        if (keep !== null) { try { prop.setValue(keep); } catch (e2) {} }
    }

    function addEntry(prop, kind, id, key) {
        var entries = readEntries(prop);
        var kept = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.id === id) continue;                           // relinking the same controller
            if (kind === "cloner" && e.kind === "cloner") continue; // one cloner per layer
            kept.push(e);
        }
        kept.push({ kind: kind, id: id, key: key || "" });
        writeEntries(prop, kept);
    }

    // ==========================================================
    // LINK EFFECTS ON LINKED LAYERS
    // ==========================================================
    function linkEffect(layer, id) {
        try { return fxByName(layer, LINK_FX + id); } catch (e) { return null; }
    }

    function ensureLinkEffect(layer, ctrl) {
        var fx = linkEffect(layer, ctrl.id);
        if (!fx) {
            parade(layer).addProperty("ADBE Layer Control");
            lastFx(layer).name = LINK_FX + ctrl.id;
            fx = lastFx(layer);
        }
        fx.property(1).setValue(ctrl.layer.index);
    }

    function removeLinkEffectIfUnused(layer, id) {
        var used = false;
        walkProps(layer, function (p) {
            if (used || !hasFgm(p)) return;
            var es = readEntries(p);
            for (var i = 0; i < es.length; i++) if (es[i].id === id) used = true;
        });
        if (!used) {
            var fx = linkEffect(layer, id);
            if (fx) fx.remove();
        }
    }

    function renameLinkId(layer, oldId, newIdv) {
        var fx = linkEffect(layer, oldId);
        if (fx) fx.name = LINK_FX + newIdv;
        var props = [];
        walkProps(layer, function (p) { if (hasFgm(p)) props.push(propPath(p)); });
        for (var i = 0; i < props.length; i++) {
            var p = resolvePath(layer, props[i]);
            if (!p) continue;
            var es = readEntries(p);
            for (var j = 0; j < es.length; j++) if (es[j].id === oldId) es[j].id = newIdv;
            writeEntries(p, es);
        }
    }

    function walkProps(group, cb) {
        var n = 0;
        try { n = group.numProperties; } catch (e) { return; }
        for (var i = 1; i <= n; i++) {
            var p = null;
            try { p = group.property(i); } catch (e2) { p = null; }
            if (!p) continue;
            if (p.propertyType === PropertyType.PROPERTY) cb(p);
            else walkProps(p, cb);
        }
    }

    /* Every layer that carries a link effect pointing at this controller. */
    function linkedLayers(comp, ctrl) {
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var l = comp.layer(i);
            if (l.index === ctrl.layer.index) continue;
            var fx = linkEffect(l, ctrl.id);
            if (!fx) continue;
            var at = 0;
            try { at = fx.property(1).value; } catch (e) {}
            if (at === ctrl.layer.index) out.push(l);
        }
        return out;
    }

    // ==========================================================
    // PER-PROPERTY CONTROLS ON FIELD / STEP / NOISE
    // ==========================================================
    function controlTypeFor(info) {
        if (info.isColor) return "color";
        if (info.dims === 3) return "point3";
        if (info.dims === 2) return "point";
        return info.isRotation ? "angle" : "slider";
    }

    function defaultInfluence(prop, info) {
        if (info.isColor) return [0.949, 0.388, 0.11, 1];
        if (info.role === "pos") return info.dims === 3 ? [0, -150, 0] : [0, -150];
        if (info.role === "scale") return info.dims === 3 ? [100, 100, 100] : [100, 100];
        if (info.isRotation) return 180;
        if (isTransform(prop, "ADBE Opacity")) return -100;
        if (info.dims === 3) return [100, 100, 100];
        if (info.dims === 2) return [100, 100];
        return 100;
    }

    function zeroFor(info) {
        if (info.isColor) return [0, 0, 0, 0];
        if (info.dims === 3) return [0, 0, 0];
        if (info.dims === 2) return [0, 0];
        return 0;
    }

    /* Returns the key used in control names ("Scale", "Scale 2", ...). Two
       properties that share a name AND a control type share one set of
       controls, the same way MographAE does. */
    function ensureKeyControls(ctrl, prop) {
        var info = propInfo(prop);
        var type = controlTypeFor(info);
        var first = ctrl.kind === "step" ? " Step" : " Influence";
        var base = clean(prop.name) || "Property";
        var key = base;
        for (var n = 2; n < 50; n++) {
            var existing = fxByName(ctrl.layer, key + first);
            if (!existing) break;
            if (existing.matchName === MATCH[type]) return key;
            key = base + " " + n;
        }

        if (ctrl.kind === "field") {
            addFx(ctrl.layer, type, key + " Influence", defaultInfluence(prop, info));
            addSpline(ctrl.layer, key + " Spline");
        } else if (ctrl.kind === "step") {
            addFx(ctrl.layer, type, key + " Step", defaultInfluence(prop, info));
            addFx(ctrl.layer, type, key + " Base Offset", zeroFor(info));
        } else if (ctrl.kind === "noise") {
            addFx(ctrl.layer, type, key + " Influence", defaultInfluence(prop, info));
            if (info.dims === 1 || info.isColor) {
                addDrop(ctrl.layer, key + " Based On", ["X Noise", "Y Noise", "Z Noise"], 1);
            } else {
                addFx(ctrl.layer, "check", key + " Split Dimensions", 1);
            }
        }
        return key;
    }

    // ==========================================================
    // SELECTION -> TARGETS
    // ==========================================================
    function selectedPlainLayers(comp) {
        var out = [];
        var sel = comp.selectedLayers;
        for (var i = 0; i < sel.length; i++) if (!isCtrl(sel[i])) out.push(sel[i]);
        out.sort(function (a, b) { return a.index - b.index; });
        return out;
    }

    function selectedCtrls(comp, cat) {
        var out = [];
        var sel = comp.selectedLayers;
        for (var i = 0; i < sel.length; i++) {
            var info = ctrlInfo(sel[i]);
            if (info && (!cat || category(info.kind) === cat)) out.push(info);
        }
        return out;
    }

    function transformProp(layer, match) {
        try {
            var p = layer.property("ADBE Transform Group").property(match);
            return (p && linkable(p)) ? p : null;
        } catch (e) { return null; }
    }

    var MASK_MATCH = { pos: "ADBE Position", scale: "ADBE Scale", rot: "ADBE Rotate Z", opa: "ADBE Opacity" };

    /* Properties to drive: whatever is selected in the timeline, or the panel's
       default toggles when only layers are selected. */
    function propertyTargets(comp, mask) {
        var out = [];
        var skipped = 0;
        var props = comp.selectedProperties;
        for (var i = 0; i < props.length; i++) {
            var p = props[i];
            if (p.propertyType !== PropertyType.PROPERTY) continue;
            var owner = ownerLayer(p);
            if (isCtrl(owner)) continue;
            if (!linkable(p)) { skipped++; continue; }
            out.push({ layer: owner, prop: p });
        }
        if (out.length || skipped) return { list: out, fromMask: false };

        var layers = selectedPlainLayers(comp);
        var keys = String(mask || "").split(",");
        for (var j = 0; j < layers.length; j++) {
            for (var k = 0; k < keys.length; k++) {
                var mt = MASK_MATCH[keys[k]];
                if (!mt) continue;
                var tp = transformProp(layers[j], mt);
                if (tp) out.push({ layer: layers[j], prop: tp });
            }
        }
        return { list: out, fromMask: true };
    }

    // ==========================================================
    // LINKING
    // ==========================================================
    function prepareProp(prop) {
        if (isTransform(prop, "ADBE Position")) {
            try { if (prop.dimensionsSeparated) prop.dimensionsSeparated = false; } catch (e) {}
        }
    }

    function userExpression(prop) {
        try { return prop.expression !== "" && !hasFgm(prop); } catch (e) { return false; }
    }

    /* Link layers to a cloner / inherit / target controller: position and
       rotation (plus scale for Linear). */
    function linkLayers(ctrl, layers) {
        var linked = 0, skipped = 0, locked = 0;
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            if (layerIsLocked(l)) { locked++; continue; }
            if (l.index === ctrl.layer.index || isCtrl(l)) continue;
            var pos = transformProp(l, "ADBE Position");
            if (!pos) { skipped++; continue; }

            var paths = [];
            var roles = ["ADBE Position", "ADBE Rotate Z"];
            if (ctrl.kind === "linear") roles.push("ADBE Scale");
            for (var r = 0; r < roles.length; r++) {
                var p = transformProp(l, roles[r]);
                if (!p) continue;
                if (userExpression(p)) { skipped++; continue; }
                prepareProp(p);
                paths.push(propPath(transformProp(l, roles[r])));
            }
            if (!paths.length) continue;

            if (CLONERS[ctrl.kind]) dropOtherCloners(l, ctrl.id);
            ensureLinkEffect(l, ctrl);
            var kind = CLONERS[ctrl.kind] ? "cloner" : ctrl.kind;
            for (var k = 0; k < paths.length; k++) {
                var tp = resolvePath(l, paths[k]);
                if (tp) addEntry(tp, kind, ctrl.id, "");
            }
            linked++;
        }
        return { linked: linked, skipped: skipped, locked: locked };
    }

    /* A layer can only follow one cloner. Remove the old cloner entries and
       their link effects before linking a new one. */
    function dropOtherCloners(layer, keepId) {
        var paths = [];
        var ids = [];
        walkProps(layer, function (p) {
            if (!hasFgm(p)) return;
            var es = readEntries(p);
            for (var i = 0; i < es.length; i++) {
                if (es[i].kind === "cloner" && es[i].id !== keepId) {
                    paths.push(propPath(p));
                    if (idxOf(ids, es[i].id) < 0) ids.push(es[i].id);
                    break;
                }
            }
        });
        for (var j = 0; j < paths.length; j++) {
            var prop = resolvePath(layer, paths[j]);
            if (!prop) continue;
            var es2 = readEntries(prop), kept = [];
            for (var k = 0; k < es2.length; k++) if (!(es2[k].kind === "cloner" && es2[k].id !== keepId)) kept.push(es2[k]);
            if (kept.length) writeEntries(prop, kept); else prop.expression = "";
        }
        for (var m = 0; m < ids.length; m++) removeLinkEffectIfUnused(layer, ids[m]);
    }

    /* Link selected properties to a field / step / noise controller. */
    function linkProps(ctrl, targets) {
        var linked = 0, skipped = 0, locked = 0;
        var jobs = [];
        for (var i = 0; i < targets.length; i++) {
            var t = targets[i];
            if (layerIsLocked(t.layer)) { locked++; continue; }
            if (userExpression(t.prop)) { skipped++; continue; }
            prepareProp(t.prop);
            jobs.push({ layer: t.layer, path: propPath(t.prop), name: t.prop.name });
        }
        // controls first: they live on the controller, not on the linked layer
        for (var j = 0; j < jobs.length; j++) {
            var p = resolvePath(jobs[j].layer, jobs[j].path);
            if (p) jobs[j].key = ensureKeyControls(ctrl, p);
        }
        for (var k = 0; k < jobs.length; k++) ensureLinkEffect(jobs[k].layer, ctrl);
        for (var m = 0; m < jobs.length; m++) {
            var prop = resolvePath(jobs[m].layer, jobs[m].path);
            if (!prop || !jobs[m].key) continue;
            addEntry(prop, ctrl.kind, ctrl.id, jobs[m].key);
            linked++;
        }
        return { linked: linked, skipped: skipped, locked: locked };
    }

    /* Index-based rigs need their layers next to each other in the timeline.
       Keeps the relative order, pulls strays up under the first one. */
    function makeContiguous(layers) {
        if (layers.length < 2) return;
        layers.sort(function (a, b) { return a.index - b.index; });
        for (var i = 1; i < layers.length; i++) {
            if (layers[i].index !== layers[i - 1].index + 1) {
                try { layers[i].moveAfter(layers[i - 1]); } catch (e) {}
            }
        }
    }

    function centroid(comp, layers) {
        var sx = 0, sy = 0, sz = 0, n = 0;
        for (var i = 0; i < layers.length; i++) {
            try {
                var p = layers[i].property("ADBE Transform Group").property("ADBE Position").value;
                if (layers[i].parent) continue;
                sx += p[0]; sy += p[1]; sz += (p.length > 2 ? p[2] : 0); n++;
            } catch (e) {}
        }
        if (!n) return [comp.width / 2, comp.height / 2, 0];
        return [sx / n, sy / n, sz / n];
    }

    function all3D(layers) {
        if (!layers.length) return false;
        for (var i = 0; i < layers.length; i++) {
            try { if (!layers[i].threeDLayer) return false; } catch (e) { return false; }
        }
        return true;
    }

    function selectOnly(comp, layers) {
        var sel = comp.selectedLayers;
        for (var i = 0; i < sel.length; i++) sel[i].selected = false;
        for (var j = 0; j < layers.length; j++) { try { layers[j].selected = true; } catch (e) {} }
    }

    function report(verb, res, ctrlName) {
        var msg = verb + " " + res.linked + " " + (res.linked === 1 ? "item" : "items") + " to " + ctrlName;
        if (res.skipped) msg += " - skipped " + res.skipped + " with their own expression";
        if (res.locked) msg += " - " + res.locked + " locked";
        return msg;
    }

    // ==========================================================
    // VIEWER SAFETY
    // Measured in AE 26.5, both expression engines: a rig rendered by the
    // viewer never errors, and a script sampling it with the viewer elsewhere
    // never errors - but the two at once make AE report "Internal error" and
    // disable expressions. So sampling happens with the viewer parked on an
    // empty comp, and every action ends by re-enabling what AE switched off.
    // ==========================================================
    function withQuietViewer(comp, fn) {
        var tmp = null;
        try {
            tmp = app.project.items.addComp("FGM Quiet Viewer", 16, 16, 1, 1, comp.frameRate);
            tmp.openInViewer();
        } catch (e) { tmp = null; }
        try {
            return fn();
        } finally {
            try { comp.openInViewer(); } catch (e2) {}
            if (tmp) { try { tmp.remove(); } catch (e3) {} }
        }
    }

    function healExpressions(comp) {
        var healed = 0;
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            var linked = isCtrl(layer);
            if (!linked) {
                try {
                    var fxp = parade(layer);
                    for (var k = 1; k <= fxp.numProperties && !linked; k++) {
                        if (fxp.property(k).name.indexOf(LINK_FX) === 0) linked = true;
                    }
                } catch (e) { linked = false; }
            }
            if (!linked) continue;
            walkProps(layer, function (p) {
                try {
                    if (!p.canSetExpression || p.expression === "") return;
                    var broken = !p.expressionEnabled;
                    if (!broken) { try { broken = /Internal error/i.test(p.expressionError || ""); } catch (e3) { broken = false; } }
                    if (broken && (hasFgm(p) || isCtrl(layer))) { recompile(p); healed++; }
                } catch (e2) {}
            });
        }
        return healed;
    }

    // ==========================================================
    // ACTION WRAPPER
    // ==========================================================
    function run(undoName, fn) {
        var comp = activeComp();
        if (!comp) return "ERR|Open a composition first";
        app.beginUndoGroup("Feugee Mograph - " + undoName);
        var res;
        try {
            ensureUniqueIds(comp);
            res = fn(comp);
        } catch (e) {
            res = "ERR|" + (e.message || e.toString()) + (e.line ? " (line " + e.line + ")" : "");
        } finally {
            try { healExpressions(comp); } catch (e2) {}
            app.endUndoGroup();
        }
        return res;
    }

    // ==========================================================
    // CREATE
    // ==========================================================
    function createCloner(comp, kind, cloneCount, gx, gy) {
        var layers = selectedPlainLayers(comp);
        if (!layers.length) {
            if (selectedCtrls(comp, null).length) return "ERR|That is a controller - select the layers you want to clone";
            return "ERR|Select at least 1 layer to clone";
        }
        for (var i = 0; i < layers.length; i++) {
            if (layerIsLocked(layers[i])) return "ERR|" + layers[i].name + " is locked";
        }

        if (layers.length === 1) {
            var src = layers[0];
            var total = Math.max(1, Math.min(500, Math.round(cloneCount) || 1));
            for (var d = 1; d < total; d++) src.duplicate();
            layers = [];
            for (var j = src.index - (total - 1); j <= src.index; j++) layers.push(comp.layer(j));
        }
        layers.sort(function (a, b) { return a.index - b.index; });

        var ctrl = makeController(comp, kind, centroid(comp, layers), all3D(layers));
        ctrl.layer.moveBefore(layers[0]);
        for (var k = 0; k < layers.length; k++) {
            var anchor = k === 0 ? ctrl.layer : layers[k - 1];
            if (layers[k].index !== anchor.index + 1) layers[k].moveAfter(anchor);
        }

        if (kind === "grid") {
            var cols = Math.max(1, Math.min(200, Math.round(gx) || 3));
            var rows = Math.max(1, Math.min(200, Math.round(gy) || 3));
            if (cols * rows < layers.length) rows = Math.ceil(layers.length / cols);
            fxByName(ctrl.layer, "Grid X").property(1).setValue(cols);
            fxByName(ctrl.layer, "Grid Y").property(1).setValue(rows);
        }

        var res = linkLayers(ctrl, layers);
        selectOnly(comp, [ctrl.layer]);
        return "OK|" + report("Cloned", res, ctrl.layer.name);
    }

    function createEffector(comp, kind, mask) {
        var ctrl, res;
        if (kind === "field" || kind === "step" || kind === "noise") {
            var targets = propertyTargets(comp, mask);
            if (!targets.list.length) {
                if (!selectedPlainLayers(comp).length && selectedCtrls(comp, null).length) {
                    return "ERR|Only a controller is selected - press SELECT to pick its layers, then " + TITLE[kind];
                }
                if (selectedPlainLayers(comp).length && !mask) {
                    return "ERR|Tick a default property (Position / Scale / ...) or select properties in the timeline";
                }
                return "ERR|" + TITLE[kind] + " needs layers or properties - select them in the timeline";
            }
            var owners = [];
            for (var i = 0; i < targets.list.length; i++) {
                if (!hasLayer(owners, targets.list[i].layer)) owners.push(targets.list[i].layer);
            }
            // property references can go stale once layers move or are added: keep paths
            var fresh = [];
            for (var r = 0; r < targets.list.length; r++) {
                fresh.push({ layer: targets.list[r].layer, path: propPath(targets.list[r].prop) });
            }
            if (kind === "step") makeContiguous(owners);
            ctrl = makeController(comp, kind, centroid(comp, owners), false);
            if (kind === "field") {
                ctrl.layer.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
            }
            ctrl.layer.moveToBeginning();
            var list = [];
            for (var s = 0; s < fresh.length; s++) {
                var fp = resolvePath(fresh[s].layer, fresh[s].path);
                if (fp) list.push({ layer: fresh[s].layer, prop: fp });
            }
            res = linkProps(ctrl, list);
        } else {
            var layers = selectedPlainLayers(comp);
            if (!layers.length) {
                if (selectedCtrls(comp, null).length) return "ERR|Only a controller is selected - press SELECT to pick its layers, then " + TITLE[kind];
                return "ERR|Select the layers " + TITLE[kind] + " should drive";
            }
            if (kind === "inherit") makeContiguous(layers);
            ctrl = makeController(comp, kind, centroid(comp, layers), false);
            if (kind === "target") {
                ctrl.layer.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
            }
            ctrl.layer.moveToBeginning();
            if (kind === "inherit") seedMorphTargets(comp, ctrl, layers);
            res = linkLayers(ctrl, layers);
        }
        selectOnly(comp, [ctrl.layer]);
        return "OK|" + report("Linked", res, ctrl.layer.name);
    }

    function addMorphTargetFx(ctrl, cloner) {
        var k = 1;
        while (fxByName(ctrl.layer, "Morph Target " + k)) k++;
        addFx(ctrl.layer, "layer", "Morph Target " + k, cloner ? cloner.layer.index : null);
        addFx(ctrl.layer, "check", "Morph Target " + k + " Valid", 0,
            "var ok = 0;\ntry { var L = effect(\"Morph Target " + k + "\")(1); ok = (L && Math.round(L.effect(\"Cloner Type\")(1).value) > 0) ? 1 : 0; } catch (e) { ok = 0; }\nok;");
        return k;
    }

    /* Pre-fill two morph targets with cloners the layers do not already follow. */
    function seedMorphTargets(comp, ctrl, layers) {
        var own = {};
        for (var i = 0; i < layers.length; i++) {
            walkProps(layers[i].property("ADBE Transform Group"), function (p) {
                var es = readEntries(p);
                for (var j = 0; j < es.length; j++) if (es[j].kind === "cloner") own[es[j].id] = 1;
            });
        }
        var picks = [];
        var list = controllers(comp);
        for (var k = 0; k < list.length && picks.length < 2; k++) {
            if (CLONERS[list[k].kind] && !own[list[k].id]) picks.push(list[k]);
        }
        addMorphTargetFx(ctrl, picks[0] || null);
        addMorphTargetFx(ctrl, picks[1] || null);
    }

    // ==========================================================
    // RESOLVE A CONTROLLER FOR LINK / UNLINK
    // ==========================================================
    function resolveTarget(comp, cat, targetId) {
        if (targetId && targetId !== "auto") {
            var byId = findCtrlById(comp, targetId);
            if (byId && category(byId.kind) === cat) return byId;
        }
        var sel = selectedCtrls(comp, cat);
        if (sel.length) return sel[0];
        var all = controllers(comp), ofCat = [];
        for (var i = 0; i < all.length; i++) if (category(all[i].kind) === cat) ofCat.push(all[i]);
        if (ofCat.length === 1) return ofCat[0];
        return null;
    }

    // ==========================================================
    // PUBLIC ACTIONS
    // ==========================================================
    function ping() {
        return "OK|Feugee Mograph host ready";
    }

    function create(kind, count, mask, gx, gy) {
        if (!(CLONERS[kind] || EFFECTORS[kind])) return "ERR|Unknown controller: " + kind;
        return run("Create " + TITLE[kind], function (comp) {
            return CLONERS[kind] ? createCloner(comp, kind, count, gx, gy) : createEffector(comp, kind, mask);
        });
    }

    function link(cat, targetId, mask) {
        return run("Link", function (comp) {
            var ctrl = resolveTarget(comp, cat, targetId);
            if (!ctrl) {
                return "ERR|Pick a " + (cat === "cloner" ? "cloner" : "effector") +
                       " in the list, or select its controller together with the layers";
            }
            var res;
            if (ctrl.kind === "field" || ctrl.kind === "step" || ctrl.kind === "noise") {
                var targets = propertyTargets(comp, mask);
                if (!targets.list.length) return "ERR|Select properties to link, or tick a default property";
                if (ctrl.kind === "step") {
                    var owners = [];
                    for (var i = 0; i < targets.list.length; i++) {
                        if (!hasLayer(owners, targets.list[i].layer)) owners.push(targets.list[i].layer);
                    }
                    var existing = linkedLayers(comp, ctrl);
                    for (var e = 0; e < existing.length; e++) if (!hasLayer(owners, existing[e])) owners.push(existing[e]);
                    var paths = [];
                    for (var p = 0; p < targets.list.length; p++) paths.push({ layer: targets.list[p].layer, path: propPath(targets.list[p].prop) });
                    makeContiguous(owners);
                    var list = [];
                    for (var r = 0; r < paths.length; r++) {
                        var rp = resolvePath(paths[r].layer, paths[r].path);
                        if (rp) list.push({ layer: paths[r].layer, prop: rp });
                    }
                    res = linkProps(ctrl, list);
                } else {
                    res = linkProps(ctrl, targets.list);
                }
            } else {
                var layers = selectedPlainLayers(comp);
                if (!layers.length) return "ERR|Select the layers to link";
                if (CLONERS[ctrl.kind] || ctrl.kind === "inherit") {
                    var group = linkedLayers(comp, ctrl);
                    for (var g = 0; g < layers.length; g++) if (!hasLayer(group, layers[g])) group.push(layers[g]);
                    group.sort(function (a, b) { return a.index - b.index; });
                    if (CLONERS[ctrl.kind]) {
                        if (ctrl.layer.index > group[0].index) ctrl.layer.moveBefore(group[0]);
                    }
                    makeContiguous(group);
                }
                res = linkLayers(ctrl, layers);
            }
            return "OK|" + report("Linked", res, ctrl.layer.name);
        });
    }

    function unlink(cat, targetId) {
        return run("Unlink", function (comp) {
            return withQuietViewer(comp, function () { return unlinkIn(comp, cat, targetId); });
        });
    }

    function unlinkIn(comp, cat, targetId) {
        {
            var layers = selectedPlainLayers(comp);
            if (!layers.length) return "ERR|Select the linked layers (or their properties) to unlink";

            var ids = {};
            var sel = selectedCtrls(comp, cat);
            if (sel.length) {
                for (var i = 0; i < sel.length; i++) ids[sel[i].id] = 1;
            } else if (targetId && targetId !== "auto") {
                ids[targetId] = 1;
            } else {
                ids = null; // every controller of this category
            }

            // restrict to selected properties when there are any
            var only = null;
            var props = comp.selectedProperties;
            for (var sp = 0; sp < props.length; sp++) {
                if (props[sp].propertyType === PropertyType.PROPERTY && hasFgm(props[sp])) {
                    if (!only) only = [];
                    only.push(ownerLayer(props[sp]).index + ":" + propPath(props[sp]).join(","));
                }
            }

            var count = 0;
            for (var l = 0; l < layers.length; l++) {
                var layer = layers[l];
                var jobs = [];
                walkProps(layer, function (p) {
                    if (!hasFgm(p)) return;
                    if (only && idxOf(only, layer.index + ":" + propPath(p).join(",")) < 0) return;
                    jobs.push(propPath(p));
                });
                var touched = [];
                for (var j = 0; j < jobs.length; j++) {
                    var prop = resolvePath(layer, jobs[j]);
                    if (!prop) continue;
                    var es = readEntries(prop), kept = [], changed = false;
                    for (var k = 0; k < es.length; k++) {
                        var ctrlCat = es[k].kind === "cloner" ? "cloner" : "effector";
                        var match = ctrlCat === cat && (!ids || ids[es[k].id]);
                        if (match) { changed = true; if (idxOf(touched, es[k].id) < 0) touched.push(es[k].id); }
                        else kept.push(es[k]);
                    }
                    if (changed) { writeEntries(prop, kept); count++; }
                }
                for (var t = 0; t < touched.length; t++) removeLinkEffectIfUnused(layer, touched[t]);
            }
            if (!count) return "ERR|Nothing to unlink - those layers are not linked to that " + cat;
            return "OK|Unlinked " + count + " propert" + (count === 1 ? "y" : "ies") + " - values kept as they looked";
        }
    }

    function addMorphTarget(targetId) {
        return run("Add Morph Target", function (comp) {
            var ctrl = null;
            var sel = selectedCtrls(comp, "effector");
            for (var i = 0; i < sel.length; i++) if (sel[i].kind === "inherit") { ctrl = sel[i]; break; }
            if (!ctrl && targetId && targetId !== "auto") {
                var t = findCtrlById(comp, targetId);
                if (t && t.kind === "inherit") ctrl = t;
            }
            if (!ctrl) {
                var all = controllers(comp), inh = [];
                for (var j = 0; j < all.length; j++) if (all[j].kind === "inherit") inh.push(all[j]);
                if (inh.length === 1) ctrl = inh[0];
            }
            if (!ctrl) return "ERR|Select an Inherit controller first";
            var clonerSel = selectedCtrls(comp, "cloner");
            var k = addMorphTargetFx(ctrl, clonerSel[0] || null);
            return "OK|Added Morph Target " + k + " to " + ctrl.layer.name +
                   (clonerSel[0] ? " -> " + clonerSel[0].layer.name : " - pick a cloner in its Layer menu");
        });
    }

    /* Select helper
       - one controller selected           -> select every layer linked to it
       - layers + a property on one of them -> select that property on all of them
       - linked layers only                 -> select their controllers */
    function selectLinked() {
        var comp = activeComp();
        if (!comp) return "ERR|Open a composition first";
        var sel = comp.selectedLayers;
        if (!sel.length) return "ERR|Select a controller, or layers with one property selected";

        var ctrls = selectedCtrls(comp, null);
        if (ctrls.length === 1 && sel.length === 1) {
            var layers = linkedLayers(comp, ctrls[0]);
            if (!layers.length) return "ERR|" + ctrls[0].layer.name + " has no linked layers";
            selectOnly(comp, layers);
            return "OK|Selected " + layers.length + " layer(s) linked to " + ctrls[0].layer.name;
        }

        var props = comp.selectedProperties;
        var ref = null;
        for (var i = 0; i < props.length; i++) {
            if (props[i].propertyType === PropertyType.PROPERTY) { ref = props[i]; break; }
        }
        if (ref && sel.length > 1) {
            var path = [];
            var p = ref;
            while (p && p.propertyDepth > 0) { path.unshift(p.matchName); p = p.parentProperty; }
            var hits = 0;
            for (var l = 0; l < sel.length; l++) {
                var cur = sel[l];
                for (var k = 0; k < path.length && cur; k++) {
                    try { cur = cur.property(path[k]); } catch (e) { cur = null; }
                }
                if (cur && cur.propertyType === PropertyType.PROPERTY) { cur.selected = true; hits++; }
            }
            return "OK|Selected " + ref.name + " on " + hits + " layer(s)";
        }

        var found = [];
        var list = controllers(comp);
        for (var s = 0; s < sel.length; s++) {
            if (isCtrl(sel[s])) continue;
            for (var c = 0; c < list.length; c++) {
                if (hasLayer(found, list[c].layer)) continue;
                if (linkEffect(sel[s], list[c].id)) found.push(list[c].layer);
            }
        }
        if (!found.length) return "ERR|Those layers are not linked to any Feugee Mograph controller";
        selectOnly(comp, found);
        return "OK|Selected " + found.length + " controller(s)";
    }

    function selectLayerById(id) {
        var comp = activeComp();
        if (!comp) return "ERR|Open a composition first";
        var c = findCtrlById(comp, id);
        if (!c) return "ERR|That controller is gone - the list will refresh";
        selectOnly(comp, [c.layer]);
        return "OK|Selected " + c.layer.name;
    }

    /* A copied layer must not join Step / Inherit rigs that were not copied:
       those count layers by index, and a second block would shift every slot
       of the original rig. */
    function dropIndexLinks(comp, layer, keepId) {
        var drop = {};
        var list = controllers(comp);
        for (var i = 0; i < list.length; i++) {
            var k = list[i].kind;
            if ((k === "step" || k === "inherit") && list[i].id !== keepId && linkEffect(layer, list[i].id)) drop[list[i].id] = 1;
        }
        var paths = [];
        walkProps(layer, function (p) { if (hasFgm(p)) paths.push(propPath(p)); });
        for (var j = 0; j < paths.length; j++) {
            var prop = resolvePath(layer, paths[j]);
            if (!prop) continue;
            var es = readEntries(prop), kept = [], changed = false;
            for (var e = 0; e < es.length; e++) { if (drop[es[e].id]) changed = true; else kept.push(es[e]); }
            if (changed) writeEntries(prop, kept);
        }
        for (var id in drop) {
            if (drop.hasOwnProperty(id)) { var fx = linkEffect(layer, id); if (fx) fx.remove(); }
        }
    }

    /* Copy: duplicate the selected controllers and rewire the copies.
       Linked layers that are selected come along; a cloner or inherit rig with
       none of its layers selected brings all of them, because a cloner without
       its clones is not a copy of anything. */
    function copyRig() {
        return run("Copy", function (comp) {
            var ctrls = selectedCtrls(comp, null);
            if (!ctrls.length) return "ERR|Select the controller(s) to copy, plus any linked layers to bring along";
            var picked = selectedPlainLayers(comp);

            var made = 0, layersCopied = 0;
            for (var i = 0; i < ctrls.length; i++) {
                var c = ctrls[i];
                var linked = linkedLayers(comp, c);
                var children = [];
                for (var a = 0; a < linked.length; a++) if (hasLayer(picked, linked[a])) children.push(linked[a]);
                var indexRig = !!CLONERS[c.kind] || c.kind === "inherit" || c.kind === "step";
                if (!children.length && (CLONERS[c.kind] || c.kind === "inherit")) children = linked;
                children.sort(function (x, y) { return x.index - y.index; });

                // name first: AE bumps the trailing number itself when duplicating
                var dupName = PREFIX + " " + TITLE[c.kind] + " " + nextNumber(comp, c.kind);
                var dupCtrl = c.layer.duplicate();
                var fresh = newId(comp);
                dupCtrl.comment = PREFIX + "|" + c.kind + "|" + fresh;
                dupCtrl.name = dupName;
                var info = { kind: c.kind, id: fresh, layer: dupCtrl };

                var prev = dupCtrl;
                for (var j = 0; j < children.length; j++) {
                    var dup = children[j].duplicate();
                    renameLinkId(dup, c.id, fresh);
                    ensureLinkEffect(dup, info);
                    dropIndexLinks(comp, dup, fresh);
                    if (indexRig) { dup.moveAfter(prev); prev = dup; }
                    layersCopied++;
                }
                if (!indexRig) dupCtrl.moveToBeginning();
                made++;
            }
            return "OK|Copied " + made + " controller(s) and " + layersCopied + " linked layer(s)";
        });
    }

    /* Organize: pull index-based children under their controller and colour
       each cloner's children with its own label. */
    function organize() {
        return run("Organize", function (comp) {
            var list = controllers(comp);
            var placed = [];
            var labels = [1, 2, 3, 5, 6, 7, 8, 11, 12, 13, 14, 15];
            var li = 0, groups = 0;
            var passes = [function (k) { return !!CLONERS[k]; }, function (k) { return k === "inherit" || k === "step"; }];

            for (var pass = 0; pass < passes.length; pass++) {
                for (var i = 0; i < list.length; i++) {
                    var c = list[i];
                    if (!passes[pass](c.kind)) continue;
                    var kids = linkedLayers(comp, c);
                    var free = [];
                    for (var k = 0; k < kids.length; k++) if (!hasLayer(placed, kids[k])) free.push(kids[k]);
                    if (!free.length) continue;
                    free.sort(function (a, b) { return a.index - b.index; });
                    if (CLONERS[c.kind]) {
                        var prev = c.layer;
                        for (var f = 0; f < free.length; f++) {
                            if (layerIsLocked(free[f])) continue;
                            if (free[f].index !== prev.index + 1) free[f].moveAfter(prev);
                            try { free[f].label = labels[li % labels.length]; } catch (e) {}
                            prev = free[f];
                            placed.push(free[f]);
                        }
                        li++;
                    } else {
                        makeContiguous(free);
                        for (var g = 0; g < free.length; g++) placed.push(free[g]);
                    }
                    groups++;
                }
            }
            var healed = healExpressions(comp);
            return "OK|Organized " + groups + " rig(s), " + placed.length + " layer(s) grouped under their controllers" +
                   (healed ? ", re-enabled " + healed + " expression(s) AE had switched off" : "");
        });
    }

    /* Layers affected by Clean / Bake: the selection plus everything linked to
       a selected controller (deleting a controller must never orphan a layer). */
    function rigScope(comp) {
        var ctrls = selectedCtrls(comp, null);
        var layers = selectedPlainLayers(comp);
        for (var i = 0; i < ctrls.length; i++) {
            var kids = linkedLayers(comp, ctrls[i]);
            for (var k = 0; k < kids.length; k++) if (!hasLayer(layers, kids[k])) layers.push(kids[k]);
        }
        return { ctrls: ctrls, layers: layers };
    }

    function stripLayer(layer) {
        var fxs = [];
        var p = parade(layer);
        for (var i = p.numProperties; i >= 1; i--) {
            if (p.property(i).name.indexOf(LINK_FX) === 0) fxs.push(i);
        }
        for (var j = 0; j < fxs.length; j++) parade(layer).property(fxs[j]).remove();
    }

    function cleanRig() {
        return run("Clean", function (comp) {
            return withQuietViewer(comp, function () { return cleanIn(comp); });
        });
    }

    function cleanIn(comp) {
        {
            var scope = rigScope(comp);
            if (!scope.layers.length && !scope.ctrls.length) return "ERR|Select controllers and/or linked layers to clean";
            var jobs = [];
            var t = comp.time;
            for (var i = 0; i < scope.layers.length; i++) {
                var layer = scope.layers[i];
                walkProps(layer, function (p) {
                    if (!hasFgm(p)) return;
                    var keep = null;
                    if (p.numKeys === 0) { var sm = sampleAt(p, t); if (sm.ok) keep = sm.value; }
                    jobs.push({ layer: layer, path: propPath(p), keep: keep });
                });
            }
            // sample everything first: later layers read earlier ones
            for (var j = 0; j < jobs.length; j++) {
                var prop = resolvePath(jobs[j].layer, jobs[j].path);
                if (!prop) continue;
                prop.expression = "";
                if (jobs[j].keep !== null) { try { prop.setValue(jobs[j].keep); } catch (e2) {} }
            }
            for (var k = 0; k < scope.layers.length; k++) stripLayer(scope.layers[k]);
            var removed = 0;
            for (var c = 0; c < scope.ctrls.length; c++) { scope.ctrls[c].layer.remove(); removed++; }
            return "OK|Cleaned " + jobs.length + " propert" + (jobs.length === 1 ? "y" : "ies") +
                   (removed ? ", removed " + removed + " controller(s)" : "") + " - static values kept";
        }
    }

    function bakeRig(workAreaOnly) {
        return run("Bake", function (comp) {
            return withQuietViewer(comp, function () { return bakeIn(comp, workAreaOnly); });
        });
    }

    function bakeIn(comp, workAreaOnly) {
        {
            var scope = rigScope(comp);
            if (!scope.layers.length) return "ERR|Select controllers and/or linked layers to bake";

            var fd = comp.frameDuration;
            var t0 = workAreaOnly ? comp.workAreaStart : 0;
            var t1 = workAreaOnly ? comp.workAreaStart + comp.workAreaDuration : comp.duration;
            var frames = Math.max(1, Math.round((t1 - t0) / fd));
            if (frames > 20000) return "ERR|That is " + frames + " frames - shorten the work area first";

            var times = [];
            for (var f = 0; f < frames; f++) times.push(t0 + f * fd);

            // sample everything before writing anything: a failure leaves the rig untouched
            var jobs = [];
            var failed = null;
            for (var i = 0; i < scope.layers.length && !failed; i++) {
                var layer = scope.layers[i];
                walkProps(layer, function (p) {
                    if (failed || !hasFgm(p)) return;
                    var vals = [];
                    for (var k = 0; k < times.length; k++) {
                        var sm = sampleAt(p, times[k]);
                        if (!sm.ok) { failed = layer.name + " / " + p.name + " at " + times[k].toFixed(2) + "s: " + sm.error; return; }
                        vals.push(sm.value);
                    }
                    jobs.push({ layer: layer, path: propPath(p), vals: vals });
                });
            }
            if (failed) return "ERR|Bake stopped, nothing changed - expression error on " + failed;
            for (var j = 0; j < jobs.length; j++) {
                var prop = resolvePath(jobs[j].layer, jobs[j].path);
                if (!prop) continue;
                prop.expression = "";
                while (prop.numKeys > 0) prop.removeKey(prop.numKeys);
                prop.setValuesAtTimes(times, jobs[j].vals);
            }
            for (var s = 0; s < scope.layers.length; s++) stripLayer(scope.layers[s]);
            var removed = 0;
            for (var c = 0; c < scope.ctrls.length; c++) { scope.ctrls[c].layer.remove(); removed++; }
            return "OK|Baked " + jobs.length + " propert" + (jobs.length === 1 ? "y" : "ies") + " x " + frames + " frames" +
                   (removed ? ", removed " + removed + " controller(s)" : "");
        }
    }

    /* A ready-made scene: 6x4 grid of rounded squares, a field sweeping across
       that scales them up, and a noise effector on rotation. */
    function sample() {
        app.beginUndoGroup("Feugee Mograph - Sample Comp");
        try {
            var comp = app.project.items.addComp("FGM Sample", 1920, 1080, 1, 6, 30);
            comp.bgColor = [0.086, 0.086, 0.098];
            var shape = comp.layers.addShape();
            shape.name = "Tile";
            var root = shape.property("ADBE Root Vectors Group");
            root.addProperty("ADBE Vector Group");
            var vecs = function () { return shape.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group"); };
            vecs().addProperty("ADBE Vector Shape - Rect");
            vecs().property(1).property("ADBE Vector Rect Size").setValue([90, 90]);
            vecs().property(1).property("ADBE Vector Rect Roundness").setValue(18);
            vecs().addProperty("ADBE Vector Graphic - Fill");
            vecs().property(2).property("ADBE Vector Fill Color").setValue([0.949, 0.388, 0.11]);
            shape.property("ADBE Transform Group").property("ADBE Position").setValue([960, 540]);
            comp.openInViewer();
            selectOnly(comp, [shape]);

            var res = createCloner(comp, "grid", 24, 6, 4);
            var grid = selectedCtrls(comp, "cloner")[0];

            var kids = linkedLayers(comp, grid);
            selectOnly(comp, kids);
            createEffector(comp, "field", "scale");
            var field = selectedCtrls(comp, "effector")[0];
            var fp = field.layer.property("ADBE Transform Group").property("ADBE Position");
            fp.setValueAtTime(0, [200, 540]);
            fp.setValueAtTime(6, [1720, 540]);
            fxByName(field.layer, "Outer Radius").property(1).setValue(420);
            fxByName(field.layer, "Inner Radius").property(1).setValue(120);

            kids = linkedLayers(comp, grid);
            selectOnly(comp, kids);
            createEffector(comp, "noise", "rot");
            var noise = selectedCtrls(comp, "effector")[0];
            fxByName(noise.layer, "Rotation Influence").property(1).setValue(35);

            selectOnly(comp, [grid.layer]);
            healExpressions(comp);
            return "OK|Sample comp ready - scrub the timeline, then tweak FGM Grid 1 / Field 1 / Noise 1" +
                   (res.indexOf("ERR|") === 0 ? " (" + res.substring(4) + ")" : "");
        } catch (e) {
            return "ERR|" + (e.message || e.toString()) + (e.line ? " (line " + e.line + ")" : "");
        } finally {
            app.endUndoGroup();
        }
    }

    // ==========================================================
    // SCAN (read-only, polled by the panel)
    // OK|<comp name>|<plain layers>|<props>|<rows>
    // row = kind~id~encodedName~links~selected, joined with ";"
    // ==========================================================
    function scan() {
        var comp = activeComp();
        if (!comp) return "OK||0|0|";
        var sel = comp.selectedLayers;
        var plain = 0;
        for (var i = 0; i < sel.length; i++) if (!isCtrl(sel[i])) plain++;
        var nProps = 0;
        var props = comp.selectedProperties;
        for (var p = 0; p < props.length; p++) {
            if (props[p].propertyType === PropertyType.PROPERTY && !isCtrl(ownerLayer(props[p]))) nProps++;
        }

        var list = controllers(comp);
        var counts = {};
        for (var c = 0; c < list.length; c++) counts[list[c].id] = 0;
        if (list.length) {
            for (var l = 1; l <= comp.numLayers; l++) {
                var layer = comp.layer(l);
                var fxp;
                try { fxp = parade(layer); } catch (e) { fxp = null; }
                if (!fxp) continue;
                for (var k = 1; k <= fxp.numProperties; k++) {
                    var nm = fxp.property(k).name;
                    if (nm.indexOf(LINK_FX) !== 0) continue;
                    var id = nm.substring(LINK_FX.length);
                    if (counts[id] !== undefined) counts[id]++;
                }
            }
        }
        var rows = [];
        for (var r = 0; r < list.length; r++) {
            var it = list[r];
            rows.push(it.kind + "~" + it.id + "~" + encodeURIComponent(it.layer.name) + "~" + counts[it.id] + "~" + (it.layer.selected ? 1 : 0));
        }
        return "OK|" + encodeURIComponent(comp.name) + "|" + plain + "|" + nProps + "|" + rows.join(";");
    }

    return {
        ping: ping,
        scan: scan,
        create: create,
        link: link,
        unlink: unlink,
        addMorphTarget: addMorphTarget,
        select: selectLinked,
        selectLayer: selectLayerById,
        copy: copyRig,
        organize: organize,
        clean: cleanRig,
        bake: bakeRig,
        sample: sample,
        // exposed for the in-AE verification harness
        _lib: LIB,
        _block: blockCode
    };
})();
