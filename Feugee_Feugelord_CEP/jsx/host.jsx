/**
 * FEUGEE STUDIO - FEUGELORD  |  HOST SCRIPT (ExtendScript, Illustrator + After Effects)
 * Author: Muhammad Rijal Nurjaman (Feugee Studio)
 *
 * Push vector artwork from Illustrator to After Effects as native shape layers.
 * Built from the public behaviour of the idea, not from anyone's code.
 *
 *   Illustrator  FG_LORD.push(mode, opts)  -> collects the selection or the active
 *                artboard into a scene payload (JSON) in the outbox folder
 *   AE hub       FG_LORD.build(path)       -> turns the payload into shape layers,
 *                writes a result file the Illustrator panel reads back
 *
 * Rules this file keeps:
 *   - ES3 only. Illustrator 30 has no JSON, no Array#indexOf/filter/map, no trim.
 *   - No chained ternaries (a ? b : c ? d : e) - ExtendScript mis-parses them.
 *   - ASCII only; one global (FG_LORD).
 *   - No alert(): every entry point returns "OK|message" or "ERR|message".
 *
 * Coordinates, measured on Illustrator 30.8 by exporting artboards to PNG:
 *   pathPoints and artboardRect share the document system, Y grows upward, so
 *   AE x = anchor.x - artboard.left,  AE y = artboard.top - anchor.y
 */

var FG_LORD = (function () {

var VERSION = "1.0.0";
var PAYLOAD_VERSION = 1;

// ==========================================================
// SHARED HELPERS
// ==========================================================
function isAE() { return BridgeTalk.appName === "aftereffects"; }

function jstr(s) {
    return '"' + String(s)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/[\u0000-\u001f\u2028\u2029]/g, function (c) {
            var h = c.charCodeAt(0).toString(16);
            while (h.length < 4) h = "0" + h;
            return "\\u" + h;
        }) + '"';
}

function num(n) {
    var r = Math.round(n * 1000) / 1000;
    if (r === 0) return "0";          // no "-0"
    return String(r);
}

function ensureFolder(path) {
    var f = new Folder(path);
    if (!f.exists) f.create();
    return f;
}

function baseFolder() { return ensureFolder(ensureFolder(Folder.userData.fsName + "/Feugee").fsName + "/Feugelord"); }
function outbox() { return ensureFolder(baseFolder().fsName + "/outbox"); }
function results() { return ensureFolder(baseFolder().fsName + "/results"); }

function readText(file) {
    if (!file.exists) return "";
    file.encoding = "UTF-8";
    if (!file.open("r")) return "";
    var t = file.read();
    file.close();
    return t;
}

function writeText(file, text) {
    file.encoding = "UTF-8";
    file.lineFeed = "Unix";
    if (!file.open("w")) return false;
    var ok = file.write(text);
    file.close();
    return ok;
}

function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

function ping() { return "OK|Feugelord host v" + VERSION + " in " + BridgeTalk.appName; }

function paths() {
    return "OK|" + jstr(outbox().fsName).slice(1, -1) + "|" + jstr(results().fsName).slice(1, -1);
}

// ==========================================================
// ILLUSTRATOR  -  COLLECT
// ==========================================================
var AI = {};

// warnings grouped by kind so the panel can say "3 gradients" once
function Report() {
    this.counts = {};
    this.order = [];
    this.paths = 0;
    this.points = 0;
}
Report.prototype.warn = function (key) {
    if (!this.counts[key]) { this.counts[key] = 0; this.order.push(key); }
    this.counts[key]++;
};
Report.prototype.json = function () {
    var out = [];
    for (var i = 0; i < this.order.length; i++) {
        out.push("[" + jstr(this.order[i]) + "," + this.counts[this.order[i]] + "]");
    }
    return "[" + out.join(",") + "]";
};

AI.color = function (c, rep) {
    if (!c) return null;
    var t = c.typename;
    if (t === "NoColor") return null;
    if (t === "RGBColor") return [c.red / 255, c.green / 255, c.blue / 255];
    if (t === "SpotColor") return AI.color(c.spot.color, rep);
    if (t === "GradientColor") {
        rep.warn("gradient sent as its first colour (gradients are phase 2)");
        var stops = c.gradient.gradientStops;
        return stops.length ? AI.color(stops[0].color, rep) : null;
    }
    if (t === "PatternColor") { rep.warn("pattern fill skipped"); return null; }
    var src = null, vals = null;
    if (t === "CMYKColor") { src = ImageColorSpace.CMYK; vals = [c.cyan, c.magenta, c.yellow, c.black]; }
    if (t === "GrayColor") { src = ImageColorSpace.GrayScale; vals = [c.gray]; }
    if (t === "LabColor") { src = ImageColorSpace.LAB; vals = [c.l, c.a, c.b]; }
    if (!src) { rep.warn("unsupported colour " + t + " skipped"); return null; }
    // Illustrator's own conversion, so it follows the document colour settings
    var rgb = app.convertSampleColor(src, vals, ImageColorSpace.RGB, ColorConvertPurpose.defaultpurpose);
    return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
};

AI.rgbJson = function (c) { return "[" + num(c[0]) + "," + num(c[1]) + "," + num(c[2]) + "]"; };

AI.pathJson = function (p, L, T, rep) {
    var pts = p.pathPoints;
    var v = [], ins = [], outs = [];
    for (var i = 0; i < pts.length; i++) {
        var pt = pts[i];
        var a = pt.anchor, l = pt.leftDirection, r = pt.rightDirection;
        v.push("[" + num(a[0] - L) + "," + num(T - a[1]) + "]");
        ins.push("[" + num(l[0] - a[0]) + "," + num(a[1] - l[1]) + "]");
        outs.push("[" + num(r[0] - a[0]) + "," + num(a[1] - r[1]) + "]");
    }
    rep.paths++;
    rep.points += pts.length;
    return '{"closed":' + (p.closed ? "true" : "false") + ',"v":[' + v.join(",") + '],"i":[' + ins.join(",") + '],"o":[' + outs.join(",") + "]}";
};

// fill + stroke of one PathItem (for compound paths: its first sub-path)
AI.styleJson = function (p, rep) {
    var parts = [];
    if (p.filled) {
        var fc = AI.color(p.fillColor, rep);
        if (fc) parts.push('"fill":{"c":' + AI.rgbJson(fc) + ',"rule":' + jstr(p.evenodd ? "evenodd" : "nonzero") + "}");
    }
    if (p.stroked && p.strokeWidth > 0) {
        var sc = AI.color(p.strokeColor, rep);
        if (sc) {
            var cap = "butt";
            if (p.strokeCap === StrokeCap.ROUNDENDCAP) cap = "round";
            if (p.strokeCap === StrokeCap.PROJECTINGENDCAP) cap = "square";
            var join = "miter";
            if (p.strokeJoin === StrokeJoin.ROUNDENDJOIN) join = "round";
            if (p.strokeJoin === StrokeJoin.BEVELENDJOIN) join = "bevel";
            var dashes = [];
            var d = p.strokeDashes;
            for (var i = 0; d && i < d.length; i++) dashes.push(num(d[i]));
            parts.push('"stroke":{"c":' + AI.rgbJson(sc) + ',"w":' + num(p.strokeWidth) + ',"cap":' + jstr(cap) +
                       ',"join":' + jstr(join) + ',"miter":' + num(p.strokeMiterLimit) +
                       ',"dash":[' + dashes.join(",") + '],"dashOffset":' + num(p.strokeDashOffset || 0) + "}");
        }
    }
    return parts;
};

AI.common = function (item, fallbackName) {
    var name = item.name;
    if (!name) name = fallbackName;
    var s = '"name":' + jstr(name) + ',"opacity":' + num(item.opacity);
    return s;
};

AI.checkBlend = function (item, rep) {
    try {
        if (item.blendingMode !== BlendModes.NORMAL) rep.warn("blend mode sent as Normal (blend modes are phase 2)");
    } catch (e) {}
};

// PageItem -> node JSON, or null when skipped
AI.node = function (item, L, T, opts, rep) {
    var t = item.typename;
    try { if (item.hidden) return null; } catch (e0) {}
    try { if (item.guides) return null; } catch (e1) {}

    if (t === "PathItem") {
        if (item.clipping) return null;
        if (item.pathPoints.length < 2) return null;
        AI.checkBlend(item, rep);
        var style = AI.styleJson(item, rep);
        return '{"t":"path",' + AI.common(item, "Path") + ',"paths":[' + AI.pathJson(item, L, T, rep) + "]" +
               (style.length ? "," + style.join(",") : "") + "}";
    }

    if (t === "CompoundPathItem") {
        var subs = [];
        for (var i = 0; i < item.pathItems.length; i++) {
            if (item.pathItems[i].pathPoints.length >= 2) subs.push(AI.pathJson(item.pathItems[i], L, T, rep));
        }
        if (!subs.length) return null;
        AI.checkBlend(item, rep);
        var cstyle = item.pathItems.length ? AI.styleJson(item.pathItems[0], rep) : [];
        return '{"t":"path",' + AI.common(item, "Compound Path") + ',"paths":[' + subs.join(",") + "]" +
               (cstyle.length ? "," + cstyle.join(",") : "") + "}";
    }

    if (t === "GroupItem") {
        if (item.clipped) rep.warn("clipping mask ignored, contents sent unclipped (masks are phase 3)");
        AI.checkBlend(item, rep);
        var kids = AI.children(item.pageItems, L, T, opts, rep);
        if (!kids.length) return null;
        return '{"t":"group",' + AI.common(item, "Group") + ',"children":[' + kids.join(",") + "]}";
    }

    if (t === "TextFrame") {
        if (!opts.outlineText) { rep.warn("text frame skipped (turn on Outline text)"); return null; }
        // outline a throwaway copy - the document keeps its live text
        var dup = item.duplicate();
        var outlined = dup.createOutline();
        var tn = AI.node(outlined, L, T, opts, rep);
        outlined.remove();
        if (tn) tn = tn.replace(/"name":"[^"]*"/, '"name":' + jstr(item.name || item.contents.substring(0, 30) || "Text"));
        rep.warn("text sent as outlines");
        return tn;
    }

    if (t === "SymbolItem") {
        var sdup = item.duplicate();
        sdup.breakLink();
        // breakLink leaves the expanded art selected-in-place as a group
        var expanded = sdup;
        var sn = null;
        try { sn = AI.node(expanded, L, T, opts, rep); } catch (e2) { sn = null; }
        try { expanded.remove(); } catch (e3) {}
        rep.warn("symbol instance expanded");
        return sn;
    }

    if (t === "PlacedItem" || t === "RasterItem") { rep.warn("raster image skipped (vectors only)"); return null; }
    if (t === "MeshItem") { rep.warn("gradient mesh skipped"); return null; }
    rep.warn(t + " skipped");
    return null;
};

// Illustrator collections list the top-most item first; AE shape contents
// also draw the first item on top, so the order carries over unchanged.
AI.children = function (coll, L, T, opts, rep) {
    var out = [];
    for (var i = 0; i < coll.length; i++) {
        var n = AI.node(coll[i], L, T, opts, rep);
        if (n) out.push(n);
    }
    return out;
};

AI.overlaps = function (item, rect) {
    var b = item.visibleBounds;          // [left, top, right, bottom], Y up
    return !(b[2] < rect[0] || b[0] > rect[2] || b[1] < rect[3] || b[3] > rect[1]);
};

/**
 * mode  "selection" | "artboard"
 * opts  "S" separate layers   "T" outline text
 */
function push(mode, optString) {
    if (isAE()) return "ERR|Push runs in Illustrator";
    if (!app.documents.length) return "ERR|Open a document first";
    var doc = app.activeDocument;
    optString = String(optString || "");
    var opts = { separate: optString.indexOf("S") >= 0, outlineText: optString.indexOf("T") >= 0 };

    var prevCoords = app.coordinateSystem;
    app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM;

    var abIndex = doc.artboards.getActiveArtboardIndex();
    var ab = doc.artboards[abIndex];
    var rect = ab.artboardRect;                  // left, top, right, bottom
    var L = rect[0], T = rect[1];
    var W = rect[2] - rect[0], H = rect[1] - rect[3];

    var rep = new Report();
    var items = [];
    var t0 = new Date().getTime();

    try {
        if (mode === "artboard") {
            // one node per visible Illustrator layer, keeping only what touches the artboard
            for (var li = 0; li < doc.layers.length; li++) {
                var layer = doc.layers[li];
                if (!layer.visible) continue;
                var inside = [];
                for (var pi = 0; pi < layer.pageItems.length; pi++) {
                    var it = layer.pageItems[pi];
                    if (it.parent !== layer) continue;
                    if (AI.overlaps(it, rect)) {
                        var n = AI.node(it, L, T, opts, rep);
                        if (n) inside.push(n);
                    }
                }
                if (inside.length) {
                    items.push('{"t":"group","name":' + jstr(layer.name) + ',"opacity":' + num(layer.opacity) + ',"children":[' + inside.join(",") + "]}");
                }
            }
            opts.separate = true;
        } else {
            var sel = doc.selection;
            if (!sel || !sel.length || sel.typename === "TextRange") {
                app.coordinateSystem = prevCoords;
                return "ERR|Select artwork first (or push the whole artboard)";
            }
            for (var si = 0; si < sel.length; si++) {
                // a direct-selected path inside a selected group arrives twice; keep the outer one
                if (AI.ancestorSelected(sel[si])) continue;
                var sn = AI.node(sel[si], L, T, opts, rep);
                if (sn) items.push(sn);
            }
        }
    } catch (e) {
        app.coordinateSystem = prevCoords;
        return "ERR|" + e.toString() + " (line " + e.line + ")";
    }
    app.coordinateSystem = prevCoords;

    if (!items.length) return "ERR|Nothing Feugelord can send in " + (mode === "artboard" ? "this artboard" : "the selection");

    var id = String(new Date().getTime()) + "-" + Math.floor(Math.random() * 1e6);
    var docName = doc.name;
    var json = '{"v":' + PAYLOAD_VERSION + ',"id":' + jstr(id) + ',"source":"illustrator","doc":' + jstr(docName) +
               ',"mode":' + jstr(mode) + ',"artboard":{"name":' + jstr(ab.name) + ',"w":' + num(W) + ',"h":' + num(H) + "}" +
               ',"options":{"separate":' + (opts.separate ? "true" : "false") + "}" +
               ',"stats":{"paths":' + rep.paths + ',"points":' + rep.points + ',"collectMs":' + (new Date().getTime() - t0) + "}" +
               ',"warnings":' + rep.json() + ',"items":[' + items.join(",") + "]}";

    // write-then-rename so the AE hub never reads half a file
    var box = outbox();
    var tmp = new File(box.fsName + "/" + id + ".tmp");
    if (!writeText(tmp, json)) return "ERR|Could not write to " + box.fsName;
    tmp.rename(id + ".json");

    return "OK|" + id + "|" + plural(rep.paths, "path") + " \u00b7 " + plural(items.length, mode === "artboard" ? "layer" : "item") +
           "|" + rep.json();
}

AI.ancestorSelected = function (item) {
    var p = item.parent;
    while (p && p.typename === "GroupItem") {
        if (p.selected) return true;
        p = p.parent;
    }
    return false;
};

function selectionInfo() {
    if (isAE()) return "ERR|Illustrator only";
    if (!app.documents.length) return "OK|0|No document";
    var doc = app.activeDocument;
    var sel = doc.selection;
    var n = (sel && sel.length && sel.typename !== "TextRange") ? sel.length : 0;
    var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
    return "OK|" + n + "|" + doc.name + " \u00b7 " + ab.name;
}

// ==========================================================
// AFTER EFFECTS  -  BUILD
// ==========================================================
var AEB = {};

AEB.parse = function (text) {
    if (typeof JSON !== "undefined") return JSON.parse(text);
    return eval("(" + text + ")");        // payload is written by push() above, never by users
};

AEB.shape = function (p, dx, dy) {
    var s = new Shape();
    var v = [], ins = [], outs = [];
    for (var i = 0; i < p.v.length; i++) {
        v.push([p.v[i][0] + dx, p.v[i][1] + dy]);
        ins.push([p.i[i][0], p.i[i][1]]);
        outs.push([p.o[i][0], p.o[i][1]]);
    }
    s.vertices = v;
    s.inTangents = ins;
    s.outTangents = outs;
    s.closed = !!p.closed;
    return s;
};

AEB.CAP = { butt: 1, round: 2, square: 3 };
AEB.JOIN = { miter: 1, round: 2, bevel: 3 };

// AE has three dash/gap pairs; Illustrator repeats an odd list to make pairs
AEB.dashPairs = function (dash) {
    var d = [];
    for (var i = 0; i < dash.length; i++) d.push(dash[i]);
    if (d.length % 2 === 1) d = d.concat(d);
    var pairs = [];
    for (var j = 0; j + 1 < d.length && pairs.length < 3; j += 2) pairs.push([d[j], d[j + 1]]);
    return pairs;
};

AEB.setOpacity = function (group, opacity) {
    if (opacity === undefined || opacity >= 100) return;
    group.property("ADBE Vector Transform Group").property("ADBE Vector Group Opacity").setValue(opacity);
};

AEB.node = function (node, contents, dx, dy, stats) {
    var grp = contents.addProperty("ADBE Vector Group");
    grp.name = node.name || (node.t === "group" ? "Group" : "Path");
    var inner = grp.property("ADBE Vectors Group");

    if (node.t === "group") {
        for (var i = 0; i < node.children.length; i++) AEB.node(node.children[i], inner, dx, dy, stats);
        stats.groups++;
    } else {
        for (var p = 0; p < node.paths.length; p++) {
            var pg = inner.addProperty("ADBE Vector Shape - Group");
            pg.property("ADBE Vector Shape").setValue(AEB.shape(node.paths[p], dx, dy));
            stats.paths++;
        }
        // listed before the fill, so it draws on top of it - as in Illustrator
        if (node.stroke) {
            var st = inner.addProperty("ADBE Vector Graphic - Stroke");
            st.property("ADBE Vector Stroke Color").setValue([node.stroke.c[0], node.stroke.c[1], node.stroke.c[2], 1]);
            st.property("ADBE Vector Stroke Width").setValue(node.stroke.w);
            st.property("ADBE Vector Stroke Line Cap").setValue(AEB.CAP[node.stroke.cap] || 1);
            st.property("ADBE Vector Stroke Line Join").setValue(AEB.JOIN[node.stroke.join] || 1);
            // AE hides Miter Limit unless the join is Miter, and refuses to set a hidden property
            if (node.stroke.miter && node.stroke.join === "miter") st.property("ADBE Vector Stroke Miter Limit").setValue(node.stroke.miter);
            var pairs = AEB.dashPairs(node.stroke.dash || []);
            if (pairs.length) {
                var dashes = st.property("ADBE Vector Stroke Dashes");
                for (var k = 0; k < pairs.length; k++) {
                    dashes.addProperty("ADBE Vector Stroke Dash " + (k + 1)).setValue(pairs[k][0]);
                    dashes.addProperty("ADBE Vector Stroke Gap " + (k + 1)).setValue(pairs[k][1]);
                }
                if (node.stroke.dashOffset) dashes.property("ADBE Vector Stroke Offset").setValue(node.stroke.dashOffset);
            }
        }
        if (node.fill) {
            var fl = inner.addProperty("ADBE Vector Graphic - Fill");
            fl.property("ADBE Vector Fill Color").setValue([node.fill.c[0], node.fill.c[1], node.fill.c[2], 1]);
            fl.property("ADBE Vector Fill Rule").setValue(node.fill.rule === "evenodd" ? 2 : 1);
        }
    }
    AEB.setOpacity(grp, node.opacity);
    return grp;
};

AEB.layerFor = function (comp, name, nodes, dx, dy, stats, made) {
    var layer = comp.layers.addShape();
    made.push(layer);
    layer.name = name;
    // layer space == comp space while building, so the payload maps 1:1
    layer.transform.anchorPoint.setValue([0, 0]);
    layer.transform.position.setValue([0, 0]);
    var root = layer.property("ADBE Root Vectors Group");
    for (var i = 0; i < nodes.length; i++) AEB.node(nodes[i], root, dx, dy, stats);

    // then centre the anchor on the artwork without moving it
    var r = layer.sourceRectAtTime(comp.time, false);
    var c = [r.left + r.width / 2, r.top + r.height / 2];
    layer.transform.anchorPoint.setValue(c);
    layer.transform.position.setValue(c);
    stats.layers++;
    return layer;
};

// a single wrapper group adds nothing - unwrap it into the layer
AEB.flatten = function (node) {
    if (node.t === "group" && node.children.length && (node.opacity === undefined || node.opacity >= 100)) return node.children;
    return [node];
};

function build(path) {
    if (!isAE()) return "ERR|Build runs in After Effects";
    var file = new File(path);
    if (!file.exists) return "ERR|Payload not found";
    var scene;
    try { scene = AEB.parse(readText(file)); } catch (e) { return "ERR|Unreadable payload: " + e.toString(); }
    var result;
    try {
        result = AEB.buildScene(scene);
    } catch (e2) {
        result = "ERR|" + e2.toString() + " (line " + e2.line + ")";
    }
    writeText(new File(results().fsName + "/" + scene.id + ".txt"), result);
    try { file.remove(); } catch (e3) {}
    return result;
}

AEB.buildScene = function (scene) {
    if (scene.v !== PAYLOAD_VERSION) return "ERR|Payload v" + scene.v + " - update Feugelord on both apps";
    var t0 = new Date().getTime();
    var comp = app.project.activeItem;
    var madeComp = false;
    if (!(comp instanceof CompItem) || scene.mode === "artboard") {
        var fps = (comp instanceof CompItem) ? comp.frameRate : 30;
        var dur = (comp instanceof CompItem) ? comp.duration : 10;
        comp = app.project.items.addComp(scene.artboard.name, Math.max(4, Math.round(scene.artboard.w)),
                                         Math.max(4, Math.round(scene.artboard.h)), 1, dur, fps);
        comp.openInViewer();
        madeComp = true;
    }
    // artboard centred on the comp when the sizes differ
    var dx = (comp.width - scene.artboard.w) / 2;
    var dy = (comp.height - scene.artboard.h) / 2;

    var stats = { layers: 0, groups: 0, paths: 0 };
    var made = [];
    var failure = null;
    app.beginUndoGroup("Feugelord push");
    try {
        if (scene.options.separate) {
            // add bottom-up so the first (top-most) Illustrator item ends up on top
            for (var i = scene.items.length - 1; i >= 0; i--) {
                var node = scene.items[i];
                AEB.layerFor(comp, node.name || ("Shape " + (i + 1)), AEB.flatten(node), dx, dy, stats, made);
            }
        } else {
            var name = scene.items.length === 1 ? (scene.items[0].name || "Shape") : scene.doc.replace(/\.ai$/i, "") + " push";
            var nodes = scene.items.length === 1 ? AEB.flatten(scene.items[0]) : scene.items;
            AEB.layerFor(comp, name, nodes, dx, dy, stats, made);
        }
        for (var s = 1; s <= comp.numLayers; s++) comp.layer(s).selected = false;
        for (var m = 0; m < made.length; m++) made[m].selected = true;
    } catch (e) {
        failure = e;
        // all or nothing: a push that fails halfway leaves no half-built layers or comp behind
        for (var x = 0; x < made.length; x++) { try { made[x].remove(); } catch (e1) {} }
        if (madeComp) { try { comp.remove(); } catch (e3) {} }
    }
    app.endUndoGroup();
    if (failure) throw failure;
    return "OK|" + plural(stats.layers, "layer") + " \u00b7 " + plural(stats.paths, "path") + " \u2192 " +
           (madeComp ? "new comp " : "") + comp.name + "|" + (new Date().getTime() - t0);
};

return {
    version: VERSION,
    ping: ping,
    paths: paths,
    push: push,
    selectionInfo: selectionInfo,
    build: build,
    _aeb: AEB           // pure helpers, for tools/tests/test-feugelord.js
};

})();
